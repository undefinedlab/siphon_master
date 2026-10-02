"""Polymarket CLOB order client — the one credential-gated seam of the private-markets backend.

Wraps Polymarket's official `py-clob-client` (an optional dependency). Placing orders on behalf of
users requires: the Polygon executor key, L2 API creds (key/secret/passphrase), and a builder code
(builder-program onboarding + posting-server whitelisting). Until those are configured this module
raises `PolymarketNotConfigured`, so the whole orchestration (withdraw → bridge → [order] → position
row) can be built and exercised up to this call without live credentials.

Config (env):
  POLYMARKET_CLOB_URL          default https://clob.polymarket.com
  POLYGON_EXECUTOR_KEY         private key of the Polygon signer/funder
  POLYMARKET_API_KEY / _SECRET / _PASSPHRASE   L2 creds (derive once via the SDK)
  POLYMARKET_BUILDER_CODE      builder attribution (optional but recommended)
  POLYMARKET_FUNDER            funder address (proxy/EOA) if different from the signer
"""
import json
import os

import requests


class PolymarketNotConfigured(RuntimeError):
    """Raised when CLOB credentials / SDK are not available. Non-fatal to the rest of the stack."""


CLOB_URL = os.environ.get("POLYMARKET_CLOB_URL", "https://clob.polymarket.com").rstrip("/")
GAMMA_URL = os.environ.get("POLYMARKET_GAMMA_URL", "https://gamma-api.polymarket.com").rstrip("/")
POLYGON_CHAIN_ID = 137
POLYGON_RPC = os.environ.get("POLYGON_RPC", "https://polygon-rpc.com")

# Polymarket's Polygon-mainnet contract surface (fixed addresses).
CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"          # ConditionalTokens (ERC-1155)
USDC_E_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"       # USDC.e — CLOB collateral
CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E"         # binary-market exchange
NEG_RISK_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a"    # neg-risk (multi-outcome)
NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296"

_ERC20_ABI = json.loads(
    '[{"constant":false,"inputs":[{"name":"spender","type":"address"},{"name":"value","type":"uint256"}],'
    '"name":"approve","outputs":[{"name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},'
    '{"constant":true,"inputs":[{"name":"owner","type":"address"},{"name":"spender","type":"address"}],'
    '"name":"allowance","outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"},'
    '{"constant":true,"inputs":[{"name":"owner","type":"address"}],"name":"balanceOf",'
    '"outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"}]'
)
_CTF_ABI = json.loads(
    '[{"inputs":[{"name":"operator","type":"address"},{"name":"approved","type":"bool"}],'
    '"name":"setApprovalForAll","outputs":[],"stateMutability":"nonpayable","type":"function"},'
    '{"inputs":[{"name":"owner","type":"address"},{"name":"operator","type":"address"}],'
    '"name":"isApprovedForAll","outputs":[{"name":"","type":"bool"}],"stateMutability":"view","type":"function"},'
    '{"inputs":[{"name":"conditionId","type":"bytes32"}],"name":"payoutDenominator",'
    '"outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"},'
    '{"inputs":[{"name":"collateralToken","type":"address"},{"name":"parentCollectionId","type":"bytes32"},'
    '{"name":"conditionId","type":"bytes32"},{"name":"indexSets","type":"uint256[]"}],'
    '"name":"redeemPositions","outputs":[],"stateMutability":"nonpayable","type":"function"}]'
)


def _polygon_w3():
    from web3 import Web3
    from web3.middleware import geth_poa_middleware  # web3 6.x name

    w3 = Web3(Web3.HTTPProvider(POLYGON_RPC, request_kwargs={"timeout": 30}))
    # Polygon is POA: block extraData exceeds 32 bytes, so block-fetching calls (fee estimation
    # in build_transaction) raise ExtraDataLengthError without this middleware.
    w3.middleware_onion.inject(geth_poa_middleware, layer=0)
    return w3


def _polygon_account(w3):
    key = os.environ.get("POLYGON_EXECUTOR_KEY")
    if not key:
        raise PolymarketNotConfigured("POLYGON_EXECUTOR_KEY not set")
    return w3.eth.account.from_key(key)


