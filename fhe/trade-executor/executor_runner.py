"""Shared on-chain execution path.

With confidential-vm decryption (`DECRYPTOR_URL`), the scheduler decrypts the FHE result bit
inside the TEE and calls `run_execution()` directly. Without a decryptor, the browser decrypts
locally and authorizes via POST /executeStrategy.
"""
from __future__ import annotations  # allow `str | None` annotations on Python 3.9 (Docker base)
import json
import time
import hmac as hmac_lib
import hashlib
import os
import requests as http
from datetime import datetime

from sqlalchemy import text

from database import db, Strategy, StrategyLeg, ExecutionEvent

from trade_executor import execute_private_withdrawal
from evm_executor import execute_evm_trade, execute_evm_leg_swap, execute_shielded_swap_v4
from evm_executor import FatalExecutionError, NullifierAlreadySpentError, NullifierSpentSwapFailed


def _is_v4_proof(zkp_data) -> bool:
    """True when the browser bound this proof to a Uniswap v4 pool (venue == 'v4').

    The venue rides on the proof, not the chain: only a proof the browser built against the v4
    pool can satisfy the hook's beforeSwap verification, so anything else must take the v3 path.
    Malformed/absent zkp_data returns False — an unparseable proof falls back to v3 and fails
    there loudly rather than being handed to a hook that cannot verify it.
    """
    try:
        z = zkp_data if isinstance(zkp_data, dict) else (json.loads(zkp_data) if zkp_data else {})
        if isinstance(z.get('proof'), dict):
            z = z['proof']
        return z.get('venue') == 'v4'
    except Exception:
        return False

_HMAC_SECRET    = os.environ.get('SERVER_HMAC_SECRET', '').encode()
_API_TOKEN      = os.environ.get('API_TOKEN', '')
_TRADE_EXECUTOR = os.environ.get('TRADE_EXECUTOR_BASE_URL', 'http://localhost:5005')


def _nullifier_hmac(nullifier_hash: str) -> str:
    return hmac_lib.new(_HMAC_SECRET, nullifier_hash.encode(), hashlib.sha256).hexdigest()


def _executor_headers():
    return {'X-API-TOKEN': _API_TOKEN, 'Content-Type': 'application/json'}


def _get_nullifier_hashes(strategy_dict) -> list[str]:
    """Extract every proof nullifier for the off-chain double-spend guard."""
    zkp = strategy_dict.get('zkp_data') or strategy_dict.get('zk_proof')
    if not zkp:
        return []
    try:
        zk = zkp if isinstance(zkp, dict) else json.loads(zkp)
        hashes = zk.get('nullifierHashes')
        if hashes and isinstance(hashes, list) and len(hashes) > 0:
            return [str(value) for value in hashes if str(value)]
        nh = str(zk.get('nullifierHash') or zk.get('nullifier') or '')
        return [nh] if nh else []
    except Exception as e:
        print(f"[Executor] ⚠️ Could not parse nullifier hashes: {e}")
        return []


def _claim_nullifier(nullifier_hash: str, commitment_id: str | None) -> bool:
    """Atomically claim a nullifier in nullifier_registry. Returns True iff THIS caller won."""
    try:
        resp = http.post(
            f"{_TRADE_EXECUTOR}/nullifier-registry",
            json={'nullifier_hash': nullifier_hash, 'commitment_id': commitment_id},
            headers=_executor_headers(),
            timeout=10,
        )
        if resp.status_code == 201:
            print(f"[Executor] Nullifier claimed: {nullifier_hash[:16]}...")
            return True
        if resp.status_code == 409:
            print(f"[Executor] Nullifier already claimed (double-spend guard): {nullifier_hash[:16]}...")
            return False
        print(f"[Executor] ⚠️ Unexpected claim response {resp.status_code}: {resp.text}")
        return False
    except Exception as e:
        print(f"[Executor] ⚠️ Nullifier claim request failed: {e}")
        return False


def _mark_nullifier_spent(nullifier_hash: str):
    """Mark nullifier spent after on-chain withdraw confirms. Also flips commitment.spent."""
    try:
        resp = http.patch(
            f"{_TRADE_EXECUTOR}/nullifier-registry/{nullifier_hash}/spent",
            headers=_executor_headers(),
            timeout=10,
        )
        if resp.status_code == 200:
            print(f"[Executor] Nullifier marked spent: {nullifier_hash[:16]}...")
        else:
            print(f"[Executor] ⚠️ mark-spent response {resp.status_code}: {resp.text}")
    except Exception as e:
        print(f"[Executor] ⚠️ mark-spent request failed: {e}")


def _release_nullifier(nullifier_hash: str):
    """Release pending claim back to false when withdraw fails/reverts."""
    try:
        resp = http.patch(
            f"{_TRADE_EXECUTOR}/nullifier-registry/{nullifier_hash}/release",
            headers=_executor_headers(),
            timeout=10,
        )
        if resp.status_code == 200:
            print(f"[Executor] Nullifier released to false: {nullifier_hash[:16]}...")
        else:
            print(f"[Executor] ⚠️ release response {resp.status_code}: {resp.text}")
    except Exception as e:
        print(f"[Executor] ⚠️ release request failed: {e}")


def _claim_nullifiers(nullifier_hashes: list[str], commitment_id: str | None) -> bool:
    """Claim all proof nullifiers, rolling back earlier claims if any later claim loses."""
    claimed = []
    for index, nullifier_hash in enumerate(nullifier_hashes):
        # The legacy payload has only one commitment id. Associate it with the primary
        # nullifier; secondary hashes still receive independent registry reservations.
        linked_commitment = commitment_id if index == 0 else None
        if not _claim_nullifier(nullifier_hash, linked_commitment):
            for claimed_hash in claimed:
                _release_nullifier(claimed_hash)
            return False
        claimed.append(nullifier_hash)
    return True


