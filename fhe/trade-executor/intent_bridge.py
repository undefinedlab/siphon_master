"""Li.Fi-class intent / bridge hop — Solana-wallet → EVM vault fund (USDC-only).

See siphon-zk-v2/chain-profiles/intent-bridge-v1.json and
siphon-contracts-v2/docs/INTENT-BRIDGE.md / SOLANA-WRAPPER.md.
"""

from __future__ import annotations

from typing import Any, Optional

from solana_runtime import is_solana_chain_id

INTENT_PROFILE_ID = "intent-bridge-v1"
WALLET_FUND_PROFILE_ID = "solana-wallet-fund-evm-usdc-v1"
PREFERRED_ADAPTERS = ("lifi", "across", "native-bridge")

# Li.Fi Solana chain key ("SOL" also accepted by /quote).
LIFI_SOLANA_CHAIN = "1151111081099710"
BASE_CHAIN_ID = 8453
ARBITRUM_CHAIN_ID = 42161
EVM_FUND_DEST_CHAIN_IDS = {BASE_CHAIN_ID, ARBITRUM_CHAIN_ID}

# Circle USDC
BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
ARBITRUM_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"
SOLANA_USDC_DEFAULT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

CHAIN_LABELS = {
    BASE_CHAIN_ID: "Base",
    ARBITRUM_CHAIN_ID: "Arbitrum",
}


def needs_intent_hop(from_chain_id: Any, to_chain_id: Any) -> bool:
    try:
        a, b = int(from_chain_id), int(to_chain_id)
    except (TypeError, ValueError):
        return False
    return a != b


def describe_intent_hop(
    *,
    from_chain_id: int,
    to_chain_id: int,
    adapter: Optional[str] = None,
) -> dict:
    chosen = (adapter or "lifi").lower()
    if chosen not in PREFERRED_ADAPTERS:
        chosen = "lifi"
    return {
        "profileId": INTENT_PROFILE_ID,
        "notAVault": True,
        "adapter": chosen,
        "fromChainId": int(from_chain_id),
        "toChainId": int(to_chain_id),
        "steps": [
            "withdraw_source_vault",
            "public_bridge_hop",
            "deposit_dest_vault",
            "asp_screen_dest",
        ],
        "sourceRuntime": "solana-v1" if is_solana_chain_id(from_chain_id) else "evm-v1",
        "destRuntime": "solana-v1" if is_solana_chain_id(to_chain_id) else "evm-v1",
        "privacyNote": "Bridge leg is public; privacy resumes after destination deposit.",
    }


def _pending_step(name: str, message: str, **details: Any) -> dict:
    return {
        "step": name,
        "status": "pending",
        "ok": False,
        "pending": True,
        "message": message,
        **details,
    }


def _completed_step(name: str, message: str, **details: Any) -> dict:
    return {
        "step": name,
        "status": "completed",
        "ok": True,
        "pending": False,
        "message": message,
        **details,
    }


def _blocked_step(name: str, prerequisite: str) -> dict:
    return {
        "step": name,
        "status": "blocked",
        "ok": False,
        "pending": True,
        "blockedBy": prerequisite,
        "message": f"Waiting for {prerequisite} to produce a confirmed transaction.",
    }


def _withdraw_source_vault(
    *,
    from_chain_id: int,
    amount: int,
    asset: str,
    recipient: str,
) -> dict:
    return _pending_step(
        "withdraw_source_vault",
        "Solana vault↔vault bridge execution is parked; use /solana/fundBase/plan for wallet→EVM.",
        runtime="solana-v1" if is_solana_chain_id(from_chain_id) else "evm-v1",
        chainId=from_chain_id,
        amount=amount,
        asset=asset,
        recipient=recipient,
    )


def _public_bridge_hop(
    *,
    from_chain_id: int,
    to_chain_id: int,
    amount: int,
    asset: str,
    recipient: str,
    adapter: str,
) -> dict:
    return _pending_step(
        "public_bridge_hop",
        f"Public {adapter} hop from {from_chain_id} → {to_chain_id} is not auto-executed.",
        adapter=adapter,
        public=True,
        fromChainId=from_chain_id,
        toChainId=to_chain_id,
        amount=amount,
        asset=asset,
        recipient=recipient,
    )


def _deposit_dest_vault(
    *,
    to_chain_id: int,
    amount: int,
    asset: str,
    recipient: str,
) -> dict:
    return _pending_step(
        "deposit_dest_vault",
        "Destination vault deposit requires the destination deposit label/precommitment.",
        chainId=to_chain_id,
        amount=amount,
        asset=asset,
        recipient=recipient,
    )


def _asp_screen_dest(*, to_chain_id: int, recipient: str) -> dict:
    return _pending_step(
        "asp_screen_dest",
        "Destination ASP screening requires the destination deposit label/precommitment.",
        chainId=to_chain_id,
        recipient=recipient,
    )


