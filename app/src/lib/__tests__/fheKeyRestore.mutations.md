# fheKeyRestore — verified mutations

`fheKeyRestore.test.ts` is only worth its runtime if it fails when the shipped code loses a
guard. Each mutation below was applied to `src/lib/fhe.ts`, the suite was run, and the result
recorded. Re-run the sweep after touching the restore path.

| # | mutation applied to `src/lib/fhe.ts` | suite |
|---|---|---|
| M1 | fingerprint comparison in `payloadIsTrustworthy` returns `true` | RED |
| M2 | `if (!p.fp) return false` → `return true` (fingerprint-less blob accepted) | RED |
| M3 | `signerAddress` check deleted from `payloadIsTrustworthy` | RED |
| M4 | `signerAddress` check deleted from `getStoredClientKey` (session tier) | RED |
| M5 | `requireDerived` gate deleted | RED |
| M6 | `payloadToHex` v1/v2 dispatch inverted | RED |
| M7 | `purgeLegacyPlaintextKey` migrates the v2 entry instead of deleting it | RED |
| M8 | `writeLocalPayload` stores the payload unwrapped | RED |
| M9 | `signerAddress !== uid` throw removed from `getOrCreateClientKey` | RED |
| M10 | in-flight dedupe map bypassed | RED |
| M11 | `wrappedClientKeyForUpload` publishes a non-derived key | RED |
| M12 | `wrappedClientKeyForUpload` skips the owner check | RED |
| M13 | `wrappedClientKeyForUpload` publishes `payload.k` (plaintext) | RED |

Baseline green before and after; `fhe.ts` byte-identical on restore.

## Deliberately not covered

The DERIVE path. `generateKeysFromSeed` is wasm, `loadFhe()` refuses outside a browser, and
shimming `window` gets past that guard only to die inside wasm-bindgen — poisoning the module
promise for every later test in the process. So the fixture is a fixed client key and only the
storage and restore tiers are exercised.

Concurrency on the derive path is therefore also untestable here. The dedupe (M10) is covered
only on the restore path, where two callers race two unwrap+fetch round trips. That is the case
that actually regressed; the derive-path race always terminates in wasm.

## Server side

`siphon-fhe/trade-executor/tests/test_fhe_key_blob.py` covers the write (which rides
`/uploadServerKey`) and the read (`GET /fheKeyBlob/<user_id>`), with its own verified mutations:

| # | mutation applied to `trade-executor/app.py` | suite |
|---|---|---|
| S1 | blob persisted only alongside a `server_key` — breaks the canary-only path | RED |
| S2 | `_wallet_authorizes` owner check dropped | RED |
| S3 | handler length bound removed | RED |
| S4 | a blob-only upload creates a row with a NULL `server_key` | RED |

S1 is the one that matters most. The browser fast-skips the ~24 MB `server_key` whenever the
executor already holds a matching fingerprint, so a canary-only POST is the ordinary request; a
blob that only persisted alongside a full upload would almost never land.

## Solana key owners (Phantom)

| # | Mutation | Result |
|---|---|---|
| P1 | `signerForKeyOwner` always returns the EVM signer | RED |
| P2 | server tier kept for Solana ids | RED |
| P3 | `seedFromSignature` drops the `0x` normalisation (bare ed25519 hex) | RED |
