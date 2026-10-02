import time
from datetime import datetime, timezone
from observability import capture_strategy_failure
from database import db, Strategy, StrategyLeg, get_server_key, get_user_canary
from oracle import get_live_prices
from polymarket_oracle import get_polymarket_odds, is_polymarket_feed
from hyperliquid_oracle import get_hyperliquid_marks, is_hyperliquid_feed
from fhe_client import (get_encrypted_result, get_encrypted_leg_result,
                        build_strategy_payload, build_leg_payload, get_batch_results)
from condition_evaluator import evaluate_tree_encrypted
from config import CHECK_INTERVAL_SECONDS, PYTH_PRICE_FEED_IDS, DECRYPTOR_URL, chain_label
from decryptor_client import decrypt_trigger, decryptor_enabled, verify_canary
from executor_runner import run_execution, run_leg_execution

# TWAP fire-times are ENCRYPTED (privacy: cadence must not leak), but each leg's *earliest
# possible* slot — anchor + leg_index*interval_sec — is derivable from plaintext columns already
# on the parent Strategy row. That bound doesn't reveal anything an observer couldn't already see
# (interval_sec/leg_count are stored plaintext), so we use it to skip the FHE round trip for
# grid/TWAP time-legs that can't possibly be due yet. Slop covers scheduler jitter + a slice that
# fires a bit early relative to its nominal slot.
TWAP_POLL_SLOP_SECONDS = max(CHECK_INTERVAL_SECONDS * 3, 30)


def _leg_not_yet_due(eval_mode, leg_index, interval_sec, elapsed):
    """True if a TWAP/DCA time-leg's earliest possible slot is still far off — skip its FHE
    round trip this tick. Grid rungs (eval_mode='price') have no time bound and are never
    skipped by this check; only 'time'-mode legs (TWAP/DCA fire-time slices) qualify."""
    if (eval_mode or 'price').lower() != 'time' or not interval_sec:
        return False
    earliest = leg_index * interval_sec
    return elapsed < earliest - TWAP_POLL_SLOP_SECONDS


def _tree_feed_ids(node, acc):
    """Recursively collect price_feed_id values from a condition tree's LEAF nodes."""
    if not isinstance(node, dict):
        return
    if node.get("op") == "LEAF":
        fid = node.get("price_feed_id")
        if fid:
            acc.add(fid)
    for child in (node.get("conditions") or []):
        _tree_feed_ids(child, acc)


def _collect_polymarket_feeds(strategy_dicts):
    """All polymarket:<token_id> feeds referenced by the given strategies (single + condition-tree)."""
    feeds = set()
    for s in strategy_dicts:
        fid = s.get("price_feed_id")
        if is_polymarket_feed(fid):
            feeds.add(fid)
        _tree_feed_ids(s.get("condition_tree"), feeds)
    return {f for f in feeds if is_polymarket_feed(f)}


def _collect_hyperliquid_feeds(strategy_dicts):
    """All hyperliquid:<COIN> feeds referenced by pending strategies."""
    feeds = set()
    for s in strategy_dicts:
        fid = s.get("price_feed_id")
        if is_hyperliquid_feed(fid):
            feeds.add(fid)
        _tree_feed_ids(s.get("condition_tree"), feeds)
    return {f for f in feeds if is_hyperliquid_feed(f)}


# Stablecoins are never the trigger asset — their price is ~$1, not what a bound is set against.
_STABLES = {"USDC", "USDT", "DAI"}


def _price_for(strategy_dict, live_prices, eth_feed_id, eth_price, sol_price):
    # The trigger price is on the VOLATILE leg, never the stablecoin. A BUY pays a stablecoin
    # (asset_in) to acquire asset_out, so the bound is on asset_out's price. Keying the feed off
    # asset_in made a USDC→ETH order compare an ETH-price bound against USDC's ~$1 feed → every buy
    # rung/leg fired instantly. Use asset_out when asset_in is a stablecoin. (Limit orders carry a
    # condition_tree that already keys the leaf feed correctly; this fixes grids + flat-bound orders.)
    asset_in = strategy_dict.get('asset_in', 'ETH').upper()
    asset_out = strategy_dict.get('asset_out', 'ETH').upper()
    trigger_asset = asset_out if asset_in in _STABLES else asset_in
    price_feed_id = strategy_dict.get('price_feed_id') or PYTH_PRICE_FEED_IDS.get(trigger_asset)
    if price_feed_id and price_feed_id in live_prices:
        return live_prices[price_feed_id]
    # A Polymarket bet MUST evaluate against its own odds feed — never fall back to a token
    # price. A missing feed (CLOB fetch failed this cycle) returns None so the caller skips
    # arming rather than comparing an odds threshold against ETH's dollar price. A Hyperliquid
    # mark is the same: a BTC entry bound compared against ETH's price would fire at random.
    if is_polymarket_feed(price_feed_id) or is_hyperliquid_feed(price_feed_id):
        return None
    if eth_feed_id and eth_feed_id in live_prices:
        return eth_price
    return sol_price


