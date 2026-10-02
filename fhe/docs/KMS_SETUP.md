# Siphon KMS-side setup — architecture, decisions, and open work

_Compiled 2026-07-12 from live code + running CVM state. Source of truth is the code;_
_this doc explains the "why" and the decisions taken across sessions._

Siphon runs signing + decryption inside a **Phala dstack CVM** (Intel TDX). "KMS" here means the
**dstack KMS** — a key-derivation service the guest agent exposes at `/var/run/dstack.sock`. It
derives keys **deterministically from the CVM's on-chain `app_id`**, inside the enclave. The raw
key never leaves the TEE, is never written to disk, and is never in env.

CVM: `app_5a537a713665c4620738254f6b92d76d513b01cf` (dstack-0.5.9, tdx.small, prod9).
Two containers: `dstack-siphon-order-signer-1` (:5003) and `dstack-siphon-decryptor-1` (:5002).

---

## 1. What the KMS gives us

`DstackClient().get_key(path)` returns a **deterministic, app-bound** key for a string path.

- **Deterministic per `app_id`** — same path always yields the same key for this CVM. Changing the
  path string changes the derived key/address, so paths are treated as fixed constants.
- **Enclave-only** — derived in TDX RAM on demand; no plaintext key at rest, in env, or in logs.
- **Replica/reboot-safe** — because it's re-derived from the KMS (not stored), it **survives
  `phala cvms replicate` and reboots**. This is how the 2026-07-08 zpool boot-loop recovery kept
  the same Polygon address after a fresh data disk.
- **Attestable** — `get_key` returns a signature chain proving the key was derived in a genuine
  TEE, which a client can verify (fail-closed).

---

## 2. The two KMS consumers

### 2a. Order-signer — Polygon/Polymarket signing key
`order-signer/app.py`

- **Path:** `KMS_KEY_PATH = "siphon/polymarket/polygon"` (fixed constant, line ~33).
- **Derivation:** `DstackClient().get_key(KMS_KEY_PATH).decode_key()` → 32 raw bytes →
  `eth_account.Account.from_key(...)` → a normal `LocalAccount`. Cached in-process (`_account_cache`).
- **Derived address (live-confirmed):** **`0x31c9a52Dc09D5c0e61256cA04156A528ecc63cf9`**
- **Used for:**
  - Polygon tx signing (Polymarket order/approve/redeem via `_send`).
  - **Receipt notary** — `/receipt/sign` signs a compliant-receipt EIP-191 digest with this key and
    returns the address as `attestation_ref` (the compliance-authority story).
- **Fallback:** `POLYGON_EXECUTOR_KEY` env → **local dev only**; never set in the CVM. `_signer_mode()`
  returns `"dstack-kms"` when the env key is absent.
- **Attestation:** `GET /attestation` returns a TDX quote with
  `report_data = sha256("siphon-order-signer:" + address)` plus the `get_key` signature chain, so a
  client can prove it's talking to the genuine KMS-keyed signer and not a look-alike address.
  Executor-side verification: `trade-executor/dcap_verify.py` (fail-closed; `POLYMARKET_DCAP_VERIFY=0`
  is the offline-dev escape).

### 2b. Decryptor — at-rest storage-seal key
`decryptor/src/main.rs`

- **Path:** `get_key("siphon-decryptor/storage-seal", "encrypt")`.
- **Use:** the KMS material is domain-separated (`chain_update(b"siphon-decryptor-storage-seal:")`)
  into an **XChaCha20-Poly1305** key. Uploaded FHE `ClientKey`s are persisted to the encrypted
  volume as `.sealed` files (24-byte nonce prepended). Useless without the enclave, even to someone
  holding the decrypted disk.
- **Why it matters:** the seal key is **app-scoped**, so it survives reboots **and** replicas —
  unlike the per-boot x25519 *upload*-sealing key. This is exactly why the 9 persisted ClientKeys
  survived the Layer-2 upgrade on 2026-07-12 ("loaded 9 persisted client key(s) from disk").
- **Fallback:** no KMS socket (local dev) → plaintext-hex `.hex` persistence.

---

## 3. Key decision: KMS-derived vs imported keys

Not everything is KMS-derived. The split, and why:

| Key | Source | Address | Rationale |
|---|---|---|---|
| Polygon signer | **KMS-derived** | `0x31c9a52D…` | Fresh address, no pre-funding constraint → let the TEE mint it. Zero key-at-rest. |
| Decryptor storage-seal | **KMS-derived** | — (symmetric) | Must be stable across replicas to unseal old ClientKeys. |
| Base executor | **Imported env** (`BASE_EXECUTOR_KEY`) | `0x5830A431…` | Pre-existing **funded/whitelisted** wallet — must be a *specific* address, which KMS derivation can't target. |
| Sepolia executor | **Imported env** (`EVM_EXECUTOR_KEY`) | `0xc5b7b574…` | Same — specific pre-funded address. (`ETH_SEPOLIA_EXECUTOR_KEY` intentionally unset → falls back to `EVM_EXECUTOR_KEY`.) |

