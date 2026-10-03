# siphon-aspv2 architecture

**Role:** Association Set Provider (ASP) + screening + revocation SMT for Siphon **PROTOCOL 3.4**.  
**Normative specs:** [`siphon-zkv2/docs/PROTOCOL.md`](../../siphon-zkv2/docs/PROTOCOL.md) (§2.3 labels, §2.5 SMT, §2.6 ASP), [`siphon-contracts-v2/docs/ARCHITECTURE.md`](../../siphon-contracts-v2/docs/ARCHITECTURE.md).  
**HTTP surface:** [`ASP-V2-API.md`](./ASP-V2-API.md).

If this file and PROTOCOL disagree on spend rules, **PROTOCOL wins**.

---

## 1. Place in the Siphon system

Siphon splits **privacy**, **compliance**, and **settlement** across three greenfield packages:

| Package | Owns |
|---------|------|
| **siphon-zkv2** | Circuits, `spend-core`, SDK witness builders (`aspClient`), PROTOCOL |
| **siphon-contracts-v2** | `VaultKernel`, `ComplianceHub`, verifiers, adapters |
| **siphon-aspv2** (this repo) | KYT screen, off-chain ASP + SMT mirrors, postman root publish, path API |

```text
                    ┌─────────────────┐
                    │   User / SDK    │
                    │  (siphon-zkv2)  │
                    └────────┬────────┘
         screen / paths /    │    prove + submit
         roots               │
                    ┌────────▼────────┐         Deposited /
                    │  siphon-aspv2   │◄──────── spend tx
                    │  ASP + SMT +    │         (RPC)
                    │  screen/postman │
                    └────────┬────────┘
         updateAdmittedRoot  │
         updateRevokedRoot   │
                    ┌────────▼────────┐
                    │ ComplianceHub   │◄── VaultKernel.spend checks
                    │ admittedRoot    │    current dual roots
                    │ revokedRoot     │
                    └─────────────────┘
```

**What aspv2 is not**

- Not a vault or relayer.
- Not a hop-graph / clustering service (v1 retired that surface).
- Not required to run inside `siphon-app` — HTTP + scripts are enough for the compliance clock.

**What aspv2 uniquely provides**

1. **Screen** depositor addresses (lists + OFAC oracle + optional zkMe).
2. **Admit** labels into an append-only ASP Merkle tree after on-chain `Deposited` + screen bind.
3. **Revoke** labels into a presence-only SMT (ASP leaf stays; spend is blocked by SMT).
4. **Publish** dual roots to `ComplianceHub` (5‑minute admit epoch; revoke publish immediate).
5. **Serve** inclusion / non-inclusion paths so the prover can witness `admittedRoot` + `revokedRoot`.

Private spend (§5.1) requires both: ASP **inclusion** of each input label and SMT **non-inclusion** (not revoked). Observers never see labels on-chain; they only see the published roots and nullifiers.

---

## 2. Compliance clock (end-to-end)

Labels are **not** written in deposit calldata. The vault mints:

`label = Poseidon(Poseidon(DOMAIN_VAULT_SCOPE, vaultScopeId, depositNonce), userSalt)`  
with `userSalt ≠ 0` (PROTOCOL §2.3 / §2.7).

```text
1. Client  (optional if zkMe off) GET /compliance-fee/check → pay vault → POST /compliance-fee/verify
           → wallet KYT year entitlement (kyt_entitlement + append-only kyt_fee_payment)

2. Client  POST /screen { chainId, depositor, commitment, userSalt? }
           → layer1 lists+oracle; then zkMe only if entitled
           → admit | deny | pending (402 kyt_fee_required)
           → on admit + userSalt: seal salt into PendingAdmit outbox

3. User    VaultKernel.deposit
           → event Deposited(depositor, token indexed, amount, commitment, nonce, stateRootAfter)
           (no label on-chain; depositor is deliberately NOT indexed — PROTOCOL §2.7)

4. Watcher or postman  POST /set/admit
           → verify Deposited receipt + vault pin
           → verify prior screen decision == admit (depositor, chain, freshness,
             list/oracle recheck; zkMe recheck if configured + entitled)
           → derive label from (scope, nonce, userSalt)
           → append ASP leaf (queued)

5. Postman  ComplianceHub.updateAdmittedRoot(newRoot)
           → only after admitEpochSeconds (default 300s) since last publish
           → avoids per-deposit root timing join

6. Prover   GET /set/path?label= + GET /set/smt-path?label=
           → ASP inclusion + SMT non-inclusion witness
           → assertRootsCurrent vs on-chain hub

7. Relayer  VaultKernel.spend(publics, proof, …)
           → verifiers check public[3]=admittedRoot, public[4]=revokedRoot are current
```

**Deny path:** screen deny cancels that depositor’s pending outbox for the commitment. Revoke of an already-admitted label is **postman-only** (`POST /set/revoke`) — never from a client-supplied `label` on `/screen`.