def _expire_strategy(sid, reason="execution window elapsed"):
    """Stop firing → mark the strategy + remaining legs EXPIRED. Unspent slice/deposit notes stay
    the user's spendable notes (the browser reverts the 'pending' reservation to 'false' on EXPIRED,
    so the leftover funds are returned). Used for window-elapsed expiry and for key-generation
    strands (see _KEY_MISMATCH_MARKER) — both are terminal: the strategy can never fire as-is."""
    try:
        strat = Strategy.query.get(sid)
        # SETTLING (Devnet) has funds mid-flight in the settlement wallet: process_staged must
        # still finish it, so expiry never touches it.
        if strat and strat.status not in ('EXECUTED', 'FAILED', 'EXPIRED', 'SETTLING'):
            strat.status = 'EXPIRED'
        doomed = StrategyLeg.query.filter(
            StrategyLeg.strategy_id == sid,
            StrategyLeg.status.in_(['PENDING', 'ARMED', 'EXECUTING']),
        ).all()
        # v3 legs are armed inside the enclave, which mirrors their sealed note secrets to the same
        # encrypted volume that holds every user's ClientKey. Expiry is terminal, so those secrets
        # will never be used again — drop them here or they accumulate for the CVM's lifetime.
        # Captured BEFORE the status update, since the filter stops matching afterwards.
        expiring = [(l.leg_index, bool(l.zkp_data)) for l in doomed]
        for leg in doomed:
            leg.status = 'EXPIRED'
        db.session.commit()
        from executor_runner import _disarm_leg_quietly
        for leg_index, had_proof in expiring:
            if not had_proof:  # enclave-armed: no browser-built proof, so secrets live in the CVM
                _disarm_leg_quietly(sid, leg_index)
        print(f"[Scheduler] ⏲ Strategy {sid} EXPIRED ({reason})")
    except Exception as e:
        db.session.rollback()
        print(f"[Scheduler] expire failed for {sid}: {e}")


# The decryptor returns this (substring) when a ciphertext decrypts to value>1 — i.e. the enclave's
# ClientKey doesn't match the ServerKey the engine evaluated under. Reached ONLY after the per-user
# canary gate passed (current keys proven one-generation this cycle), so it deterministically means
# THIS strategy's stored bounds are a STALE generation (user regenerated keys after arming). It can
# never self-heal — the bounds are only re-encrypted by re-arming — so we quarantine instead of
# re-decrypting (and re-logging the mismatch) every cycle forever.
_KEY_MISMATCH_MARKER = "client key mismatch"


def _is_key_mismatch(err):
    return bool(err) and _KEY_MISMATCH_MARKER in err


def _anchor_epoch(strategy_dict):
    """Epoch seconds the execution window counts from. Prefer schedule_anchor (set at submit);
    fall back to created_at so a missing/null anchor can't silently disable expiry (armed-forever,
    free-FHE-compute abuse vector). created_at is a naive-UTC ISO string (datetime.utcnow)."""
    a = strategy_dict.get('schedule_anchor')
    if a:
        return a
    ca = strategy_dict.get('created_at')
    if ca:
        try:
            # to_dict() emits a trailing Z; Python 3.9 fromisoformat rejects it, and the except
            # below would swallow that into None — silently disabling expiry.
            return datetime.fromisoformat(str(ca).replace("Z", "+00:00")).replace(tzinfo=timezone.utc).timestamp()
        except ValueError:
            return None
    return None


def _is_expired(strategy_dict):
    w = strategy_dict.get('execution_window_sec')
    a = _anchor_epoch(strategy_dict)
    try:
        return bool(w and a and (int(time.time()) - int(a)) > int(w))
    except (TypeError, ValueError):
        return False


