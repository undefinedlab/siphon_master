# Solana Security Notes

These notes describe required security boundaries. Host scaffolding does not substitute for Anchor
account constraints, deployed-program review, or real Groth16 verification.

## PDA authorization

- Derive vault, compliance, pending-input, verifying-key, and nullifier addresses from documented
  domain-separated seeds and the deployed program ID.
- Every handler must verify account owner, expected PDA address and bump, signer/authority, writable
  status, and account discriminator/version before reading or mutating data.
- CPI targets, hub/settlement programs, token programs, and mints must be allowlisted. Never accept
  a caller-supplied executable account solely because it is executable.
- Upgrade and close authorities are part of the release policy. State that records spent
  nullifiers must not be closable or recyclable.

## Pending-inputs binder

The 25 public limbs are committed in a pending-inputs PDA before proof verification to stay within
Solana transaction-size limits. `spend` must consume that account exactly once and require its
32-byte binder to match the expected transaction/user/session binding. A mismatch, missing commit,
second commit, or replay fails closed. Production account constraints must additionally bind the
PDA to its authority and vault; the host binder check alone is not account authorization.

## Nullifier PDA per nullifier

Each active nullifier maps to one PDA using the domain-separated seeds `b"nf"` and the 32-byte
nullifier. Account existence is the durable spent marker. Only the first `input_count` nullifiers
may be burned; every padded slot must be zero. A spent-marker PDA must remain program-owned,
non-closeable, and impossible to reinitialize, or a closed account could resurrect a spend.

## No fake Groth16

Production acceptance requires a real BN254 Groth16 pairing check over all 25 public limbs and the
selected one of 14 verifying keys. `StructuralAcceptBackend` only checks routing/shape and is
restricted to tests or the explicit `scaffold-verify` feature. Default host verification and the
current unfinished on-chain backend return failure. A release must not enable `scaffold-verify`,
contain structural-accept symbols, use an attestation as a proof substitute, or deploy while
`AltBn128SyscallBackend` remains fail-closed scaffolding.
