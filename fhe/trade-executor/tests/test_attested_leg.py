"""v3 enclave-armed legs: prove in the CVM, then submit VaultKernel.spendAttested.

A v2 leg carries a browser-built proof, so its nullifiers are known before execution starts. An
enclave-armed leg has no proof until the trigger fires, which moves two things that the rest of the
executor takes for granted:

  - nullifiers are claimed AFTER proving, because they do not exist before it;
  - "the enclave could not prove right now" is a RETRY, not a failure — the leg is still armed and
    the user already paid an arming fee for it.

Both are easy to get wrong in ways that are silent in production (a stranded leg looks like a leg
that simply never triggered), so they are pinned here.
"""
import pytest
from types import SimpleNamespace

import decryptor_client
import executor_runner
from executor_runner import _execute_attested_leg, run_leg_execution

STRATEGY = {"id": "strat-1", "chain_id": 11155111, "output_mode": "vault"}
# output_precommitment must be present for a vault-output leg: it is what the browser-recorded
# {nullifier, secret} row resolves against. Without it the note is unresolvable (see the guard).
LEG = {"id": 7, "leg_index": 0, "commitment_id": "c-1", "output_precommitment": "555"}


def _signals(input_count=1, nullifiers=("111",)):
    """25 limbs in spend-core's layout: [1]=inputCount, [9..]=nullifierHashes, rest padding."""
    pi = [0] * 25
    pi[0] = 2               # SWAP
    pi[1] = input_count
    for i, n in enumerate(nullifiers):
        pi[9 + i] = int(n)
    pi[16] = 5              # PROGRAM_VERSION (compliance split)
    return [str(x) for x in pi]


def _ok_result(**over):
    body = {
        "ok": True,
        "proof": [str(i) for i in range(8)],
        "publicSignals": _signals(),
        # COMPLIANCE_CIRCUIT_SPLIT §2.2 — a private spend that reaches the chain carries BOTH
        # halves. These keys mirror what `/spend/prove` really emits (decryptor/src/main.rs):
        # FLAT and camelCase. This fixture used to invent a nested `compliance` object, so the
        # suite passed while the runner could not read a real enclave's response at all — and the
        # error it raised blamed the CVM for being pre-split. A stub that agrees with the caller
        # instead of with the service tests nothing.
        "complianceProof": [str(i) for i in range(8)],
        "compliancePublicSignals": ["1", "0", "0", "0", "5"],
        "complianceCircuit": "compliance1",
        "complianceProveMs": 1,
        "rawPayee": "00" * 20,
        "attestationExpiry": 9999999999,
        "attesterSig": "ab" * 65,
    }
    body.update(over)
    return body


@pytest.fixture
def wired(monkeypatch):
    """Stub the chain so the tests exercise ordering + guards, not web3."""
    calls = {"claimed": [], "released": [], "spent": [], "submitted": []}
    monkeypatch.setattr(executor_runner, "_claim_nullifiers",
                        lambda hashes, cid: (calls["claimed"].append(list(hashes)), True)[1])
    monkeypatch.setattr(executor_runner, "_release_nullifiers",
                        lambda hashes: calls["released"].append(list(hashes)))
    monkeypatch.setattr(executor_runner, "_mark_nullifiers_spent",
                        lambda hashes: calls["spent"].append(list(hashes)))
    import evm_executor, evm_chain_config
    # A configured VaultKernel is half of what makes a proof-less strategy "attested" — a
    # pre-upgrade row on a chain with no kernel must NOT take that path.
    chain_stub = SimpleNamespace(chain_id=11155111, name="Ethereum Sepolia",
                                 vault_kernel="0x50Db1b65fe56de4015912FD3E1AdC1bccFB08151")
    monkeypatch.setattr(evm_chain_config, "get_evm_chain_config", lambda cid: chain_stub)
    monkeypatch.setattr(evm_executor, "get_web3", lambda chain: object())
    monkeypatch.setattr(evm_executor, "get_executor_account", lambda w3, cid: object())

    def submit(w3, account, chain, **kw):
        calls["submitted"].append(kw)
        return "0xdeadbeef"

    monkeypatch.setattr(evm_executor, "vault_kernel_spend_attested", submit)

    calls["disarmed"] = []
    monkeypatch.setattr(executor_runner, "_disarm_leg_quietly",
                        lambda sid, i: calls["disarmed"].append((sid, i)))
    calls["attempts"] = [0]

    def bump(row_id, single=False):
        calls["attempts"][0] += 1
        calls.setdefault("bumped_single", []).append(bool(single))
        return calls["attempts"][0]

    monkeypatch.setattr(executor_runner, "_bump_prove_attempts", bump)
    monkeypatch.setattr(executor_runner, "_mark_leg", lambda *a, **k: None)
    monkeypatch.setattr(executor_runner, "_mark_failed", lambda *a, **k: None)
    monkeypatch.setattr(executor_runner, "_claim_leg", lambda leg_id: True)
    return calls


