"""Siphon v4 shielded-swap deployment config for the executor.

The executor routes a strategy leg through the v4 hook (vault.shieldedSwap) instead of the v3
Entrypoint.swap when a v4 pool exists for the leg's token pair on that chain. The hook verifies the
proof inside the pool's swap and re-shields the output atomically — no executor custody window.

Because the on-chain guard requires msg.sender == proof.recipient, the browser MUST generate the
leg's swap proof with recipient == the executor wallet (getZkWithdrawRecipient already returns it),
pool == the low 160 bits of the v4 PoolId, and an output precommitment for the re-shielded note.

Source of truth for addresses:
  siphon-contracts/evm/ignition/deployments/chain-<id>/v4_fee_deployed_addresses.json
"""

# Runtime image is Python 3.9: `X | None` annotations are evaluated at def time there and
# raise TypeError on import. This makes them lazy strings. See tests/test_py39_annotations.py.
from __future__ import annotations

# chain_id -> v4 deployment. Only pairs with a registered pool + seeded liquidity are routable.
V4_DEPLOYMENTS = {
    11155111: {
        "vault": "0xed4739305818457dcAE2d68fA4042C165732DDB4",
        "hook": "0xfaBa649Ce2982f61B0488383671A19BAfe2440c0",
        # currency0 < currency1 (v4 requirement). hooks filled in by v4_pool_for.
        "pools": {
            # Real Sepolia WETH/USDC (production strategies route here).
            ("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14"): {
                "currency0": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",  # USDC (6dec)
                "currency1": "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",  # WETH (18dec)
                "fee": 3000,
                "tickSpacing": 60,
            },
        },
    },
}

def v4_deployment(chain_id: int) -> dict | None:
    return V4_DEPLOYMENTS.get(int(chain_id))


def v4_pool_for(chain_id: int, token_a: str, token_b: str) -> dict | None:
    """Return the PoolKey (with hooks filled in) for a token pair, or None if no v4 pool exists."""
    dep = v4_deployment(chain_id)
    if not dep:
        return None
    a, b = token_a.lower(), token_b.lower()
    for (t0, t1), key in dep["pools"].items():
        pair = {t0.lower(), t1.lower()}
        if pair == {a, b}:
            return {**key, "hooks": dep["hook"]}
    return None
