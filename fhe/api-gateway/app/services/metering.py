import uuid
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from app.repository.models import UsageEvent
from app.services import billing_ref
from app.adapters.executor import ExecutorClient

def record(
    db: Session,
    api_key_id: str,
    event_type: str,
    *,
    strategy_id: str | None = None,
    tx_hash: str | None = None,
    amount_minor: int = 0,
    request_id: str
) -> UsageEvent | None:
    """Record a billing/metering usage event in the gateway database.
    
    Flushes to the database session so it commits atomically within the caller's
    transaction boundary. Deduplicates based on tx_hash before inserting.
    """
    if tx_hash:
        existing = db.query(UsageEvent).filter_by(event_type=event_type, tx_hash=tx_hash).first()
        if existing:
            return existing

    event = UsageEvent(
        id=str(uuid.uuid4()),
        api_key_id=api_key_id,
        event_type=event_type,
        strategy_id=strategy_id,
        tx_hash=tx_hash,
        amount_minor=amount_minor,
        request_id=request_id
    )
    db.add(event)
    db.flush()
    return event


def reconcile(db: Session, executor: ExecutorClient) -> int:
    """Fetch execution events from the executor and record them in the gateway DB.
    
    Verifies the billing_ref to identify which api_key_id to charge.
    Returns the count of newly reconciled events.
    """
    try:
        events = executor.execution_events()
    except Exception as e:
        print(f"[reconcile] failed to fetch execution events: {e}")
        return 0

    reconciled_count = 0
    for item in events:
        billing_ref_claim = item.get("billing_ref")
        if not billing_ref_claim:
            continue

        api_key_id = billing_ref.verify(billing_ref_claim)
        if not api_key_id:
            print(f"[reconcile] invalid billing_ref: {billing_ref_claim}")
            continue

        tx_hash = item.get("tx_hash")
        strategy_id = item.get("strategy_id")

        existing = db.query(UsageEvent).filter_by(event_type="execution", tx_hash=tx_hash).first()
        if not existing:
            record(
                db,
                api_key_id=api_key_id,
                event_type="execution",
                strategy_id=strategy_id,
                tx_hash=tx_hash,
                amount_minor=0,
                request_id="req_reconcile"
            )
            reconciled_count += 1

    return reconciled_count