def _mark_nullifiers_spent(nullifier_hashes: list[str]):
    for nullifier_hash in nullifier_hashes:
        _mark_nullifier_spent(nullifier_hash)


def _release_nullifiers(nullifier_hashes: list[str]):
    for nullifier_hash in nullifier_hashes:
        _release_nullifier(nullifier_hash)


def _reconcile_spent_nullifiers(all_hashes: list[str], spent_hashes: list[str] | None):
    """Mark only hashes confirmed spent by the vault; release every still-valid claim."""
    if spent_hashes is None:
        print("[Executor] ⚠️ Nullifier reconciliation unavailable; keeping claims pending")
        return
    spent = set(spent_hashes)
    for nullifier_hash in all_hashes:
        if nullifier_hash in spent:
            _mark_nullifier_spent(nullifier_hash)
        else:
            _release_nullifier(nullifier_hash)


def _claim_strategy(sid):
    """Atomically move a strategy ARMED/PENDING -> EXECUTING. Returns True iff THIS caller won."""
    result = db.session.execute(
        text("UPDATE strategy SET status='EXECUTING' WHERE id=:id AND status IN ('PENDING','ARMED')"),
        {"id": sid},
    )
    db.session.commit()
    return result.rowcount == 1


def run_execution(strategy_dict, current_price):
    """Execute a (browser-authorized) strategy. Returns a result dict; updates DB + nullifier.

    Returns: { "status": "EXECUTED"|"FAILED", "tx_hash": str|None }
    """
    sid        = strategy_dict['id']
    is_private = strategy_dict.get('is_private', False)

    # Solana Devnet: submit the client Groth16 spend, then swap on Meteora DLMM.
    try:
        from_cid = int(strategy_dict.get("from_chain") or strategy_dict.get("chain_id") or 0)
    except (TypeError, ValueError):
        from_cid = 0
    if from_cid == 900_002:
        from solana_devnet_strategy import run_solana_devnet_strategy

        if not _claim_strategy(sid):
            cur = Strategy.query.get(sid)
            cur_status = cur.status if cur else "<gone>"
            print(f"[Executor] Solana Devnet strategy {sid} not claimable (status={cur_status})")
            return {"status": "FAILED", "tx_hash": None}
        # Settles and records the outcome on the row (EXECUTED / SETTLING / PENDING-for-reproof /
        # ARMED-for-no-route / FAILED) — see solana_devnet_strategy._record.
        result = run_solana_devnet_strategy(strategy_dict)
        print(f"[Executor] Solana Devnet strategy {sid} {result.get('status')}: "
              f"{result.get('tx_hash') or result.get('error')}")
        return {**result, "status": result.get("status"), "tx_hash": result.get("tx_hash")}

    # Enclave-armed (v3 kernel) strategies carry no proof — see the attested branch below.
    attested = _is_attested_strategy(strategy_dict)

    # Re-check immediately before claiming the strategy or any nullifier. This independently
    # blocks old rows (which have no generation) and generations moved to EXIT_ONLY after arming.
    #
    # Skipped for attested spends, and NOT as a relaxation: every clause of this check is
    # v1-Entrypoint-shaped. It matches the claimed generation against ACTIVE_VAULT_ENTRYPOINT_*
    # and demands a proof whose root is already indexed — a v3 spend has neither, so it fails
    # closed on VAULT_GENERATION_REQUIRED / VAULT_PROOF_ROOT_UNKNOWN no matter how healthy it is.
    # (run_leg_execution never ran this check either, which is why multi-leg v3 already worked.)
    #
    # What the check buys — "a strategy armed before a cutover must not spend from a retired
    # vault" — the v3 path gets structurally instead: the kernel address comes from server config,
    # never the request, and the enclave proves against the CURRENT state root, so a note from a
    # retired generation is simply not in the tree and cannot produce a valid proof.
    from vault_generation import (
        generation_decision,
        validate_strategy_provenance,
        strategy_generation_message,
    )
    generation_result = generation_decision(strategy_dict, validate_strategy_provenance)
    if not generation_result["ok"]:
        code = generation_result["code"]
        print(f"[Executor] Strategy {sid} blocked by vault generation policy: {code}")
        return {
            "status": "FAILED",
            "tx_hash": None,
            "error_code": code,
            "error": strategy_generation_message(code),
        }

    # POLYMARKET / HYPERLIQUID: only execute when venue rails are configured. Otherwise leave
    # ARMED (no withdraw) so we never spend a note we can't place an order with.
    if strategy_dict.get('strategy_type') == 'POLYMARKET':
        import polymarket_client
        if not polymarket_client.is_configured():
            print(f"[Executor] POLYMARKET {sid} triggered but CLOB not configured — leaving ARMED (no withdraw).")
            return {"status": "PENDING", "tx_hash": None}
    if strategy_dict.get('strategy_type') == 'HYPERLIQUID':
        import hyperliquid_client
        if not hyperliquid_client.is_configured():
            print(f"[Executor] HYPERLIQUID {sid} triggered but HL not configured — leaving ARMED (no withdraw).")
            return {"status": "PENDING", "tx_hash": None}

    # commitment_id is included by the browser in the strategy payload so the executor
    # can mark the right commitments row spent after confirmation.
    commitment_id   = strategy_dict.get('commitment_id')
    nullifier_hashes = _get_nullifier_hashes(strategy_dict) if is_private else []

    # ── Strategy-level atomic guard ──
    if not _claim_strategy(sid):
        cur = Strategy.query.get(sid)
        cur_status = cur.status if cur else '<gone>'
        print(f"[Executor] Strategy {sid} not claimable (status={cur_status}) — another executor owns it; aborting")
        return {"status": "FAILED", "tx_hash": None}

    # ── Atomic nullifier claim via nullifier_registry ──
    if nullifier_hashes:
        if not _claim_nullifiers(nullifier_hashes, commitment_id):
            print(f"[Executor] Strategy {sid} — a nullifier is already claimed, aborting double-spend")
            _mark_failed(sid)
            return {"status": "FAILED", "tx_hash": None}

    # Callback fired the instant the ZK withdraw receipt confirms on-chain.
    def _on_withdraw_confirmed(_tx_hash):
        if nullifier_hashes:
            _mark_nullifiers_spent(nullifier_hashes)

    # Enclave-armed (v3 kernel) SINGLE-leg strategy — same discriminator as the multi-leg path:
    # no proof, because the circuit binds the ASP roots and one built at arming is stale by the
    # time the trigger fires. The enclave keys armed legs by (strategyId, legIndex), so a single
    # strategy is simply leg 0. _execute_attested_leg is REUSED rather than duplicated, which keeps
    # the nullifier-claim ordering, the vault-output precommitment refusal, and the attestation
    # margin check identical across both shapes.
    if attested:
        synthetic_leg = {
            'id': sid,
            'leg_index': 0,
            'output_precommitment': strategy_dict.get('output_precommitment'),
            'commitment_id': commitment_id,
        }
        outcome = _execute_attested_leg(synthetic_leg, strategy_dict)

        if outcome["status"] == "RETRY":
            attempts = _bump_prove_attempts(sid, single=True)
            if attempts >= MAX_PROVE_ATTEMPTS:
                # Every attempt is a full ASP sync + Groth16 on 2 vCPUs. Something a retry will not
                # fix; left alone it would consume the enclave every tick forever.
                print(f"[Executor] strategy {sid} gave up after {attempts} prove attempts")
                _mark_failed(sid, f"could not prove after {attempts} attempts")
                _disarm_leg_quietly(_arm_key(strategy_dict), 0)
                return {"status": "FAILED", "tx_hash": None}
            # _claim_strategy moved this to EXECUTING and the scheduler only picks up
            # PENDING/ARMED. Without this reset a transient ASP hiccup strands it forever.
            strat = Strategy.query.get(sid)
            if strat:
                strat.status = 'ARMED'
                db.session.commit()
            return {"status": "RETRY", "tx_hash": None}

        if outcome["status"] == "WAIT":
            # A payout with no route yet, or a spend the bridge worker is still settling. Nothing
            # was proved or spent, so it costs no attempt — it re-checks next tick, until expiry.
            strat = Strategy.query.get(sid)
            if strat:
                strat.status = 'ARMED'
                db.session.commit()
            return outcome

        if outcome["status"] == "EXECUTED":
            strat = Strategy.query.get(sid)
            if strat:
                strat.status = 'EXECUTED'
                strat.tx_hash = outcome.get("tx_hash")
                strat.executed_at = datetime.utcnow()
                db.session.commit()
            print(f"[Executor] Strategy {sid} EXECUTED (attested): {outcome.get('tx_hash')}")
        else:
            _mark_failed(sid, "attested spend failed")
        # Terminal either way: the enclave holds sealed secrets for a spend that will never fire
        # again. Dropping them is the whole point of /spend/disarm.
        _disarm_leg_quietly(_arm_key(strategy_dict), 0)
        return outcome

    t_exec = time.monotonic()
    try:
        if _is_v4_proof(strategy_dict.get('zkp_data')):
            # v4-bound proof: fire it atomically through the hook — no v3 withdraw, no custody window.
            tx_hash = execute_shielded_swap_v4(
                strategy_dict, current_price, on_withdraw_confirmed=_on_withdraw_confirmed
            )
        elif strategy_dict.get('strategy_type') == 'POLYMARKET':
            # Shielded withdraw (Base) → bridge to Polygon → CLOB order → position row.
            from polymarket_executor import execute_polymarket_entry
            tx_hash = execute_polymarket_entry(
                strategy_dict, current_price, on_withdraw_confirmed=_on_withdraw_confirmed
            )
        elif strategy_dict.get('strategy_type') == 'HYPERLIQUID':
            # Perps fire only as enclave-armed payouts (the attested branch above), then
            # hyperliquid_watcher opens the position. A row carrying a client proof predates that.
            raise FatalExecutionError("Hyperliquid orders arm through the v5 enclave — re-arm this order")
        elif is_private:
            tx_hash = execute_private_withdrawal(
                strategy_dict, current_price, on_withdraw_confirmed=_on_withdraw_confirmed
            )
        else:
            # EVM-only: non-private strategies execute directly from the executor wallet on the
            # strategy's EVM chain (no Solana path).
            tx_hash = execute_evm_trade(strategy_dict, current_price)

    except NullifierSpentSwapFailed as swap_fatal:
        print(f"[Executor] ⚠️  ZK withdraw confirmed but swap failed for {sid}: {swap_fatal}")
        _mark_failed(sid, swap_fatal)
        # Nullifier IS spent on-chain — mark it; do NOT release.
        if nullifier_hashes:
            _mark_nullifiers_spent(nullifier_hashes)
        return {"status": "FAILED", "tx_hash": None}

    except NullifierAlreadySpentError as spent_fatal:
        print(f"[Executor] ❌ Fatal error for {sid}: {spent_fatal}")
        _mark_failed(sid, spent_fatal)
        _reconcile_spent_nullifiers(nullifier_hashes, spent_fatal.spent_hashes)
        return {"status": "FAILED", "tx_hash": None}

    except FatalExecutionError as fatal:
        print(f"[Executor] ❌ Fatal error for {sid}: {fatal}")
        _mark_failed(sid, fatal)
        if nullifier_hashes:
            # Withdraw never confirmed — release claim so note is spendable again.
            _release_nullifiers(nullifier_hashes)
        return {"status": "FAILED", "tx_hash": None}

    exec_ms = (time.monotonic() - t_exec) * 1000
    print(f"[Executor] Execution took {exec_ms:.0f}ms | tx_hash={tx_hash}")

    if tx_hash:
        strat = Strategy.query.get(sid)
        if strat:
            strat.status     = 'EXECUTED'
            strat.tx_hash    = tx_hash
            strat.executed_at = datetime.utcnow()
            if strat.billing_ref:
                existing = ExecutionEvent.query.filter_by(tx_hash=tx_hash).first()
                if not existing:
                    event = ExecutionEvent(
                        strategy_id=sid,
                        tx_hash=tx_hash,
                        billing_ref=strat.billing_ref
                    )
                    db.session.add(event)
            db.session.commit()
            print(f"[Executor] Strategy {sid} EXECUTED: {tx_hash}")

        # Belt-and-suspenders: ensure spent for non-ZK path (confirm callback didn't fire).
        if nullifier_hashes:
            _mark_nullifiers_spent(nullifier_hashes)
        return {"status": "EXECUTED", "tx_hash": tx_hash}

    # No tx hash and withdraw never confirmed — release nullifier so user can retry.
    if nullifier_hashes:
        _release_nullifiers(nullifier_hashes)
    return {"status": "FAILED", "tx_hash": None}