def _send_polygon_tx(w3, account, tx, label: str) -> str:
    tx.setdefault("nonce", w3.eth.get_transaction_count(account.address))
    tx.setdefault("chainId", POLYGON_CHAIN_ID)
    if "gasPrice" not in tx and "maxFeePerGas" not in tx:
        tx["gasPrice"] = int(w3.eth.gas_price * 1.2)
    signed = account.sign_transaction(tx)
    raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
    tx_hash = w3.eth.send_raw_transaction(raw)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=300)
    if receipt.status != 1:
        raise RuntimeError(f"{label} tx reverted: {tx_hash.hex()}")
    print(f"   [Polymarket] {label} confirmed: {tx_hash.hex()}")
    return tx_hash.hex()


# ── TEE signing mode ─────────────────────────────────────────────────────────────────────────
# When ORDER_SIGNER_URL (+ token) is set, ALL Polymarket signing — CLOB orders, approvals, CTF
# redemptions — happens inside the Phala CVM's order-signer (see ../order-signer/). This box
# then holds no Polygon key and no CLOB creds; it only sends authenticated intents. The local
# venv-bridge below remains as the non-TEE fallback.
ORDER_SIGNER_URL = os.environ.get("ORDER_SIGNER_URL", "").rstrip("/")
ORDER_SIGNER_TOKEN = os.environ.get("ORDER_SIGNER_TOKEN", "")
# Pinned enclave identity. When set, the signer's attestation MUST match before we trust it with
# funds. ORDER_SIGNER_MEASUREMENT is the compose-hash/RTMR from `phala cvms attestation`.
ORDER_SIGNER_MEASUREMENT = os.environ.get("ORDER_SIGNER_MEASUREMENT", "")
# Full Intel DCAP signature-chain verification via Phala's hosted verifier (server-to-server,
# no CORS concern here). On by default; set POLYMARKET_DCAP_VERIFY=0 only for offline local dev.
QUOTE_VERIFY_URL = os.environ.get(
    "QUOTE_VERIFY_URL", "https://cloud-api.phala.network/api/v1/attestations/verify"
)
DCAP_VERIFY = os.environ.get("POLYMARKET_DCAP_VERIFY", "1") != "0"
_signer_address_cache: "list" = []
_attested_ok: "list" = []  # cache: verified once per process


def tee_signing() -> bool:
    return bool(ORDER_SIGNER_URL and ORDER_SIGNER_TOKEN)


def _verify_signer_attestation() -> None:
    """Confirm the order-signer is the genuine KMS-keyed enclave before bridging funds to it.

    Full DCAP verification (see dcap_verify.py — the Python twin of the browser's
    decryptorAttestation.ts), cached after first success:
      1. the quote's Intel DCAP signature chain verifies against Intel's roots via Phala's
         hosted verifier (unless POLYMARKET_DCAP_VERIFY=0 — offline local dev only),
      2. the QUOTE BYTES' report_data == sha256("siphon-order-signer:" + address) — binds the
         attested quote to the exact address we will bridge to (checked against the signed quote
         itself, never the response's self-reported report_data_hex field),
      3. if ORDER_SIGNER_MEASUREMENT is pinned, the dstack event log replays to the quote's
         RTMR3 and its compose-hash event equals the pin (a lying log can't fake this).

    Raises on failure. (1) proves genuine Intel hardware, (2) binds it to the bridge recipient,
    and (3) pins the exact enclave image — the full chain, not just pinning.
    """
    if _attested_ok:
        return
    from dcap_verify import (
        DcapVerificationError,
        verify_measurement_pin,
        verify_quote_signature,
        verify_report_data_binding,
    )

    res = requests.get(f"{ORDER_SIGNER_URL}/attestation", timeout=20)
    data = res.json() if res.ok else {}
    if not res.ok or data.get("error"):
        raise RuntimeError(f"signer attestation unavailable: {data.get('error') or res.status_code}")

    address = data.get("address")
    quote = data.get("quote")
    if not address or not quote:
        raise RuntimeError("signer attestation missing address/quote")
    event_log = data.get("event_log")
    if isinstance(event_log, (list, dict)):  # dstack SDK versions differ: JSON string vs parsed
        event_log = json.dumps(event_log)

    try:
        quote_bytes = bytes.fromhex(str(quote).removeprefix("0x"))
        if DCAP_VERIFY:
            verify_quote_signature(str(quote), verify_url=QUOTE_VERIFY_URL)
        verify_report_data_binding(quote_bytes, f"siphon-order-signer:{address}")
        if ORDER_SIGNER_MEASUREMENT:
            if not event_log:
                raise DcapVerificationError("measurement pinned but attestation has no event log")
            verify_measurement_pin(quote_bytes, event_log, ORDER_SIGNER_MEASUREMENT)
    except DcapVerificationError as e:
        raise RuntimeError(f"signer attestation FAILED for {address}: {e}")

    print(f"[Polymarket] ✅ signer attestation verified for {address} "
          f"(measurement {'pinned' if ORDER_SIGNER_MEASUREMENT else 'UNPINNED'}, "
          f"DCAP {'verified' if DCAP_VERIFY else 'SKIPPED'})")
    _attested_ok.append(True)