def _process_multi_leg(strategy_dict, current_price, server_key, user_id, canary_ok=True,
                       leg_results=None):
    """Evaluate + (in TEE mode) fire each eligible leg of a TWAP/Grid strategy independently.

    Each leg is a fully shielded sub-trade: it has its own encrypted trigger (price band for a
    grid rung, encrypted fire-time for a TWAP slice), its own slice-note ZK proof, and its own
    nullifier. A leg fires only when its OWN encrypted condition decrypts to TRUE inside the
    TEE, so a TWAP of N slices yields N independent withdraw+swap txs with N distinct nullifiers.
    The parent strategy becomes EXECUTED only once every leg has completed.
    """
    sid = strategy_dict.get('id')
    legs = StrategyLeg.query.filter(
        StrategyLeg.strategy_id == sid,
        StrategyLeg.status.in_(['PENDING', 'ARMED']),
    ).order_by(StrategyLeg.leg_index).all()

    # TWAP fire-times are encoded RELATIVE to the strategy's schedule_anchor (small values:
    # k*interval), so we compare against elapsed-seconds-since-anchor — not the absolute unix
    # time (~1.7e9), which is too large for the FHE integer width and is wasteful to compare.
    anchor = strategy_dict.get('schedule_anchor') or 0
    interval = int(strategy_dict.get('interval_sec') or 0)
    elapsed = max(0, int(time.time()) - int(anchor))
    for leg in legs:
        leg_dict = leg.to_dict()
        # PIPELINE hops 1..N (and hop 0 without an FHE trigger) use eval_mode=pipeline — they
        # advance via TEE prove-after-EXECUTED, not the FHE trigger loop.
        if (leg.eval_mode or "").lower() == "pipeline" or (leg.leg_kind or "").lower() == "pipeline" and int(leg.leg_index or 0) > 0:
            continue
        if leg_results is not None:
            # Pre-computed by the tick's batch pre-pass (one engine round trip for all legs);
            # that pass already skipped not-yet-due TWAP legs, so a miss here can mean "skipped".
            enc_result = leg_results.get(f"leg:{leg.id}")
        else:
            # Direct (non-batched) path: apply the same not-yet-due skip.
            if _leg_not_yet_due(leg.eval_mode, leg.leg_index, interval, elapsed):
                continue
            enc_result = get_encrypted_leg_result(leg_dict, current_price, server_key, now_ts=elapsed)
        if not enc_result:
            continue

        # Store the per-leg encrypted result (browser arming path can decrypt this too).
        leg.encrypted_result = enc_result
        leg.result_updated_at = datetime.utcnow()
        if leg.status == 'PENDING':
            leg.status = 'ARMED'
        db.session.commit()

        if not (decryptor_enabled() and enc_result):
            continue  # arming-only mode: leave it for the browser to authorize
        if not canary_ok:
            continue  # keys not proven one-generation this cycle → never fire on a garbage decrypt

        triggered, dec_err = decrypt_trigger(user_id, enc_result)
        if dec_err:
            if _is_key_mismatch(dec_err):
                # Canary passed but this leg's bounds are a stale key generation → the whole
                # strategy is stranded (all legs share one generation). Quarantine + return funds.
                print(f"[Scheduler] 🔑 {sid} stranded on a stale key generation "
                      f"(leg {leg.leg_index} decrypt mismatch); EXPIRING — re-arm to re-encrypt bounds")
                _expire_strategy(sid, reason="FHE key regenerated after arming — re-arm required")
                return
            print(f"[Scheduler] Decryptor error for {sid} leg {leg.leg_index}: {dec_err}")
            continue
        if not triggered:
            continue

        # Re-fetch the leg — its status may have changed during decryption.
        leg = StrategyLeg.query.get(leg.id)
        if not leg or leg.status in ('EXECUTED', 'FAILED', 'EXECUTING'):
            continue
        print(f"[Scheduler] TEE trigger=TRUE for {sid} leg {leg.leg_index} — executing on-chain…")
        try:
            result = run_leg_execution(leg.to_dict(), strategy_dict, current_price)
            print(f"[Scheduler] {sid} leg {leg.leg_index} executed | {result}")
        except Exception as exec_err:
            print(f"[Scheduler] Execution failed for {sid} leg {leg.leg_index}: {exec_err}")

    # Mark the parent EXECUTED once all legs are done; FAILED if any leg failed and none remain.
    # QUEUED must count as remaining — PIPELINE hops 1..N stay QUEUED until the prior hop
    # advances; omitting them made parent flip to EXECUTED after hop 0 alone.
    strat = Strategy.query.get(sid)
    if strat:
        remaining = StrategyLeg.query.filter(
            StrategyLeg.strategy_id == sid,
            StrategyLeg.status.in_(['PENDING', 'ARMED', 'EXECUTING', 'SETTLING', 'QUEUED']),
        ).count()
        done = StrategyLeg.query.filter_by(strategy_id=sid, status='EXECUTED').count()
        strat.executed_count = done
        if remaining == 0 and strat.status not in ('EXECUTED', 'FAILED'):
            failed = StrategyLeg.query.filter_by(strategy_id=sid, status='FAILED').count()
            strat.status = 'EXECUTED' if done > 0 else 'FAILED'
            if failed:
                print(f"[Scheduler] {sid} complete: {done} legs executed, {failed} failed")
        db.session.commit()