def _mark_failed(sid, reason=None):
    strat = Strategy.query.get(sid)
    if strat:
        strat.status = 'FAILED'
        if reason:
            # Keep bounded structured recovery metadata so operators can recover exact
            # custody state after a restart; never automatically retry the on-chain leg.
            payload = {"message": str(reason)}
            for attr, key in (
                ("stage", "stage"),
                ("asset", "asset"),
                ("amount_wei", "amount_wei"),
                ("tx_hash", "prior_tx_hash"),
            ):
                value = getattr(reason, attr, None)
                if value is not None:
                    payload[key] = value
            strat.execution_error = json.dumps(payload, sort_keys=True)[:8000]
        db.session.commit()


# ---------------------------------------------------------------------------------------------
#  Per-leg execution (TWAP slice / grid rung)
# ---------------------------------------------------------------------------------------------

def _claim_leg(leg_id):
    """Atomically move a leg ARMED/PENDING -> EXECUTING. Returns True iff THIS caller won."""
    result = db.session.execute(
        text("UPDATE strategy_legs SET status='EXECUTING' WHERE id=:id AND status IN ('PENDING','ARMED')"),
        {"id": leg_id},
    )
    db.session.commit()
    return result.rowcount == 1


def _mark_leg(leg_id, status, tx_hash=None):
    leg = StrategyLeg.query.get(leg_id)
    if leg:
        leg.status = status
        if tx_hash:
            leg.tx_hash = tx_hash
        if status == 'EXECUTED':
            leg.executed_at = datetime.utcnow()
            strat = leg.strategy
            if strat and strat.billing_ref and tx_hash:
                existing = ExecutionEvent.query.filter_by(tx_hash=tx_hash).first()
                if not existing:
                    event = ExecutionEvent(
                        strategy_id=leg.strategy_id,
                        tx_hash=tx_hash,
                        billing_ref=strat.billing_ref
                    )
                    db.session.add(event)
        db.session.commit()



