# Handoff — Remaining Sepolia Tests (pause / ragequit / fees / adversarial)

**Status as of 2026-08-16:** the Hard ASP production-key dry run has PASSED its two main paths
(manual W1 withdraw + FHE strategy via sealed TEE → `swapAndDeposit` re-shield). See
`SEPOLIA_PRODKEY_DRYRUN_2026-08-15.md` for that evidence. This document covers **everything still
outstanding before Base**, with enough detail to be executed by someone who was not in the session.

> ⚠️ Read "Known gaps found while writing this" (§7) FIRST — two of them change what you should
> expect the tests to do.

---

## 1. Environment

### 1.1 Staging host

| Item | Value |
|---|---|
| Host | `54.221.134.175` |
| SSH | `ssh -i ~/Downloads/Siphon.pem ubuntu@54.221.134.175` (**Siphon.pem**, *not* Siphonnew.pem) |
| Compose root | `~/siphon-release/siphon-fhe/` |
| Compose file | `docker-compose.prod.yml` (backup: `.bak-20260815-appenv`) |
| Env file | `~/siphon-release/siphon-fhe/.env` (backup: `.env.bak-20260815-prodkeys`) |
| App bundle | `~/siphon-release/frontend-runtime/current/.next` (backup: `.next.bak-20260815-prodkeys`) |
| Browser ZK artifacts | `~/siphon-release/siphon-app/public/zk/` (dev-beacon backup: `*.bak-20260815-devbeacon`) |
| Relayer ZK artifacts | `~/siphon-release/zk-build-current/` (same backup suffix) |

**Do not** SSH the old MCP box `16.16.173.107`. This host (`54.221…`) is the only one in play.

### 1.2 URLs

| Purpose | URL |
|---|---|
| App (test here) | `https://app-54-221-134-175.sslip.io/dapp` |
| API origin (executor/gateway/relayer) | `https://54-221-134-175.sslip.io` |
| Legacy app (soft era, withdraw-only) | `https://legacy-54-221-134-175.sslip.io` |

**Gotcha:** `curl` gets **403 "Access denied."** from the app — that is the anti-crawler middleware
rejecting non-browser user agents, *not* an outage. Probe with a browser UA:
```bash
curl -sk -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36" \
  https://app-54-221-134-175.sslip.io/zk/CEREMONY.json
```

### 1.3 Containers

```
docker ps --format "{{.Names}}\t{{.Status}}\t{{.Ports}}" | sort
```

| Container | Internal address | Role |
|---|---|---|
| `siphon-app-current` | `siphon-app-current:3000` | Next.js app (v2 / Hard ASP) |
| `siphon-trade-executor` | `siphon-trade-executor:5005` | strategies, relayWithdraw, scheduler |
| `siphon-api-gateway` | `siphon-api-gateway:8000` | commercial API `/v1/*` |
| `proving-relayer` | `proving-relayer:5010` | server-side proving (`/prove`) |
| `siphon-asp` | `siphon-asp:5055` | screening + association set |
| `siphon-asp-watcher` | — | admits labels, publishes roots (20s loop) |
| `siphon-indexer-sepolia` | `127.0.0.1:42070` | **current** Sepolia indexer |
| `siphon-indexer-sepolia-legacy` | `127.0.0.1:42071` | soft-era indexer |
| `siphon-indexer-base` | `127.0.0.1:42069` | Base (currently **unhealthy** — pre-existing, unrelated) |
| `syphon-fhe-engine` | `fhe-engine:5001` | FHE evaluation |
| `siphon-postgres` / `siphon-redis` / `siphon-caddy` | — | infra / TLS edge |

Restart pattern (never `--build`, it cascades into a ~20min FHE-engine rebuild):
```bash
cd ~/siphon-release/siphon-fhe
docker compose -f docker-compose.prod.yml up -d --no-deps --no-build --force-recreate <service>
```
For `.py`-only executor changes: `docker cp file siphon-trade-executor:/app/file && docker restart siphon-trade-executor`.

### 1.4 Contracts — Sepolia generation `sepolia-hard-asp-v2-20260815`

| Item | Address |
|---|---|
| **Entrypoint** | `0x568C03C9d44C7EBbbF63b1e8415CB55FDd3E55f4` (deploy block 11495159) |
| NativeVault (ETH) | `0x5E62C965E52D6A408C2E33e8FE0611cA47E811Ba` |
| USDC Vault | `0xFEd3A2C6cF39d19B1038835D0AAD1FE8126F751A` |
| USDC token | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| WETH | `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14` |
| PoseidonT3 | `0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93` (canonical, pre-existing) |
| NativeVaultFactory | `0x9914607830Cf1C9b5ad7B9c29f4D59CC037A066b` |
| AltVaultFactory | `0xe6baDdCEd078B5B523d8B5e51c93Bf22c52B24aE` |

