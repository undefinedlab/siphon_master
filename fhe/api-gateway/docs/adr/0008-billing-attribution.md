# ADR 0008 — Billing attribution via signed `billing_ref` + executor outbox

**Status:** Accepted (v1) · **Date:** 2026-07-22 · **Spec:** §5.1, §8, D8

## Context

The executor fires a confidential strategy **internally** — there is no gateway request in the loop
at fire time — so at fire time it must already know *which API key to bill*. Metering must be
un-gameable (a replayed API call cannot fabricate a billable event) and money must be recorded from
day one even though automated debit is deferred to v1.1.

## Decision

1. **Signed `billing_ref`.** At arm time (`POST /v1/strategies`) the gateway attaches
   `billing_ref = "{api_key_id}.{HMAC_sha256(api_key_id)}"` (HMAC keyed by `BILLING_REF_HMAC_KEY`)
   to the executor's `createStrategy` call. The executor never learns the integrator↔user mapping;
   it cannot be tricked into billing an arbitrary key because it cannot forge the HMAC.
2. **Executor persists + stamps.** The executor stores `billing_ref` on the strategy row (new
   column) and, when the strategy fires, writes an `ExecutionEvent` **outbox** row (`tx_hash`,
   `billing_ref`) in the **same DB transaction** as the strategy state change — no dual-write.
3. **Gateway reconciles.** A single-owner reconciler process pulls the executor's `/execution-events`
   outbox, HMAC-verifies each `billing_ref` (constant-time), and records an `execution`
   `usage_event` for the attributed key. `UNIQUE(event_type, tx_hash)` makes this idempotent — a
   re-emitted on-chain event cannot double-bill.
4. **Record-only in v1.** No automated debit/top-up. `/v1/account/usage` surfaces counts, spend,
   granted credit, and balance; invoicing is manual.

## Consequences

- **Un-gameable:** an `execution` event exists only if a real on-chain tx exists; replay can't forge one.
- **Crash-safe:** outbox in-txn + idempotent reconcile survives a reconciler or executor restart.
- **Single-owner reconciler** (`RUN_RECONCILER_IN_WORKER=0` on web, dedicated `reconciler` service)
  prevents N-worker duplicate polling. See [ADR TODO: reconciler topology].
- **Trust:** the executor holds an opaque `api_key_id`, never the integrator identity (§Trust Boundaries).
- **Deferred:** automated prepaid-balance drawdown + Stripe top-ups (v1.1). Clawback of granted
  credit is deferred; grants are additive-only (`amount_minor > 0`).