# --------------------------------------------------------------------------- v3 attested legs

# Give-up threshold for fire-time proving. Each attempt costs a full ASP sync plus a Groth16 proof
# on a 2-vCPU CVM, so this bounds how much of the enclave one wedged leg can consume.
MAX_PROVE_ATTEMPTS = int(os.getenv("MAX_PROVE_ATTEMPTS", "10"))

# Refuse to submit an attestation with less than this left. The hub checks expiry at MINING time,
# so a signature with seconds on it is a paid-for revert.
ATTESTATION_MIN_MARGIN_SECS = int(os.getenv("ATTESTATION_MIN_MARGIN_SECS", "30"))


# Owned by vault_generation: the policy and the definition of who it applies to have to move
# together. They were separate once, and the arming gate in app.py went on rejecting v3 strategies
# for a full release after the execution gate here learned to exempt them.
from vault_generation import (  # noqa: E402
    is_attested_strategy as _is_attested_strategy,
    strategy_chain_id as _strategy_chain_id,
)


def _bump_prove_attempts(row_id, *, single: bool = False) -> int:
    """Increment and return the fire-time prove counter for a leg, or for a single strategy.

    Both shapes re-prove in the enclave on every tick, so both need the same bound — a single-leg
    limit order can wedge the CVM exactly as a TWAP slice can. The counter lives on whichever row
    actually exists: multi-leg strategies have a strategy_legs row, single ones do not.
    """
    table, model = ("strategy", Strategy) if single else ("strategy_legs", StrategyLeg)
    db.session.execute(
        text(f"UPDATE {table} SET prove_attempts = COALESCE(prove_attempts, 0) + 1 WHERE id=:id"),
        {"id": row_id},
    )
    db.session.commit()
    row = model.query.get(row_id)
    return (row.prove_attempts or 0) if row else 0