**Roles (live values, verified by `eth_call`):**

| Role | Value |
|---|---|
| `owner()` | `0xc5b7b574EE84A9B59B475FE32Eaf908C246d3859` (deployer EOA — Sepolia only; **Base uses the Safe**) |
| `aspPostman()` | `0xe3C781b49Cff389481dc27bbbB5C56099822E2B1` |
| `paused()` | `false` |
| `swapAndDepositFeeBps()` | **`0`** ← see §7.1 |
| `swapAndDepositFeeCollector()` | **`0x0`** ← see §7.1 |
| `swapAndDepositPermissionless()` | `false` (allowlist mode; executor allowlisted block 11497026) |

Contracts repo for scripts: `~/Siphon/tmp/legacy-exit-release/siphon-contracts/evm`
(branch `codex/legacy-exit-release-contracts`). **This is the checkout with the reviewed ceremony
verifiers** — see §7.4.

### 1.5 Quick health check

```bash
# on the host
docker exec siphon-asp curl -s http://localhost:5055/ready          # {"ready":true}
curl -s http://127.0.0.1:42070/identity                             # generation + entrypoint + lag
docker exec siphon-trade-executor curl -s http://localhost:5005/health
# from anywhere — on-chain sanity
cd siphon-contracts/evm && python3 scripts/check_hard_asp_live.py \
  --chain 11155111 --entrypoint 0x568C03C9d44C7EBbbF63b1e8415CB55FDd3E55f4
```

---

## 2. Test A — Pause (exits must stay open)

**What it proves:** the owner can stop new risk-taking without ever trapping user funds. This is the
single most important safety property of the governance design.

**Contract facts (verified in source, `Entrypoint.sol`):** `whenNotPaused` is applied to
**`deposit` (L205), `swapAndDeposit` (L290), `swap` (L327)** — and is **absent** from
**`withdraw` (L222)** and **`ragequit` (L383)**.

### Preparation
You need **two live notes** before pausing (you cannot create one while paused):
1. one ETH note to withdraw during pause,
2. one note to ragequit in Test B (can be the same deposit round; make two deposits).

Deposit via the app, then wait ~20–40s for the watcher to admit each label and republish the root
(see §5 — this wait is mandatory or withdrawals fail with "Label not admitted yet").

### Steps
```bash
cd ~/Siphon/tmp/legacy-exit-release/siphon-contracts/evm
# 1. Pause  (owner EOA; PRIVATE_KEY in evm/.env)
npx hardhat console --network sepolia
> const ep = await ethers.getContractAt("Entrypoint","0x568C03C9d44C7EBbbF63b1e8415CB55FDd3E55f4")
> await (await ep.setPaused(true)).wait()
> await ep.paused()            // true
```
Then in the browser:

| # | Action | Expected |
|---|---|---|
| A1 | Deposit any amount | **REVERTS** (`EnforcedPause` / paused) |
| A2 | Run a strategy (swapAndDeposit path) | **REVERTS** |
| A3 | **Withdraw an existing note** | **SUCCEEDS** ← the critical one |
| A4 | **Ragequit an existing note** (§3) | **SUCCEEDS** |
| A5 | Unpause, re-run A1 | succeeds again |

```bash
> await (await ep.setPaused(false)).wait()
```

**Record:** tx hashes for pause/unpause, the reverted attempts, and the successful withdraw-while-
paused. A3 failing would be a **launch blocker**.

---

## 3. Test B — Ragequit

**What it proves:** the user's unilateral escape hatch. Ragequit returns a deposit to its **original
depositor** without needing ASP membership — the answer to "what if the ASP censors me". It is the
counterweight to the whole compliance layer, so it must be exercised at least once on production keys.

### ⚠️ There is no ragequit button in the UI
`ragequit` exists only as a library function — `src/lib/handler.ts:824`:
```ts
export async function ragequit(_token: string, _noteKey: string)
```
No component calls it (verified: zero matches in `src/components`). **You must invoke it from the
browser devtools console**, or add a temporary dev button.

### Steps
1. Open `https://app-54-221-134-175.sslip.io/dapp`, connect the wallet that made the deposit
   (ragequit pays back the **original depositor** — a different wallet will fail).
