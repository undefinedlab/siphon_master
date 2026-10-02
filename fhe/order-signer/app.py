"""Siphon order-signer — runs INSIDE the Phala CVM (Intel TDX), sidecar to siphon-decryptor.

Custodies the Polygon executor key + Polymarket CLOB credentials as CVM secrets and performs
every Polymarket signing operation on behalf of the trade-executor, which only ever sends
authenticated *intents*. The EC2 box never holds the Polygon key once this is live.

Endpoints (all POST routes require X-API-TOKEN == ORDER_SIGNER_TOKEN):
  GET  /health               → { ok, address, clob_ready }
  POST /polymarket/order     { token_id, side, price, size, builder_code? } → CLOB order result
  POST /polymarket/approvals {} → ensures USDC.e + CTF operator approvals (idempotent)
  POST /polymarket/redeem    { condition_id } → CTF redeemPositions tx hash
  POST /polymarket/deriveCreds {} → derives L2 creds, stores them in-process (nothing returned)

Env (set as encrypted secrets in the Phala dashboard):
  ORDER_SIGNER_TOKEN   shared secret with the trade-executor (required)
  POLYGON_EXECUTOR_KEY Polygon EOA private key (required)
  POLYGON_RPC          default https://polygon-rpc.com
  POLYMARKET_API_KEY / _SECRET / _PASSPHRASE  L2 creds (or POST /deriveCreds once)
  POLYMARKET_BUILDER_CODE  optional order attribution
"""
import hashlib
import json
import os
import threading

from flask import Flask, jsonify, request
from web3 import Web3

app = Flask(__name__)

# dstack KMS key path — deterministic per app_id. Changing this string changes the derived
# address, so it is fixed. The key is derived INSIDE the enclave; no plaintext key is stored.
KMS_KEY_PATH = os.environ.get("KMS_KEY_PATH", "siphon/polymarket/polygon")

# EVM executor keys (imported as encrypted CVM secrets) — same wallets the frontend bakes into
# withdraw proofs, so addresses are UNCHANGED. Chain → env var; EVM_EXECUTOR_KEY is the fallback.
_EVM_KEY_ENV = {
    8453: "BASE_EXECUTOR_KEY",
    11155111: "ETH_SEPOLIA_EXECUTOR_KEY",
}
_evm_account_cache: dict = {}

CLOB_HOST = os.environ.get("POLYMARKET_CLOB_URL", "https://clob.polymarket.com").rstrip("/")
POLYGON_RPC = os.environ.get("POLYGON_RPC", "https://polygon-rpc.com")
POLYGON_CHAIN_ID = 137

CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
USDC_E_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E"
NEG_RISK_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a"
NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296"

_ERC20_ABI = json.loads(
    '[{"inputs":[{"name":"spender","type":"address"},{"name":"value","type":"uint256"}],'
    '"name":"approve","outputs":[{"name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},'
    '{"inputs":[{"name":"owner","type":"address"},{"name":"spender","type":"address"}],'
    '"name":"allowance","outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"}]'
)
_CTF_ABI = json.loads(
    '[{"inputs":[{"name":"operator","type":"address"},{"name":"approved","type":"bool"}],'
    '"name":"setApprovalForAll","outputs":[],"stateMutability":"nonpayable","type":"function"},'
    '{"inputs":[{"name":"owner","type":"address"},{"name":"operator","type":"address"}],'
    '"name":"isApprovedForAll","outputs":[{"name":"","type":"bool"}],"stateMutability":"view","type":"function"},'
    '{"inputs":[{"name":"collateralToken","type":"address"},{"name":"parentCollectionId","type":"bytes32"},'
    '{"name":"conditionId","type":"bytes32"},{"name":"indexSets","type":"uint256[]"}],'
    '"name":"redeemPositions","outputs":[],"stateMutability":"nonpayable","type":"function"}]'
)

# In-process creds cache: /deriveCreds fills this so L2 creds never have to leave the enclave.
_derived_creds: dict = {}
_tx_lock = threading.Lock()  # single EOA → serialize nonce-bearing transactions
_account_cache: list = []    # [LocalAccount] — derived once at first use


def _token_ok() -> bool:
    expected = os.environ.get("ORDER_SIGNER_TOKEN", "")
    if not expected:
        return False  # unauthenticated operation is never allowed
    got = (request.headers.get("X-API-TOKEN")
           or request.headers.get("Authorization", "").replace("Bearer ", "")).strip()
    return got == expected


def _w3() -> Web3:
    w3 = Web3(Web3.HTTPProvider(POLYGON_RPC, request_kwargs={"timeout": 30}))
    # Polygon is POA: block extraData exceeds 32 bytes, so any block-fetching call (fee
    # estimation in build_transaction) raises ExtraDataLengthError without this middleware.
    from web3.middleware import ExtraDataToPOAMiddleware

    w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)
    return w3


