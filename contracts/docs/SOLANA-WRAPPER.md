# Solana product cut

| Mode | Vault custody | Path |
| --- | --- | --- |
| **Mainnet** | Arbitrum One (42161) | Phantom USDC → Li.Fi → `depositV3` (EVM wrapper) |
| **Devnet** | Solana Devnet (`900002`) | Phantom → `siphon-vault-zk` deposit, Groth16 spend, Meteora settle |

## Mainnet (wrapper)

```text
Phantom (Solana mainnet USDC)
  → Li.Fi public hop to Arbitrum
  → depositV3 on Arbitrum VaultKernel
  → ASP / private strategies on Arbitrum
```

Native Solana **mainnet** program deploy remains gated by
[`../solana/MAINNET-GATE.md`](../solana/MAINNET-GATE.md) (rent, ceremony keys, soak).

## Devnet (native ZK vault)

```text
Phantom (Solana Devnet)
  → deposit on siphon-vault-zk (commitment, not a plaintext note)
  → browser Groth16 spend
  → executor submits the spend
  → Meteora DLMM swap to the recipient
```

Program `F8UqgsnSrrtGe2EETRWKJU8iRMNiKowEDFQcVLAPjEQH`. Walkthrough: [`DEVNET-SOL-E2E.md`](./DEVNET-SOL-E2E.md).

`siphon-vault-onchain` is a retired scaffold. Its `spend` and `strategy_swap` fail closed in source. The copy still deployed at `Eip1D6GPh5hc3qrJVBcghd3W3KSPszqyRYbn6XPi9MWj` was built before that and must not be funded.

## Related

- Product program: `siphon-contracts-v2/solana/programs/siphon-vault-zk`
- Host kernel (tests): `siphon-contracts-v2/solana/programs/siphon-vault`
- Retired scaffold: `siphon-contracts-v2/solana/programs/siphon-vault-onchain`
- Client: `siphon-app/src/lib/chains/solanaVaultZk.ts`