2. Find the note key. Notes live in `localStorage`; list them in the console:
   ```js
   Object.keys(localStorage).filter(k => k.includes('note') || k.includes('siphon'))
   ```
   Identify the unspent ETH note's `noteKey` (canonical form — see §7.3).
3. Call it. The app exposes modules through its bundle; easiest path is to add a temporary
   `window.__ragequit = ragequit` export in `handler.ts` and rebuild (§6), then:
   ```js
   await window.__ragequit('ETH', '<noteKey>')
   // → { success: true, transactionHash: '0x…' }
   ```
4. Verify on-chain: the nullifier is spent, funds landed at the depositor address, and the note is
   marked spent locally.

**Note:** `ragequit()` calls `assertHardAspLive(chainId)` first, so it will refuse if the Entrypoint
isn't Hard ASP — that's expected and is itself a check worth recording.

**Circuit exercised:** `RagequitVerifier` (`0x…` deployed in this generation) — this is the **only
one of the 14 production circuits not yet exercised on-chain**, which is why this test matters.

---

## 4. Test C — Fees

**What it proves:** the protocol actually collects what the UI quotes, and fee caps hold.

### Two independent fee systems

**(a) swapAndDeposit fee** — `Entrypoint.setSwapAndDepositFee(uint16 bps, address collector)`
- Hard cap `MAX_SWAP_AND_DEPOSIT_FEE_BPS = 100` (**1%**), enforced on-chain (`FeeConfigCapExceeded`).
- `bps > 0` requires a non-zero collector (`ZeroAddress` revert otherwise).
- **Currently `bps=0`, `collector=0x0` on Sepolia v2 → no fee is being skimmed at all.** See §7.1.

**(b) Withdrawal fee** — `Entrypoint.setVaultFeeConfig(address asset, WithdrawFee.FeeConfig cfg)`,
with caps **and a timelock enforced inside the Vault**. This is the `flatGas`/relay-cost fee that has
historically been mis-calibrated (Base flatGas was once 9.3× real cost, causing
`WithdrawalCostExceedsAmount` on small withdrawals).

### Steps
```bash
npx hardhat console --network sepolia
> const ep = await ethers.getContractAt("Entrypoint","0x568C03C9d44C7EBbbF63b1e8415CB55FDd3E55f4")
# C1 — cap enforcement (must revert)
> await ep.setSwapAndDepositFee(101, "0xc5b7b574EE84A9B59B475FE32Eaf908C246d3859")   // expect FeeConfigCapExceeded
# C2 — zero-collector guard (must revert)
> await ep.setSwapAndDepositFee(50, ethers.ZeroAddress)                              // expect ZeroAddress
# C3 — set a real fee
> await (await ep.setSwapAndDepositFee(30, "<collector>")).wait()                    // 0.30%
> await ep.swapAndDepositFeeBps()                                                    // 30
```
Then run a strategy (§ dry-run doc) and verify:

| # | Check |
|---|---|
| C4 | Collector balance increased by **exactly** `amountOut × 30/10000` |
| C5 | The re-shielded note value equals `amountOut − fee` |
| C6 | UI-quoted fee matches what was actually skimmed (**this is the mismatch in §7.1**) |
| C7 | Withdrawal fee: quote a small ETH withdrawal, confirm the deducted amount matches config and that a dust-sized withdrawal is not bricked by `WithdrawalCostExceedsAmount` |

Reset to `setSwapAndDepositFee(0, ZeroAddress)` afterwards if you want to leave staging as found.

---

## 5. Test D — Adversarial suite

**All of these MUST revert.** They are the negative-space proof that Hard ASP enforcement is real.
Most can be driven as Hardhat tests against a fork; some need a crafted browser call.

| # | Case | How | Expected |
|---|---|---|---|
| D1 | **Stale ASP root** | Build a withdraw proof against a previous root, then push ≥32 new roots so it falls out of the ring | revert (root not in ring) |
| D2 | **Root not yet published** | Deposit, then withdraw *before* the watcher publishes | app: "Label not admitted yet"; direct contract call: revert |
| D3 | **Replayed nullifier** | Withdraw a note, then submit the identical proof again | revert (nullifier already spent) |
| D4 | **Wrong chain** | Submit a Sepolia-generated proof to another chain's Entrypoint | revert |
| D5 | **Malformed proof** | Flip a byte in `pA`/`pB`/`pC` | `InvalidZKProof()` |
| D6 | **Unadmitted label** | Craft an ASP path for a label never admitted | revert |
| D7 | **Non-postman root publish** | Call `updateAspRoot` from any other key | revert (`onlyAspPostman`) |
| D8 | **Non-owner governance** | Call `setPaused` / `setSwapAndDepositFee` / `setAspPostman` from a non-owner | revert (`onlyOwner`) |
| D9 | **Non-allowlisted relayer** | Call `swapAndDeposit` from a key not in `swapAndDepositRelayers` | revert |