def _local_account():
    """The signing account. Preference order:
      1. dstack KMS — key derived INSIDE the enclave via get_key(path).to_account(); the raw
         key is never stored, never leaves the TEE, and is deterministic per app_id.
      2. POLYGON_EXECUTOR_KEY env — LOCAL DEV ONLY fallback (never used in the CVM).
    """
    if _account_cache:
        return _account_cache[0]

    env_key = os.environ.get("POLYGON_EXECUTOR_KEY")
    if env_key:
        acct = _w3().eth.account.from_key(env_key)
        _account_cache.append(acct)
        return acct

    # KMS derivation — dstack guest agent at /var/run/dstack.sock (mounted into the container).
    # get_key returns a deterministic app-bound key; decode_key() yields the 32 raw bytes, which
    # become the eth-account. Key material stays in enclave RAM, never persisted.
    from dstack_sdk import DstackClient
    from eth_account import Account

    key_resp = DstackClient().get_key(KMS_KEY_PATH)
    key_bytes = key_resp.decode_key()  # bytes
    acct = Account.from_key(key_bytes)
    _account_cache.append(acct)
    return acct


def _account(w3: Web3):
    # web3 signs from a LocalAccount regardless of how it was created.
    return _local_account()


def _send(w3: Web3, account, tx: dict, label: str) -> str:
    with _tx_lock:
        tx.setdefault("nonce", w3.eth.get_transaction_count(account.address))
        tx.setdefault("chainId", POLYGON_CHAIN_ID)
        if "gasPrice" not in tx and "maxFeePerGas" not in tx:
            tx["gasPrice"] = int(w3.eth.gas_price * 1.2)
        signed = account.sign_transaction(tx)
        raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
        tx_hash = w3.eth.send_raw_transaction(raw)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=300)
    if receipt.status != 1:
        raise RuntimeError(f"{label} reverted: {tx_hash.hex()}")
    return tx_hash.hex()


def _clob_creds():
    if _derived_creds:
        return _derived_creds
    if all(os.environ.get(k) for k in
           ("POLYMARKET_API_KEY", "POLYMARKET_API_SECRET", "POLYMARKET_API_PASSPHRASE")):
        return {
            "api_key": os.environ["POLYMARKET_API_KEY"],
            "api_secret": os.environ["POLYMARKET_API_SECRET"],
            "api_passphrase": os.environ["POLYMARKET_API_PASSPHRASE"],
        }
    return None


def _signing_key_hex() -> str:
    """Raw private key hex for the CLOB SDK — materialized transiently in enclave RAM only
    (KMS-derived, never persisted, never in env). py-clob-client needs the hex to L1-sign."""
    acct = _local_account()
    h = acct.key.hex()
    return h if h.startswith("0x") else "0x" + h


def _builder_config():
    """Builder-program credentials → builder-signed headers on every order post (the sanctioned
    server-side flow; consumer IP geoblocking does not apply to attributed builder traffic).
    Env: POLYMARKET_BUILDER_API_KEY / _SECRET / _PASSPHRASE. None when unset (plain flow)."""
    key = os.environ.get("POLYMARKET_BUILDER_API_KEY", "").strip()
    secret = os.environ.get("POLYMARKET_BUILDER_API_SECRET", "").strip()
    passphrase = os.environ.get("POLYMARKET_BUILDER_API_PASSPHRASE", "").strip()
    if not (key and secret and passphrase):
        return None
    from py_builder_signing_sdk.config import BuilderConfig
    from py_builder_signing_sdk.sdk_types import BuilderApiKeyCreds

    return BuilderConfig(
        local_builder_creds=BuilderApiKeyCreds(key=key, secret=secret, passphrase=passphrase)
    )


def _clob_client():
    from py_clob_client.client import ClobClient
    from py_clob_client.clob_types import ApiCreds

    creds = _clob_creds()
    if not creds:
        raise RuntimeError("CLOB L2 creds missing — POST /polymarket/deriveCreds once")
    funder = os.environ.get("POLYMARKET_FUNDER") or None
    return ClobClient(
        CLOB_HOST, key=_signing_key_hex(), chain_id=POLYGON_CHAIN_ID,
        creds=ApiCreds(api_key=creds["api_key"], api_secret=creds["api_secret"],
                       api_passphrase=creds["api_passphrase"]),
        funder=funder,
        builder_config=_builder_config(),
    )


def _key_source() -> str:
    return "env" if os.environ.get("POLYGON_EXECUTOR_KEY") else "dstack-kms"