**Ragequit:** never-admitted / revoked notes use PROTOCOL §5.2 branches (pending bootstrap or SMT inclusion). Admitted notes must private-spend; they cannot ragequit while ASP∈ ∧ SMT∉.

---

## 3. Dual trees

### 3.1 Association set (ASP) — §2.6

| Property | Value |
|----------|--------|
| Structure | Depth-32 Poseidon incremental Merkle tree |
| Leaf | Canonical decimal label (BN254 field element) |
| Semantics | **Append-only** admission membership |
| On-chain | Single current `ComplianceHub.admittedRoot` (no historical ring) |
| Empty root | Matches zkv2 `test-vectors/asp/empty-root.json` |

Insert is idempotent per label. Duplicate insert is a no-op return (`already`). Postgres uses an advisory lock around mutations.

### 3.2 Revocation SMT — §2.5

| Property | Value |
|----------|--------|
| Structure | Depth-32 sparse Merkle tree over `smtKey(label)` |
| Semantics | Presence-only **revoked** set |
| On-chain | Single current `ComplianceHub.revokedRoot` |
| ASP link | Revoking does **not** remove the ASP leaf |

Spend proves **non-inclusion**: Circom leaf input is `claimedLeaf` (actual slot content), not `leafHash(label)`. See API doc mapping for `aspClient`.

---

## 4. Internal components

```text
app.py                 Flask HTTP (screen, compliance-fee, set/*, metrics, lists)
screen.py              KYT pipeline: lists → oracle → zkMe (entitlement-gated)
compliance_fee.py      On-chain fee verify → entitlement + payment ledger
pending_admit.py       Sealed userSalt outbox (Fernet)
association_set.py     ASP tree persistence + paths
revocation_set.py      SMT persistence + paths
chain_verify.py        Deposited parse, vault pin, screen bind + recheck
postman.py             ComplianceHub publish + drift reconcile
oracle.py / zkme.py    External screening sinks (zkMe: no response cache)
core/                  Poseidon, AspTree, SMT, domains, label mint
scripts/               watch_deposits, e2e_journey, export_aspv2_env
```

### 4.1 Screening

**Sequence diagrams (KYT + zkKYC):** [COMPLIANCE_FLOWS.md](./COMPLIANCE_FLOWS.md)

Checks **in order** (layer 1 never spends zkMe quota):

1. Address lists: `sanction`, `mixer`, `custom_ban` (cex allowlist informational).
2. Chainalysis-style `isSanctioned` oracle (fail-closed in production).
3. **Stop on any layer-1 deny** — zkMe is not called.
4. Optional zkMe KYT (only if configured **and** wallet has an active **KYT entitlement**).

**KYT entitlement (`kyt_year_v1`):** on-chain ~$0.50 fee (ETH or USDC to `ASP_COMPLIANCE_VAULT`) → coverage for `ASP_KYT_ENTITLEMENT_DAYS` (default 365; ≤366 in production) per wallet. Stored in `kyt_entitlement`; each fee `tx_hash` is recorded once in append-only `kyt_fee_payment` (no replay / cross-wallet reuse; same tx cannot pay KYC). Confirmations use `ASP_CHAIN_MIN_CONFIRMATIONS`. Re-screens inside the window reuse the entitlement (live zkMe API; no short TTL cache). Missing entitlement → `pending` / HTTP **402** `kyt_fee_required` before any zkMe call. Dev escape: `ASP_ALLOW_SKIP_KYT_FEE=1` (forbidden in production).

**KYC entitlement (`kyc_year_v1`):** separate $0.50/year product for zkKYC widget access (siphon-app). Stored in `kyc_entitlement` + `kyc_fee_payment`. asp-v2 does not store identity PII — fee ledger only. See [COMPLIANCE_FLOWS.md](./COMPLIANCE_FLOWS.md).

Outcomes: `admit`, `deny`, or `pending` (`kyt_fee_required`, or degraded when lists/zkMe unavailable and not forced deny).

### 4.2 Screen → admit binding

`/set/admit` and the deposit watcher require:

- A prior **admit** screen for `(commitment, chainId)`.
- Screen depositor == on-chain depositor.
- Decision not older than `ASP_SCREEN_ADMIT_MAX_AGE_SEC`.
- Live recheck: list hits + oracle (production must keep recheck on).
- If zkMe is configured: active KYT entitlement required, then live zkMe score (same as screen layer 2).

### 4.3 Pending-admit outbox

So the watcher can derive the label without the client re-sending salt in cleartext logs:

- Salt sealed at rest (`ASP_PENDING_SALT_KEY`; required in production).
- Bound to `(chainId, commitment, depositor)`.
- Immutable while `status=pending`; wiped on admit / fail / cancel.

### 4.4 Postman

| Root | Cadence | Why |
|------|---------|-----|
| `admittedRoot` | ≥ `admitEpochSeconds` (hub), typically 300s | Epoch bus — not per deposit |
| `revokedRoot` | Immediate on revoke | Safety-critical block of spend |

