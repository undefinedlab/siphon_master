# ZK + DB Revamp — Complete Reference

## What Was Built

End-to-end private note lifecycle on EVM (Sepolia). A user deposits ETH/USDC into the Siphon vault, which mints a ZK commitment. They can later withdraw by proving note ownership without revealing which deposit they are spending. A note DB (Supabase) persists encrypted notes across devices.

---

## Architecture Overview

```
Browser (localStorage + sessionStorage)
  └─ localNoteStore.ts      — encrypted note read/write, metadata scan
  └─ noteAuth.ts            — wallet-sig tag derivation, AES-GCM key, auth headers
  └─ commitmentStore.ts     — Supabase commitments table (spendable notes)
  └─ precommitmentStore.ts  — Supabase precommitments table (vault-mode output notes)
  └─ outputNoteResolver.ts  — resolves vault-output precommitments after on-chain deposit
  └─ zkHandler.ts           — proof generation, leaf scan, balance, generateZKData
  └─ handler.ts             — on-chain deposit / withdraw tx submission

Supabase (note DB)
  └─ precommitments table   — pending vault-output notes (nullifier/secret encrypted)
  └─ commitments table      — spendable notes (nullifier/secret encrypted)

Trade Executor (Python)
  └─ commitments.py         — nullifier registry endpoints
  └─ precommitments.py      — precommitment claim/release endpoints
```

---

## Note Lifecycle

### 1. Deposit (user-initiated)

**File:** `src/lib/handler.ts`

- User calls `deposit(amount, token)` → on-chain tx to `Entrypoint.deposit()`
- Vault emits `Deposited(amount, commitment, precommitment)` event
- On tx confirm, `generateCommitmentData()` (`zkHandler.ts:194`) is called with the actual amount
- Returns `{ nullifier, secret, commitment, precommitment, nullifierHash }`
- `writeNote(key, note, signer)` (`localNoteStore.ts:43`) saves the note encrypted to localStorage
- `postCommitment(signer, payload, asset, source)` (`commitmentStore.ts:26`) uploads encrypted note to Supabase

**localStorage key format:** `{chainId}-{symbol}-{commitment}`
e.g. `11155111-ETH-0xabc...`

**Supabase commitments row:**
```
{ tag, enc_blob, iv, asset, spent, chainId }
```
`enc_blob` = AES-GCM encrypted JSON `{ nullifier, secret, commitment, amount, nullifierHash, precommitment }`

---

### 2. Balance Scan

**File:** `src/lib/zkHandler.ts:388` — `getSpendableVaultBalance(chainId, tokenMap)`

1. `scanNoteMeta(prefix)` (`localNoteStore.ts:182`) — reads all localStorage keys with matching prefix, returns plaintext metadata (commitment, nullifierHash, amount, spent flag) without decrypting
2. For each unspent note: checks `leaves.has(commitment)` — on-chain leaf set via `getLeafSet(tokenAddress)` (cached 3 min)
3. Checks `vault.nullifiers(nullifierHash)` on-chain — if spent, marks note spent locally and skips
4. Sums remaining amounts per token

**Server sync (inside `generateZKData` only, not balance scan):**
- `fetchCommitments(signer)` pulls Supabase rows, decrypts, writes missing notes to localStorage via `writeNote`
- Detects metadata-only stubs (notes with no `nullifier_enc`) and upgrades them

---

### 3. Withdrawal (ZK proof + on-chain)

**File:** `src/lib/zkHandler.ts:491` — `generateZKData(chainId, token, amount, recipient, swap?)`

