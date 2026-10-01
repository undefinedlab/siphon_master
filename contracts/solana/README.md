# Siphon Solana runtime

Modular Solana binding for the **same** PROTOCOL guest as Base (`evm-v1`).
The Devnet product is `siphon-vault-zk`: Poseidon notes, real Groth16, settle on Meteora.
`siphon-vault-onchain` is a retired scaffold. Do not present it as the vault.

| | |
| --- | --- |
| Profile | [`siphon-zk-v2/chain-profiles/solana-v1.json`](../../siphon-zk-v2/chain-profiles/solana-v1.json) |
| Devnet E2E | [`../docs/DEVNET-SOL-E2E.md`](../docs/DEVNET-SOL-E2E.md) |
| Verify research | [`VERIFY-RESEARCH.md`](./VERIFY-RESEARCH.md) |
| Mainnet gate | [`MAINNET-GATE.md`](./MAINNET-GATE.md) |
| Status | **Devnet product:** `siphon-vault-zk` (`F8UqgsnSrrtGe2EETRWKJU8iRMNiKowEDFQcVLAPjEQH`), Groth16 on. Mainnet not shipped. |

---

## Hackathon Devnet — submission status

### Product on Solana Devnet

| Component | Address / value |
| --- | --- |
| Program (`siphon-vault-zk`) | `F8UqgsnSrrtGe2EETRWKJU8iRMNiKowEDFQcVLAPjEQH` |
| Vault PDA | `FuBg5w5TnevKM887xFJ7zxCcQbUbzjE41wSPgSojoyQK` |
| Settle venue | Meteora DLMM `BY4cLgYMpE1AA5X5jiXHEMTrVkG7uhDvr6KxjU8YfCEZ` |
| Test USDC mint | `DteUanphWnAmksJGq1uQFCRmY6ZwTV7cEib8CqGa5Bie` |
| Product chain id | `900002` |
| Walkthrough | [`docs/DEVNET-SOL-E2E.md`](../docs/DEVNET-SOL-E2E.md) |

Notes are commitments. The browser proves the spend. The executor only submits it, then swaps on Meteora. `siphon-pool-v1` is not the venue.

### Retired scaffold — do not fund

`siphon-vault-onchain` (`Eip1D6GPh5hc3qrJVBcghd3W3KSPszqyRYbn6XPi9MWj`) is retired. In this tree `spend` and `strategy_swap` always return `VerifyNotConfigured`. Notes on that program are still plaintext. The binary already on Devnet was built before this and must not be funded.

Run the real loop from [`docs/DEVNET-SOL-E2E.md`](../docs/DEVNET-SOL-E2E.md): `setup-meteora-devnet-pool.mjs`, then `e2e-devnet-zk-meteora.mjs` against the trade executor.

---

## Host kernel (mainnet-bound work)

- `siphon-kernel-types` — 25-limb `PublicInputs`, actions, checklist, errors
- `pending_inputs` — commit / read / consume PDA layout
- `verify` — Groth16 + VK registry + circuit router (14 circuits)
- `spend_flow` — verify → version → state root → compliance → nullifiers → dispatch
- Unit tests: `cargo test` in this directory

The host crate’s tests still use `StructuralAcceptBackend`. The deployed BPF program `siphon-vault-zk` verifies Groth16 on `alt_bn128`. Do not confuse the two.

## Non-negotiable

- Same 25 public limbs as EVM. On this program only withdraw and merge settle; other actions revert.
- **Do not** trust the relayer as a proof.
- Base / `evm/` untouched; Foundry CI stays on `evm/`.

## Build / deploy

```bash
cd solana
cargo test
./scripts/deploy-devnet-zk.ps1   # siphon-vault-zk. deploy-devnet.ps1 is the retired scaffold.
```

## Next (mainnet-grade)

1. Restore the ceremony verification key and prove through siphon-solasp (the Devnet run used a dev-beacon key and `set_compliance`).
2. Settle swap, split, and ragequit. Those actions revert today so a proof cannot burn a note without a payout.
3. Complete [`MAINNET-GATE.md`](./MAINNET-GATE.md). The host test backend is still structural; the BPF program is not.