`postman.py loop` also **reconciles** off-chain MetaKV vs hub and clears stuck pending flags when roots already match.

---

## 5. Trust & auth model

| Role | Token | Capability |
|------|-------|------------|
| Screen | `ASP_SCREEN_TOKEN` | Screen, read roots/paths/member/metrics |
| Postman | `ASP_POSTMAN_TOKEN` | Admit / revoke queue; on-chain key is `ASP_POSTMAN_KEY` |
| Admin | `ASP_ADMIN_TOKEN` | Custom ban/unban |

Production (`ASP_ENV=production|prod|mainnet`) fail-closes on: SQLite, default `asp:asp` DSN, missing Redis, missing pending-salt key, identical/short tokens, disabled screen recheck / oracle fail-open / unseeded lists, Flask debug, zero confirmations, zero compliance fee amounts, entitlement days > 366, `ASP_ALLOW_SKIP_KYT_FEE`, missing `ASP_COMPLIANCE_VAULT` when zkMe is configured, empty `ASP_SCREEN_TOKEN`.

The postman EOA must match `ComplianceHub.postman()` (and optional `ASP_POSTMAN_ADDRESS` pin).

---

## 6. Data stores

| Store | Contents |
|-------|----------|
| `address_list` | Mixer / OFAC / custom_ban seeds |
| `screen_result` | Decisions (no `userSalt` in `request_json`) |
| `pending_admit` | Sealed salt outbox |
| `kyt_entitlement` | Wallet → paid-until (`expires_at`) for zkMe KYT year |
| `kyt_fee_payment` | Append-only ledger — each fee `tx_hash` consumed once |
| `asp_label` | Append-only admitted leaves + leaf index |
| `revoked_label` | SMT revoked labels |
| `meta_kv` | Roots, pending publish flags, watcher cursors, counters |

Production DB is **PostgreSQL** (advisory locks). Tests may use `sqlite:///:memory:`.

---

## 7. Integration map

| Consumer | Integration |
|----------|-------------|
| **siphon-zkv2 SDK** | `aspClient`: `/set/root`, `/set/path`, `/set/smt-path`; maps `claimedLeaf` → Circom |
| **siphon-contracts-v2** | Hub addresses via `ASP_COMPLIANCE_HUB_*` / `COMPLIANCE_HUB_*`; vault via `VAULT_KERNEL_*` |
| **Relayer / app** | Optional thin client: screen before deposit; paths before prove |

Local Anvil clock: [`scripts/BOOTSTRAP.md`](../scripts/BOOTSTRAP.md).

---

## 8. Threat model (ASP-relevant)

| Threat | Mitigation |
|--------|------------|
| Label borrow / user-supplied label | Vault forbids label calldata; aspv2 derives from salt + nonce |
| Unscreened private spend | Spend needs current ASP inclusion proof |
| Timing join deposit → +1 leaf | 5‑minute admit epoch (not per-deposit publish) |
| Stale screen admit | Max age + list/oracle (+ zkMe) recheck at admit |
| Cross-tenant pending cancel | Deny cancels only matching depositor |
| Salt leak at rest | Fernet seal; strip salt keys from persisted screen JSON |
| SMT pollution | Revoke requires prior ASP admission (unless explicit escape) |
| Postman spoof | On-chain postman address + token auth |
| zkMe quota burn without pay | Layer1 short-circuit; `/screen` 402 without entitlement |
| Fee tx replay / free renew | Append-only `kyt_fee_payment`; each `tx_hash` once |
| Unconfirmed fee credit | Fee verify requires `CHAIN_MIN_CONFIRMATIONS` |

Privacy claim for the vault (what observers must not learn): [`siphon-contracts-v2/docs/PRIVACY.md`](../../siphon-contracts-v2/docs/PRIVACY.md).

---

## 9. v1 → v2 summary

| v1 (`siphon-asp`) | v2 (`siphon-aspv2`) |
|-------------------|---------------------|
| `Entrypoint.updateAspRoot` | `ComplianceHub.updateAdmittedRoot` + `updateRevokedRoot` |
| `LabelMinted` verify | `VaultKernel.Deposited` + derived label |
| Revoke = ASP eviction | Append-only ASP + SMT insert |
| Soft fee UX only | Hard paywall on `/screen` + fee ledger |
| Hop graph | Removed |

---

## 10. Related docs

| Doc | Content |
|-----|---------|
| [`ASP-V2-API.md`](./ASP-V2-API.md) | HTTP endpoints, path field mapping |
| [`../scripts/BOOTSTRAP.md`](../scripts/BOOTSTRAP.md) | Local Anvil + env export |
| [`../../siphon-zkv2/docs/PROTOCOL.md`](../../siphon-zkv2/docs/PROTOCOL.md) | Normative compliance + spend |
| [`../../siphon-contracts-v2/docs/ARCHITECTURE.md`](../../siphon-contracts-v2/docs/ARCHITECTURE.md) | Vault + hub architecture |
