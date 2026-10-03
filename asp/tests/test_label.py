"""Label derivation — chain-profile + deposit-ok (CommitmentLib / spend-core parity)."""
from __future__ import annotations

from pathlib import Path

from tests.conftest import load_json


def test_chain_profile_vault_scope(poseidon_ready):
    from core.domains import vault_scope_id_evm
    from core.label import evm_vault_scope_id

    data = load_json("chain-profile-evm.json")
    vault_field = int(data["vaultAddressBytes20"], 16)
    scope = vault_scope_id_evm(data["chainId"], vault_field)
    assert str(scope) == data["vaultScopeId"]
    assert str(evm_vault_scope_id(data["chainId"], data["vaultAddress"])) == data["vaultScopeId"]


def test_deposit_ok_salted_label(poseidon_ready):
    """Parity with siphon-contracts-v2 fixtures/zkv2/test-vectors/deposit-ok.json."""
    from core.domains import mint_label_salted
    from core.label import derive_deposit_label

    contracts_vec = (
        Path(__file__).resolve().parents[2]
        / "siphon-contracts-v2"
        / "fixtures"
        / "zkv2"
        / "test-vectors"
        / "deposit-ok.json"
    )
    data = __import__("json").loads(contracts_vec.read_text())
    expected = data["expectedLabel"]
    scope = int(data["vaultScopeId"])
    nonce = int(data["depositNonce"])
    salt = int(data["userSalt"])

    via_domains = mint_label_salted(scope, nonce, salt)
    assert str(via_domains) == expected

    # Same formula via derive_deposit_label when vault/scope known from profile
    profile = load_json("chain-profile-evm.json")
    # deposit-ok may use different vault than chain-profile; prefer vaultScopeId path above.
    # Cross-check derive when scope matches profile:
    if str(scope) == profile["vaultScopeId"]:
        derived = derive_deposit_label(
            chain_id=int(profile["chainId"]),
            vault_address=profile["vaultAddress"],
            deposit_nonce=nonce,
            user_salt=salt,
        )
        assert str(derived) == expected