def execute_intent_hop(
    from_chain_id: int,
    to_chain_id: int,
    amount: int,
    asset: str,
    recipient: str,
    bridge_adapter: str = "lifi",
) -> dict:
    from_chain_id, to_chain_id = int(from_chain_id), int(to_chain_id)
    amount = int(amount)
    asset, recipient = str(asset).strip(), str(recipient).strip()
    if from_chain_id == to_chain_id:
        raise ValueError("intent hop requires distinct source and destination chains")
    if amount <= 0:
        raise ValueError("amount must be a positive integer in asset base units")
    if not asset or not recipient:
        raise ValueError("asset and recipient are required")

    desc = describe_intent_hop(
        from_chain_id=from_chain_id,
        to_chain_id=to_chain_id,
        adapter=bridge_adapter,
    )
    adapter = desc["adapter"]
    transitions = (
        (
            "withdraw_source_vault",
            lambda: _withdraw_source_vault(
                from_chain_id=from_chain_id,
                amount=amount,
                asset=asset,
                recipient=recipient,
            ),
        ),
        (
            "public_bridge_hop",
            lambda: _public_bridge_hop(
                from_chain_id=from_chain_id,
                to_chain_id=to_chain_id,
                amount=amount,
                asset=asset,
                recipient=recipient,
                adapter=adapter,
            ),
        ),
        (
            "deposit_dest_vault",
            lambda: _deposit_dest_vault(
                to_chain_id=to_chain_id,
                amount=amount,
                asset=asset,
                recipient=recipient,
            ),
        ),
        (
            "asp_screen_dest",
            lambda: _asp_screen_dest(to_chain_id=to_chain_id, recipient=recipient),
        ),
    )

    steps = []
    blocked_by = None
    for name, transition in transitions:
        if blocked_by:
            steps.append(_blocked_step(name, blocked_by))
            continue
        try:
            step = transition()
        except Exception as exc:
            step = _pending_step(name, f"{name} did not complete: {exc}")
        steps.append(step)
        if step.get("status") != "completed":
            blocked_by = name

    return {
        **desc,
        "ok": False,
        "pending": True,
        "status": "pending",
        "amount": amount,
        "asset": asset,
        "recipient": recipient,
        "stepStatus": steps,
        "message": "Intent hop is not complete; no end-to-end settlement is claimed.",
    }


def execute_intent_hop_stub(**kwargs: Any) -> dict:
    if "adapter" in kwargs and "bridge_adapter" not in kwargs:
        kwargs["bridge_adapter"] = kwargs.pop("adapter")
    return execute_intent_hop(**kwargs)


def _dest_usdc(to_chain_id: int) -> str:
    if to_chain_id == ARBITRUM_CHAIN_ID:
        return ARBITRUM_USDC
    return BASE_USDC


def _quote_solana_usdc_to_evm(
    *,
    amount: int,
    solana_owner: str,
    recipient: str,
    to_chain_id: int,
    mint: Optional[str] = None,
) -> dict:
    """Best-effort Li.Fi quote for Phantom USDC → EVM USDC. Never claims a submitted tx."""
    from_token = mint or SOLANA_USDC_DEFAULT
    to_token = _dest_usdc(to_chain_id)
    label = CHAIN_LABELS.get(to_chain_id, str(to_chain_id))
    tool_url = (
        f"https://li.fi/widget?fromChain={LIFI_SOLANA_CHAIN}&toChain={to_chain_id}"
        f"&fromToken={from_token}&toToken={to_token}"
    )
    try:
        from lifi_executor import get_lifi_quote
    except ImportError:
        return _pending_step(
            "public_bridge_hop",
            f"Li.Fi quote helper unavailable; open the bridge widget to move USDC to {label}.",
            adapter="lifi",
            public=True,
            quoteAvailable=False,
            toolUrl=tool_url,
            fromChainId=LIFI_SOLANA_CHAIN,
            toChainId=to_chain_id,
        )

    try:
        quote = get_lifi_quote(
            from_chain=LIFI_SOLANA_CHAIN,
            to_chain=str(to_chain_id),
            from_token=from_token,
            to_token=to_token,
            from_amount=amount,
            from_address=solana_owner,
            to_address=recipient,
        )
    except Exception as exc:
        return _pending_step(
            "public_bridge_hop",
            f"Li.Fi quote pending ({exc}). Use the bridge widget, then deposit USDC on {label}.",
            adapter="lifi",
            public=True,
            quoteAvailable=False,
            toolUrl=tool_url,
            fromChainId=LIFI_SOLANA_CHAIN,
            toChainId=to_chain_id,
        )

    estimate = (quote or {}).get("estimate") or {}
    return _pending_step(
        "public_bridge_hop",
        f"Public Solana→{label} USDC bridge requires a Phantom-signed hop; "
        "quote prepared, tx not submitted by executor.",
        adapter="lifi",
        public=True,
        quoteAvailable=True,
        toolUrl=tool_url,
        toAmount=estimate.get("toAmount"),
        tool=(quote.get("tool") if isinstance(quote, dict) else None),
        hasTransactionRequest=bool((quote or {}).get("transactionRequest")),
        fromChainId=LIFI_SOLANA_CHAIN,
        toChainId=to_chain_id,
    )