# --------------------------------------------------------------------------- nullifier extraction


def test_claims_only_the_declared_nullifier_slots(monkeypatch, wired):
    """Limbs 9..14 are six slots; a 2-note spend leaves four as ZERO padding.

    Claiming a padding zero would collide across every leg that spends fewer than six notes — the
    first such leg would reserve "0" and every later one would look like a double-spend.
    """
    monkeypatch.setattr(decryptor_client, "prove_spend_leg",
                        lambda sid, i: (_ok_result(publicSignals=_signals(2, ("111", "222"))), None))

    out = _execute_attested_leg(LEG, STRATEGY)

    assert out["status"] == "EXECUTED"
    assert wired["claimed"] == [["111", "222"]], "must claim exactly inputCount hashes, no padding"
    assert wired["spent"] == [["111", "222"]]


@pytest.mark.parametrize("bad_count", [0, 7, 99])
def test_refuses_an_implausible_input_count(monkeypatch, wired, bad_count):
    monkeypatch.setattr(decryptor_client, "prove_spend_leg",
                        lambda sid, i: (_ok_result(publicSignals=_signals(bad_count)), None))
    assert _execute_attested_leg(LEG, STRATEGY)["status"] == "FAILED"
    assert wired["claimed"] == []


def test_refuses_a_short_public_signal_array(monkeypatch, wired):
    monkeypatch.setattr(decryptor_client, "prove_spend_leg",
                        lambda sid, i: (_ok_result(publicSignals=["1"] * 24), None))
    assert _execute_attested_leg(LEG, STRATEGY)["status"] == "FAILED"
    assert wired["claimed"] == []


# --------------------------------------------------------------------------- retry vs failure


def test_a_retryable_prove_error_is_retry_not_failure(monkeypatch, wired):
    """The ASP snapshot moving mid-sync is transient. Burning the leg would cost the arming fee."""
    monkeypatch.setattr(decryptor_client, "prove_spend_leg",
                        lambda sid, i: (None, "retryable: asp snapshot is 130s old, max 120s"))
    out = _execute_attested_leg(LEG, STRATEGY)
    assert out["status"] == "RETRY"
    assert wired["claimed"] == [], "nothing may be reserved for a leg that never proved"


def test_a_permanent_prove_error_is_a_failure(monkeypatch, wired):
    monkeypatch.setattr(decryptor_client, "prove_spend_leg",
                        lambda sid, i: (None, "label 42 is revoked — this spend must not be proved"))
    assert _execute_attested_leg(LEG, STRATEGY)["status"] == "FAILED"


# --------------------------------------------------------------------------- claim lifecycle


def test_a_claimed_nullifier_aborts_before_submitting(monkeypatch, wired):
    monkeypatch.setattr(decryptor_client, "prove_spend_leg", lambda sid, i: (_ok_result(), None))
    monkeypatch.setattr(executor_runner, "_claim_nullifiers", lambda hashes, cid: False)
    assert _execute_attested_leg(LEG, STRATEGY)["status"] == "FAILED"
    assert wired["submitted"] == [], "must not submit once the double-spend guard has tripped"


