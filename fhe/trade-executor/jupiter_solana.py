"""Jupiter SOL/USDC swap + Trigger (limit) helpers for Solana bootstrap execution.

Honest scope: this is the *public* Jupiter leg used until siphon-vault private
settlement CPI is live. Mainnet Jupiter APIs require JUPITER_API_KEY.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

SOL_MINT = "So11111111111111111111111111111111111111112"
USDC_MINT = os.getenv(
    "SOLANA_USDC_MINT", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
)

JUPITER_API_URL = os.getenv("JUPITER_API_URL", "https://api.jup.ag/swap/v1").rstrip("/")
JUPITER_TRIGGER_URL = os.getenv("JUPITER_TRIGGER_URL", "https://api.jup.ag/trigger/v2").rstrip("/")
JUPITER_API_KEY = (os.getenv("JUPITER_API_KEY") or "").strip()


def _headers(extra: Optional[dict] = None) -> dict:
    h = {"Content-Type": "application/json", "Accept": "application/json"}
    if JUPITER_API_KEY:
        h["x-api-key"] = JUPITER_API_KEY
    if extra:
        h.update(extra)
    return h


def _http_json(url: str, *, method: str = "GET", body: Any = None, headers: Optional[dict] = None) -> dict:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers=_headers(headers), method=method)
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:800]
        raise RuntimeError(f"Jupiter HTTP {exc.code} {url}: {detail}") from exc


def mint_pair(side: str) -> tuple[str, str]:
    """LIMIT_SELL / sell = SOL→USDC; LIMIT_BUY / buy = USDC→SOL."""
    s = (side or "").upper()
    if s in ("LIMIT_BUY", "BUY"):
        return USDC_MINT, SOL_MINT
    return SOL_MINT, USDC_MINT


def quote_swap(
    *,
    amount: int,
    side: str = "LIMIT_SELL",
    slippage_bps: int = 100,
) -> dict:
    input_mint, output_mint = mint_pair(side)
    if amount <= 0:
        raise ValueError("amount must be positive base units")
    qs = urllib.parse.urlencode(
        {
            "inputMint": input_mint,
            "outputMint": output_mint,
            "amount": str(int(amount)),
            "slippageBps": str(int(slippage_bps)),
        }
    )
    # Prefer swap/v1 quote path; fall back to legacy shape if host uses swap/v1 root.
    base = JUPITER_API_URL
    if base.endswith("/swap/v1"):
        url = f"{base}/quote?{qs}"
    else:
        url = f"{base}/quote?{qs}"
    return _http_json(url)


def build_swap_transaction(*, quote: dict, user_pubkey: str) -> dict:
    user_pubkey = (user_pubkey or "").strip()
    if not user_pubkey:
        raise ValueError("user_pubkey required")
    base = JUPITER_API_URL
    url = f"{base}/swap" if base.endswith("/swap/v1") else f"{base}/swap"
    return _http_json(
        url,
        method="POST",
        body={
            "quoteResponse": quote,
            "userPublicKey": user_pubkey,
            "wrapAndUnwrapSol": True,
            "dynamicComputeUnitLimit": True,
        },
    )


def craft_trigger_limit_deposit(
    *,
    user_pubkey: str,
    amount: int,
    side: str = "LIMIT_SELL",
) -> dict:
    """Jupiter Trigger v2 deposit craft for a single price order."""
    if not JUPITER_API_KEY:
        raise RuntimeError("JUPITER_API_KEY is required for Trigger limit orders")
    input_mint, output_mint = mint_pair(side)
    return _http_json(
        f"{JUPITER_TRIGGER_URL}/deposit/craft",
        method="POST",
        body={
            "inputMint": input_mint,
            "outputMint": output_mint,
            "userAddress": user_pubkey,
            "amount": str(int(amount)),
            "orderType": "price",
            "orderSubType": "single",
        },
    )


def create_trigger_limit_order(
    *,
    user_pubkey: str,
    amount: int,
    trigger_price_usd: float,
    side: str = "LIMIT_SELL",
    deposit_request_id: str,
    deposit_signed_tx: str,
    slippage_bps: int = 100,
    expires_ms: Optional[int] = None,
    auth_bearer: Optional[str] = None,
) -> dict:
    """Create a Jupiter Trigger single price order after the deposit tx is signed."""
    if not JUPITER_API_KEY:
        raise RuntimeError("JUPITER_API_KEY is required for Trigger limit orders")
    input_mint, output_mint = mint_pair(side)
    # Sell SOL when price goes *above* target; buy SOL when price goes *below*.
    condition = "below" if (side or "").upper() in ("LIMIT_BUY", "BUY") else "above"
    body = {
        "orderType": "single",
        "depositRequestId": deposit_request_id,
        "depositSignedTx": deposit_signed_tx,
        "userPubkey": user_pubkey,
        "inputMint": input_mint,
        "outputMint": output_mint,
        "inputAmount": str(int(amount)),
        "triggerMint": SOL_MINT,
        "triggerCondition": condition,
        "triggerPriceUsd": float(trigger_price_usd),
        "slippageBps": int(slippage_bps),
        "expiresAt": int(expires_ms or (time.time() * 1000 + 7 * 24 * 60 * 60 * 1000)),
    }
    headers = {}
    if auth_bearer:
        headers["Authorization"] = f"Bearer {auth_bearer}"
    return _http_json(
        f"{JUPITER_TRIGGER_URL}/orders/price",
        method="POST",
        body=body,
        headers=headers,
    )


def describe_sol_usdc_limit_plan(
    *,
    amount: int,
    trigger_price_usd: float,
    side: str,
    user_pubkey: str,
) -> dict:
    input_mint, output_mint = mint_pair(side)
    return {
        "runtime": "solana-v1",
        "settlement": "jupiter-public-bootstrap",
        "privacyNote": "Public Jupiter leg — not a private vault spend.",
        "side": side,
        "amount": int(amount),
        "triggerPriceUsd": float(trigger_price_usd),
        "inputMint": input_mint,
        "outputMint": output_mint,
        "userPubkey": user_pubkey,
        "requiresApiKey": not bool(JUPITER_API_KEY),
        "steps": [
            "faucet_or_fund_wallet",
            "craft_trigger_deposit",
            "phantom_sign_deposit",
            "create_trigger_price_order",
        ],
    }


def execute_solana_strategy_fill(strategy: dict, current_price: float) -> dict:
    """Market-swap fill path used when Siphon's own trigger fires (FHE/condition tree).

    Builds a Jupiter swap from the strategy size; does not claim a mined tx unless
    SOLANA_RELAYER_KEYPAIR is later wired to sign+send (same policy as vault spend).
    """
    side = (strategy.get("side") or strategy.get("strategy_type") or "LIMIT_SELL").upper()
    if "BUY" in side:
        side = "LIMIT_BUY"
    else:
        side = "LIMIT_SELL"
    amount = int(strategy.get("amount") or strategy.get("amount_wei") or 0)
    if amount <= 0:
        # allow human decimals in amount_ui * 1e9 for SOL sells
        ui = float(strategy.get("amount_ui") or 0)
        amount = int(ui * 1_000_000_000) if side == "LIMIT_SELL" else int(ui * 1_000_000)
    user = (
        strategy.get("recipient_address")
        or strategy.get("recipient")
        or strategy.get("wallet")
        or ""
    )
    quote = quote_swap(amount=amount, side=side, slippage_bps=int(strategy.get("slippage_bps") or 100))
    built = build_swap_transaction(quote=quote, user_pubkey=user)
    return {
        "ok": False,
        "pending": True,
        "runtime": "solana-v1",
        "settlement": "jupiter-swap",
        "message": "Jupiter swap transaction built; sign with Phantom or relayer to submit.",
        "currentPrice": current_price,
        "quote": quote,
        "swapTransaction": built.get("swapTransaction") or built.get("transaction"),
        "raw": built,
    }