**Existing coverage to build on** (`siphon-contracts/evm/test/`):
- `PauseOwnership.test.ts` — two-step ownership, pause-keeps-exits-open (covers A3 in unit form, D8)
- `AspRootRegistry.security.test.ts` — postman gating, root ring eviction (covers D7, part of D1)
- `SwapSecurity.test.ts` — swap/relayer paths (covers D9)

Run: `npx hardhat test test/PauseOwnership.test.ts test/AspRootRegistry.security.test.ts test/SwapSecurity.test.ts`
(4 of these passed during the fork rehearsal — re-run and extend with D1–D6.)

---

## 6. Rebuilding / redeploying the app (you WILL need this)

`NEXT_PUBLIC_*` values are **inlined at build time**, and this deployment has **no runtime env for
them** — anything not passed at build silently becomes `undefined`. Always build with the full set:

```bash
cd ~/Siphon/tmp/legacy-exit-release/siphon-app
NEXT_PUBLIC_ETH_SEPOLIA_ENTRYPOINT=0x568C03C9d44C7EBbbF63b1e8415CB55FDd3E55f4 \
NEXT_PUBLIC_ETH_SEPOLIA_DEPLOY_BLOCK=11495159 \
NEXT_PUBLIC_SEPOLIA_ACTIVE_VAULT_GENERATION=sepolia-hard-asp-v2-20260815 \
NEXT_PUBLIC_ZK_CEREMONY=mpc \
NEXT_PUBLIC_ADMIN_WALLETS=0xc5b7b574EE84A9B59B475FE32Eaf908C246d3859 \
NEXT_PUBLIC_DECRYPTOR_MEASUREMENT=c4265baf6bb8ee6745df2ca3fd169ff721986afb258e14c7c0deb18ddd6db389 \
NEXT_PUBLIC_TEE_AUTONOMOUS=true \
npx next build

cp -r .next/static .next/standalone/.next/static
rsync -az --delete --exclude cache -e "ssh -i ~/Downloads/Siphon.pem" \
  .next/standalone/.next/ ubuntu@54.221.134.175:/home/ubuntu/siphon-release/frontend-runtime/current/.next/
ssh -i ~/Downloads/Siphon.pem ubuntu@54.221.134.175 \
  'cd ~/siphon-release/siphon-fhe && docker compose -f docker-compose.prod.yml up -d --no-deps --no-build --force-recreate siphon-app-current'
```

- **`NEXT_PUBLIC_ADMIN_WALLETS`** — without it the BASE/ETHEREUM network toggle is invisible **to
  everyone** (it is admin-gated), and you cannot switch the app to Sepolia at all.
- **`NEXT_PUBLIC_DECRYPTOR_MEASUREMENT`** — the enclave compose-hash. **Re-fetch it before each
  build; it rotates on every CVM upgrade:**
  ```bash
  docker exec siphon-trade-executor python3 -c "
  import os,json,urllib.request
  d=json.loads(urllib.request.urlopen(os.getenv('DECRYPTOR_URL').rstrip('/')+'/attestation',timeout=15).read())
  ev=d['event_log']; ev=json.loads(ev) if isinstance(ev,str) else ev
  print([e['event_payload'] for e in ev if 'compose' in (e.get('event') or '')][0])"
  ```
  Verification (inlined name gone = value baked in):
  `grep -rl NEXT_PUBLIC_DECRYPTOR_MEASUREMENT .next/static/chunks | wc -l` → **0**

---

## 7. Known gaps found while writing this — READ BEFORE TESTING

### 7.1 🔴 Fees are not configured, but the UI quotes them
`swapAndDepositFeeBps() == 0` and `swapAndDepositFeeCollector() == 0x0`, yet the strategy modal
quotes *"Execution fee (per fill) $0.30 — max($0.20, 0.20%) + $0.10 gas · deducted from the fill"*
and the executor logged *"swapAndDeposit on-chain skim handles protocol fee"*. **With bps=0 nothing
is skimmed.** So either the UI quote is cosmetic-only, or fee collection is silently disabled.
**Resolve this before Base** — decide the intended bps/collector, set them, and re-verify C4–C6.
Base must not launch with a quoted-but-uncollected fee (revenue loss) or an uncommunicated one.

