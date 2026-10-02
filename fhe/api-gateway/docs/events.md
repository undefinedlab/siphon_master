# Metering events catalog

`usage_events` is the append-only, un-gameable record of billable activity (spec §5.1, §8). Money is
BIGINT minor units. Recording ships in v1; automated debit is deferred (v1.1). See
[ADR 0008](adr/0008-billing-attribution.md).

## Schema (`usage_events`)

| column | type | notes |
|---|---|---|
| `id` | UUID | PK |
| `api_key_id` | TEXT | attributed key |
| `event_type` | TEXT | one of the types below |
| `strategy_id` | TEXT? | set for strategy/execution events |
| `tx_hash` | TEXT? | on-chain tx; **`UNIQUE(event_type, tx_hash)`** dedups `execution` |
| `amount_minor` | BIGINT | minor units; 0 when not a priced event |
| `request_id` | TEXT | correlation to the request that produced it |
| `created_at` | TIMESTAMPTZ | |

## Event types

| `event_type` | Emitted when | Written by | `tx_hash` | Idempotency |
|---|---|---|---|---|
| `strategy_created` | `POST /v1/strategies` succeeds (arm) | gateway, inside the idempotency txn | — | Idempotency-Key |
| `withdrawal` | `POST /v1/withdrawals/{id}/confirmation` passes confirmation depth | gateway, at confirm | yes | `UNIQUE(event_type, tx_hash)` |
| `execution` | a confidential strategy fires on-chain | executor outbox → gateway reconciler | yes | `UNIQUE(event_type, tx_hash)` + reconcile dedup |

Notes:
- **`execution`** is the only event the gateway does not originate — it is reconciled from the
  executor's `ExecutionEvent` outbox via signed `billing_ref` (ADR 0008). This is what makes metering
  un-gameable: no matching on-chain tx ⇒ no event.
- Deposits and consolidations are **not** billed in v1 (no `deposit`/`consolidation` event type).
- `metering.record()` **flushes** within the caller's transaction (never commits independently), so
  an event and the state change that justifies it commit atomically.

## Admin credit grants (not a usage event)

Operator comps are recorded in `audit_log` (`action="credit.grant"`), not `usage_events`. A grant
increments `api_keys.balance_minor` (additive-only, `amount_minor > 0`) and is surfaced as
`granted_credit_minor` in `GET /v1/account/usage` so the comp is transparent to the integrator
(spec §5.4).