**The tradeoff this creates (and the 2026-07-12 incident):** imported keys live in the CVM's
**encrypted env**, gated by the app-compose `allowed_envs` whitelist. KMS-derived keys don't depend
on env at all. So:

- A `phala cvms upgrade` **without `-e`** reset `allowed_envs` → `[]`, which **dropped the imported
  Base/Sepolia keys and `ORDER_SIGNER_TOKEN`** → order-signer went fully `unauthorized`, EVM signing
  down. The **KMS Polygon key was unaffected** (re-derived on demand).
- Recovery: re-`upgrade` **with the exact original 9-var env file** → `allowed_envs` restored → and
  because the var-NAME set matched, the `compose_hash` returned to the original `c4265baf…`, so **no
  measurement repin was needed**. Keys verified to derive to `0x5830…`/`0xc5b7…` before deploy.

**Lesson / rule:** always pass the full env file on any `cvms upgrade`. The 9 names are:
`ORDER_SIGNER_TOKEN, POLYGON_RPC, POLYMARKET_FUNDER, POLYMARKET_BUILDER_CODE,
POLYMARKET_BUILDER_API_{KEY,SECRET,PASSPHRASE}, BASE_EXECUTOR_KEY, EVM_EXECUTOR_KEY`
(empty values still count toward `allowed_envs`). Backup at
`~/Desktop/siphon-secrets-backup-*/cvm-order-signer.env`.

---

## 4. Attestation / measurement pinning (how clients trust the KMS keys)

- The **`compose_hash`** (app-compose measurement) is the pin. Current: `c4265baf…`.
  It is driven by `allowed_envs` (var-name set) **and** the compose text — change either and it
  rotates. Get it after any change via `phala cvms get <app_id> --json → compose_hash`.
- Two places pin it, **must move together** (they didn't need to on 2026-07-12 because the hash
  returned to the original):
  - App (Vercel): `NEXT_PUBLIC_DECRYPTOR_MEASUREMENT` — gates the sealed ClientKey upload.
  - EC2 executor: `ORDER_SIGNER_MEASUREMENT` — gates the bridge to the signer (fail-closed).
- CLOB L2 creds are **enclave-RAM only** — `POST /polymarket/deriveCreds` once after every signer
  restart (they are derived from the KMS Polygon key, never persisted).

---

## 5. Open items / where to work next

- **Migrate Base/Sepolia to KMS?** Would remove the env-drop failure mode entirely, but requires
  moving funds to fresh KMS-derived addresses (and re-whitelisting anywhere those addresses are
  referenced: `NEXT_PUBLIC_*_EXECUTOR_ADDRESS`, withdraw recipients baked into ZK proofs, indexer).
  Big change — weigh against just always passing `-e`.
- **Key rotation of imported wallets** — the Base/Sepolia private keys were pasted into chat on
  2026-07-12. Same keys already in the CVM, so no new enclave exposure, but rotating both wallets
  would close the transcript-exposure gap.
- **Digest-pin the images** — the compose uses `:latest`, so the measurement does not cryptographically
  bind the exact decryptor/signer binary. Pinning `@sha256:…` is stricter but rotates the pin every
  deploy (repin dance). Deliberate hardening decision, not yet taken.
- **`SIPHON_DEV_PLAINTEXT_KEY`** still present in the decryptor compose as a fallback; removing it
  rotates the compose-hash — do it as one deliberate pin-rotation deploy.
- **CLOB creds auto-derive** — currently a manual `POST /deriveCreds` after each restart; could be
  wired to run on boot.

---

## 6. Quick reference

```bash
# EC2 (holds executor + all the pins/tokens)
ssh -i ~/Downloads/Siphon.pem ubuntu@3.81.144.108

# KMS Polygon signer address (live)
curl -s "$ORDER_SIGNER_URL/attestation"        # → 0x31c9a52D…

# EVM signer addresses (imported keys)
curl -s -H "X-API-TOKEN: $EVM_SIGNER_TOKEN" "$ORDER_SIGNER_URL/evm/address?chain_id=8453"      # 0x5830…
curl -s -H "X-API-TOKEN: $EVM_SIGNER_TOKEN" "$ORDER_SIGNER_URL/evm/address?chain_id=11155111"  # 0xc5b7…

# Measurement after any change
phala cvms get app_5a537a713665c4620738254f6b92d76d513b01cf --json | jq -r .compose_hash

# ALWAYS pass -e on upgrade (else env is dropped)
phala cvms upgrade app_5a537… --compose ./decryptor/docker-compose.yml -e <full-env-file>
```

Related memories: `cvm-signing-architecture`, `dcap-attestation-status`, `tee-decryptor-key-gotchas`.