def test_a_failed_submission_releases_the_claim_and_keeps_the_leg(monkeypatch, wired):
    """The proof never reached the chain, so the notes are unspent.

    Leaving the reservation in place would strand the leg behind its own claim permanently — and
    the outcome is RETRY, not FAILED. FAILED is terminal and DISARMS the leg, destroying secrets
    the user paid an arming fee for and cannot recreate. The commonest causes here are transient
    (a nonce race, a gas estimate, an RPC blip); a proof-shape bug in this block once burned a
    real leg this way. MAX_PROVE_ATTEMPTS still stops a genuinely broken one.
    """
    import evm_executor
    monkeypatch.setattr(decryptor_client, "prove_spend_leg", lambda sid, i: (_ok_result(), None))
    monkeypatch.setattr(evm_executor, "vault_kernel_spend_attested",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("rpc down")))

    assert _execute_attested_leg(LEG, STRATEGY)["status"] == "RETRY"
    assert wired["released"] == [["111"]]
    assert wired["spent"] == []


def test_nullifiers_are_marked_spent_only_after_a_tx_lands(monkeypatch, wired):
    import evm_executor
    monkeypatch.setattr(decryptor_client, "prove_spend_leg", lambda sid, i: (_ok_result(), None))
    monkeypatch.setattr(evm_executor, "vault_kernel_spend_attested", lambda *a, **k: None)

    assert _execute_attested_leg(LEG, STRATEGY)["status"] == "FAILED"
    assert wired["released"] == [["111"]]
    assert wired["spent"] == []


# --------------------------------------------------------------------------- what reaches the chain


def test_passes_the_attestation_through_unchanged(monkeypatch, wired):
    monkeypatch.setattr(decryptor_client, "prove_spend_leg", lambda sid, i: (_ok_result(), None))
    _execute_attested_leg(LEG, STRATEGY)

    sent = wired["submitted"][0]
    assert sent["attestation_expiry"] == 9999999999
    assert sent["attester_sig"] == bytes.fromhex("ab" * 65)
    assert len(sent["attester_sig"]) == 65, "the hub rejects any other length outright"
    assert sent["raw_payee"] == b"\x00" * 20
    assert len(sent["public_inputs"]) == 25


def test_accepts_a_0x_prefixed_signature(monkeypatch, wired):
    """The enclave hex-encodes; tolerate either form rather than silently mangling it."""
    monkeypatch.setattr(decryptor_client, "prove_spend_leg",
                        lambda sid, i: (_ok_result(attesterSig="0x" + "cd" * 65,
                                                   rawPayee="0x" + "00" * 20), None))
    assert _execute_attested_leg(LEG, STRATEGY)["status"] == "EXECUTED"
    assert wired["submitted"][0]["attester_sig"] == bytes.fromhex("cd" * 65)


# --------------------------------------------------------------------------- the output note


def test_refuses_a_vault_leg_with_no_output_precommitment(monkeypatch, wired):
    """A vault-output leg re-shields into a note owned by `output_precommitment`.

    The browser records the matching {nullifier, secret} when it arms. Without that row the note
    exists on-chain and is permanently unresolvable — funds correctly shielded and invisible, which
    is the failure mode that already bit twice (the fill-fee change and the vault-output Merkle
    assert). The v2 path refuses this case, so the v3 path must too. The executor cannot write the
    row itself: precommitments are posted by the browser under the user's own key.
    """
    proved = []
    monkeypatch.setattr(decryptor_client, "prove_spend_leg",
                        lambda sid, i: (proved.append(1), (_ok_result(), None))[1])

    leg = {**LEG, "output_precommitment": None}
    assert _execute_attested_leg(leg, STRATEGY)["status"] == "FAILED"
    assert proved == [], "must refuse BEFORE burning a proof on a note nothing can resolve"
    assert wired["claimed"] == []


def test_a_non_vault_leg_needs_no_precommitment(monkeypatch, wired):
    """Address-output legs pay out externally; there is no note to resolve."""
    monkeypatch.setattr(decryptor_client, "prove_spend_leg", lambda sid, i: (_ok_result(), None))
    leg = {**LEG, "output_precommitment": None}
    strategy = {**STRATEGY, "output_mode": "address"}
    assert _execute_attested_leg(leg, strategy)["status"] == "EXECUTED"