Steps:
1. Fetch on-chain leaf set (`getOnChainLeaves`) and Merkle root
2. Sync server commitments into localStorage
3. Greedy-select notes to cover `amount` (largest first, up to 6 notes — `MAX_NOTES = 6`)
4. For each selected note: `readNote(key, signer)` decrypts nullifier + secret from localStorage
5. Build Merkle path (`buildMerklePath`) for each note leaf
6. Compute `nullifierHash` via Poseidon, compute `changeCommitment` for leftover
7. Call proving relayer (`proofRelayer.ts`) → rapidsnark Groth16 proof
8. Return `ZKData` with `{ proof, publicSignals, nullifierHashes[], changeCommitment, spentDepositKeys[] }`

**Circuit public signals (5):** `[withdrawnValue, stateRoot, newCommitment, nullifierHash, recipient]`
Multi-note: `nullifierHash` = Poseidon of all nullifierHashes array.

**File:** `src/lib/handler.ts` — `withdraw(zkData, token, recipient, swap?)`
- Calls `Entrypoint.withdraw(proof, publicInputs, recipient, swap?)` on-chain
- On success: marks each spent note via `markNoteSpent(key)` + `markCommitmentSpent(signer, id)` (Supabase)

---

### 4. Vault-Mode Output Notes (swap output re-deposited into vault)

**File:** `src/lib/outputNoteResolver.ts`

**At strategy submission time** (`createVaultOutputNote`):
- Generate note secret material (`nullifier`, `secret`, `precommitment`) with amount=0 (unknown until swap executes)
- Save metadata-only pending record to localStorage: `siphon-pending-output-{chainId}-{symbol}-{precommitment}`
- Upload full note (with nullifier/secret) to Supabase precommitments table via `postPrecommitment`

**After strategy executes** (`resolvePendingOutputNotes`, called from `StrategyAutoExecutor.onExecuted`):
- For each `siphon-pending-output-*` key: call `resolveOutputNote(tokenAddress, precommitment, chainId)` — reads `Deposited` event from chain to get real amount + commitment
- Recover `nullifier`/`secret` from Supabase precommitment row (`serverMatch.decrypted`)
- `writeNote(noteKey, fullNote, signer)` — write spendable note to localStorage
- `postCommitment(signer, ...)` — write spendable note to Supabase commitments table
- `resolvePrecommitment(signer, id)` — mark Supabase precommitment row as resolved
- Remove pending localStorage key

---

## Supabase Tables

### `precommitments`
| column | type | notes |
|---|---|---|
| id | uuid | PK |
| tag | text | keccak256(sig)[0:20] for precomm table — wallet-derived, not stored address |
| enc_blob | text | AES-GCM base64 of `{ nullifier, secret, precommitment, asset, chainId }` |
| iv | text | AES-GCM IV base64 |
| status | text | `pending` → `claimed` → `resolved` |
| created_at | timestamptz | |

### `commitments`
| column | type | notes |
|---|---|---|
| id | uuid | PK |
| tag | text | keccak256(sig)[0:20] for comm table — separate from precomm tag |
| enc_blob | text | AES-GCM base64 of `{ nullifier, secret, commitment, amount, nullifierHash, precommitment, chainId }` |
| iv | text | AES-GCM IV base64 |
| asset | text | token symbol e.g. `ETH` |
| spent | text | `false` / `true` / `pending` |
| chain_id | int | EVM chain ID |
| source | text | deposit source e.g. `deposit`, `vault-output` |
| created_at | timestamptz | |

---

## Auth Model (noteAuth.ts)

Two separate wallet-derived tags — one per table. Prevents cross-join attacks even with full DB dump.

```
precomm-tag = keccak256(walletSig("Siphon precomm-tag v1"))[0:20 bytes]
comm-tag    = keccak256(walletSig("Siphon comm-tag v1"))[0:20 bytes]
enc-key     = SHA-256(walletSig("Siphon-Encryption-Key-v1"))  → AES-GCM key
```

Auth headers per request: `X-Tag`, `X-Wallet-Address`, `X-Signature`, `X-Timestamp`
- Signature covers `wallet + tag + timestamp` — server recovers signer to validate
- TTL: 270s (4.5 min) — cached in sessionStorage so HMR reloads don't re-prompt MetaMask
- Enc key stored as hex in sessionStorage — re-imported without re-signing

