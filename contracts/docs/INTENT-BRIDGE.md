# Intent / bridge profile (`intent-bridge-v1`)

Cross-chain hops between **per-chain Siphon vaults**. This is **not** a third privacy pool and **not** an atomic ETH↔SOL note.

**Current product cut:** same-chain Solana uses the Devnet ZK vault (`siphon-vault-zk`). This cross-chain hop still does not withdraw from that vault. Use the **wallet fund** path
([`SOLANA-WRAPPER.md`](./SOLANA-WRAPPER.md)):

```text
Phantom wallet → Li.Fi / bridge (public) → depositV3 (Base vault) → private again
```

Executor: `POST /solana/fundBase/plan` → `execute_wallet_fund_hop` (skips `withdraw_source_vault`).

Canonical vault↔vault JSON (parked for Solana source): [`siphon-zk-v2/chain-profiles/intent-bridge-v1.json`](../../siphon-zk-v2/chain-profiles/intent-bridge-v1.json).

```text
private withdraw (vault A) → Li.Fi / bridge (public) → deposit (vault B) → private again
```


| Layer | Owns |
| --- | --- |
| Vaults (`evm-v1`, `solana-v1`) | Private capital + ZK spend |
| Intent profile | Sequencing + adapter selection |
| Li.Fi / Across / native | Public hop routing only |

See also [`MULTI-CHAIN.md`](./MULTI-CHAIN.md).

## Executor scaffold

The trade executor exposes `POST /intentHop` with:

```json
{
  "from_chain_id": 900002,
  "to_chain_id": 8453,
  "amount": 1000000,
  "asset": "USDC",
  "recipient": "0x...",
  "bridge_adapter": "lifi"
}
```

The response reports `withdraw_source_vault`, `public_bridge_hop`, `deposit_dest_vault`, and
`asp_screen_dest` separately. It currently returns HTTP `202` with `ok: false` and
`pending: true`: proof-bound vault withdrawal/deposit inputs are not yet wired end to end.

The bridge is an explicitly public leg. For EVM-to-EVM hops the state machine is connected to the
Li.Fi executor, but it cannot run until a real source-vault withdrawal transaction is confirmed.
Any hop involving Solana remains pending with an adapter note. A submitted source bridge
transaction is not destination settlement; completion requires the Li.Fi destination transaction
as well. The profile remains a **scaffold**, not production-ready, until end-to-end vault, bridge,
deposit, and ASP tests pass.