def _groth16_flat(proof) -> list:
    """The enclave's proof as the `uint256[8]` the kernel's verifier expects.

    The enclave returns snarkjs' native shape — `{pi_a, pi_b, pi_c}` — because that is what its
    prover script emits verbatim. Iterating that dict yielded the KEYS, so the submission died on
    `int('pi_a', 0)` with the nullifiers already claimed.

    The G2 element is coordinate-SWAPPED on the way out. snarkjs orders pi_b as [x0, x1] while the
    Solidity pairing expects [x1, x0]; this is the same transform the browser applies in
    v3/spendActionsV3.proofToCalldata for this very verifier. Getting it wrong does not raise — it
    produces a well-formed proof that simply fails verification on-chain, after gas.
    """
    if isinstance(proof, dict) and "pi_a" in proof:
        a, b, c = proof["pi_a"], proof["pi_b"], proof["pi_c"]
        flat = [a[0], a[1], b[0][1], b[0][0], b[1][1], b[1][0], c[0], c[1]]
    elif isinstance(proof, (list, tuple)):
        flat = list(proof)
    else:
        raise ValueError(f"unrecognised proof shape from the enclave: {type(proof).__name__}")
    return [int(str(x), 0) if isinstance(x, str) else int(x) for x in flat]


def _arm_key(strategy_dict) -> str:
    """The id the enclave keys this strategy's armed legs by.

    NOT the row id. The browser seals its legs to the enclave BEFORE createStrategy exists to mint
    a row id, so it arms under an id of its own and reports it back as `arm_strategy_id`. Proving
    by row id found no armed leg and the strategy sat PENDING until it expired.

    Falls back to the row id so a non-attested caller — and any row predating the column — behaves
    exactly as before; only the enclave paths read this.
    """
    return str(strategy_dict.get('arm_strategy_id') or strategy_dict['id'])


def _disarm_leg_quietly(strategy_id, leg_index):
    """Drop a terminal leg's sealed secrets from the enclave.

    Best-effort on purpose: the leg is already finished, and failing to disarm must never turn a
    successful execution into a reported failure. But it must be ATTEMPTED on every terminal path —
    the enclave mirrors sealed legs to its encrypted volume, so secrets for legs that will never
    fire otherwise accumulate on the same 20GB disk that holds every user's ClientKey.
    """
    if leg_index is None:
        return
    try:
        from decryptor_client import decryptor_enabled, disarm_spend_leg
        if not decryptor_enabled():
            return
        err = disarm_spend_leg(strategy_id, leg_index)
        if err:
            print(f"[Executor] disarm {strategy_id}:{leg_index} failed (non-fatal): {err}")
    except Exception as exc:
        print(f"[Executor] disarm {strategy_id}:{leg_index} errored (non-fatal): {exc}")