def _tee_post(path: str, payload: dict, timeout: int = 300) -> dict:
    res = requests.post(
        f"{ORDER_SIGNER_URL}{path}",
        json=payload,
        headers={"X-API-TOKEN": ORDER_SIGNER_TOKEN},
        timeout=timeout,
    )
    try:
        data = res.json()
    except Exception:
        data = {}
    if not res.ok or data.get("error"):
        raise RuntimeError(f"order-signer {path} failed (HTTP {res.status_code}): "
                           f"{data.get('error') or res.text[:300]}")
    return data


# The CLOB SDK lives in its own venv (dependency clash with web3 6.x — see clob_bridge.py).
CLOB_VENV_PYTHON = os.environ.get("CLOB_VENV_PYTHON", "/opt/clob/bin/python")
_BRIDGE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "clob_bridge.py")


def _bridge_available() -> bool:
    return os.path.exists(CLOB_VENV_PYTHON) and os.path.exists(_BRIDGE)


def _call_bridge(request: dict, timeout: int = 60) -> dict:
    """Run one op in the isolated CLOB venv; JSON on stdin/stdout, secrets via inherited env."""
    import subprocess

    proc = subprocess.run(
        [CLOB_VENV_PYTHON, _BRIDGE],
        input=json.dumps(request).encode(),
        capture_output=True,
        timeout=timeout,
        env=os.environ.copy(),
    )
    out = proc.stdout.decode().strip()
    if proc.returncode != 0 or not out:
        detail = out or proc.stderr.decode().strip()[-500:]
        raise RuntimeError(f"clob bridge failed (op={request.get('op')}): {detail}")
    resp = json.loads(out)
    if resp.get("error"):
        raise RuntimeError(f"clob bridge error: {resp['error']}")
    return resp


def is_configured() -> bool:
    """TEE mode: signer URL+token suffice (key/creds live in the enclave). Local mode: venv
    bridge + key + L2 creds must all be present on this box."""
    if tee_signing():
        return True
    if not os.environ.get("POLYGON_EXECUTOR_KEY"):
        return False
    if not (
        os.environ.get("POLYMARKET_API_KEY")
        and os.environ.get("POLYMARKET_API_SECRET")
        and os.environ.get("POLYMARKET_API_PASSPHRASE")
    ):
        return False
    return _bridge_available()


def derive_api_creds() -> dict:
    """L1-sign against the CLOB to create-or-derive the L2 API creds (key/secret/passphrase)."""
    if not os.environ.get("POLYGON_EXECUTOR_KEY"):
        raise PolymarketNotConfigured("POLYGON_EXECUTOR_KEY not set")
    if not _bridge_available():
        raise PolymarketNotConfigured(f"CLOB venv missing at {CLOB_VENV_PYTHON}")
    return _call_bridge({"op": "derive_creds"})


