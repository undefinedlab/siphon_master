# Siphon Protocol — Updates

---

## Fee Payment via MetaMask (`payExecutionFee`)

**Flow:** ZK proof → MetaMask fee tx → strategy registration

Before a strategy is submitted to the executor, the user signs a `payExecutionFee` transaction on-chain. This locks the ZK proof into the contract, updates the Merkle commitment, and transfers the execution fee to the Entrypoint. The executor's ZK withdraw runs against the state root produced by this tx — so the fee tx must confirm first.

**Fee model** (`price_utils.tsx`):
- Base: **$5.00** flat
- Variable: **$0.15/hour** of strategy monitoring window
- Total converted to ETH at live Pyth price before MetaMask prompt

**Key constraint:** The proof passed to `payExecutionFee` must use `recipient = vault address` (not the user's wallet). The contract's `updateCommitment` verifies `pubSignals[4] == uint160(address(this))`.

---

## Note Management

Notes are the user-side record of a deposit commitment (nullifier + secret + amount). They live encrypted on the trade-executor DB and in localStorage as a fallback.

**Three-state spent tracking** (`spent: 'false' | 'pending' | 'true'`):

| State | Meaning |
|---|---|
| `false` | Unspent — available for a new strategy |
| `pending` | Strategy triggered, tx in-flight |
| `true` | Nullifier confirmed spent on-chain |

Scheduler sets `pending` before execution. On outcome:
- Success → `true`
- `FatalExecutionError` (ZK withdraw not yet sent) → `false`
- `NullifierSpentSwapFailed` (ZK withdraw confirmed, swap failed) → `true` — nullifier is spent, funds are in executor wallet

**REST API** (`trade-executor/notes.py`):
- `POST /notes` — save encrypted note
- `GET /notes` — fetch notes for authenticated wallet
- `POST /notes/<id>/mark_spent` — update spent state
- `DELETE /notes/<id>` — delete

**Frontend** (`noteStore.ts`):
- Notes encrypted with AES-GCM in-browser before upload. Server stores ciphertext + IV only.
- Encryption key derived from signing `'Siphon-Encryption-Key-v1'` (never transmitted, cached per session).
- Auth headers use a separate timestamp-rotating signature (`'Siphon auth v1:<timestamp>'`).
- `exportNotes` / `importNotes` — JSON backup/restore, wallet-authenticated.

---

## Server-Side Proving (`/api/prove`)

Proof generation moved off the browser. Flow:

1. Frontend sends circuit inputs to `/api/prove` (Next.js route)
2. Route writes inputs to a temp dir, runs `node generate_witness.js`, then `rapidsnark`
3. Returns `{ proof, publicSignals }`, cleans up temp files

~200ms vs ~10s browser-side. Configured via:
```
ZK_BUILD_DIR=siphon-zk/circuits/build
RAPIDSNARK_BIN=/opt/homebrew/bin/rapidsnark
```

If `NEXT_PUBLIC_PROVING_RELAYER_URL` is set, proof requests route to the external relayer with wallet-signed auth headers instead.

---

## EVM Execution (`evm_executor.py`)

**Swap routing:**
- Cross-chain → Li.Fi (mainnet only, not Sepolia)
- Same-chain ETH → ERC20 → Uniswap UniversalRouter: `WRAP_ETH (0x0b)` + `V3_SWAP_EXACT_IN (0x00)` in one tx
- Same asset → direct transfer

**Stuck tx / RBF:** When `pending_nonce > confirmed_nonce`, `send_tx()` bumps priority to 15 gwei, max fee to `4×base + priority`, and forces `nonce = confirmed_nonce` to replace the stuck tx.

**Gunicorn timeout:** Must start with `--timeout 700`. Sepolia block confirmation can take up to 600s.
```bash
gunicorn -w 1 -b 0.0.0.0:5005 --timeout 700 app:app
```

---

## Circuit (`siphon-zk`)

5 public signals: `[withdrawnValue, stateRoot, newCommitment, nullifierHash, recipient]`

Key decisions (do not revert):
- `LessEqThan(128)` for underflow — `Num2Bits(256)` does not catch BN254 field wraparound
- `pathIndex * (1 - pathIndex) === 0` — binary constraint on Merkle path indices
- 2-multiplication Selector via diff/swap identity
- `recipientSquare <== recipient * recipient` — binds recipient as public signal
- `IsZero().out === 0` passes when nullifiers differ (IsZero returns 1 when equal)

---

## Deployment

Backend — one server (EC2 c5.2xlarge or similar), all via Docker:

| Service | What it does | Port |
|---|---|---|
| Trade Executor | Flask — strategy DB, scheduler, ZK withdraw, swaps | 5005 |
| FHE Engine | Rust — evaluates encrypted strategy conditions | 5001 |
| Payload Generator | Rust — encrypts strategy payload before storing | 5009 |
| Proving Relayer | Python — rapidsnark ZK proof generation | 5010 |
| Postgres | Strategy + note storage | 5432 |
| Caddy | Reverse proxy + automatic HTTPS | 80/443 |

All six spin up with `docker compose up --build` from `siphon-fhe/`.

---

## Known Open Issues

| ID | Area | Issue |
|---|---|---|
| FHE-01 | Backend | Rotate committed private key; scrub git history |
| FHE-02 | Backend | `auth.py` returns 500 if `API_TOKEN` unset but doesn't abort on startup — app still starts |
| FHE-05 | Backend | `amountOutMinimum = 0` in `swap_eth_to_token()` — sandwich attack vector |
| F-01 | Frontend | `handler.ts` writes raw nullifier + secret to localStorage — needs AES-GCM encryption |
| Fee proof | Frontend | `payExecutionFee` proof must use `recipient = vault address` — currently uses user wallet, causing `InvalidZKProof` |
| Solana | Verifier | Build on-chain Groth16 verifier (currently trust-based relayer) |

## Fixed

**Contracts:**
- `initializeVaults()` — `onlyOwner` ✓
- Vault external functions — `onlyEntrypoint` + `nonReentrant` ✓
- `MerkleTree.insert` — `onlyVault` ✓
- `rootExists()` check on all vault operations ✓
- `MerkleTree` — `filledSubtrees` incremental pattern ✓
- `safeTransferFrom` in `Entrypoint.deposit` ✓
- `WithdrawalVerifier.sol` — Groth16 verifier with `uint[5]` public signals ✓

**Frontend:**
- `crypto.randomBytes(32)` for nullifier + secret generation ✓
- Encryption key derivation separated from auth signature in `noteStore.ts` ✓
- Error details stripped from `/api/prove` client response ✓
