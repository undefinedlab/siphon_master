"""Self-serve API-key purchase: verify a plain USDC Transfer, mint key, credit balance.

Payment is intentionally unshielded (wallet USDC → collector). Credits are 1:1 with USDC minor
units (6 decimals). The raw key plaintext is returned once and never stored.
"""
from __future__ import annotations

from typing import Any

from eth_abi import decode as abi_decode
from sqlalchemy.orm import Session
from web3 import Web3
from web3.exceptions import TransactionNotFound

from app.config import get_settings
from app.errors import BadRequest, Conflict, DownstreamUnavailable, NotFound
from app.repository.models import ApiKey, AuditLog, UsageEvent
from app.services import api_key_service, credit_service
from app.services.confirmations import get_rpc_url, is_confirmed

TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

# Credit packs priced in USDC minor units (6 decimals).
PACKS: dict[str, dict[str, Any]] = {
    "starter": {
        "id": "starter",
        "label": "$5 API credit",
        "usdc_minor": 5_000_000,
        "plan": "starter",
    },
    "growth": {
        "id": "growth",
        "label": "$25 API credit",
        "usdc_minor": 25_000_000,
        "plan": "growth",
    },
    "scale": {
        "id": "scale",
        "label": "$100 API credit",
        "usdc_minor": 100_000_000,
        "plan": "enterprise",
    },
}

# Custom amount: any USDC ≥ this floor (1 USDC).
MIN_CUSTOM_USDC_MINOR = 1_000_000
CUSTOM_PACK_ID = "custom"

# Canonical USDC addresses for supported chains (must match siphon-app networks.ts).
USDC_BY_CHAIN: dict[int, str] = {
    8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    42161: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    11155111: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
}


def list_packs() -> list[dict[str, Any]]:
    return [
        {
            "id": p["id"],
            "label": p["label"],
            "usdc_minor": p["usdc_minor"],
            "plan": p["plan"],
        }
        for p in PACKS.values()
    ]


def resolve_pack(pack_id: str, usdc_minor: int | None = None) -> dict[str, Any]:
    """Resolve a fixed pack or a custom amount into {id, label, usdc_minor, plan}."""
    if pack_id == CUSTOM_PACK_ID:
        if usdc_minor is None:
            raise BadRequest("Custom pack requires usdc_minor.")
        amount = int(usdc_minor)
        if amount < MIN_CUSTOM_USDC_MINOR:
            raise BadRequest(
                f"Custom credit must be at least {MIN_CUSTOM_USDC_MINOR} minor units "
                f"({MIN_CUSTOM_USDC_MINOR / 1_000_000:.0f} USDC)."
            )
        return {
            "id": CUSTOM_PACK_ID,
            "label": "Custom API credit",
            "usdc_minor": amount,
            "plan": "custom",
        }
    pack = PACKS.get(pack_id)
    if not pack:
        raise NotFound(f"Unknown credit pack: {pack_id}")
    return dict(pack)


def collector_address() -> str:
    """The address customer USDC is paid to. Fail-CLOSED in production.

    An unset env var must never silently route real payments to a baked-in address: that is a
    funds-misdirection bug that looks like a working deploy. The dev fallback stays for local work.
    """
    settings = get_settings()
    addr = (settings.api_credit_collector or "").strip()
    if not addr:
        env = (getattr(settings, "siphon_env", None) or "").strip().lower()
        if env in {"prod", "production"}:
            raise DownstreamUnavailable(
                "API_CREDIT_COLLECTOR is not configured; refusing to quote or accept a payment "
                "address in production."
            )
        # Local/staging only: Base executor / arming-fee recipient used by the app today.
        addr = "0x5830A431E6866B8F8a605625b0713D8190FB06bA"
    return Web3.to_checksum_address(addr)


def usdc_address(chain_id: int) -> str:
    addr = USDC_BY_CHAIN.get(int(chain_id))
    if not addr:
        raise BadRequest(f"Unsupported chain_id for API credit purchase: {chain_id}")
    return Web3.to_checksum_address(addr)


def _norm_topic(topic: Any) -> str:
    """Normalize log topics from HexBytes / bytes / hex strings to lowercase 0x… form."""
    if hasattr(topic, "hex") and not isinstance(topic, str):
        s = topic.hex()
    else:
        s = str(topic)
    s = s.lower()
    return s if s.startswith("0x") else "0x" + s


def _topic_address(topic_hex: str) -> str:
    raw = topic_hex[2:] if topic_hex.startswith("0x") else topic_hex
    return Web3.to_checksum_address("0x" + raw[-40:])


