"""Runs UNDER THE /opt/clob VENV (py-clob-client's isolated env), never the main app env.

polymarket_client.py invokes this as a subprocess with a JSON request on stdin and reads a JSON
response from stdout. This isolation exists because py-clob-client's dependency tree
(eth-account>=0.13 → hexbytes>=1.2) cannot coexist with the executor's web3 6.x
(hexbytes<0.4) in one environment.

Ops:
  {"op": "derive_creds"}                                   → {api_key, api_secret, api_passphrase}
  {"op": "place_order", "token_id", "side", "price", "size", "builder_code"?}
                                                           → {order_id, status, raw}
Credentials come from the environment (POLYGON_EXECUTOR_KEY, POLYMARKET_API_*), inherited from
the parent process — nothing secret travels through argv or the JSON pipe.
"""
import json
import os
import sys

CLOB_HOST = os.environ.get("POLYMARKET_CLOB_URL", "https://clob.polymarket.com").rstrip("/")
POLYGON_CHAIN_ID = 137


def _fail(msg: str) -> None:
    print(json.dumps({"error": msg}))
    sys.exit(1)


def main() -> None:
    try:
        req = json.load(sys.stdin)
    except Exception as e:
        return _fail(f"bad request json: {e}")

    key = os.environ.get("POLYGON_EXECUTOR_KEY")
    if not key:
        return _fail("POLYGON_EXECUTOR_KEY not set")

    from py_clob_client.client import ClobClient

    op = req.get("op")

    if op == "derive_creds":
        client = ClobClient(CLOB_HOST, key=key, chain_id=POLYGON_CHAIN_ID)
        creds = client.create_or_derive_api_creds()
        print(json.dumps({
            "api_key": creds.api_key,
            "api_secret": creds.api_secret,
            "api_passphrase": creds.api_passphrase,
        }))
        return

    if op == "place_order":
        from py_clob_client.clob_types import ApiCreds, OrderArgs, OrderType
        from py_clob_client.order_builder.constants import BUY, SELL

        creds = ApiCreds(
            api_key=os.environ["POLYMARKET_API_KEY"],
            api_secret=os.environ["POLYMARKET_API_SECRET"],
            api_passphrase=os.environ["POLYMARKET_API_PASSPHRASE"],
        )
        funder = os.environ.get("POLYMARKET_FUNDER") or None
        client = ClobClient(CLOB_HOST, key=key, chain_id=POLYGON_CHAIN_ID, creds=creds, funder=funder)

        builder = req.get("builder_code") or os.environ.get("POLYMARKET_BUILDER_CODE") or None
        if builder:
            try:
                client.session.headers.update({"X-Builder-Code": builder})  # type: ignore[attr-defined]
            except Exception:
                pass  # SDK version without a session attr — attribution is best-effort

        args = OrderArgs(
            token_id=str(req["token_id"]),
            price=float(req["price"]),
            size=float(req["size"]),
            side=BUY if str(req.get("side", "BUY")).upper() == "BUY" else SELL,
        )
        signed = client.create_order(args)
        # GTC for entries (rest on the book); FAK/FOK for exits — mirrors the order-signer so
        # local mode and TEE mode place identical orders.
        ot = str(req.get("order_type", "GTC")).upper()
        order_type = {"GTC": OrderType.GTC, "FAK": OrderType.FAK, "FOK": OrderType.FOK}.get(ot, OrderType.GTC)
        resp = client.post_order(signed, order_type)
        resp = resp if isinstance(resp, dict) else {}
        print(json.dumps({
            "order_id": resp.get("orderID") or resp.get("order_id"),
            "status": resp.get("status"),
            "raw": resp,
        }))
        return

    _fail(f"unknown op: {op}")


if __name__ == "__main__":
    main()
