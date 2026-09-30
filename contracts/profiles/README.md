# Chain profiles (re-export)

**Canonical source of truth:** [`siphon-zk-v2/chain-profiles/`](../../siphon-zk-v2/chain-profiles/).

| Profile | Path in zkv2 | Runtime tree |
| --- | --- | --- |
| `evm-v1` | [`evm-v1.json`](../../siphon-zk-v2/chain-profiles/evm-v1.json) | [`../evm/`](../evm/) |
| `solana-v1` | [`solana-v1.json`](../../siphon-zk-v2/chain-profiles/solana-v1.json) | [`../solana/`](../solana/) |
| `intent-bridge-v1` | [`intent-bridge-v1.json`](../../siphon-zk-v2/chain-profiles/intent-bridge-v1.json) | Cross-vault hop only (not a vault) — see [`../docs/INTENT-BRIDGE.md`](../docs/INTENT-BRIDGE.md) |

Do **not** duplicate JSON here with different semantics. Edit zkv2, then sync fixtures if Foundry needs a pinned copy (`scripts/sync-zkv2-fixtures.sh`).

Adding a chain = new profile JSON + new runtime folder under this repo + `PROGRAM_VERSION` pin. Not a new circuit family.
