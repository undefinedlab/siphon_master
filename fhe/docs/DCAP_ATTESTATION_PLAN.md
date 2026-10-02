# DCAP attestation + retiring `SIPHON_DEV_PLAINTEXT_KEY` — staged plan

**Status (2026-07-08): VERIFIED LIVE.** Full sealed round trip passed against the production CVM
(`scripts/live_roundtrip.mjs`): Intel signature chain via Phala's DCAP API, report_data binding,
RTMR3 replay + compose-hash pin (`6c29bba15797…`), crypto_box_seal upload, decrypt(1)/decrypt(0)
correct. `NEXT_PUBLIC_DECRYPTOR_MEASUREMENT` is set in the app env; EC2's
`ORDER_SIGNER_MEASUREMENT` updated to match. `SIPHON_DEV_PLAINTEXT_KEY=1` is still in the CVM
compose as a fallback — removing it (which rotates the compose-hash again → update BOTH pins) is
the last step once the browser flow is observed working for real users.

**Deploy war stories (2026-07-08):**
- `phala cvms upgrade` with a byte-identical docker-compose.yml still rotated the compose-hash
  (the CLI regenerates the app-compose envelope) — treat EVERY upgrade as a pin rotation.
- The upgrade also left the CVM boot-looping: LUKS opened but `zpool import dstack` found no
  pool (data disk half-initialized after an interrupted first boot / node move). Recovery:
  `phala cvms replicate <app-id>` — fresh data disk, SAME app_id so the order-signer's
  KMS-derived address survives. The old volume's mirrored ClientKeys were lost; browsers
  re-upload via the resync flow.
- dstack 0.5.9 returns event logs with EMPTY `digest` fields — verifiers must recompute
  `sha384(event_type_le || ":" || event || ":" || payload)` per event when replaying RTMR3.
- Decryptor Dockerfile builder needs rust ≥1.91 (dstack-sdk → alloy `rust-version`).

**What landed (2026-07-08):**
- `decryptor/src/main.rs` — per-boot x25519 identity; `GET /attestation` returns a real dstack TDX
  quote with `report_data = sha256("siphon-decryptor:" + pubkey_hex)` + event log (null quote
  outside a CVM); `POST /clientKey` tries sealed-box unseal first, dev-plaintext only as fallback
  while `SIPHON_DEV_PLAINTEXT_KEY=1`. Keys persist to the TDX-encrypted volume as plain
  hex(bincode) — required because the sealing keypair is per-boot. Unit tests + a Node↔Rust
  `crypto_box_seal` round-trip (`examples/unseal_check.rs`) pass.
- `trade-executor/app.py` — `GET /decryptorAttestation` pass-through proxy.
- `siphon-app/src/lib/decryptorAttestation.ts` — Stage 2 (Option B) + Stage 3: quote signature
  chain via Phala's verify API (`NEXT_PUBLIC_QUOTE_VERIFY_URL`, default
  `https://cloud-api.phala.network/api/v1/attestations/verify`, requires `quote.verified === true`),
  report_data binding, RTMR3 event-log replay + compose-hash digest check against
  `NEXT_PUBLIC_DECRYPTOR_MEASUREMENT`, then `crypto_box_seal` (libsodium-wrappers) of the
  ClientKey to the attested pubkey. Wired into `ensureClientKeyInDecryptor`.

**To go live:** redeploy decryptor CVM → `phala cvms attestation` → set
`NEXT_PUBLIC_DECRYPTOR_MEASUREMENT=<compose-hash>` in the app env → verify upload+decrypt round
trip → then remove `SIPHON_DEV_PLAINTEXT_KEY` from the compose. Remember: every CVM redeploy
rotates the compose-hash → update the pin. Note the enclave keypair is per-boot: a browser must
fetch a FRESH attestation right before sealing (the module does this in `attestAndSealClientKey`).

## What exists today (the honest baseline)