def ensure_polygon_approvals() -> None:
    """One-time ERC-20 + ERC-1155 approvals so the CLOB exchanges can settle our orders.

    BUY fills pull USDC.e from the funder; SELL fills (and neg-risk markets) move CTF outcome
    tokens. Checked lazily before every order — no-ops once granted. Requires POL for gas.
    """
    if tee_signing():
        _tee_post("/polymarket/approvals", {})
        return

    from web3 import Web3

    w3 = _polygon_w3()
    account = _polygon_account(w3)
    usdc = w3.eth.contract(address=Web3.to_checksum_address(USDC_E_ADDRESS), abi=_ERC20_ABI)
    ctf = w3.eth.contract(address=Web3.to_checksum_address(CTF_ADDRESS), abi=_CTF_ABI)
    max_uint = 2**256 - 1

    for spender in (CTF_EXCHANGE, NEG_RISK_EXCHANGE, NEG_RISK_ADAPTER):
        spender = Web3.to_checksum_address(spender)
        if usdc.functions.allowance(account.address, spender).call() < 10**12:
            tx = usdc.functions.approve(spender, max_uint).build_transaction(
                {"from": account.address, "gas": 120_000}
            )
            _send_polygon_tx(w3, account, tx, f"usdc_approve:{spender[:10]}")
        if not ctf.functions.isApprovedForAll(account.address, spender).call():
            tx = ctf.functions.setApprovalForAll(spender, True).build_transaction(
                {"from": account.address, "gas": 120_000}
            )
            _send_polygon_tx(w3, account, tx, f"ctf_approval:{spender[:10]}")


def condition_id_for_token(token_id: str) -> "str | None":
    """Resolve a CLOB token id to its market's conditionId via the public Gamma API."""
    try:
        res = requests.get(
            f"{GAMMA_URL}/markets",
            params={"clob_token_ids": str(token_id)},
            timeout=10,
        )
        res.raise_for_status()
        markets = res.json()
        if isinstance(markets, list) and markets:
            cid = markets[0].get("conditionId")
            return str(cid) if cid else None
    except Exception as e:
        print(f"   [Polymarket] ⚠️ condition lookup failed for token {token_id}: {e}")
    return None


def is_resolved(condition_id: str) -> bool:
    """True once the market's oracle has reported payouts (payoutDenominator > 0)."""
    from web3 import Web3

    w3 = _polygon_w3()
    ctf = w3.eth.contract(address=Web3.to_checksum_address(CTF_ADDRESS), abi=_CTF_ABI)
    cid = bytes.fromhex(condition_id.removeprefix("0x"))
    return ctf.functions.payoutDenominator(cid).call() > 0


def usdc_e_balance(address: str) -> int:
    from web3 import Web3

    w3 = _polygon_w3()
    usdc = w3.eth.contract(address=Web3.to_checksum_address(USDC_E_ADDRESS), abi=_ERC20_ABI)
    return usdc.functions.balanceOf(Web3.to_checksum_address(address)).call()


def executor_polygon_address() -> str:
    if tee_signing():
        # Verify BEFORE returning the address — this value becomes the bridge recipient, so we
        # must prove it belongs to the genuine KMS-keyed enclave first.
        _verify_signer_attestation()
        if not _signer_address_cache:
            res = requests.get(f"{ORDER_SIGNER_URL}/health", timeout=15)
            addr = (res.json() or {}).get("address")
            if not addr:
                raise RuntimeError("order-signer /health returned no address")
            _signer_address_cache.append(addr)
        return _signer_address_cache[0]
    w3 = _polygon_w3()
    return _polygon_account(w3).address