### 7.2 🟠 Vault balances need reconciliation before fee testing
Post-strategy observed balances: ETH vault **0.0 ETH**, USDC vault **25.585669 USDC**. The strategy
swapped 0.001 ETH → ~1.88 USDC, so the USDC vault holds materially more than this session created.
Establish where the rest came from before using balance deltas as fee evidence (C4/C5 depend on it).

### 7.3 🟠 Note keys must be canonical
Slice/note lookups must use the canonical `noteKey()` form. A non-canonical key silently yields
"Have 0.0" rather than an error — this previously cost significant debugging time on TWAP splits.

### 7.4 🔴 Deploy only from the reviewed checkout
Two contract checkouts exist with **different verifiers**:
- ✅ `~/Siphon/tmp/legacy-exit-release/siphon-contracts` — branch `codex/legacy-exit-release-contracts`,
  reviewed ceremony verifiers (w1 zkey `525275fa…`)
- ❌ `~/Siphon/siphon-contracts` — branch `codex/legacy-exit-production-upgrade`, **older non-ceremony
  verifiers** (w1 zkey `8d2db1e6…`)

A first Sepolia deploy was made from the wrong one and discarded (`0xbD1dA154…` — **do not use**).
Always verify before deploying:
```bash
head -2 src/verifiers/WithdrawalVerifier1.sol   # must show sha256=525275fa…
```

### 7.5 🟠 Executor `/precommitments` returns 401
Note backups are **browser-only** — clearing site data loses recovery metadata (funds are still
recoverable from the note itself, but the convenience path is gone). Pre-existing endpoint-auth gap
(audit items C3/M4). Do not clear browser storage mid-test.

### 7.6 🟠 Scheduler gate
`RUN_SCHEDULER_IN_WORKER` was `0` on this host, so armed strategies sat `PENDING` forever. It is now
`1` (safe here: gunicorn runs a **single** worker). With multiple workers this would double-execute —
Base must explicitly choose worker-scheduler vs a dedicated `scheduler_main.py` service.

### 7.7 🔴 Staging-only overrides that MUST NOT reach Base
| Override | Where | Why it's on |
|---|---|---|
| `WORLD_ID_ELIGIBILITY_REQUIRED=false` | compose, app service | no World ID portal credentials on this host |
| owner is an EOA, not a Safe | Sepolia Entrypoint | staging convenience; **Base owner = Safe `0x74F5f4C010bAC584830538084A5cfE47E477a062` (2-of-2)** |

---

## 8. Base post-deploy checklist (derived from what this dry run caught)

1. Deploy with `REQUIRE_HARD_ASP_PREFLIGHT=1` from the **reviewed** checkout (§7.4).
2. `transferOwnership` → Safe `acceptOwnership` (2-of-2).
3. `setAspPostman(0x6adB76276Fd21F022BDfee3DB10307e881f2a46D)` — funded with Base ETH.
4. **`setSwapAndDepositRelayer(<executor>, true)`** — a fresh Entrypoint has an EMPTY allowlist and
   **every strategy reverts** until this is called. Script: `scripts/setSwapRelayer.ts`.
5. `setSwapAndDepositFee(<bps>, <collector>)` — resolve §7.1 first.
6. Provision real World ID credentials; remove the staging override.
7. Choose the scheduler topology (§7.6).
8. Build the app with the **full** `NEXT_PUBLIC_*` set incl. a **freshly fetched** decryptor
   measurement (§6).
9. Stand up a distinct Base-current indexer; verify `/identity` before trusting its leaves.
10. Publish the first ASP root; confirm `currentAspRoot() != 0`.
11. Only then flip `base-hard-asp-v1` to ACTIVE in the generation manifest and re-pin the digest.

---

## 9. Evidence already captured (do not redo)

| Path | Tx | Block |
|---|---|---|
| W1 withdraw, production keys | `0x828bd8d2cd6ab373b5ccec6a7aff8c56b221a6767a74404b467f7be6b795f1b5` | 11495978 |
| FHE strategy → `swapAndDeposit` re-shield | `0x7b907d13021724a99cd7c4f4d0629fe4992ed2636745c0336119d97b04323db0` | 11497153 |
| Relayer allowlisted | `0xed4efa7f…` | 11497026 |
| First ASP root published | root `18694893…337843` | — |

Circuits exercised on-chain so far: **W1** and **Swap**. Merge (M2–M6), Split, and **Ragequit**
remain unexercised with production keys — Ragequit is covered by Test B; consider a multi-note
withdraw to touch a Merge circuit and a TWAP/split run to touch Split before Base.