@app.get("/health")
def health():
    address = None
    try:
        address = _local_account().address
    except Exception as e:
        return jsonify({"ok": False, "service": "siphon-order-signer",
                        "error": f"key unavailable: {e}", "key_source": _key_source()}), 503
    return jsonify({
        "ok": True,
        "service": "siphon-order-signer",
        "address": address,
        "key_source": _key_source(),
        "clob_ready": _clob_creds() is not None,
    })


@app.get("/attestation")
def attestation():
    """TDX quote binding this enclave to its derived Polygon address, so a client can verify it
    is talking to the genuine KMS-keyed signer (not an impostor with a look-alike address).

    report_data = sha256("siphon-order-signer:" + address). Returned alongside the get_key
    signature_chain (proves the key was KMS-derived in a real TEE). Public — no token needed.
    """
    from dstack_sdk import DstackClient

    try:
        acct = _local_account()
        rd = hashlib.sha256(f"siphon-order-signer:{acct.address}".encode()).digest()
        client = DstackClient()
        quote = client.get_quote(rd)
        key_resp = client.get_key(KMS_KEY_PATH)
        return jsonify({
            "address": acct.address,
            "report_data_hex": rd.hex(),
            "quote": getattr(quote, "quote", None),
            "event_log": getattr(quote, "event_log", None),
            # Signatures proving the key was KMS-derived in a genuine TEE (list of hex strings).
            "key_signature_chain": getattr(key_resp, "signature_chain", None),
        })
    except Exception as e:
        return jsonify({"error": f"attestation unavailable: {e}", "key_source": _key_source()}), 503


# ── Compliant receipts: enclave notary ──────────────────────────────────────────────────────────
@app.post("/receipt/sign")
def receipt_sign():
    """Notarise a compliant receipt: sign its canonical digest with the enclave's KMS-derived key
    (EIP-191). A verifier recovers the signer from the signature and confirms — via GET /attestation
    — that this address is report_data-bound inside a genuine TDX quote, i.e. the receipt was minted
    by the real Siphon enclave. Only the digest is signed; the enclave never sees the note linkage."""
    if not _token_ok():
        return jsonify({"error": "unauthorized"}), 401
    body = request.get_json(force=True, silent=True) or {}
    digest = body.get("digest")
    if not isinstance(digest, str) or not digest.startswith("0x"):
        return jsonify({"error": "digest (0x-hex) required"}), 400
    try:
        from eth_account.messages import encode_defunct

        acct = _local_account()
        signed = acct.sign_message(encode_defunct(hexstr=digest))
        raw = getattr(signed, "signature", None)
        sig = raw.hex() if hasattr(raw, "hex") else str(raw)
        return jsonify({
            "signature": sig if sig.startswith("0x") else "0x" + sig,
            "address": acct.address,
            # The signer address IS the attestation binding: report_data = sha256("siphon-order-signer:"+address).
            "attestation_ref": acct.address,
        })
    except Exception as e:
        return jsonify({"error": f"receipt sign failed: {e}"}), 500


# ── EVM signing (imported keys) ────────────────────────────────────────────────────────────────
def _evm_account(chain_id: int):
    if chain_id in _evm_account_cache:
        return _evm_account_cache[chain_id]
    from eth_account import Account

    env_name = _EVM_KEY_ENV.get(chain_id, "EVM_EXECUTOR_KEY")
    key = (os.environ.get(env_name) or os.environ.get("EVM_EXECUTOR_KEY") or "").strip()
    if not key:
        raise RuntimeError(f"no EVM key for chain {chain_id} (set {env_name} or EVM_EXECUTOR_KEY)")
    acct = Account.from_key(key if key.startswith("0x") else "0x" + key)
    _evm_account_cache[chain_id] = acct
    return acct


@app.get("/evm/address")
def evm_address():
    if not _token_ok():
        return jsonify({"error": "unauthorized"}), 401
    try:
        chain_id = int(request.args.get("chain_id", "0"))
        return jsonify({"chain_id": chain_id, "address": _evm_account(chain_id).address})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/evm/sign")
