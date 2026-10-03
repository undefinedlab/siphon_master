# Compliance flows — KYT & zkKYC

siphon-aspv2 is the **fee ledger and KYT screening authority**. zkKYC identity runs in
**siphon-app** via the zkMe widget, but **KYC fee entitlements** (`kyc_year_v1`) are stored
here alongside KYT (`kyt_year_v1`).

**KYT and KYC are separate products** — $0.50 / wallet / year each, separate on-chain
payments to `ASP_COMPLIANCE_VAULT`. One fee does not cover the other.

| Product | ASP table | Purpose | Required for deposits? |
|---------|-----------|---------|------------------------|
| `kyt_year_v1` | `kyt_entitlement` | Transaction-risk screening (zkMe `risk/score`) | Yes (Level 1) |
| `kyc_year_v1` | `kyc_entitlement` | zkKYC widget access (identity) | No (Level 2) |

---

## Overview

```mermaid
flowchart TB
  subgraph L1["Level 1 — KYT (asp-v2)"]
    TOS[TOS + Privacy]
    KYTFEE[Pay kyt_year_v1 $0.50/yr]
    SCREEN[POST /screen]
    L1A[Lists + Chainalysis oracle]
    L1B[zkMe risk/score]
    TOS --> KYTFEE --> SCREEN --> L1A --> L1B
  end

  subgraph L2["Level 2 — zkKYC (app + asp-v2 fee)"]
    KYCFee[Pay kyc_year_v1 $0.50/yr]
  end

  subgraph APP["siphon-app"]
    WIDGET[zkMe zkKYC widget]
    VERIFY[verifyKycWithZkMeServices]
    KYCFee --> WIDGET --> VERIFY
  end

  L1 --> L2
  SCREEN --> DEP[Deposit → watcher admit]
```

---

## Level 1 — KYT (required to deposit)

Transaction-risk screening at screen time. asp-v2 calls zkMe server-side when
`kyt_entitlement` is active.

```mermaid
sequenceDiagram
  participant U as User
  participant App as siphon-app
  participant ASP as asp-v2
  participant ZK as zkMe KYT API

  U->>App: Trust → TOS + Privacy
  U->>App: Pay $0.50 KYT fee
  App->>ASP: POST /compliance-fee/verify<br/>product=kyt_year_v1
  ASP-->>App: kyt_entitlement (365 days)
  U->>App: Run KYT screen
  App->>ASP: POST /screen
  ASP->>ASP: Layer 1 — lists + Chainalysis oracle
  alt Layer 1 clear + entitled
    ASP->>ZK: GET risk/score
    ZK-->>ASP: riskScore, riskLevel
  else No entitlement
    ASP-->>App: 402 kyt_fee_required
  end
  ASP-->>App: admit / deny / pending
  Note over ASP: Persisted in screen_result
  U->>App: Deposit
  App->>ASP: Live re-screen
  ASP-->>App: admit
  Note over ASP: Watcher admits label after Deposited
```

### Step-by-step

1. User connects wallet → Trust tab → accepts TOS + Privacy.
2. Pays **KYT fee** (`product=kyt_year_v1`) to `ASP_COMPLIANCE_VAULT`.
3. App calls `POST /compliance-fee/verify` → asp-v2 writes `kyt_entitlement` (365 days).
4. App proxies `POST /screen`:
   - **Layer 1:** OFAC/mixer lists + Chainalysis `isSanctioned` (zkMe never called on hit).
   - **Layer 2:** zkMe `risk/score` only when entitled.
5. Result `admit` | `deny` | `402 kyt_fee_required` → `screen_result` + `/decisions`.
6. On deposit: live re-screen; watcher admits from pending outbox after on-chain `Deposited`.

### API

```bash
# Check KYT entitlement (default product)
curl -s -H "Authorization: Bearer $ASP_SCREEN_TOKEN" \
  "https://api.siphon.money/aspv2/compliance-fee/check?wallet=0xWALLET&product=kyt_year_v1"

# Screen (402 if KYT fee unpaid and zkMe configured)
curl -s -X POST https://api.siphon.money/aspv2/screen \
  -H "Authorization: Bearer $ASP_SCREEN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"chainId":8453,"depositor":"0xWALLET"}'
```