def _execute_attested_leg(leg_dict, strategy_dict):
    """Fire one enclave-armed leg: prove inside the CVM, then submit VaultKernel.spendAttested.

    Returns { "status": "EXECUTED"|"FAILED"|"RETRY"|"WAIT", "tx_hash": str|None }.

    WAIT is a payout strategy (output_mode='bridge') with no route that clears its floor right now,
    or one whose earlier spend the bridge worker is still settling. Nothing was proved or spent.

    RETRY is a real outcome here, distinct from FAILED. The commonest transient is the ASP snapshot
    moving between the enclave's sync and its check; the leg is still armed and still valid, so the
    next tick simply re-proves. Marking that FAILED would burn a leg the user paid an arming fee for.

    Ordering note — nullifiers are claimed AFTER proving, unlike every other leg shape. A v2 leg
    carries a browser-built proof, so its nullifier hashes are known before execution starts. An
    enclave-armed leg has no proof until the trigger fires, so the hashes do not exist until the
    enclave returns them in publicSignals. Claiming earlier is impossible; claiming later than the
    submission would leave a double-spend window.
    """
    from decryptor_client import prove_spend_leg
    from evm_chain_config import get_evm_chain_config
    from evm_executor import (
        get_web3, get_executor_account, vault_kernel_spend_attested,
        SPEND_PUBLIC_WIDTH,
    )

    sid = strategy_dict['id']
    leg_index = leg_dict.get('leg_index')
    leg_id = leg_dict['id']

    # A vault-output leg re-shields its proceeds into a note owned by `output_precommitment`. The
    # browser records the matching {nullifier, secret} when it arms; without that row the note is
    # on-chain but unresolvable — funds correctly shielded and permanently invisible. The v2 path
    # refuses this case (evm_executor.py::execute_evm_trade), so the v3 path must too. The executor
    # cannot write the row itself: precommitments are posted by the browser, under the user's key.
    if (strategy_dict.get('output_mode') or 'vault').lower() == 'vault' \
            and not leg_dict.get('output_precommitment'):
        print(f"[Executor] ❌ leg {leg_id}: output_mode=vault but no output_precommitment — "
              f"refusing to mint a note nothing can resolve")
        return {"status": "FAILED", "tx_hash": None}

    # Payout: the leg is a WITHDRAW to this executor, and its receipt funds a BridgeOrder that
    # bridge_payout's worker forwards through LI.FI (or refunds on this chain).
    payout = strategy_dict.get('payout')
    order = fire = None
    if payout:
        import bridge_payout
        from database import BridgeOrder

        prior = (BridgeOrder.query.filter_by(strategy_id=sid)
                 .order_by(BridgeOrder.created_at.desc()).first())
        if prior is not None and prior.status != 'FAILED':
            # An earlier tick already broadcast this strategy's spend and lost track of it. The
            # order is the bridge worker's now: wait while it settles, never prove a second one.
            if prior.status == 'RELAYING':
                return {"status": "WAIT", "tx_hash": None}
            return {"status": "EXECUTED", "tx_hash": prior.spend_tx}
        chain_id = _strategy_chain_id(strategy_dict)
        chain = get_evm_chain_config(chain_id)
        w3 = get_web3(chain)
        account = get_executor_account(w3, chain_id)
        try:
            fire = bridge_payout.fire_check(chain_id, payout, strategy_dict, account.address)
        except Exception as exc:
            print(f"[Executor] leg {leg_id}: payout to {payout.get('to_chain_id')} not routable yet "
                  f"({exc}) — leaving armed")
            return {"status": "WAIT", "tx_hash": None}

    result, err = prove_spend_leg(_arm_key(strategy_dict), leg_index)
    if err:
        if err.startswith("retryable:"):
            print(f"[Executor] leg {leg_id} prove deferred ({err}) — leaving armed for the next tick")
            return {"status": "RETRY", "tx_hash": None}
        print(f"[Executor] ❌ leg {leg_id} prove failed: {err}")
        return {"status": "FAILED", "tx_hash": None}

    public_inputs = [int(str(x), 0) if isinstance(x, str) else int(x)
                     for x in result["publicSignals"]]
    if len(public_inputs) != SPEND_PUBLIC_WIDTH:
        print(f"[Executor] ❌ leg {leg_id}: enclave returned {len(public_inputs)} limbs, "
              f"expected {SPEND_PUBLIC_WIDTH}")
        return {"status": "FAILED", "tx_hash": None}

    # Limbs 9..9+inputCount are the nullifier hashes (spend-core public.rs::to_bn254_limbs).
    # Slots beyond inputCount are zero padding and must not be claimed — claiming a zero would
    # collide across every leg that spends fewer than six notes.
    input_count = public_inputs[1]
    if not 1 <= input_count <= 6:
        print(f"[Executor] ❌ leg {leg_id}: implausible inputCount {input_count}")
        return {"status": "FAILED", "tx_hash": None}
    nullifier_hashes = [str(public_inputs[9 + i]) for i in range(input_count)]

    if not _claim_nullifiers(nullifier_hashes, leg_dict.get('commitment_id')):
        print(f"[Executor] leg {leg_id} — a nullifier is already claimed, aborting double-spend")
        return {"status": "FAILED", "tx_hash": None}

    # The hub reverts if the attestation has expired at MINING time, not submission time, so a
    # signature with seconds left is a near-certain wasted transaction. Bail out while the leg is
    # still cleanly retryable rather than paying gas to learn the same thing on-chain.
    expiry = int(result["attestationExpiry"])
    remaining = expiry - int(time.time())
    if remaining < ATTESTATION_MIN_MARGIN_SECS:
        _release_nullifiers(nullifier_hashes)
        print(f"[Executor] leg {leg_id}: attestation has {remaining}s left "
              f"(< {ATTESTATION_MIN_MARGIN_SECS}s margin) — re-proving next tick")
        return {"status": "RETRY", "tx_hash": None}

    if payout:
        native = fire["token"] == bridge_payout.NATIVE
        asset = chain.weth if native else fire["token"]
        payee = str(result["rawPayee"]).removeprefix("0x").lower()
        # The order is funded by what this proof pays THIS executor. A leg armed as anything else
        # would fund nothing, or pay someone else while an order promised a payout.
        if public_inputs[0] != 0 or payee != account.address.lower()[2:] \
                or public_inputs[17] != int(asset, 16):
            _release_nullifiers(nullifier_hashes)
            print(f"[Executor] ❌ leg {leg_id}: payout leg is not a withdraw of {asset} to this "
                  f"executor — refusing")
            return {"status": "FAILED", "tx_hash": None}
        amount = public_inputs[5]
        min_out = bridge_payout.fire_min_out(
            fire["quote"], amount / 10 ** fire["decimals"] * fire["price"], payout["slippage_bps"])
        # Written before the broadcast, with the spend hash saved before it leaves (on_prepared):
        # a crash anywhere after this leaves the worker enough to finish or refund.
        order = BridgeOrder(
            strategy_id=sid, wallet=strategy_dict.get('user_id'), chain_id=chain_id,
            token=fire["token"], to_chain_id=str(payout["to_chain_id"]), to_token=payout["to_token"],
            to_address=payout["to_address"], min_out=str(min_out),
            refund_address=payout["refund_address"], status='RELAYING',
        )
        db.session.add(order)
        db.session.commit()

    try:
        raw_payee = bytes.fromhex(str(result["rawPayee"]).removeprefix("0x"))
        attester_sig = bytes.fromhex(str(result["attesterSig"]).removeprefix("0x"))
        splits = [int(str(x), 0) if isinstance(x, str) else int(x)
                  for x in (result.get("splitCommitments") or [])]

        chain_id = _strategy_chain_id(strategy_dict)
        chain = get_evm_chain_config(chain_id)
        w3 = get_web3(chain)
        account = get_executor_account(w3, chain_id)
        # The compliance half — COMPLIANCE_CIRCUIT_SPLIT §2.2. The enclave proves both halves from
        # one witness and refuses to return either unverified, so a genuinely absent compliance
        # proof means the CVM is running a pre-split image; relaying zeros would revert on-chain as
        # LabelCommitMismatch and read as a proving fault rather than a stale deployment.
        #
        # The keys are FLAT and camelCase because that is what `/spend/prove` actually emits
        # (decryptor/src/main.rs). This read a nested `result["compliance"]["proof"]` that the
        # decryptor has never sent, so a fully split-capable enclave still tripped the guard below
        # — and the error accused the CVM of being stale, which is the one thing it was not.
        compliance_proof = result.get("complianceProof")
        compliance_signals = result.get("compliancePublicSignals")
        if not compliance_proof or not compliance_signals:
            raise ValueError(
                "enclave returned no compliance proof — the CVM image predates the split "
                "(expects compliance1..compliance6 artifacts)"
            )
        compliance_publics = [int(str(x), 0) if isinstance(x, str) else int(x)
                              for x in compliance_signals]

        tx_hash = vault_kernel_spend_attested(
            w3, account, chain,
            public_inputs=public_inputs,
            proof=_groth16_flat(result["proof"]),
            compliance_public_inputs=compliance_publics,
            compliance_proof=_groth16_flat(compliance_proof),
            raw_payee=raw_payee,
            attestation_expiry=expiry,
            attester_sig=attester_sig,
            split_commitments=splits,
            on_prepared=(lambda h, _raw: bridge_payout._save(order, spend_tx=bridge_payout._hex(h)))
            if order is not None else None,
        )
    except Exception as exc:
        if order is not None and order.spend_tx:
            settled = _settle_payout_spend(order, w3, account, nullifier_hashes)
            if settled:
                return settled
            # Broadcast, outcome unknown. Releasing the nullifiers or re-proving could pay twice;
            # the bridge worker settles the order from its receipt and the next tick follows it.
            print(f"[Executor] leg {leg_id}: payout spend {order.spend_tx} broadcast but unconfirmed "
                  f"({exc}) — the bridge worker settles it")
            return {"status": "WAIT", "tx_hash": None}
        if order is not None:
            db.session.delete(order)  # never broadcast: no funds, no order
            db.session.commit()
        # The proof never reached the chain, so the notes are unspent. Release the claim or the
        # leg is stranded behind its own reservation for good.
        _release_nullifiers(nullifier_hashes)
        print(f"[Executor] ❌ leg {leg_id} spendAttested failed: {exc}")
        # RETRY, not FAILED. Nothing was spent, the leg is still valid, and the commonest causes
        # here are transient — a nonce race, a gas estimate, an RPC blip. FAILED is terminal and
        # DISARMS the leg, which destroys secrets the user paid an arming fee for and cannot
        # recreate; that is exactly what a proof-shape bug in this block cost once. Retries are
        # bounded by MAX_PROVE_ATTEMPTS, so a genuinely broken leg still stops.
        return {"status": "RETRY", "tx_hash": None}

    if not tx_hash:
        _release_nullifiers(nullifier_hashes)
        return {"status": "FAILED", "tx_hash": None}

    _mark_nullifiers_spent(nullifier_hashes)
    if order is not None:
        try:
            bridge_payout.mark_received(order, w3, w3.eth.get_transaction_receipt(tx_hash), account.address)
        except Exception as exc:
            print(f"[Executor] leg {leg_id}: payout receipt read failed ({exc}) — the bridge worker "
                  f"settles it")
    return {"status": "EXECUTED", "tx_hash": tx_hash}


