# ASP v2 HTTP API

siphon-aspv2 (port **5056**) implements PROTOCOL **3.4** compliance: screening, association-set (ASP), revocation SMT, and ComplianceHub root publishing.

Architecture and Siphon-wide role: [ARCHITECTURE.md](./ARCHITECTURE.md).

## Authentication

| Token | Env | Routes |
|-------|-----|--------|
| Screen | `ASP_SCREEN_TOKEN` | `/screen`, `/screen/batch`, `/compliance-fee/*`, `/set/root`, `/set/path`, `/set/smt-path`, `/set/member`, `/metrics`, decisions |
| Postman | `ASP_POSTMAN_TOKEN` | `/set/admit`, `/set/revoke` |
| Admin | `ASP_ADMIN_TOKEN` | `/lists/custom_ban`, `/lists/custom_unban` |

Tokens must be **distinct** and ≥16 characters when set (floored under production).

## Deposit → admit sequence

1. **GET /compliance-fee/check?wallet=** — active KYT year? If not, pay vault then **POST /compliance-fee/verify**
2. **POST /screen** — `{ chainId, depositor, commitment, userSalt? }` → `{ decision: admit|deny|pending }`
   - Layer 1 (lists + oracle) first; **deny short-circuits before zkMe**
   - zkMe only if entitled; else **402** + `kyt_fee_required`
   - On **admit** with `userSalt` + `commitment`: stores `PendingAdmit` outbox (salt sealed; never logged/returned)
   - On **deny**: cancels pending outbox **only if** deny depositor owns that pending row (never revokes from client `label`)
3. Wallet deposits on **VaultKernel** — emits `Deposited(...)` (no label)
4. **POST /set/admit** (postman) — **`userSalt` required** (derives label). Optional client `label` must match derivation.
   - Or run `python scripts/watch_deposits.py --chain-id N` to auto-admit from outbox + logs
5. Postman publishes **admittedRoot** on ComplianceHub on the **5-minute epoch** (or manual `postman publish-admitted`)
6. **GET /set/path?label=** + **GET /set/smt-path?label=** — prover witness paths
7. Client/SDK calls `assertRootsCurrent` against on-chain hub roots

## Ops

| Command | Role |
|---------|------|
| `python postman.py loop` | Epoch admit publish + revoke publish + drift reconcile |
| `python postman.py reconcile` | Sync on-chain roots / clear stuck pending flags |
| `python scripts/watch_deposits.py --chain-id N` | Deposited log → pending outbox → admit |
| `GET /metrics` | Queue depth, drift, counters |

## Endpoints

### KYT fee / entitlement

Aligns with zkMe’s **~$0.50 per user per year**. Aspv2 records payment on-chain (ETH or USDC to `ASP_COMPLIANCE_VAULT`), then grants a wallet entitlement (`expires_at`).

#### GET `/compliance-fee/check?wallet=0x…`

Screen-token auth. Returns:

```json
{
  "paid": true,
  "active": true,
  "wallet": "0x…",
  "expiresAt": "2027-08-25T…",
  "vault": "0x…",
  "feeWei": 200000000000000,
  "feeUsdc": 500000,
  "entitlementDays": 365,
  "product": "kyt_year_v1"
}
```

#### POST `/compliance-fee/verify`

```json
{ "wallet": "0x…", "txHash": "0x…64 hex…", "chainId": 8453 }
```

- Validates wallet (`0x`+40) and `txHash` (`0x`+64) before RPC.
- Requires `CHAIN_MIN_CONFIRMATIONS` (same floor as deposit verify).
- Credits / renews entitlement; each fee **`txHash` is consumable once** (`kyt_fee_payment` ledger).
- Active entitlement → `{ ok: true, alreadyPaid: true }` (no double-credit).

### Screening

#### POST `/screen`

Body: `{ chainId, depositor, commitment?, txHash?, userSalt?, vault? }`.

| Outcome | HTTP | Notes |
|---------|------|--------|
| `admit` | 200 | Layer1 clear; zkMe clear or unconfigured |
| `deny` | 200 | Layer1 or zkMe deny |
| `pending` + `kyt_fee_required` | **402** | Layer1 clear; zkMe configured; no active year |
| `pending` (degraded) | 200 | e.g. `zkme_unavailable` when not `ASP_DEGRADED_AS_DENY` |

#### POST `/screen/batch`

Same per-item rules. Response:

```json
{ "results": [ … ], "feeRequired": true }
```

HTTP **402** when any item has `kyt_fee_required` (parity with single `/screen`).

### GET `/set/root`

Returns dual roots and publish state:

```json
{
  "admittedRoot": "...",
  "revokedRoot": "...",
  "admittedLeafCount": 0,
  "pendingAdmitPublish": false,
  "onchainSync": { "admittedMatch": true, "revokedMatch": true }
}
```

Returns **503** when `pendingAdmitPublish` and `ASP_AUTO_PUBLISH_ROOT=1`.

