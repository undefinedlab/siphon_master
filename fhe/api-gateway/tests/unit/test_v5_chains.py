"""v5 deployments: the gateway's registry must equal the SDK's (@siphon/sdk-ts v5/constants.ts).

A drift here means the gateway builds calldata for one kernel while the SDK proves against another
— both pass their own tests and every deposit reverts. Skipped when siphon-app is not checked out
beside siphon-fhe (as in CI); run locally before changing either file.
"""
import os
import re
from pathlib import Path

import pytest

from app.services.v5_chains import CHAINS

_SDK = [
    Path(os.environ.get("SIPHON_SDK_CONSTANTS", "")),
    Path(__file__).resolve().parents[4] / "siphon-app/packages/sdk-ts/src/v5/constants.ts",
]


def _sdk_source() -> str | None:
    for p in _SDK:
        if p.is_file():
            return p.read_text()
    return None


@pytest.mark.skipif(_sdk_source() is None, reason="siphon-app SDK checkout not found")
def test_gateway_and_sdk_agree_on_every_v5_address():
    src = _sdk_source()
    for chain_id, c in CHAINS.items():
        block = re.search(rf"\n  {chain_id}: \{{(.*?)\n  \}},", src, re.S)
        assert block, f"chain {chain_id} missing from the SDK"
        body = block.group(1)
        for field, sdk_key in (("vault_kernel", "vaultKernel"), ("compliance_hub", "complianceHub"),
                               ("note_tree", "noteTree"), ("nullifier_set", "nullifierSet"),
                               ("weth", "weth"), ("usdc", "usdc"),
                               ("asset_adapter", "assetAdapter")):
            m = re.search(rf'{sdk_key}: "(0x[0-9a-fA-F]{{40}})"', body)
            assert m and m.group(1).lower() == getattr(c, field).lower(), f"{chain_id}.{field} differs from the SDK"
        assert f"deployBlock: {c.deploy_block}," in body
        assert f'zkKeys: "{c.zk_keys}"' in body
        assert f"adminOnly: {str(c.admin_only).lower()}," in body


def test_assets_resolve_and_eth_is_held_as_weth():
    base = CHAINS[8453]
    assert base.token("ETH") == (base.weth, True)
    assert base.token("usdc") == (base.usdc, False)
    assert base.token(base.weth) == (base.weth, False)
    with pytest.raises(Exception):
        base.token("DOGE")