# --------------------------------------------------------------------------- attestation timing


def test_refuses_to_submit_an_attestation_that_is_about_to_expire(monkeypatch, wired):
    """The hub checks expiry at MINING time, not submission time.

    Submitting with seconds left buys a revert. Bailing keeps the leg cleanly retryable — and the
    claim must be released, or the leg is stranded behind its own reservation.
    """
    import time as _t
    soon = int(_t.time()) + executor_runner.ATTESTATION_MIN_MARGIN_SECS - 1
    monkeypatch.setattr(decryptor_client, "prove_spend_leg",
                        lambda sid, i: (_ok_result(attestationExpiry=soon), None))

    out = _execute_attested_leg(LEG, STRATEGY)
    assert out["status"] == "RETRY"
    assert wired["submitted"] == [], "must not pay gas for a near-certain revert"
    assert wired["released"] == [["111"]], "claim must not outlive the abandoned attempt"


def test_submits_when_the_attestation_has_comfortable_margin(monkeypatch, wired):
    import time as _t
    ok = int(_t.time()) + executor_runner.ATTESTATION_MIN_MARGIN_SECS + 60
    monkeypatch.setattr(decryptor_client, "prove_spend_leg",
                        lambda sid, i: (_ok_result(attestationExpiry=ok), None))
    assert _execute_attested_leg(LEG, STRATEGY)["status"] == "EXECUTED"
    assert len(wired["submitted"]) == 1


# --------------------------------------------------------------------------- retry bounding + disarm


def test_retries_are_bounded_and_the_leg_is_disarmed_on_give_up(monkeypatch, wired):
    """Each attempt is a full ASP sync + Groth16 on 2 vCPUs.

    Unbounded, one wedged leg consumes the enclave every tick forever. On give-up the sealed
    secrets must also be dropped — otherwise they sit on the same volume as every ClientKey.
    """
    monkeypatch.setattr(decryptor_client, "prove_spend_leg",
                        lambda sid, i: (None, "retryable: asp snapshot is stale"))

    outcomes = []
    for _ in range(executor_runner.MAX_PROVE_ATTEMPTS):
        outcomes.append(run_leg_execution(LEG, STRATEGY, 0.0)["status"])

    assert outcomes[:-1] == ["RETRY"] * (executor_runner.MAX_PROVE_ATTEMPTS - 1)
    assert outcomes[-1] == "FAILED", "must give up rather than retry forever"
    assert wired["disarmed"] == [("strat-1", 0)], "give-up must drop the enclave's sealed secrets"


def test_a_successful_leg_is_disarmed(monkeypatch, wired):
    """Terminal either way: the enclave must not keep secrets for a leg that will never fire again."""
    monkeypatch.setattr(decryptor_client, "prove_spend_leg", lambda sid, i: (_ok_result(), None))
    assert run_leg_execution(LEG, STRATEGY, 0.0)["status"] == "EXECUTED"
    assert wired["disarmed"] == [("strat-1", 0)]


def test_a_retrying_leg_is_not_disarmed(monkeypatch, wired):
    """Disarming a leg that is still going to retry would destroy the secrets it needs."""
    monkeypatch.setattr(decryptor_client, "prove_spend_leg",
                        lambda sid, i: (None, "retryable: asp snapshot is stale"))
    assert run_leg_execution(LEG, STRATEGY, 0.0)["status"] == "RETRY"
    assert wired["disarmed"] == []


# ------------------------------------------------------------ single-leg (no StrategyLeg row)
#
# A Limit Order is one spend with no leg row. It reaches the enclave the same way a TWAP slice
# does — armed by the browser, proved at fire time — so run_execution needs the branch
# run_leg_execution already had. Before this it fell through to the v2 path, which targets the
# retired v1 Entrypoint: the proof was built against a tree whose root the v3 kernel has never
# seen, so it could only fail with UnknownStateRoot after spending gas.
#
# These run against a real in-memory database rather than a stubbed session, so they also prove
# `strategy.prove_attempts` exists and that _bump_prove_attempts(single=True) actually increments
# it — the exact thing that was broken when the column sat on the wrong model.

