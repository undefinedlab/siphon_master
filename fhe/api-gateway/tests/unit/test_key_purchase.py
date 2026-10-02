"""Unit tests for credit packs (no RPC)."""
import pytest

from app.errors import BadRequest, NotFound
from app.services.key_purchase import (
    MIN_CUSTOM_USDC_MINOR,
    PACKS,
    collector_address,
    list_packs,
    resolve_pack,
    usdc_address,
)


def test_list_packs_has_starter_growth_scale():
    packs = list_packs()
    ids = {p["id"] for p in packs}
    assert ids == {"starter", "growth", "scale"}
    assert PACKS["starter"]["usdc_minor"] == 5_000_000


def test_usdc_and_collector_checksummed():
    assert usdc_address(8453).startswith("0x")
    assert collector_address().startswith("0x")


def test_mainnet_purchase_usdc_matches_v5_chain_registry():
    from app.services.v5_chains import CHAINS

    for chain_id in (8453, 42161):
        assert usdc_address(chain_id) == CHAINS[chain_id].usdc
    with pytest.raises(BadRequest):
        usdc_address(10)


def test_resolve_custom_pack():
    pack = resolve_pack("custom", 12_500_000)
    assert pack["id"] == "custom"
    assert pack["usdc_minor"] == 12_500_000
    assert pack["plan"] == "custom"


def test_resolve_custom_rejects_below_minimum():
    with pytest.raises(BadRequest):
        resolve_pack("custom", MIN_CUSTOM_USDC_MINOR - 1)


def test_resolve_unknown_pack():
    with pytest.raises(NotFound):
        resolve_pack("nope")
