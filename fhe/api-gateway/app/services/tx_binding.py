"""Tx-ownership binding — records who created an on-chain tx so a `…/confirmation` can verify the
caller owns it (BOLA) via an indexed tx_hash lookup, not a table scan.

The binding is internal state: it is never serialized to a client response (unlike the earlier
approach that smuggled api_key_id into the response body).
"""
from sqlalchemy.orm import Session

from app.repository.models import TxBinding


def bind(db: Session, *, tx_hash: str, wallet: str, api_key_id: str, chain_id: int, kind: str) -> None:
    """Record the tx -> (wallet, api_key_id) binding at create time. Idempotent on tx_hash
    (a re-created binding for the same tx_hash is a no-op)."""
    if not tx_hash:
        return
    if db.get(TxBinding, tx_hash) is not None:
        return
    db.add(TxBinding(tx_hash=tx_hash, wallet=wallet.lower(), api_key_id=api_key_id,
                     chain_id=int(chain_id), kind=kind))
    db.flush()


def lookup(db: Session, tx_hash: str) -> TxBinding | None:
    """Indexed lookup of the binding for a tx_hash (PK), or None."""
    return db.get(TxBinding, tx_hash)