def execute_wallet_fund_hop(
    *,
    from_chain_id: int,
    to_chain_id: int,
    amount: int,
    asset: str,
    recipient: str,
    solana_owner: str,
    mint: Optional[str] = None,
    bridge_adapter: str = "lifi",
) -> dict:
    """Solana wallet USDC → public bridge → EVM vault deposit guidance."""
    from_chain_id, to_chain_id = int(from_chain_id), int(to_chain_id)
    amount = int(amount)
    asset = str(asset).strip().upper()
    recipient = str(recipient).strip()
    solana_owner = str(solana_owner).strip()
    if not is_solana_chain_id(from_chain_id):
        raise ValueError("wallet fund hop requires a Solana source chain id")
    if to_chain_id not in EVM_FUND_DEST_CHAIN_IDS:
        raise ValueError(
            f"wallet fund hop destination must be Base ({BASE_CHAIN_ID}) or "
            f"Arbitrum ({ARBITRUM_CHAIN_ID})"
        )
    if asset != "USDC":
        raise ValueError("Solana fund door accepts USDC only")
    if amount <= 0:
        raise ValueError("amount must be a positive integer in USDC base units (6 decimals)")
    if not recipient or not solana_owner:
        raise ValueError("recipient and solana_owner are required")
    if not recipient.startswith("0x") or len(recipient) != 42:
        raise ValueError("recipient must be an EVM address")

    adapter = (bridge_adapter or "lifi").lower()
    if adapter not in PREFERRED_ADAPTERS:
        adapter = "lifi"

    label = CHAIN_LABELS.get(to_chain_id, str(to_chain_id))
    source = _completed_step(
        "source_wallet",
        "USDC leaves the Phantom wallet (not a Solana Siphon vault).",
        runtime="solana-wallet",
        chainId=from_chain_id,
        owner=solana_owner,
        amount=amount,
        asset="USDC",
    )
    bridge = _quote_solana_usdc_to_evm(
        amount=amount,
        solana_owner=solana_owner,
        recipient=recipient,
        to_chain_id=to_chain_id,
        mint=mint or SOLANA_USDC_DEFAULT,
    )
    deposit = _pending_step(
        "deposit_dest_vault",
        f"After the bridge lands, call depositV3 on {label} ({to_chain_id}) with the EVM signer.",
        runtime="evm-v1",
        chainId=to_chain_id,
        amount=amount,
        asset="USDC",
        recipient=recipient,
        clientAction="depositV3",
        destUsdc=_dest_usdc(to_chain_id),
    )
    asp = _blocked_step("asp_screen_dest", "deposit_dest_vault")

    steps = [source, bridge, deposit, asp]
    return {
        "profileId": WALLET_FUND_PROFILE_ID,
        "notAVault": True,
        "wrapperCut": True,
        "usdcOnly": True,
        "adapter": adapter,
        "fromChainId": from_chain_id,
        "toChainId": to_chain_id,
        "sourceRuntime": "solana-wallet",
        "destRuntime": "evm-v1",
        "steps": [s["step"] for s in steps],
        "ok": False,
        "pending": True,
        "status": "pending",
        "amount": amount,
        "asset": "USDC",
        "recipient": recipient,
        "solanaOwner": solana_owner,
        "stepStatus": steps,
        "message": (
            f"Plan ready: bridge Solana USDC → {label} publicly, "
            f"then deposit into the {label} Siphon vault."
        ),
        "clientNext": (
            f"Complete the public bridge (Phantom), wait for {label} USDC, then depositV3. "
            f"ASP admit runs on {label} after deposit."
        ),
        "privacyNote": f"Bridge leg is public; privacy starts after {label} vault deposit.",
    }


def _self_check() -> None:
    result = execute_intent_hop(
        900002, 8453, 1_000_000, "USDC", "0x0000000000000000000000000000000000000001"
    )
    assert result["ok"] is False and result["pending"] is True

    fund = execute_wallet_fund_hop(
        from_chain_id=900001,
        to_chain_id=8453,
        amount=1_000_000,
        asset="USDC",
        recipient="0x0000000000000000000000000000000000000001",
        solana_owner="11111111111111111111111111111111",
    )
    assert fund["profileId"] == WALLET_FUND_PROFILE_ID
    assert fund["usdcOnly"] is True
    assert fund["stepStatus"][0]["status"] == "completed"

    try:
        execute_wallet_fund_hop(
            from_chain_id=900001,
            to_chain_id=8453,
            amount=1,
            asset="SOL",
            recipient="0x0000000000000000000000000000000000000001",
            solana_owner="11111111111111111111111111111111",
        )
        raise AssertionError("SOL must be rejected")
    except ValueError as exc:
        assert "USDC only" in str(exc)

    fund_arb = execute_wallet_fund_hop(
        from_chain_id=900001,
        to_chain_id=42161,
        amount=1_000_000,
        asset="USDC",
        recipient="0x0000000000000000000000000000000000000001",
        solana_owner="11111111111111111111111111111111",
    )
    assert fund_arb["toChainId"] == 42161
    print("intent_bridge self-check: PASS (USDC-only fund Base+Arb)")


if __name__ == "__main__":
    _self_check()