SINGLE_ID = "strat-single"


@pytest.fixture
def single_ctx(monkeypatch, wired):
    from flask import Flask
    from database import db as real_db, Strategy

    app = Flask(__name__)
    app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///:memory:"
    app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
    real_db.init_app(app)
    with app.app_context():
        real_db.create_all()
        real_db.session.add(Strategy(
            id=SINGLE_ID, user_id="u", strategy_type="LIMIT_ORDER",
            asset_in="ETH", asset_out="USDC", amount=0.001,
            recipient_address="0x" + "11" * 20, status="ARMED",
            output_mode="vault", output_precommitment="555",
        ))
        real_db.session.commit()

        # Let the REAL counter run — the leg-table stub from `wired` would hide the bug this
        # test exists for (a counter written to the wrong table increments nothing).
        monkeypatch.setattr(executor_runner, "_bump_prove_attempts", _real_bump)
        wired["Strategy"] = Strategy
        yield wired


def _real_bump(row_id, single=False):
    """The genuine implementation, re-bound because `wired` stubs it for the leg tests."""
    from database import db as real_db, Strategy, StrategyLeg
    from sqlalchemy import text as _text
    table, model = ("strategy", Strategy) if single else ("strategy_legs", StrategyLeg)
    real_db.session.execute(
        _text(f"UPDATE {table} SET prove_attempts = COALESCE(prove_attempts, 0) + 1 WHERE id=:id"),
        {"id": row_id},
    )
    real_db.session.commit()
    row = model.query.get(row_id)
    return (row.prove_attempts or 0) if row else 0


def _single(**over):
    d = {
        "id": SINGLE_ID, "chain_id": 11155111, "output_mode": "vault",
        "output_precommitment": "555", "commitment_id": "c-1", "is_private": True,
        # no zkp_data — that absence is what routes it through the attested path
    }
    d.update(over)
    return d


def test_a_single_leg_strategy_with_no_proof_takes_the_attested_path(monkeypatch, single_ctx):
    monkeypatch.setattr(decryptor_client, "prove_spend_leg", lambda sid, i: (_ok_result(), None))
    out = executor_runner.run_execution(_single(), 0.0)
    assert out["status"] == "EXECUTED"
    assert out["tx_hash"] == "0xdeadbeef"
    # Proved as leg 0 — the enclave keys armed legs by (strategyId, legIndex).
    assert single_ctx["disarmed"] == [(SINGLE_ID, 0)]
    assert single_ctx["Strategy"].query.get(SINGLE_ID).status == "EXECUTED"


def test_single_leg_retry_leaves_it_armed_for_the_next_tick(monkeypatch, single_ctx):
    """_claim_strategy moved it to EXECUTING and the scheduler only picks up PENDING/ARMED —
    without the reset a transient ASP hiccup strands it forever."""
    monkeypatch.setattr(decryptor_client, "prove_spend_leg",
                        lambda sid, i: (None, "retryable: asp snapshot is stale"))
    out = executor_runner.run_execution(_single(), 0.0)
    assert out["status"] == "RETRY"
    assert single_ctx["Strategy"].query.get(SINGLE_ID).status == "ARMED"
    assert single_ctx["disarmed"] == [], "a leg that will retry must keep its sealed secrets"


def test_single_leg_retries_are_bounded_on_the_strategy_row(monkeypatch, single_ctx):
    """The counter must land on `strategy`, not `strategy_legs` — a single-leg strategy has no leg
    row, so writing the leg table would count nothing and the bound would never be reached."""
    monkeypatch.setattr(decryptor_client, "prove_spend_leg",
                        lambda sid, i: (None, "retryable: asp snapshot is stale"))
    outcomes = []
    for _ in range(executor_runner.MAX_PROVE_ATTEMPTS):
        outcomes.append(executor_runner.run_execution(_single(), 0.0)["status"])
    assert outcomes[-1] == "FAILED", "must give up rather than retry forever"
    assert single_ctx["Strategy"].query.get(SINGLE_ID).prove_attempts == \
        executor_runner.MAX_PROVE_ATTEMPTS
    assert single_ctx["disarmed"] == [(SINGLE_ID, 0)]