- **order-signer** (Polygon/EVM signing): real dstack TDX quote at `/attestation`, `report_data =
  sha256("siphon-order-signer:"+address)`. The **executor verifies** it before bridging funds:
  report_data binds the address + `ORDER_SIGNER_MEASUREMENT` (compose-hash) is pinned. This is a
  *real, working* attestation check — but it is **measurement-pinning + report_data binding**, not
  full Intel DCAP quote-signature-chain verification.
- **decryptor** (FHE client keys): `/attestation` is a STUB. `SIPHON_DEV_PLAINTEXT_KEY=1` accepts a
  plaintext hex `ClientKey` over TLS. The key only ever lives in the TDX enclave (now also on the
  encrypted persistent volume), but the browser does NOT verify the enclave before handing it over,
  and the key is not HPKE-sealed to the enclave. Threat not yet covered: a malicious host proxying
  `/clientKey` to a fake enclave to harvest client keys.

## The gap to close

The browser must **prove it is talking to the genuine enclave** (matching a pinned measurement)
**before** releasing the `ClientKey`, and release it **sealed** so only that enclave can open it.

## Stages

### Stage 1 — decryptor: x25519 identity + real quote  (Rust, bounded)
- On boot, generate an ephemeral x25519 keypair (`x25519-dalek`), hold the secret in memory only.
- `GET /attestation` → call dstack `get_quote(report_data = sha256(x25519_pubkey))` via the guest
  socket (`dstack-sdk` Rust crate, or raw HTTP over `/var/run/dstack.sock`), return
  `{ quote, event_log, x25519_pubkey }`. Mirror the order-signer's Python pattern.
- New deps: `x25519-dalek`, `hpke` (or `crypto_box`), a dstack client. Additive; boot must still
  succeed if the socket is absent (local dev) — fall back to the current dev path.

### Stage 2 — browser: verify the quote  (the HARD part)
- Fetch `/attestation`. Verify the TDX quote:
  - **Option A (self-contained):** bundle a WASM DCAP quote verifier (Intel QVL / `dcap-qvl`),
    check the quote signature chain to the Intel roots, then check RTMR3/compose-hash == a pinned
    `NEXT_PUBLIC_DECRYPTOR_MEASUREMENT` (from `phala cvms attestation`).
  - **Option B (delegated):** POST the quote to Phala's attestation verification API / on-chain
    verifier and check the verdict + measurement. Less code, adds a trust dependency + network hop.
- Also verify `report_data == sha256(x25519_pubkey)` so the pubkey is bound to the attested enclave.
- **Recommendation:** start with Option B (ship faster, lower risk), move to Option A for full
  self-custody of the trust root later.

### Stage 3 — browser: HPKE-seal the ClientKey
- Seal `bincode(ClientKey)` to the verified `x25519_pubkey` (HPKE base mode / libsodium sealedbox).
- POST the sealed blob to `/clientKey` (via the existing executor proxy).

### Stage 4 — decryptor: unseal + retire the dev flag
- HPKE-unseal with the enclave x25519 secret → `bincode` → `ClientKey`. Persist the SEALED blob (not
  plaintext) to `/data/keys` — reseal-at-rest, or keep the disk-encryption seal as-is.
- Once Stage 1–3 verified end-to-end, remove `SIPHON_DEV_PLAINTEXT_KEY` from the compose and delete
  the plaintext branch in `set_client_key`.

## Also worth pinning (independent of the above)
- Executor's order-signer check is measurement-pinning, not full DCAP. Same Option A/B choice applies
  if you want the executor to fully DCAP-verify the signer quote (not just pin the compose-hash).
- Every CVM redeploy rotates the compose-hash → update `ORDER_SIGNER_MEASUREMENT` (EC2) and
  `NEXT_PUBLIC_DECRYPTOR_MEASUREMENT` (app) each time. Automate this in the deploy script.

## Effort estimate
Stage 1: ~half a day. Stage 2 (Option B): ~half a day; (Option A): 2–3 days (WASM QVL integration).
Stage 3–4: ~half a day. **Do not ship partially** — an unverified seal is security theater.