def _settle_payout_spend(order, w3, account, nullifier_hashes):
    """A payout spend raised after broadcast: settle it from its receipt if the chain already knows.

    Returns the leg outcome, or None while the receipt is unknown (the worker takes over).
    """
    import bridge_payout

    try:
        r = bridge_payout._receipt(w3, order.spend_tx)
    except Exception:
        return None
    if r is None:
        return None
    if r["status"] != 1:
        # Reverted: nothing left the vault. Close the order and free the notes for a re-prove.
        bridge_payout.mark_received(order, w3, r, account.address)
        _release_nullifiers(nullifier_hashes)
        return {"status": "RETRY", "tx_hash": None}
    _mark_nullifiers_spent(nullifier_hashes)
    bridge_payout.mark_received(order, w3, r, account.address)
    return {"status": "EXECUTED", "tx_hash": order.spend_tx}


def run_leg_execution(leg_dict, strategy_dict, current_price):
    """Execute ONE leg of a multi-leg strategy on-chain.

    A leg is structurally identical to a single-strategy trade — spend exactly one (slice) note
    and swap — so it reuses the full `execute_evm_trade` withdraw→swap→(vault re-deposit) path,
    but with the LEG's own amount, ZK proof, and nullifier. N legs therefore yield N independent
    withdraw+swap txs with N distinct nullifiers; one note is never spent twice.

    Returns { "status": "EXECUTED"|"FAILED", "tx_hash": str|None }.
    """
    leg_id = leg_dict['id']
    sid    = strategy_dict['id']

    # Per-leg atomic guard (prevents two cycles firing the same leg).
    if not _claim_leg(leg_id):
        print(f"[Executor] Leg {leg_id} not claimable — another cycle owns it; aborting")
        return {"status": "FAILED", "tx_hash": None}

    # Solana Devnet leg: its own slice note, client-proved to the settlement wallet, settled on
    # Meteora with the output returned to the vault. Records its own outcome on the leg row.
    if str(strategy_dict.get('from_chain')) == '900002':
        from solana_devnet_strategy import settle_leg_row
        result = settle_leg_row(leg_id, strategy_dict)
        if result.get("status") == "FAILED":
            _mark_failed(sid, f"leg {leg_dict.get('leg_index')}: {result.get('error')}")
        return {"status": result.get("status"), "tx_hash": result.get("tx_hash")}

    # Enclave-armed (v3 kernel) legs carry no proof: the browser sealed the note secrets to the
    # CVM and the proof is built when the trigger fires, because the circuit binds the ASP roots
    # and an arming-time proof is stale by then. Every other leg shape requires zkp_data and would
    # fail immediately without it, so its absence is an unambiguous discriminator.
    if not (leg_dict.get('zkp_data') or leg_dict.get('zk_proof')):
        outcome = _execute_attested_leg(leg_dict, strategy_dict)

        if outcome["status"] == "RETRY":
            attempts = _bump_prove_attempts(leg_id)
            if attempts >= MAX_PROVE_ATTEMPTS:
                # Every attempt is a full ASP sync + Groth16 on 2 vCPUs. A leg that has failed this
                # many times is wedged on something a retry will not fix (misconfigured kernel,
                # stale attester epoch, an ASP that never catches up), and left alone it would
                # consume the enclave every tick forever.
                print(f"[Executor] leg {leg_id} gave up after {attempts} prove attempts")
                _mark_leg(leg_id, 'FAILED')
                _mark_failed(sid, f"could not prove after {attempts} attempts")
                _disarm_leg_quietly(_arm_key(strategy_dict), leg_dict.get('leg_index'))
                return {"status": "FAILED", "tx_hash": None}
            # _claim_leg moved this to EXECUTING, and the scheduler only ever picks up
            # PENDING/ARMED. Without this reset a transient ASP hiccup strands the leg forever.
            _mark_leg(leg_id, 'ARMED')
            return {"status": "RETRY", "tx_hash": None}
        if outcome["status"] == "WAIT":
            _mark_leg(leg_id, 'ARMED')
            return outcome

        _mark_leg(leg_id, outcome["status"], tx_hash=outcome.get("tx_hash"))
        if outcome["status"] == "FAILED":
            _mark_failed(sid, "attested leg execution failed")
        # Terminal either way: the enclave is holding sealed note secrets for a leg that will
        # never fire again. Dropping them is the whole point of /spend/disarm.
        _disarm_leg_quietly(_arm_key(strategy_dict), leg_dict.get('leg_index'))
        return outcome

    nullifier_hashes = _get_nullifier_hashes(leg_dict)  # reads leg_dict['zkp_data']

    # Atomic nullifier claim (double-spend guard, same registry as single-strategy path).
    if nullifier_hashes:
        if not _claim_nullifiers(nullifier_hashes, leg_dict.get('commitment_id')):
            print(f"[Executor] Leg {leg_id} — a nullifier is already claimed, aborting double-spend")
            _mark_leg(leg_id, 'FAILED')
            return {"status": "FAILED", "tx_hash": None}

    def _on_withdraw_confirmed(_tx_hash):
        if nullifier_hashes:
            _mark_nullifiers_spent(nullifier_hashes)

    # Synthesize a single-trade strategy dict from parent + this leg. Prefer atomic
    # swapAndDeposit when zkp_data is a swap proof (execute_evm_trade branches); else legacy withdraw path.
    leg_strategy = dict(strategy_dict)
    leg_zk = leg_dict.get('zkp_data') or leg_dict.get('zk_proof')
    leg_strategy.update({
        'amount':   leg_dict['amount'],
        'zkp_data': leg_zk,
        'output_mode': (strategy_dict.get('output_mode') or 'vault'),
        'output_precommitment': leg_dict.get('output_precommitment'),
        'is_private': True,
    })

    t_exec = time.monotonic()
    try:
        # Two leg shapes. v4 (venue=='v4'): zkp_data is a 9-signal SWAP proof bound to the v4 pool;
        # the hook verifies it inside the swap, burns the nullifier and re-shields the output in one
        # atomic tx. v3 (legacy): a single-slice WITHDRAW proof — withdraw → swap → re-deposit.
        # Either way N legs ⇒ N distinct nullifiers, so a note is never spent twice.
        if _is_v4_proof(leg_zk):
            tx_hash = execute_shielded_swap_v4(
                leg_strategy, current_price, on_withdraw_confirmed=_on_withdraw_confirmed
            )
        else:
            tx_hash = execute_evm_trade(
                leg_strategy, current_price, on_withdraw_confirmed=_on_withdraw_confirmed
            )
    except NullifierSpentSwapFailed as swap_fatal:
        print(f"[Executor] ⚠️  leg {leg_id}: withdraw confirmed but swap failed: {swap_fatal}")
        _mark_leg(leg_id, 'FAILED')
        _mark_failed(sid, swap_fatal)
        if nullifier_hashes:
            _mark_nullifiers_spent(nullifier_hashes)  # spent on-chain — never reuse
        return {"status": "FAILED", "tx_hash": None}
    except NullifierAlreadySpentError as spent_fatal:
        print(f"[Executor] ❌ leg {leg_id} fatal: {spent_fatal}")
        _mark_leg(leg_id, 'FAILED')
        _mark_failed(sid, spent_fatal)
        _reconcile_spent_nullifiers(nullifier_hashes, spent_fatal.spent_hashes)
        return {"status": "FAILED", "tx_hash": None}
    except FatalExecutionError as fatal:
        print(f"[Executor] ❌ leg {leg_id} fatal: {fatal}")
        _mark_leg(leg_id, 'FAILED')
        _mark_failed(sid, fatal)
        if nullifier_hashes:
            _release_nullifiers(nullifier_hashes)
        return {"status": "FAILED", "tx_hash": None}

    exec_ms = (time.monotonic() - t_exec) * 1000
    print(f"[Executor] Leg {leg_id} took {exec_ms:.0f}ms | tx_hash={tx_hash}")

    if tx_hash:
        _mark_leg(leg_id, 'EXECUTED', tx_hash=tx_hash)
        if nullifier_hashes:
            _mark_nullifiers_spent(nullifier_hashes)
        return {"status": "EXECUTED", "tx_hash": tx_hash}

    _mark_leg(leg_id, 'FAILED')
    if nullifier_hashes:
        _release_nullifiers(nullifier_hashes)
    return {"status": "FAILED", "tx_hash": None}
