# asp

> Part of **`siphon_master`** — Association Set Provider (compliance roots).

Greenfield **Association Set Provider** for Siphon PROTOCOL 3.4 — clock-aligned with:

- Circom / spend-core dual roots (ASP + SMT paths)
- [`../contracts`](../contracts) — `VaultKernel.Deposited`, `ComplianceHub`

No hop graph. The compliance + prove loop does not require the app UI — ASP publishes roots that spends bind to on-chain.

## What ships

| Layer | Status |
|-------|--------|
| Screening (`POST /screen`, batch) — lists → oracle → zkMe KYT | Done |
| KYT year entitlement (`kyt_year_v1`, `/compliance-fee/*`) | Done |
| KYC year entitlement (`kyc_year_v1`, separate fee) | Done |
| ASP tree + revocation SMT (zkv2 fixture parity) | Done |
| `/set/admit` (userSalt-derived label), `/set/revoke`, paths | Done |
| Pending-admit outbox + `scripts/watch_deposits.py` | Done |
| Deny → cancel pending (same depositor only) | Done |
| Postman → ComplianceHub (5-min admit epoch; immediate revoke) | Done |
| Drift reconcile + `GET /metrics` | Done |
| PostgreSQL (production) | Default |

## Quick start

```bash
cd siphon-aspv2
# Postgres (prod). Tests use sqlite:///:memory: via ASP_DATABASE_URL.
export ASP_DATABASE_URL=postgresql+psycopg2://asp:asp@127.0.0.1:5432/aspv2
pip install -r requirements.txt
npm install
cp .env.example .env

python lists/seed_mixers.py && python lists/seed_sanctions.py
python app.py                                    # :5056
python postman.py loop --chain-id 31337          # epoch publish + reconcile
python scripts/watch_deposits.py --chain-id 31337 --loop
```

Local Anvil: [scripts/BOOTSTRAP.md](./scripts/BOOTSTRAP.md)

## API

- **Compliance flows (KYT + zkKYC, with diagrams):** [docs/COMPLIANCE_FLOWS.md](./docs/COMPLIANCE_FLOWS.md)
- Architecture (system role + trees + trust): [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
- HTTP endpoints: [docs/ASP-V2-API.md](./docs/ASP-V2-API.md)
- Production deploy: [docs/DEPLOY.md](./docs/DEPLOY.md)

```bash
# KYT year entitlement (when zkMe is configured)
curl -s -H "Authorization: Bearer $ASP_SCREEN_TOKEN" \
  "http://127.0.0.1:5056/compliance-fee/check?wallet=0x…" | jq

# Screen (layer1 first; 402 kyt_fee_required if zkMe needs unpaid year)
curl -s -X POST http://127.0.0.1:5056/screen \
  -H "Authorization: Bearer $ASP_SCREEN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"chainId":31337,"depositor":"0x…","commitment":"123"}' | jq

# Dual roots
curl -s -H "Authorization: Bearer $ASP_SCREEN_TOKEN" \
  http://127.0.0.1:5056/set/root | jq
```

Dev without paying zkMe: set `ASP_ALLOW_SKIP_KYT_FEE=1` (forbidden when `ASP_ENV=production`).

## Tests / smoke

```bash
npm install && python -m pytest -q
python scripts/e2e_journey.py   # screen → admit (mock) → paths shaped for zkv2
```

## Layout

| Path | Role |
|------|------|
| `core/` | ASP tree, SMT, domains, salted label (§2.3) |
| `association_set.py` / `revocation_set.py` | DB-backed trees |
| `screen.py` | Lists → oracle → zkMe (entitlement-gated) |
| `compliance_fee.py` | On-chain fee verify → `kyt_entitlement` + `kyc_entitlement` + payment ledgers |
| `chain_verify.py` | `Deposited` + screen bind + hub postman check |
| `postman.py` | Publish roots to ComplianceHub (epoch admit / immediate revoke) |
| `app.py` | Flask HTTP |
| `scripts/e2e_journey.py` | Off-chain clock smoke |
| `scripts/export_aspv2_env.sh` | Emit both `ASP_COMPLIANCE_HUB_*` and `COMPLIANCE_HUB_*` |

## v1 → v2

| v1 (`siphon-asp`) | v2 (`siphon-aspv2`) |
|-------------------|---------------------|
| `Entrypoint.updateAspRoot` | `ComplianceHub.updateAdmittedRoot` + `updateRevokedRoot` |
| `LabelMinted` admit verify | `VaultKernel.Deposited` + client label (+ optional `userSalt`) |
| Revoke = ASP eviction | Append-only ASP + SMT insert |
| Soft fee UX (not gated on `/screen`) | Fee ledger + `/screen` paywall; separate KYT vs KYC products |

See [docs/COMPLIANCE_FLOWS.md](./docs/COMPLIANCE_FLOWS.md) for end-to-end KYT and zkKYC sequence diagrams.
