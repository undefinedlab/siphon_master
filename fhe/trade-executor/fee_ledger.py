"""Fee accrual ledger. Records each deducted fee (kept in the executor wallet) for a later sweep
into the Siphon fee-vault. Sweep is implemented separately (accrue-then-sweep)."""


def record_fee(chain_id, asset, fee_wei, kind='execution', strategy_id=None, leg_id=None, tx_hash=None):
    """Persist a FeeAccrual. Best-effort — never raises into the on-chain execution path."""
    try:
        fee_wei = int(fee_wei)
    except (TypeError, ValueError):
        return None
    if fee_wei <= 0:
        return None
    try:
        from database import db, FeeAccrual
        row = FeeAccrual(
            chain_id=int(chain_id), asset=(asset or '').upper(), amount_wei=str(fee_wei),
            kind=kind, strategy_id=strategy_id, leg_id=leg_id, tx_hash=tx_hash,
        )
        db.session.add(row)
        db.session.commit()
        return row.id
    except Exception as e:
        try:
            from database import db
            db.session.rollback()
        except Exception:
            pass
        print(f"[Fee] record_fee failed: {e}")
        return None


# ERC20 Transfer(address,address,uint256)
_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"


def record_swap_and_deposit_fee(w3, chain_id, tx_hash, *, dst_token, dst_symbol,
                                collector, strategy_id=None, leg_id=None):
    """Record the fill fee the Entrypoint skimmed on a swapAndDeposit.

    That skim (`swapAndDepositFeeBps`) is taken from the measured swap OUTPUT and pulled straight
    to the collector. It emits NO event of its own, and unlike the withdrawal fee it never lands
    in a vault pull-payment balance — so it reaches neither `fee_accruals` nor
    withdraw_fee_ledger, and /admin/fees would report the fill leg as zero forever.

    The one on-chain trace is the ERC20 Transfer(vault -> collector) inside our own receipt, so
    recover it from there. A native-asset output is a raw ETH send with no log; that returns None
    and is logged, so it shows up as unmeasured rather than as nothing having been charged.

    Best-effort: never raises into the execution path — the trade already settled.
    """
    if not tx_hash or not collector or not dst_token:
        return None
    try:
        if not str(dst_token).startswith("0x") or len(str(dst_token)) != 42:
            print(f"[Fee] fill fee not attributable (native output) tx={str(tx_hash)[:14]}")
            return None
        receipt = w3.eth.get_transaction_receipt(tx_hash)
        want_token = str(dst_token).lower()
        want_to = str(collector).lower()[2:].rjust(64, "0")
        total = 0
        for entry in receipt.get("logs", []):
            if str(entry.get("address", "")).lower() != want_token:
                continue
            topics = entry.get("topics") or []
            if len(topics) < 3:
                continue
            t0 = topics[0].hex() if hasattr(topics[0], "hex") else str(topics[0])
            if t0.lower().lstrip("0x") != _TRANSFER_TOPIC[2:]:
                continue
            t2 = topics[2].hex() if hasattr(topics[2], "hex") else str(topics[2])
            if t2.lower().lstrip("0x").rjust(64, "0") != want_to:
                continue
            data = entry["data"]
            total += int(data.hex() if hasattr(data, "hex") else data, 16)
        if total <= 0:
            return None
        print(f"[Fee] fill fee skimmed on-chain: {total} {dst_symbol} -> collector")
        return record_fee(chain_id, dst_symbol, total, kind="fill",
                          strategy_id=strategy_id, leg_id=leg_id, tx_hash=tx_hash)
    except Exception as e:
        print(f"[Fee] record_swap_and_deposit_fee failed: {e}")
        return None