def evm_sign():
    """Sign a fully-formed EVM transaction with the chain's imported key. The executor builds the
    tx (nonce/gas/fees/data) and broadcasts the returned raw tx — the key never leaves the CVM."""
    if not _token_ok():
        return jsonify({"error": "unauthorized"}), 401
    body = request.get_json(force=True, silent=True) or {}
    try:
        chain_id = int(body["chain_id"])
        tx = dict(body["tx"])
        # JSON carries big ints as strings for fields that can exceed 2^53 — coerce back.
        for f in ("value", "gas", "nonce", "maxFeePerGas", "maxPriorityFeePerGas", "gasPrice", "chainId"):
            if f in tx and isinstance(tx[f], str) and tx[f].strip() != "":
                tx[f] = int(tx[f], 0)
        acct = _evm_account(chain_id)
        # `from` is derived from the key; different eth-account versions disagree on accepting it.
        sender = tx.pop("from", None)
        if sender and Web3.to_checksum_address(sender) != acct.address:
            return jsonify({"error": f"from {sender} != signer {acct.address}"}), 400
        signed = acct.sign_transaction(tx)
        raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
        return jsonify({"raw": "0x" + bytes(raw).hex(), "from": acct.address})
    except KeyError as e:
        return jsonify({"error": f"missing field {e}"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/polymarket/deriveCreds")
def derive_creds():
    if not _token_ok():
        return jsonify({"error": "unauthorized"}), 401
    from py_clob_client.client import ClobClient

    client = ClobClient(CLOB_HOST, key=_signing_key_hex(), chain_id=POLYGON_CHAIN_ID)
    creds = client.create_or_derive_api_creds()
    _derived_creds.update({
        "api_key": creds.api_key,
        "api_secret": creds.api_secret,
        "api_passphrase": creds.api_passphrase,
    })
    # Deliberately NOT returned — the creds live and die inside the enclave.
    return jsonify({"ok": True, "derived": True})


@app.post("/polymarket/approvals")
def approvals():
    if not _token_ok():
        return jsonify({"error": "unauthorized"}), 401
    w3 = _w3()
    account = _account(w3)
    usdc = w3.eth.contract(address=Web3.to_checksum_address(USDC_E_ADDRESS), abi=_ERC20_ABI)
    ctf = w3.eth.contract(address=Web3.to_checksum_address(CTF_ADDRESS), abi=_CTF_ABI)
    sent = []
    for spender in (CTF_EXCHANGE, NEG_RISK_EXCHANGE, NEG_RISK_ADAPTER):
        spender = Web3.to_checksum_address(spender)
        if usdc.functions.allowance(account.address, spender).call() < 10**12:
            tx = usdc.functions.approve(spender, 2**256 - 1).build_transaction(
                {"from": account.address, "gas": 120_000})
            sent.append(_send(w3, account, tx, f"usdc_approve:{spender[:10]}"))
        if not ctf.functions.isApprovedForAll(account.address, spender).call():
            tx = ctf.functions.setApprovalForAll(spender, True).build_transaction(
                {"from": account.address, "gas": 120_000})
            sent.append(_send(w3, account, tx, f"ctf_approval:{spender[:10]}"))
    return jsonify({"ok": True, "txs": sent})


@app.post("/polymarket/order")
def order():
    if not _token_ok():
        return jsonify({"error": "unauthorized"}), 401
    from py_clob_client.clob_types import OrderArgs, OrderType
    from py_clob_client.order_builder.constants import BUY, SELL

    body = request.get_json(force=True, silent=True) or {}
    try:
        client = _clob_client()
        builder = body.get("builder_code") or os.environ.get("POLYMARKET_BUILDER_CODE") or None
        if builder:
            try:
                client.session.headers.update({"X-Builder-Code": builder})  # type: ignore[attr-defined]
            except Exception:
                pass
        args = OrderArgs(
            token_id=str(body["token_id"]),
            price=float(body["price"]),
            size=float(body["size"]),
            side=BUY if str(body.get("side", "BUY")).upper() == "BUY" else SELL,
        )
        # GTC for entries (rest on the book); FAK/FOK for exits (fill-now-or-cancel, so the
        # executor can measure realized proceeds immediately instead of leaving a resting order).
        ot = str(body.get("order_type", "GTC")).upper()
        order_type = {"GTC": OrderType.GTC, "FAK": OrderType.FAK, "FOK": OrderType.FOK}.get(ot, OrderType.GTC)
        signed = client.create_order(args)
        resp = client.post_order(signed, order_type)
        resp = resp if isinstance(resp, dict) else {}
        return jsonify({
            "order_id": resp.get("orderID") or resp.get("order_id"),
            "status": resp.get("status"),
            "raw": resp,
        })
    except KeyError as e:
        return jsonify({"error": f"missing field {e}"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/polymarket/redeem")
def redeem():
    if not _token_ok():
        return jsonify({"error": "unauthorized"}), 401
    body = request.get_json(force=True, silent=True) or {}
    condition_id = str(body.get("condition_id") or "")
    if not condition_id:
        return jsonify({"error": "condition_id required"}), 400
    try:
        w3 = _w3()
        account = _account(w3)
        ctf = w3.eth.contract(address=Web3.to_checksum_address(CTF_ADDRESS), abi=_CTF_ABI)
        cid = bytes.fromhex(condition_id.removeprefix("0x"))
        tx = ctf.functions.redeemPositions(
            Web3.to_checksum_address(USDC_E_ADDRESS), b"\x00" * 32, cid, [1, 2],
        ).build_transaction({"from": account.address, "gas": 400_000})
        return jsonify({"ok": True, "tx_hash": _send(w3, account, tx, "ctf_redeem")})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5003")))
