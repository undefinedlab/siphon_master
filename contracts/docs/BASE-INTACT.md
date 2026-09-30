# Base / evm-v1 intact

The Solana work lives under `solana/` and shared docs/profiles only.

**Do not** modify `evm/src`, Foundry deploy scripts, or EVM verifier bytecode as part of Solana expansion.

| Tree | Role |
| --- | --- |
| `evm/` | Production Base / EVM vault — freeze unless EVM bugfix |
| `solana/` | `solana-v1` runtime |
| `siphon-zk-v2/chain-profiles/` | Shared profiles (`evm-v1`, `solana-v1`, `intent-bridge-v1`) |

CI: existing Foundry `make test` targets `evm/` only.