def market_price(token_id: str, side: str) -> float:
    """Best marketable price for `token_id` on `side` (CLOB /price). side='SELL' → the bid we can
    sell into; 'BUY' → the ask we'd pay. Falls back to the /midpoint if /price is unavailable."""
    s = str(side).upper()
    try:
        res = requests.get(f"{CLOB_URL}/price", params={"token_id": str(token_id), "side": s}, timeout=10)
        res.raise_for_status()
        p = float((res.json() or {}).get("price"))
        if p > 0:
            return p
    except Exception as e:
        print(f"   [Polymarket] ⚠️ price lookup failed for {token_id} ({s}): {e}")
    res = requests.get(f"{CLOB_URL}/midpoint", params={"token_id": str(token_id)}, timeout=10)
    res.raise_for_status()
    return float((res.json() or {}).get("mid"))


def _submit_order(token_id: str, side: str, price: float, shares: float, order_type: str = "GTC") -> dict:
    """Low-level CLOB order submit (SHARES-denominated). Routes to the TEE signer when configured,
    else the local venv bridge. order_type ∈ {GTC, FAK, FOK} — exits use FAK to fill-now-or-cancel."""
    builder = os.environ.get("POLYMARKET_BUILDER_CODE") or None
    order_req = {
        "token_id": str(token_id),
        "side": str(side).upper(),
        "price": float(price),
        "size": float(shares),
        "order_type": str(order_type).upper(),
        "builder_code": builder,
    }
    if tee_signing():
        resp = _tee_post("/polymarket/order", order_req)
    else:
        resp = _call_bridge({"op": "place_order", **order_req})
    return {
        "order_id": resp.get("order_id"),
        "status": resp.get("status"),
        "shares": shares,
        "builder_code": builder,
        "raw": resp.get("raw"),
    }


def place_order(token_id: str, side: str, price: float, size_usdc: float) -> dict:
    """Place a GTC limit order for `size_usdc` of `token_id` at `price` (0..1). side ∈ {BUY, SELL}.

    Returns { order_id, status, shares, raw }. Raises PolymarketNotConfigured until wired.
    """
    if not is_configured():
        raise PolymarketNotConfigured(
            "Polymarket CLOB not configured: set ORDER_SIGNER_URL+TOKEN (TEE mode) or "
            "POLYGON_EXECUTOR_KEY + POLYMARKET_API_* with the /opt/clob venv (local mode)."
        )
    ensure_polygon_approvals()  # no-op once granted; first order needs USDC/CTF operator rights
    # size is in SHARES for the CLOB; shares = usdc / price.
    shares = size_usdc / price if price > 0 else 0
    return _submit_order(token_id, side, price, shares)


def sell_shares(token_id: str, price: float, shares: float) -> dict:
    """Liquidate `shares` of a held outcome token at `price` (fill-and-kill — take what the book
    offers now, cancel the rest). Used to EXIT a position before market resolution."""
    if not is_configured():
        raise PolymarketNotConfigured("Polymarket CLOB not configured (exit needs a live signer).")
    ensure_polygon_approvals()  # CTF setApprovalForAll lets the exchange move our outcome tokens
    return _submit_order(token_id, "SELL", price, shares, order_type="FAK")


def redeem_positions(condition_id: str, token_id: str) -> str:
    """Redeem resolved CTF outcome shares → USDC.e on Polygon. Returns tx hash.

    `redeemPositions(USDC.e, 0x0, conditionId, [1, 2])` burns whatever outcome tokens the
    executor holds for BOTH index sets (winning set pays out, losing set burns for 0) and
    credits USDC.e. Caller measures the balance delta for the realized payout.
    """
    if tee_signing():
        return _tee_post("/polymarket/redeem", {"condition_id": condition_id})["tx_hash"]

    from web3 import Web3

    w3 = _polygon_w3()
    account = _polygon_account(w3)
    ctf = w3.eth.contract(address=Web3.to_checksum_address(CTF_ADDRESS), abi=_CTF_ABI)
    cid = bytes.fromhex(condition_id.removeprefix("0x"))
    tx = ctf.functions.redeemPositions(
        Web3.to_checksum_address(USDC_E_ADDRESS),
        b"\x00" * 32,
        cid,
        [1, 2],
    ).build_transaction({"from": account.address, "gas": 400_000})
    return _send_polygon_tx(w3, account, tx, "ctf_redeem")
