# Gateway hardening TODOs (post-v1)

Tracked follow-ups that are deliberate deferrals, not oversights.

## ~~rate-limit-backup — Redis-outage resilience for rate limiting~~ — DONE 2026-08-20

**Status:** closed · **Raised:** 2026-07-22 (found during live E2E) · **Closed:** 2026-08-20

**What shipped:** `app/deps/rate_limit.py` now falls back to an in-process fixed-window bucket
(`_fallback_allow`) whenever Redis raises, for **every** class. A cap is always enforced.

Note the doc was stale when this was picked up: it described a *uniform* fail-open, but the code had
already moved `proof` to fail-CLOSED. That was worse than described in one direction — a Redis blip
denied **every** proof/withdraw request outright — and unchanged in the other, since `read`/`validate`
were still completely unthrottled during an outage. The fallback removes both edges.

* per-worker fixed window, so the effective cluster-wide cap during an outage is `capacity × workers`
  — deliberate; an approximate limit that always holds beats no limit or a total outage
* `fail_closed` (still set for `proof`) now only decides behaviour if the in-memory fallback itself
  cannot be consulted, which is close to unreachable
* logs carry the `rate_limiter_degraded` marker plus `extra={"event": ...}` for ops alerting
* pinned by `tests/integration/test_rate_limit_degraded.py` (renamed from `test_rate_limit_fail_open.py`)

**Remaining (low priority):** if outage-window over-admission is ever measured to matter, replace the
per-worker bucket with a shared secondary store.

---

## ~~credit-ledger — billing derived from audit-log JSON~~ — DONE 2026-08-20

`GET /v1/account/usage` computed `granted_credit_minor` by Python-summing
`audit_log.detail->>'amount_minor'` at read time, making customer balances depend on audit-log
retention. Replaced with the typed append-only `credit_ledger` table (migration `0003`);
`api_keys.balance_minor` is now a materialized cache of `SUM(amount_minor)`, and both `credit_service.grant`
and `key_purchase.purchase_key` post through `credit_service.post_entry`. `verify_balance()` exposes
cache-vs-ledger drift. Pinned by `tests/test_credit_ledger_and_limiter.py`, including a test that
deletes every audit row and asserts balances are unchanged.

---

## ~~claim-recovery — plaintext API key on disk~~ — REMOVED 2026-08-20

`POST /v1/keys/claim-recovery` read a live API key in plaintext from `.recovered_api_key.txt` in the
app directory. Keys are stored only as HMAC hashes, so "recovery" required writing the secret to
disk, where any backup, log shipper, or image layer could pick it up. The endpoint had **zero
callers** (no dapp, no SDK, no test) and was deleted along with the file path. A lost key is replaced
by purchasing a new one, never recovered.

---

## ~~wallet-nonce — advisory, not binding~~ — DONE 2026-08-20

When `X-Nonce` was present but the signature did not cover the nonce-suffixed message,
`check_wallet_sig` silently fell back to verifying the nonce-less message. Any caller could staple an
arbitrary nonce onto a signature that never committed to one, so the nonce constrained nothing. The
fallback is removed: with `X-Nonce` present the signature **must** cover
`Siphon API v1:{chain}:{ts}:{nonce}`. The Redis replay key now includes the nonce segment
(`walletnonce:{wallet}:{ts}:{nonce}:{sig}`).

**Client impact:** a client that sends `X-Nonce` without signing it now gets 401 instead of silently
passing. That combination was always a client bug.

---

## ~~api-credit-collector — hardcoded fallback address~~ — DONE 2026-08-20

`collector_address()` fell back to a baked-in address when `API_CREDIT_COLLECTOR` was unset, so a
missing env var silently routed real customer USDC to a hardcoded destination while looking like a
healthy deploy. Now fail-closed: raises `DownstreamUnavailable` when unset and
`SIPHON_ENV`/`APP_ENV` is `prod`/`production`. The dev fallback remains for local work only.