---

## Level 2 — zkKYC (optional)

Identity credential via zkMe browser widget. asp-v2 holds the **KYC fee ledger** only —
no identity PII. Widget + verification live in siphon-app.

```mermaid
sequenceDiagram
  participant U as User
  participant App as siphon-app
  participant ASP as asp-v2
  participant ZK as zkMe widget

  Note over U: Level 1 complete (TOS + KYT fee + screen clear)
  U->>App: Pay $0.50 KYC fee (separate tx)
  App->>ASP: POST /compliance-fee/verify<br/>product=kyc_year_v1
  ASP-->>App: kyc_entitlement (365 days)
  U->>App: Start zkKYC
  App->>ASP: POST /api/zkme/token (app proxy)
  ASP-->>App: accessToken
  App->>ZK: Launch @zkmelabs/widget
  U->>ZK: Complete identity flow
  ZK-->>App: kycFinished
  App->>ZK: verifyKycWithZkMeServices
  ZK-->>App: isGrant
  Note over App: L2 badge + gates (API keys, limits)
```

### Step-by-step

1. User completes Level 1.
2. Pays **KYC fee** (`product=kyc_year_v1`) — **separate** $0.50 tx → `kyc_entitlement`.
3. App mints widget token (`ZKME_API_KEY` stays server-side).
4. zkMe widget opens (`lv: zkKYC`).
5. User completes zk.me identity flow; app handles `kycFinished`.
6. App verifies via `verifyKycWithZkMeServices`; Level 2 gates unlock.

**Total if user wants both:** $1.00/year (two separate payments).

### API (asp-v2 side)

```bash
# Check KYC entitlement
curl -s -H "Authorization: Bearer $ASP_SCREEN_TOKEN" \
  "https://api.siphon.money/aspv2/compliance-fee/check?wallet=0xWALLET&product=kyc_year_v1"

# Verify KYC fee payment
curl -s -X POST https://api.siphon.money/aspv2/compliance-fee/verify \
  -H "Authorization: Bearer $ASP_SCREEN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"wallet":"0xWALLET","txHash":"0x…","chainId":8453,"product":"kyc_year_v1"}'
```

Widget token mint is proxied by siphon-app (`POST /api/zkme/token`), not exposed on asp-v2
public routes from the browser with the API key.

---

## Screening pipeline (asp-v2 internals)

```mermaid
flowchart LR
  REQ[POST /screen] --> L1{Layer 1}
  L1 -->|OFAC / mixer / oracle hit| DENY[deny]
  L1 -->|clear| ENT{kyt_entitlement?}
  ENT -->|no| FEE[402 kyt_fee_required]
  ENT -->|yes| ZK[zkMe risk/score]
  ZK -->|score OK| ADMIT[admit]
  ZK -->|high risk| DENY
  ZK -->|API down| DEG[deny or pending]
```

Implementation: `screen.py` → `zkme.py`. Audit: `screen_result` table, `GET /decisions`.

---

## Configuration

| Variable | Purpose |
|----------|---------|
| `ZKME_MCH_NO`, `ZKME_API_KEY` | Server KYT API (+ app widget token mint) |
| `ASP_COMPLIANCE_VAULT` | Fee recipient (both products) |
| `ASP_COMPLIANCE_FEE_WEI` / `ASP_COMPLIANCE_FEE_USDC` | ~$0.50 per product |
| `ASP_KYT_ENTITLEMENT_DAYS` | KYT window (default 365) |
| `ASP_KYC_ENTITLEMENT_DAYS` | KYC window (default 365) |

`/ready` lists `zkme_unconfigured` until `ZKME_*` keys are set. KYC fee tables
(`kyc_entitlement`, `kyc_fee_payment`) are created on `init_db` / first deploy after pull.

Deploy: [DEPLOY.md](./DEPLOY.md) · zkMe rollout: monorepo `audits/ASPV2_ZKME_DEPLOY.md`
