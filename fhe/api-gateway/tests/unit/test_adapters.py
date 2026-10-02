"""Typed downstream adapters — SSRF-safe fixed hosts, explicit timeouts, error mapping.

The hardened executor REJECTS X-API-TOKEN on its (write-challenge gated) user routes, so the gateway
forwards the USER's wallet/write-challenge headers on those calls — it does not impersonate with the
internal token. httpx.MockTransport lets us assert the request shape without a live executor.
"""
import httpx
import pytest

from app.adapters.executor import ExecutorClient
from app.adapters.asp import AspClient, AssociationSetRoot, ScreeningDecision
from app.errors import AspUnavailable, DownstreamUnavailable, ProofFailed


def _client(handler) -> ExecutorClient:
    transport = httpx.MockTransport(handler)
    return ExecutorClient(base_url="http://executor:5005", api_token="tok", transport=transport)


def _asp_client(handler) -> AspClient:
    transport = httpx.MockTransport(handler)
    return AspClient(base_url="http://asp:5055", screen_token="asp-screen-token", transport=transport)


def test_asp_root_uses_the_internal_screen_credential():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        assert str(request.url).endswith("/set/root")
        assert request.headers.get("Authorization") == "Bearer asp-screen-token"
        return httpx.Response(
            200,
            json={
                "setId": "screened",
                "root": "123",
                "size": 1,
                "ipfsCid": "",
                "depth": 32,
            },
        )

    root = _asp_client(handler).get_root()

    assert root == AssociationSetRoot(
        setId="screened", root="123", size=1, ipfsCid="", depth=32
    )


def test_asp_root_rejects_a_malformed_response():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"setId": "screened", "root": "123", "size": 1, "depth": 32})

    with pytest.raises(AspUnavailable, match="invalid association-set root"):
        _asp_client(handler).get_root()


def test_asp_screen_sends_only_public_deposit_binding_fields():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert str(request.url).endswith("/screen")
        assert request.headers.get("Authorization") == "Bearer asp-screen-token"
        assert request.read()
        assert request.headers.get("Content-Type") == "application/json"
        import json

        assert json.loads(request.content) == {
            "chainId": 8453,
            "depositor": "0x00000000000000000000000000000000000000aa",
            "txHash": "0x" + "11" * 32,
            "commitment": "123",
            "asset": "USDC",
        }
        return httpx.Response(
            200,
            json={
                "decision": "admit",
                "decisionId": "dec_1",
                "setId": "screened",
                "reasons": [],
                "deps": {},
                "policyVersion": "screened-v0.4",
                "commitment": "123",
            },
        )

    decision = _asp_client(handler).screen_deposit(
        chain_id=8453,
        depositor="0x00000000000000000000000000000000000000aa",
        tx_hash="0x" + "11" * 32,
        commitment="123",
        asset="USDC",
    )

    assert decision.decision == "admit"


def test_asp_screen_omits_unavailable_optional_binding_fields():
    def handler(request: httpx.Request) -> httpx.Response:
        import json

        assert json.loads(request.content) == {
            "chainId": 8453,
            "depositor": "0x00000000000000000000000000000000000000aa",
        }
        return httpx.Response(
            200,
            json={
                "decision": "pending",
                "decisionId": "dec_1",
                "setId": "screened",
                "reasons": ["indexer_unavailable"],
                "deps": {},
                "policyVersion": "screened-v0.4",
                "commitment": None,
            },
        )

    decision = _asp_client(handler).screen_deposit(
        chain_id=8453,
        depositor="0x00000000000000000000000000000000000000aa",
    )

    assert decision == ScreeningDecision(
        decision="pending",
        decisionId="dec_1",
        setId="screened",
        reasons=["indexer_unavailable"],
        deps={},
        policyVersion="screened-v0.4",
        commitment=None,
    )


def test_asp_client_rejects_a_blank_screen_token():
    with pytest.raises(ValueError, match="screen_token must not be blank"):
        AspClient(base_url="http://asp:5055", screen_token="  ")


@pytest.mark.parametrize("status", [400, 401, 403, 404, 409, 422, 429])
def test_asp_client_errors_are_mapped_without_leaking_internal_details(status: int):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json={"error": "secret topology and policy details"})

    with pytest.raises(AspUnavailable) as raised:
        _asp_client(handler).screen_deposit(
            chain_id=8453,
            depositor="0x00000000000000000000000000000000000000aa",
        )

    assert raised.value.error_code.value == "asp_unavailable"
    assert "secret" not in raised.value.detail


def test_create_strategy_posts_to_createstrategy_with_wallet_headers():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["method"] = request.method
        seen["wallet"] = request.headers.get("X-Wallet-Address")
        seen["write_sig"] = request.headers.get("X-Write-Signature")
        seen["gateway_token"] = request.headers.get("X-Siphon-Gateway-Token")
        return httpx.Response(200, json={"id": "s1", "status": "PENDING"})

    c = _client(handler)
    out = c.create_strategy({"user_id": "0xabc"}, wallet_headers={
        "X-Wallet-Address": "0xabc", "X-Write-Signature": "0xsig", "X-Write-Nonce": "n1",
    })
    assert out["id"] == "s1"
    assert seen["url"].endswith("/createStrategy") and seen["method"] == "POST"
    assert seen["wallet"] == "0xabc" and seen["write_sig"] == "0xsig"
    assert seen["gateway_token"] == "tok"


def test_has_server_key_is_a_get():
    def handler(request):
        assert request.method == "GET"
        assert str(request.url).endswith("/internal/hasServerKey/0xabc")
        assert request.headers["X-API-TOKEN"] == "tok"
        return httpx.Response(200, json={"has_key": True})

    c = _client(handler)
    assert c.has_server_key("0xabc")["has_key"] is True


def test_prepare_relay_submission_uses_internal_auth_and_binds_payload():
    import json

    def handler(request):
        assert request.method == "POST"
        assert request.url.path == "/internal/relay-submissions/" + "a" * 64 + "/prepare"
        assert request.headers["X-API-TOKEN"] == "tok"
        assert json.loads(request.content) == {
            "wallet": "0xabc",
            "payload": {"chain_id": 8453},
        }
        return httpx.Response(201, json={"status": "leased"})

    result = _client(handler).prepare_relay_submission(
        "a" * 64, {"chain_id": 8453}, wallet="0xabc"
    )
    assert result["status"] == "leased"


def test_timeout_maps_to_downstream_unavailable():
    def handler(request):
        raise httpx.ConnectTimeout("timed out")

    c = _client(handler)
    with pytest.raises(DownstreamUnavailable):
        c.has_server_key("0xabc")


def test_5xx_maps_to_downstream_unavailable():
    def handler(request):
        return httpx.Response(502, text="bad gateway")

    c = _client(handler)
    with pytest.raises(DownstreamUnavailable):
        c.has_server_key("0xabc")


def test_executor_422_maps_to_stable_proof_failed_error():
    def handler(request):
        return httpx.Response(422, json={"error": "Groth16 proof rejected"})

    with pytest.raises(ProofFailed) as raised:
        _client(handler).relay_withdraw({}, wallet_headers={})

    assert raised.value.error_code.value == "proof_failed"


def test_internal_route_sends_api_token():
    # vault-index is an internal proxy route (not a user route) — it carries the internal token.
    def handler(request):
        assert request.headers.get("X-API-TOKEN") == "tok"
        return httpx.Response(200, json={"leaves": []})

    c = _client(handler)
    c.vault_index_leaves(chain_id=8453, asset="ETH")
