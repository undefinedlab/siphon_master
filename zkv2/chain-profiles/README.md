# Chain profiles

Portable spend logic lives in [`PROTOCOL.md`](../PROTOCOL.md) (core). **Chain profiles** define how raw chain identities map to field elements and how public mux slots bind to on-chain calldata.

| Profile | Status | Verifier |
| --- | --- | --- |
| [`evm-v1.json`](./evm-v1.json) | Normative for current EVM / Base | Groth16 / BN254 |
| [`solana-v1.json`](./solana-v1.json) | Artifact locked; runtime scaffold | `groth16-bn254-solana-altbn128-v1` |
| [`intent-bridge-v1.json`](./intent-bridge-v1.json) | Spec — cross-vault hops only | N/A (not a vault) |

`PROGRAM_VERSION` (public index 16) pins a deployment to one tuple:

`(guestLogicId, chainProfileId, verifyArtifactId)` — see [`manifest/universal-spend-v1.json`](../manifest/universal-spend-v1.json).

## Modularity rule

- **One guest** (`spend-core` + Circom): 25 limbs, actions 0–4, Poseidon trees.
- **One profile JSON per runtime**: identity, mux, asset id, verify artifact id.
- **On-chain code** lives under `siphon-contracts-v2/{evm,solana}/` and implements the same kernel checklist against that profile.

Canonical directory: **this folder** (`siphon-zk-v2/chain-profiles/`).  
`siphon-contracts-v2/profiles/` re-exports / documents these files — do not fork copies with divergent semantics.

Fixtures: [`test-vectors/chain-profile-evm.json`](../test-vectors/chain-profile-evm.json). Solana vectors land when payee compression domain is pinned.
