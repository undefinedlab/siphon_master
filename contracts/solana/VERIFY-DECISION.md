# Solana verify artifact — decision record

**Status:** locked  
**Artifact id:** `groth16-bn254-solana-altbn128-v1`  
**Profile:** `solana-v1`  
**Guest:** unchanged Circom Groth16 / 25-limb PROTOCOL (same as `evm-v1`)

## Decision

Use **syscall-backed Circom Groth16** on Solana (Light-class `groth16-solana` / `alt_bn128`), not a second proving system and not relayer attestation.

| Requirement | Choice |
| --- | --- |
| Same guest as Base | Yes — reuse snarkjs zkeys |
| On-chain soundness | `alt_bn128` pairing syscalls |
| 25 public limbs in 1232 B tx | **Pending-inputs PDA** (commit then spend) |
| Multi-circuit | 14 VK slots (withdraw1–6, merge2–6, swap, split, ragequit) |

## Rejected

- Fake / trust-relayer “proof”
- Pure-BPF Groth16 without syscalls
- Shrinking public inputs / new circuit family for Solana
- STARK/SP1 as primary product path (PROTOCOL: Circom Groth16 only)

## Implementation map

| Piece | Location |
| --- | --- |
| Research | [`VERIFY-RESEARCH.md`](./VERIFY-RESEARCH.md) |
| Verify port | `programs/siphon-vault/src/verify/` |
| Pending inputs | `programs/siphon-vault/src/pending_inputs.rs` |
| Spend checklist | `programs/siphon-vault/src/spend_flow.rs` |
| Profile JSON | `siphon-zk-v2/chain-profiles/solana-v1.json` |

## Remaining for mainnet

Wire `PairingBackend` to live syscalls + real VK accounts; mollusk CU bench on Siphon vkeys.