---

## localNoteStore.ts — Encrypted Storage Format

**Encrypted note** (full, spendable):
```json
{
  "nullifier_enc": "<base64>",
  "nullifier_iv":  "<base64>",
  "secret_enc":    "<base64>",
  "secret_iv":     "<base64>",
  "commitment":    "0x...",
  "precommitment": "0x...",
  "nullifierHash": "...",
  "amount":        "0.01",
  "spent":         false
}
```

**Metadata-only stub** (no `nullifier_enc` — vault-output pending note):
```json
{
  "commitment":    "0x...",
  "precommitment": "0x...",
  "nullifierHash": "...",
  "amount":        "0.01",
  "spent":         false
}
```

`scanNoteMeta(prefix)` reads the plaintext fields only (no decryption) — used for balance scan.
`readNote(key, signer)` decrypts nullifier + secret — used only at withdrawal time.

---

## Nullifier Registry (Trade Executor)

**File:** `siphon-fhe/trade-executor/commitments.py`

Endpoints:
- `POST /commitments/claim` — marks nullifier `in-strategy` (atomic guard against double-spend)
- `POST /commitments/release` — DELETE row (used when strategy execution fails before ZK withdraw)
- `POST /commitments/spent` — marks nullifier `spent` (called after on-chain ZK withdraw confirms)

Lifecycle: `in-strategy` → `spent` (success) or DELETE (failure before withdraw)

**Precommitments:** `siphon-fhe/trade-executor/precommitments.py`
- `POST /precommitments/claim` — marks `claimed` (executor is processing it)
- `POST /precommitments/release` — marks `pending` (rollback)
- `POST /precommitments/resolve` — marks `resolved` (deposit confirmed)

---

## Key Files — Quick Reference

| File | Role |
|---|---|
| `src/lib/zkHandler.ts` | Proof generation, leaf scan, balance, Merkle path |
| `src/lib/handler.ts` | On-chain deposit / withdraw tx |
| `src/lib/localNoteStore.ts` | Encrypted localStorage read/write, metadata scan |
| `src/lib/noteAuth.ts` | Tag derivation, enc key, auth headers, AES-GCM helpers |
| `src/lib/commitmentStore.ts` | Supabase commitments CRUD |
| `src/lib/precommitmentStore.ts` | Supabase precommitments CRUD |
| `src/lib/outputNoteResolver.ts` | Vault-output note lifecycle |
| `src/lib/proofRelayer.ts` | Calls proving-relayer `/prove` endpoint |
| `src/components/StrategyAutoExecutor.tsx` | Background poller, fires `siphon:strategyExecuted`, cleans up spent notes |
| `siphon-fhe/proving-relayer/app.py` | rapidsnark proof generation service (port 5010) |
| `siphon-fhe/trade-executor/commitments.py` | Nullifier registry |
| `siphon-fhe/trade-executor/precommitments.py` | Precommitment registry |

---

## Known Gaps (not yet implemented)

- **Change note not posted to Supabase** — after multi-note withdrawal, the change note is saved to localStorage but not uploaded to Supabase commitments table. Needs a `postCommitment` call in the withdraw confirm handler.
- **Supabase commitment rows not marked spent** for locally-originated notes — `markCommitmentSpent` requires a server row `id`, which is only available if the note came from `fetchCommitments`. Notes created locally (not synced from server) have no `id` and are silently skipped.
- **Change note saved before on-chain confirm** — `generateZKData` saves the change note to localStorage at proof generation time, before the tx confirms. If the tx fails, a phantom spendable note exists until the nullifier check during the next balance scan clears it.
- **Spare pool routes through executor** instead of Supabase direct — `sparePool.ts` calls the trade executor to claim a precommitment rather than hitting Supabase directly.