def verify_usdc_payment(
    *,
    chain_id: int,
    tx_hash: str,
    payer: str,
    expected_amount_minor: int,
    require_extra_confirmations: bool = False,
) -> None:
    """Fail-closed: receipt must show USDC Transfer(payer → collector, amount)."""
    if require_extra_confirmations and not is_confirmed(chain_id, tx_hash):
        raise BadRequest("Payment transaction is missing, failed, or not yet confirmed.")

    rpc = get_rpc_url(chain_id)
    if not rpc:
        raise BadRequest("No RPC configured for this chain.")

    w3 = Web3(Web3.HTTPProvider(rpc))
    try:
        receipt = w3.eth.get_transaction_receipt(tx_hash)
    except TransactionNotFound as exc:
        # The chain answered and does not have it — a real negative about the payment.
        raise BadRequest("Payment transaction not found on this chain.") from exc
    except Exception as exc:
        # Same distinction as is_confirmed(): we could not look, which is our problem and is
        # retryable. Reporting it as a 400 blamed the user's payment for our dead RPC key.
        raise DownstreamUnavailable(
            "Could not reach the chain to verify your payment. The payment itself is unaffected — "
            "retry in a moment."
        ) from exc
    if not receipt or int(receipt.get("status", 0)) != 1:
        raise BadRequest("Payment transaction failed on-chain.")

    payer_cs = Web3.to_checksum_address(payer)
    collector = collector_address()
    token = usdc_address(chain_id).lower()
    topic0 = TRANSFER_TOPIC.lower()
    if not topic0.startswith("0x"):
        topic0 = "0x" + topic0

    matched = False
    for log in receipt.get("logs") or []:
        log_addr = (log.get("address") or "").lower()
        topics = log.get("topics") or []
        if log_addr != token.lower() or len(topics) < 3:
            continue
        t0 = _norm_topic(topics[0])
        if t0 != topic0.lower():
            continue
        frm = _topic_address(_norm_topic(topics[1]))
        to = _topic_address(_norm_topic(topics[2]))
        data = log.get("data") or b""
        if isinstance(data, str):
            data_bytes = bytes.fromhex(data[2:] if data.startswith("0x") else data)
        else:
            data_bytes = bytes(data)
        (value,) = abi_decode(["uint256"], data_bytes)
        if frm.lower() == payer_cs.lower() and to.lower() == collector.lower() and int(value) == int(expected_amount_minor):
            matched = True
            break

    if not matched:
        raise BadRequest(
            "No matching USDC transfer to the Siphon API credit collector was found in this transaction."
        )


def purchase_key(
    db: Session,
    *,
    wallet: str,
    chain_id: int,
    pack_id: str,
    tx_hash: str,
    request_id: str,
    test: bool = False,
    usdc_minor: int | None = None,
) -> dict:
    pack = resolve_pack(pack_id, usdc_minor)

    tx_norm = tx_hash.lower()
    if not tx_norm.startswith("0x"):
        tx_norm = "0x" + tx_norm

    # Idempotent: same payment tx cannot mint twice.
    prior = (
        db.query(UsageEvent)
        .filter(UsageEvent.event_type == "key_purchase", UsageEvent.tx_hash == tx_norm)
        .first()
    )
    if prior:
        raise Conflict("This payment transaction was already used to purchase an API key.")

    verify_usdc_payment(
        chain_id=chain_id,
        tx_hash=tx_norm,
        payer=wallet,
        expected_amount_minor=int(pack["usdc_minor"]),
        require_extra_confirmations=True,
    )

    wallet_l = wallet.lower()
    raw, row = api_key_service.mint_key(
        db,
        integrator_id=wallet_l,
        plan=str(pack["plan"]),
        test=test,
    )
    # Prepaid credit is posted through the ledger, not assigned directly, so every minor unit a key
    # has ever held is reconstructible from credit_ledger alone.
    credit_service.post_entry(
        db,
        row,
        kind="purchase",
        amount_minor=int(pack["usdc_minor"]),
        reason=f"pack={pack['id']} tx={tx_norm}",
        request_id=request_id,
    )

    db.add(
        UsageEvent(
            api_key_id=row.id,
            event_type="key_purchase",
            tx_hash=tx_norm,
            amount_minor=int(pack["usdc_minor"]),
            request_id=request_id,
        )
    )
    db.add(
        AuditLog(
            actor=wallet_l,
            action="key.purchase",
            target=row.id,
            result="minted",
            request_id=request_id,
            detail={
                "pack_id": pack["id"],
                "chain_id": chain_id,
                "tx_hash": tx_norm,
                "usdc_minor": int(pack["usdc_minor"]),
                "collector": collector_address(),
            },
        )
    )
    db.flush()

    return {
        "api_key": raw,
        "api_key_id": row.id,
        "plan": row.plan,
        "balance_minor": row.balance_minor,
        "pack_id": pack["id"],
        "tx_hash": tx_norm,
        "collector": collector_address(),
        "usdc": usdc_address(chain_id),
    }


def list_keys_for_wallet(db: Session, wallet: str) -> list[dict]:
    from sqlalchemy import func

    rows = (
        db.query(ApiKey)
        # EVM integrator ids are lowercase; a Solana wallet's base58 id is stored verbatim.
        .filter(ApiKey.integrator_id.in_({wallet, wallet.lower()}))
        .order_by(ApiKey.created_at.desc())
        .all()
    )
    out: list[dict] = []
    for r in rows:
        purchased = (
            db.query(func.coalesce(func.sum(UsageEvent.amount_minor), 0))
            .filter(
                UsageEvent.api_key_id == r.id,
                UsageEvent.event_type == "key_purchase",
            )
            .scalar()
        )
        credited = int(purchased or 0)
        grants = (
            db.query(AuditLog)
            .filter(AuditLog.target == r.id, AuditLog.action == "credit.grant")
            .all()
        )
        for g in grants:
            detail = g.detail or {}
            credited += int(detail.get("amount_minor") or 0)
        if credited < int(r.balance_minor or 0):
            credited = int(r.balance_minor or 0)
        out.append(
            {
                "api_key_id": r.id,
                "plan": r.plan,
                "status": r.status,
                "balance_minor": r.balance_minor,
                "credited_minor": credited,
                "created_at": (r.created_at.isoformat() if r.created_at else None),
            }
        )
    return out