def test_a_single_leg_vault_strategy_still_needs_its_output_precommitment(monkeypatch, single_ctx):
    """Same refusal as the multi-leg path: without the browser-recorded row the re-shielded
    proceeds are on-chain and permanently unresolvable."""
    monkeypatch.setattr(decryptor_client, "prove_spend_leg", lambda sid, i: (_ok_result(), None))
    out = executor_runner.run_execution(_single(output_precommitment=None), 0.0)
    assert out["status"] == "FAILED"
    assert single_ctx["submitted"] == [], "must not mint a note nothing can resolve"


def test_a_proofless_row_on_a_chain_with_no_kernel_is_not_attested(monkeypatch, single_ctx):
    """Absence of a proof is NOT sufficient to mean "enclave-armed".

    A pre-upgrade strategy row has no proof either. Treating one as attested would skip the
    vault-generation policy that exists precisely to reject it — so the discriminator also
    requires a VaultKernel configured for that chain, which comes from server config and cannot
    be influenced by the row.
    """
    import evm_chain_config
    monkeypatch.setattr(evm_chain_config, "get_evm_chain_config",
                        lambda cid: SimpleNamespace(chain_id=cid, vault_kernel=""))
    assert executor_runner._is_attested_strategy(_single()) is False
    # An unsupported chain raises inside get_evm_chain_config — must read as "not attested",
    # never as an exception escaping into the execution path.
    monkeypatch.setattr(evm_chain_config, "get_evm_chain_config",
                        lambda cid: (_ for _ in ()).throw(ValueError("unsupported")))
    assert executor_runner._is_attested_strategy(_single()) is False


def test_the_spend_chain_comes_from_from_chain_not_a_missing_chain_id():
    """Strategy.to_dict() emits `from_chain`, never `chain_id`.

    Reading only 'chain_id' resolved 0 for every real row, so get_evm_chain_config(0) raised and
    the attested submission failed with the nullifiers already claimed — for multi-leg too.
    """
    assert executor_runner._strategy_chain_id({"from_chain": "11155111"}) == 11155111
    assert executor_runner._strategy_chain_id({"chain_id": 8453}) == 8453
    # Explicit chain_id wins; both present is what the internal callers construct.
    assert executor_runner._strategy_chain_id({"chain_id": 8453, "from_chain": "11155111"}) == 8453
    assert executor_runner._strategy_chain_id({"from_chain": ""}) == 0
    assert executor_runner._strategy_chain_id({}) == 0


def test_a_pre_split_enclave_is_refused(monkeypatch, wired):
    """A pre-split enclave omits the compliance keys, and the leg must not relay.

    Relaying zeros would revert on-chain as LabelCommitMismatch — indistinguishable in the logs
    from a genuine proving fault, and it would burn the trigger and the gas to find out. The
    nullifier claim has to come back too, or the leg is stranded behind its own reservation.
    """
    body = _ok_result()
    del body["complianceProof"]
    del body["compliancePublicSignals"]
    monkeypatch.setattr(decryptor_client, "prove_spend_leg", lambda sid, i: (body, None))

    _execute_attested_leg(LEG, STRATEGY)

    assert wired["submitted"] == [], "a pre-split enclave must never reach the chain"
    assert wired["released"], "the nullifier claim must be released"


def test_the_compliance_half_reaches_the_kernel(monkeypatch, wired):
    """Both proofs must arrive, and the compliance publics must be ints, not the enclave's strings.

    web3 encodes uint256[5] from Python ints; a list of decimal strings raises at encode time, so
    this is the difference between a working relay and every attested leg failing at submission.
    """
    monkeypatch.setattr(decryptor_client, "prove_spend_leg", lambda sid, i: (_ok_result(), None))
    _execute_attested_leg(LEG, STRATEGY)

    sent = wired["submitted"][0]
    assert sent["compliance_public_inputs"] == [1, 0, 0, 0, 5]
    assert all(isinstance(x, int) for x in sent["compliance_public_inputs"])
    assert len(sent["compliance_proof"]) == 8