def worker_loop(app):
    mode = "TEE auto-execute" if decryptor_enabled() else "arming — browser decrypts & authorizes"
    print(f"[Scheduler] Starting worker loop ({mode})")

    while True:
        try:
            with app.app_context():
                # Polymarket resolution watcher — BEFORE the empty-pending early-continue, so
                # open positions still settle when no strategies are awaiting triggers.
                # Internally throttled (POLYMARKET_WATCH_INTERVAL_SEC) + no-op unconfigured.
                try:
                    from polymarket_watcher import process_open_positions
                    process_open_positions()
                except Exception as watch_err:
                    print(f"[Scheduler] PolyWatch error: {watch_err}")

                try:
                    from hyperliquid_watcher import process_open_positions as process_hl_positions
                    process_hl_positions()
                except Exception as hl_watch_err:
                    print(f"[Scheduler] HLWatch error: {hl_watch_err}")

                # Withdraw-to-any-chain orders (relayed payout → LI.FI hop / refund). Same
                # placement and reason: open orders must advance with no strategies pending.
                try:
                    from bridge_payout import process_bridge_orders
                    process_bridge_orders()
                except Exception as bridge_err:
                    print(f"[Scheduler] Bridge orders error: {bridge_err}")

                # Devnet settlements whose spend landed but whose swap/return did not: the funds
                # already left the vault, so they finish regardless of the trigger.
                try:
                    from solana_devnet_strategy import process_staged, process_pipeline_advances
                    process_staged()
                    process_pipeline_advances()
                except Exception as staged_err:
                    print(f"[Scheduler] Devnet staged settlements error: {staged_err}")

                # Process strategies awaiting a trigger. ARMED ones are refreshed each cycle
                # so the browser always sees a result reflecting the current price.
                pending = Strategy.query.filter(Strategy.status.in_(['PENDING', 'ARMED'])).all()

                if not pending:
                    time.sleep(CHECK_INTERVAL_SECONDS)
                    continue

                strategies_to_process = [s.to_dict() for s in pending]

                feed_ids = [fid for fid in PYTH_PRICE_FEED_IDS.values() if fid]
                live_prices = get_live_prices(feed_ids)
                if not live_prices:
                    print("[Scheduler] Warning: No prices from oracle this cycle. Retrying.")
                    time.sleep(CHECK_INTERVAL_SECONDS)
                    continue

                # Merge live Polymarket odds for any POLYMARKET strategy this cycle. Keyed
                # polymarket:<token_id>, they slot into live_prices next to Pyth feeds; _price_for
                # and the FHE tree evaluator route by price_feed_id, so no further wiring is needed.
                poly_feeds = _collect_polymarket_feeds(strategies_to_process)
                if poly_feeds:
                    live_prices.update(get_polymarket_odds(poly_feeds))

                hl_feeds = _collect_hyperliquid_feeds(strategies_to_process)
                if hl_feeds:
                    live_prices.update(get_hyperliquid_marks(hl_feeds))

                eth_feed_id = PYTH_PRICE_FEED_IDS.get("ETH")
                sol_feed_id = PYTH_PRICE_FEED_IDS.get("SOL")
                eth_price = live_prices.get(eth_feed_id, 0)
                sol_price = live_prices.get(sol_feed_id, 0)
                print(f"[Scheduler] Arming {len(strategies_to_process)} strategies. "
                      f"ETH=${eth_price:,.2f} SOL=${sol_price:,.2f}")

                # Cache server keys per user to avoid repeated (large) lookups within a cycle.
                server_keys = {}
                # Cache the decrypt-time key-consistency gate per user per cycle (one engine+decrypt
                # canary round-trip per user, not per strategy). True = the decryptor's ClientKey is
                # proven to match this generation → safe to trust its decrypts and fire.
                canary_ok = {}

                # ── Batch pre-pass: every FHE eval of this tick in ONE engine round trip ──
                # Jobs run in parallel on the engine (one per core). batch_results is
                # {job_id: enc_hex}; None means the batch call itself failed and the loop
                # below falls back to the old per-strategy calls.
                t_batch = time.monotonic()
                prices_cents = {feed: int(round(p * 100)) for feed, p in live_prices.items()}
                batch_items = []
                now_epoch = int(time.time())
                for sd in strategies_to_process:
                    uid = sd.get('user_id')
                    if uid not in server_keys:
                        server_keys[uid] = get_server_key(uid)
                    sk = server_keys[uid]
                    if not sk or _is_expired(sd):
                        continue
                    price = _price_for(sd, live_prices, eth_feed_id, eth_price, sol_price)
                    if price is None:
                        continue
                    if sd.get('leg_count'):
                        elapsed = max(0, now_epoch - int(sd.get('schedule_anchor') or 0))
                        interval = int(sd.get('interval_sec') or 0)
                        legs = StrategyLeg.query.filter(
                            StrategyLeg.strategy_id == sd['id'],
                            StrategyLeg.status.in_(['PENDING', 'ARMED'])).all()
                        for leg in legs:
                            if (leg.eval_mode or "").lower() == "pipeline" or (
                                (leg.leg_kind or "").lower() == "pipeline" and int(leg.leg_index or 0) > 0
                            ):
                                continue
                            if _leg_not_yet_due(leg.eval_mode, leg.leg_index, interval, elapsed):
                                continue
                            lp = build_leg_payload(leg.to_dict(), price, elapsed)
                            if lp:
                                batch_items.append((f"leg:{leg.id}", lp, sk))
                    elif sd.get('condition_tree'):
                        batch_items.append((f"strat:{sd['id']}", {"tree": sd['condition_tree']}, sk))
                    else:
                        sp = build_strategy_payload(sd, price)
                        if sp:
                            batch_items.append((f"strat:{sd['id']}", sp, sk))
                batch_results = get_batch_results(batch_items, prices_cents)
                if batch_results is not None:
                    print(f"[Scheduler] Batch: {len(batch_items)} evals -> {len(batch_results)} "
                          f"results in {(time.monotonic() - t_batch) * 1000:.0f}ms")

                def _keys_consistent(uid, skey):
                    if uid in canary_ok:
                        return canary_ok[uid]
                    if not decryptor_enabled():
                        canary_ok[uid] = True
                        return True
                    canary = get_user_canary(uid)
                    if not canary:
                        # No canary → we CANNOT prove the decryptor holds this generation's ClientKey.
                        # The decryptor's own fail-closed only rejects value>1; a garbage decrypt landing
                        # on exactly 1 would still fire (this is how a LIMIT_SELL fired at $1800). FAIL
                        # CLOSED: never fire without a passing canary. The browser uploads one on every
                        # arm, so a legit user re-arms and clears this; only a stale/mismatched key stays
                        # blocked (correct — it must not fire).
                        print(f"[Scheduler] 🔒 no key-consistency canary for {uid[:10]}… — NOT firing "
                              f"(re-arm from the browser to upload one)")
                        canary_ok[uid] = False
                        return False
                    ok, err = verify_canary(uid, canary, skey)
                    if not ok:
                        print(f"[Scheduler] 🔒 key-consistency canary FAILED for {uid[:10]}… "
                              f"({err}); NOT firing this cycle — decryptor ClientKey is stale/mismatched, "
                              f"re-sync from the browser")
                    canary_ok[uid] = ok
                    return ok

                for strategy_dict in strategies_to_process:
                    sid = strategy_dict.get('id')
                    try:
                        user_id = strategy_dict.get('user_id')
                        server_key = server_keys.get(user_id)
                        if server_key is None:
                            server_key = get_server_key(user_id)
                            server_keys[user_id] = server_key
                        if not server_key:
                            print(f"[Scheduler] ⚠️ No server key for user {user_id}; skipping {sid}")
                            continue

                        # Expiry: execution window elapsed → stop firing, return unspent funds.
                        if _is_expired(strategy_dict):
                            _expire_strategy(sid)
                            continue

                        current_price = _price_for(strategy_dict, live_prices, eth_feed_id, eth_price, sol_price)
                        if current_price is None:
                            # No usable price this cycle (e.g. Polymarket odds feed unavailable) —
                            # leave the strategy as-is and retry next cycle. Never arm blind.
                            print(f"[Scheduler] ⏭ {sid}: price feed unavailable this cycle; skipping")
                            continue

                        # Multi-leg (TWAP / RANGE_GRID): evaluate + fire each leg independently.
                        if strategy_dict.get('leg_count'):
                            _process_multi_leg(strategy_dict, current_price, server_key, user_id,
                                               canary_ok=_keys_consistent(user_id, server_key),
                                               leg_results=batch_results)
                            continue

                        t_fhe = time.monotonic()
                        if batch_results is not None:
                            enc_result = batch_results.get(f"strat:{sid}")
                        else:
                            # Batch transport failed — old per-strategy path as fallback.
                            condition_tree = strategy_dict.get('condition_tree')
                            if condition_tree:
                                enc_result = evaluate_tree_encrypted(condition_tree, live_prices, server_key)
                            else:
                                enc_result = get_encrypted_result(strategy_dict, current_price, server_key)
                        fhe_ms = (time.monotonic() - t_fhe) * 1000

                        if not enc_result:
                            print(f"[Scheduler] ⚠️ No encrypted result for {sid} this cycle")
                            continue

                        strat = Strategy.query.get(sid)
                        if strat:
                            strat.encrypted_result = enc_result
                            strat.result_updated_at = datetime.utcnow()
                            if strat.status == 'PENDING':
                                strat.status = 'ARMED'
                            db.session.commit()
                        print(f"[Scheduler] [{chain_label(strategy_dict.get('from_chain'))}] Strategy {sid} armed | price={current_price:.2f} | fhe={fhe_ms:.0f}ms")

                        # Confidential VM path: decrypt result in TEE and execute server-side.
                        if decryptor_enabled() and enc_result:
                            # Gate: only trust the decrypt if the user's keys are proven one-generation
                            # this cycle. Otherwise the strategy stays ARMED (never fires garbage).
                            if not _keys_consistent(user_id, server_key):
                                continue
                            triggered, dec_err = decrypt_trigger(user_id, enc_result)
                            if dec_err:
                                if _is_key_mismatch(dec_err):
                                    # Canary passed but this strategy's bounds are a stale key
                                    # generation (user regenerated keys after arming). It can never
                                    # fire as-is; quarantine + return funds instead of re-logging
                                    # the mismatch every cycle.
                                    print(f"[Scheduler] 🔑 {sid} stranded on a stale key generation "
                                          f"(decrypt mismatch); EXPIRING — re-arm to re-encrypt bounds")
                                    _expire_strategy(sid, reason="FHE key regenerated after arming — re-arm required")
                                    continue
                                print(f"[Scheduler] Decryptor error for {sid}: {dec_err}")
                                continue
                            if not triggered:
                                continue
                            # Re-fetch row — status may have changed while we were decrypting.
                            strat = Strategy.query.get(sid)
                            if not strat or strat.status in ('EXECUTED', 'FAILED'):
                                continue
                            print(f"[Scheduler] TEE trigger=TRUE for {sid} — executing on-chain…")
                            try:
                                result = run_execution(strat.to_dict(), current_price)
                                print(f"[Scheduler] Strategy {sid} executed via TEE | {result}")
                            except Exception as exec_err:
                                print(f"[Scheduler] Execution failed for {sid}: {exec_err}")
                                # A failed fire is money not moving when the user expected it to.
                                # print() alone means nobody hears about it until someone reads
                                # this box's docker logs, which is the gap GAPS Epic 3 exists to close.
                                capture_strategy_failure(sid, "execute", exec_err)

                    except Exception as strategy_err:
                        print(f"[Scheduler] Error arming strategy {sid}: {strategy_err}")
                        capture_strategy_failure(sid, "arm", strategy_err)
                        continue

        except Exception as e:
            print(f"[Scheduler] Global loop error: {e}")
            import traceback
            traceback.print_exc()
            # The loop catches everything to stay alive; without this the whole scheduler can be
            # failing every tick and look identical to idle from the outside.
            capture_strategy_failure(None, "scheduler_loop", e)

        time.sleep(CHECK_INTERVAL_SECONDS)