### GET `/set/path?label=`

ASP Merkle inclusion for spend (label must be admitted).

### GET `/set/smt-path?label=`

SMT non-inclusion proving label is **not** revoked (required for private spend).

| Field | Meaning |
|-------|---------|
| `claimedLeaf` | **Circom `revokedSmtLeaf`** — actual leaf at `smtKey(label)` (`0` if empty) |
| `labelLeafHash` / `revokedSmtLeaf` | `leafHash(label)` for forensics — **not** a Circom signal |

zkv2 SDK `aspClient.smtPathToCircom` / `loadComplianceWitness` maps `claimedLeaf` → Circom.

### GET `/set/smt-inclusion-path?label=`

SMT inclusion for revoked ragequit flows.

### POST `/set/admit`

Postman-only. Queues label; optional auto-publish when `ASP_AUTO_PUBLISH_ROOT=1`.

Admit bind rechecks lists + oracle + (if zkMe configured) **active KYT entitlement** then live zkMe.

### POST `/set/revoke`

Postman-only. Requires label already in ASP (unless `ASP_ALLOW_REVOKE_UNADMITTED=1`, forbidden in production). SMT insert + pending revoke publish (immediate in postman loop).

Three request shapes:

| Body | Behaviour |
|---|---|
| `{ label }` | Revoke that label directly (must be admitted). |
| `{ label?, txHash, userSalt, chainId, vault }` | Exit ticket — proves the label from the `Deposited` event (§5.2.1, F-8). |
| `{ depositor, amount, assetId, flaggedLabel? }` | **Rule 1/2 selection** — the ASP picks which live label to freeze. |

#### Rule 1/2 amount-based revoke (after-merge compliance)

Freezes `amount` of a depositor's in-pool value when the bad deposit was already
merged away and no lineage exists to trace. Justified by **fungibility**: compliance
requires freezing X of the depositor's value, not the specific coins.

Selection order (single label — no greedy multi-label sweep):

1. **Source**: if `flaggedLabel` is itself still live, revoke it and stop,
   **irrespective of its value** — accepting that some funds may already have gone
   through. It is the actual bad label and revoking it blocks every child note that
   inherited it. Checked first: substituting a fungible label while the real bad
   label stays spendable would be strictly worse.
2. **Rule 1 — exact**: a live label whose deposit amount `== amount`.
3. **Rule 2 — smallest-fit**: the smallest single live label `>= amount`.
4. Otherwise nothing is revoked; `sufficient: false` with the candidate set.

A label is *live* when it is in the ASP and not in the revocation SMT. Selection is
**per-asset** (D1) and ignores rows with an unknown amount (admitted before the
`amount`/`asset_id` columns existed).

```jsonc
// request
{ "depositor": "0x…", "amount": "500", "assetId": "0xa0b8…", "flaggedLabel": "123" }

// 200 — a label was frozen
{ "revoked": true, "mode": "rule_1_2", "policy": "rule_2_smallest_fit",
  "labels": ["17002"], "covered": "600", "requested": "500", "shortfall": "0",
  "sufficient": true, "root": "…", "publish": {…} }

// 200 — nothing fits (value already left the pool; compliance moot)
{ "revoked": false, "mode": "rule_1_2", "policy": "none", "labels": [],
  "sufficient": false, "shortfall": "500", "candidates": [{…}] }
```

`assetId` accepts a token address or a decimal `uint160`. Both outcomes write an
`set_revoke_rule_1_2` audit row. All SMT inserts for one request land in a single
transaction with **one** root publish (O-7 atomic revoke).

> **Deferred:** selection cannot yet tell whether a label's note was already spent —
> the indexer's `/state/leaves` is 503 until `NoteTree.insert` emits an event. Worst
> case a just-spent label is chosen and the freeze is a harmless no-op.

## Retired (v1)

- `/set/child`, `/set/unrevoke` — not in v2
- On-chain `LabelMinted` — replaced by off-chain admit bind

## Local bootstrap

See [scripts/BOOTSTRAP.md](../scripts/BOOTSTRAP.md) and:

```bash
./scripts/export_aspv2_env.sh ../siphon-contracts-v2/evm/deployments/chain-31337/deployed_addresses.json
```

## Error codes

| Code | Meaning |
|------|---------|
| `kyt_fee_required` | Layer1 clear; pay / renew KYT year before zkMe (HTTP 402; batch sets `feeRequired`) |
| `fee_not_paid` | `/compliance-fee/verify` rejected (bad tx, confirmations, consumed hash, …) |
| `not_member` | Label not in admitted ASP |
| `admit_publish_pending` | Paths blocked until postman publishes |
| `confirmation` | Tx needs more confirmations |
| `screen_bind_failed` | No prior admit screen for commitment |
| `kyt entitlement inactive at admit recheck` | Admit refused — renew fee before zkMe recheck |
