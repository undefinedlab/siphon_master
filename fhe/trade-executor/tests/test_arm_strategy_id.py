"""The enclave keys armed legs by the id the BROWSER chose, not by this row's id.

The browser must seal its legs before /createStrategy exists to mint a row id, so it arms under an
id of its own and reports it as `arm_strategy_id`. Proving by row id asked the enclave for a leg
that was never stored there — "no armed leg <uuid>:0" — and the strategy sat PENDING until it
expired, arming fee already paid.
"""
import executor_runner


def test_the_prove_key_is_the_id_the_browser_armed_under():
    strategy = {
        "id": "dc1cfe71-bbc8-4d53-bb35-b520ba0dce77",
        "arm_strategy_id": "0x50Db1b65fe56de4015912FD3E1AdC1bccFB08151-1787871173",
    }

    assert executor_runner._arm_key(strategy) == strategy["arm_strategy_id"]


def test_a_row_without_an_arm_id_still_uses_its_own_id():
    """Non-attested rows never reach the enclave; falling back keeps them behaving as before."""
    assert executor_runner._arm_key({"id": "row-1"}) == "row-1"
    assert executor_runner._arm_key({"id": "row-1", "arm_strategy_id": None}) == "row-1"
    assert executor_runner._arm_key({"id": "row-1", "arm_strategy_id": ""}) == "row-1"


def test_the_arm_id_survives_the_enclaves_key_filter():
    """`spend::leg_key` keeps only [A-Za-z0-9_-] before joining with ':'.

    The first version of this id used a colon — `<kernel>:<anchor>` — which the filter silently
    dropped, so `<kernel>:<anchor>` and `<kernel><anchor>` collapsed to one key. The separator is
    a hyphen for that reason; this asserts the id the browser builds is filter-stable.
    """
    arm_id = "0x50Db1b65fe56de4015912FD3E1AdC1bccFB08151-1787871173"
    filtered = "".join(c for c in arm_id if c.isalnum() and c.isascii() or c in "-_")

    assert filtered == arm_id


def test_the_enclave_proof_is_flattened_with_the_g2_swap():
    """snarkjs orders pi_b as [x0, x1]; the Solidity pairing wants [x1, x0].

    Iterating the enclave's dict yielded its KEYS, so submission died on int('pi_a', 0) with the
    nullifiers already claimed. Getting the SWAP wrong instead would not raise at all — it builds
    a well-formed proof that fails verification on-chain, after gas.
    """
    snarkjs = {
        "pi_a": ["1", "2", "1"],
        "pi_b": [["3", "4"], ["5", "6"], ["1", "0"]],
        "pi_c": ["7", "8", "1"],
    }

    # a.x, a.y, b.x[1], b.x[0], b.y[1], b.y[0], c.x, c.y
    assert executor_runner._groth16_flat(snarkjs) == [1, 2, 4, 3, 6, 5, 7, 8]


def test_an_already_flat_proof_passes_through():
    assert executor_runner._groth16_flat(["1", "0x2", 3, 4, 5, 6, 7, 8]) == [1, 2, 3, 4, 5, 6, 7, 8]


def test_an_unrecognised_proof_shape_raises_rather_than_submitting():
    import pytest

    with pytest.raises(ValueError, match="unrecognised proof shape"):
        executor_runner._groth16_flat("0xdeadbeef")
