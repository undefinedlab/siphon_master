"""SQLAlchemy models — screening layer (v2)."""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

from sqlalchemy import BigInteger, Boolean, DateTime, Integer, String, Text, UniqueConstraint, create_engine, func, select, text
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

import config


class Base(DeclarativeBase):
    pass


class AddressList(Base):
    __tablename__ = "address_list"
    __table_args__ = (UniqueConstraint("address", "kind", name="uq_address_kind"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    address: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    chain_hint: Mapped[str | None] = mapped_column(String(32), nullable=True, default="evm")
    kind: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    source: Mapped[str] = mapped_column(String(128), nullable=False)
    entity_name: Mapped[str | None] = mapped_column(String(512), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )


class ScreenResult(Base):
    __tablename__ = "screen_result"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    decision_id: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    chain_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    depositor: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    # 128, not 80: Solana signatures are up to 88 base58 chars (EVM tx hashes are 66).
    tx_hash: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    commitment: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    precommitment: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    request_json: Mapped[str] = mapped_column(Text, nullable=False)
    decision: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    reasons: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    addresses_checked: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    deps_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    policy_version: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        index=True,
    )


class AdminAudit(Base):
    __tablename__ = "admin_audit"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    actor: Mapped[str | None] = mapped_column(String(128), nullable=True)
    payload_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )


class AspLabel(Base):
    """Append-only ASP association set leaf — PROTOCOL §2.6."""

    __tablename__ = "asp_label"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    label: Mapped[str] = mapped_column(String(128), nullable=False, unique=True, index=True)
    leaf_index: Mapped[int] = mapped_column(Integer, nullable=False, unique=True, index=True)
    chain_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    vault_address: Mapped[str | None] = mapped_column(String(64), nullable=True)
    deposit_nonce: Mapped[int | None] = mapped_column(Integer, nullable=True)
    depositor: Mapped[str | None] = mapped_column(String(64), nullable=True)
    commitment: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    # Rule 1/2 selection inputs (see rule_one_two.py). Both derive from the Deposited
    # event at admit time; rows admitted before these columns existed stay NULL and are
    # excluded from selection (amount unknown => not safely freezable).
    amount: Mapped[str | None] = mapped_column(String(80), nullable=True)
    # D1 asset binding: assetId = uint160(token) as a decimal string. Freezing is per-asset.
    asset_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="queued", index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )


class RevokedLabel(Base):
    """Revocation SMT leaf log — PROTOCOL §2.5 (ASP tree not evicted)."""

    __tablename__ = "revoked_label"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    label: Mapped[str] = mapped_column(String(128), nullable=False, unique=True, index=True)
    reason: Mapped[str | None] = mapped_column(String(256), nullable=True)
    revoked_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )


class PendingAdmit(Base):
    """Outbox for deposit watcher — commitment + userSalt (never log salt)."""

    __tablename__ = "pending_admit"
    __table_args__ = (UniqueConstraint("chain_id", "commitment", name="uq_pending_admit_chain_commitment"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    chain_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    commitment: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    depositor: Mapped[str | None] = mapped_column(String(64), nullable=True)
    vault_address: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Sensitive — never write to logs / API responses.
    # Text: Fernet seals for field-element salts exceed String(128) (OVERLORD F-1).
    user_salt: Mapped[str] = mapped_column(Text, nullable=False)
    label: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending", index=True)
    tx_hash: Mapped[str | None] = mapped_column(String(128), nullable=True)  # Solana sigs: up to 88
    error: Mapped[str | None] = mapped_column(String(512), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )


class KytEntitlement(Base):
    """zkMe KYT coverage — $0.50 / wallet / year (merchant billing aligned)."""

    __tablename__ = "kyt_entitlement"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    wallet: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    # Latest payment tx (display); forever-unique consumption is kyt_fee_payment
    tx_hash: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    chain_id: Mapped[int] = mapped_column(Integer, nullable=False)
    token: Mapped[str] = mapped_column(String(16), nullable=False, default="ETH")
    amount_raw: Mapped[str] = mapped_column(String(64), nullable=False)
    product: Mapped[str] = mapped_column(String(32), nullable=False, default="kyt_year_v1")
    paid_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        index=True,
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        index=True,
    )


class KytFeePayment(Base):
    """Append-only ledger — each fee tx_hash is consumable exactly once (OVERLORD F-1)."""

    __tablename__ = "kyt_fee_payment"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    tx_hash: Mapped[str] = mapped_column(String(80), nullable=False, unique=True, index=True)
    wallet: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    chain_id: Mapped[int] = mapped_column(Integer, nullable=False)
    token: Mapped[str] = mapped_column(String(16), nullable=False)
    amount_raw: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )


class KycEntitlement(Base):
    """zkMe zkKYC widget coverage — $0.50 / wallet / year (separate from KYT)."""

    __tablename__ = "kyc_entitlement"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    wallet: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    tx_hash: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    chain_id: Mapped[int] = mapped_column(Integer, nullable=False)
    token: Mapped[str] = mapped_column(String(16), nullable=False, default="ETH")
    amount_raw: Mapped[str] = mapped_column(String(64), nullable=False)
    product: Mapped[str] = mapped_column(String(32), nullable=False, default="kyc_year_v1")
    paid_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        index=True,
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        index=True,
    )


class KycFeePayment(Base):
    """Append-only ledger for zkKYC fee txs — tx_hash unique across KYT + KYC ledgers."""

    __tablename__ = "kyc_fee_payment"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    tx_hash: Mapped[str] = mapped_column(String(80), nullable=False, unique=True, index=True)
    wallet: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    chain_id: Mapped[int] = mapped_column(Integer, nullable=False)
    token: Mapped[str] = mapped_column(String(16), nullable=False)
    amount_raw: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )


class MetaKV(Base):
    __tablename__ = "meta_kv"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )


# Meta keys for compliance trees
META_ADMITTED_ROOT = "admitted_root"
META_REVOKED_ROOT = "revoked_root"
META_ADMITTED_LEAF_COUNT = "admitted_leaf_count"
META_PENDING_ADMIT_PUBLISH = "pending_admit_publish"
META_PENDING_REVOKE_PUBLISH = "pending_revoke_publish"
META_LAST_ADMIT_PUBLISH_TS = "last_admit_publish_ts"
META_ONCHAIN_ADMITTED_ROOT = "onchain_admitted_root"
META_ONCHAIN_REVOKED_ROOT = "onchain_revoked_root"
META_METRIC_SCREENS = "metric_screens_total"
META_METRIC_ADMITS = "metric_admits_total"
META_METRIC_REVOKES = "metric_revokes_total"
META_METRIC_WATCHER_ADMITS = "metric_watcher_admits_total"
META_METRIC_ZKME_CALLS = "metric_zkme_calls_total"
META_METRIC_ZKME_DENIES = "metric_zkme_denies_total"
META_METRIC_ZKME_UNAVAILABLE = "metric_zkme_unavailable_total"
META_DRIFT_ADMITTED = "drift_admitted"
META_DRIFT_REVOKED = "drift_revoked"


class SolanaLeaf(Base):
    """siphon-vault-zk state-tree leaf, indexed from DepositEvent / LeafInserted logs.

    The Solana vault keeps only the frontier on chain, so this table is the source the app
    rebuilds Merkle paths from (/solana/state/leaves) and the watcher admits deposits from.
    """

    __tablename__ = "solana_leaf"
    __table_args__ = (UniqueConstraint("chain_id", "leaf_index", name="uq_solana_leaf_chain_index"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    chain_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    leaf_index: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    commitment: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)  # deposit | change
    depositor: Mapped[str | None] = mapped_column(String(64), nullable=True)
    mint: Mapped[str | None] = mapped_column(String(64), nullable=True)
    deposit_nonce: Mapped[int | None] = mapped_column(Integer, nullable=True)
    signature: Mapped[str] = mapped_column(String(128), nullable=False)
    slot: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # Watcher bookkeeping for deposits: NULL until a pending admit was matched (or failed).
    admit_status: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )


def bump_meta_counter(db: Session, key: str, delta: int = 1) -> int:
    cur = int(get_meta(db, key) or "0")
    nxt = cur + delta
    set_meta(db, key, str(nxt))
    return nxt


def watcher_cursor_key(chain_id: int) -> str:
    return f"deposit_watcher_cursor_{chain_id}"


_engine = None
SessionLocal: sessionmaker[Session] | None = None


def get_engine():
    global _engine, SessionLocal
    if _engine is None:
        url = config.DATABASE_URL
        connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
        _engine = create_engine(url, future=True, connect_args=connect_args)
        SessionLocal = sessionmaker(bind=_engine, autoflush=False, autocommit=False, future=True)
    return _engine


def init_db() -> None:
    get_engine()
    Base.metadata.create_all(_engine)
    migrate_schema()


def migrate_schema() -> None:
    """Idempotent column upgrades — create_all does not widen existing types (F-1)."""
    assert _engine is not None
    dialect = _engine.dialect.name
    with _engine.begin() as conn:
        if dialect == "postgresql":
            # Widen sealed-salt column; no-op-safe if already TEXT.
            conn.execute(
                text(
                    "ALTER TABLE IF EXISTS pending_admit "
                    "ALTER COLUMN user_salt TYPE TEXT USING user_salt::text"
                )
            )
            # Solana deposit signatures (≤88 base58 chars) overflow the original VARCHAR(80).
            conn.execute(text("ALTER TABLE IF EXISTS pending_admit ALTER COLUMN tx_hash TYPE VARCHAR(128)"))
            conn.execute(text("ALTER TABLE IF EXISTS screen_result ALTER COLUMN tx_hash TYPE VARCHAR(128)"))
            # Rule 1/2 selection columns — nullable, so existing rows need no backfill.
            conn.execute(
                text("ALTER TABLE IF EXISTS asp_label ADD COLUMN IF NOT EXISTS amount VARCHAR(80)")
            )
            conn.execute(
                text("ALTER TABLE IF EXISTS asp_label ADD COLUMN IF NOT EXISTS asset_id VARCHAR(64)")
            )
            conn.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS ix_asp_label_asset_id "
                    "ON asp_label (asset_id)"
                )
            )
        elif dialect == "sqlite":
            # SQLite type affinity does not enforce VARCHAR(n); create_all covers fresh DBs.
            # Existing files predating the Rule 1/2 columns still need them added.
            cols = {row[1] for row in conn.execute(text("PRAGMA table_info(asp_label)"))}
            if cols:
                if "amount" not in cols:
                    conn.execute(text("ALTER TABLE asp_label ADD COLUMN amount VARCHAR(80)"))
                if "asset_id" not in cols:
                    conn.execute(text("ALTER TABLE asp_label ADD COLUMN asset_id VARCHAR(64)"))


def session() -> Session:
    get_engine()
    assert SessionLocal is not None
    return SessionLocal()


def list_counts(db: Session, *, active_only: bool = True) -> dict[str, int]:
    q = select(AddressList.kind, func.count()).group_by(AddressList.kind)
    if active_only:
        q = select(AddressList.kind, func.count()).where(AddressList.active.is_(True)).group_by(AddressList.kind)
    return {kind: int(n) for kind, n in db.execute(q).all()}


def upsert_address(
    db: Session,
    *,
    address: str,
    kind: str,
    source: str,
    entity_name: str | None = None,
    note: str | None = None,
    chain_hint: str = "evm",
    active: bool = True,
) -> bool:
    addr = address.lower().strip()
    existing = db.execute(
        select(AddressList).where(AddressList.address == addr, AddressList.kind == kind)
    ).scalar_one_or_none()
    now = datetime.now(timezone.utc)
    if existing:
        existing.source = source
        existing.entity_name = entity_name or existing.entity_name
        existing.note = note if note is not None else existing.note
        existing.active = active
        existing.updated_at = now
        return False
    db.add(
        AddressList(
            address=addr,
            chain_hint=chain_hint,
            kind=kind,
            source=source,
            entity_name=entity_name,
            note=note,
            active=active,
            updated_at=now,
        )
    )
    db.flush()
    return True


def deactivate_address(db: Session, *, address: str, kind: str) -> bool:
    addr = address.lower().strip()
    existing = db.execute(
        select(AddressList).where(AddressList.address == addr, AddressList.kind == kind)
    ).scalar_one_or_none()
    if not existing:
        return False
    existing.active = False
    existing.updated_at = datetime.now(timezone.utc)
    return True


def find_list_hits(db: Session, addresses: list[str]) -> list[AddressList]:
    if not addresses:
        return []
    lowered = [a.lower() for a in addresses]
    return list(
        db.execute(
            select(AddressList).where(AddressList.address.in_(lowered), AddressList.active.is_(True))
        ).scalars()
    )


def write_audit(db: Session, *, action: str, payload: dict, actor: str | None = None) -> None:
    db.add(
        AdminAudit(
            action=action,
            actor=actor,
            payload_json=json.dumps(payload, sort_keys=True),
        )
    )


def get_decision_by_commitment(
    db: Session, commitment: str, chain_id: int | None = None
) -> ScreenResult | None:
    """Latest screen for commitment; when chain_id set, scope to that chain (F-5)."""
    c = commitment.strip()
    q = select(ScreenResult).where(ScreenResult.commitment == c)
    if chain_id is not None:
        q = q.where(ScreenResult.chain_id == int(chain_id))
    return db.execute(q.order_by(ScreenResult.created_at.desc()).limit(1)).scalar_one_or_none()


def get_decision_by_tx(db: Session, chain_id: int, tx_hash: str) -> ScreenResult | None:
    return db.execute(
        select(ScreenResult)
        .where(ScreenResult.chain_id == chain_id, ScreenResult.tx_hash == tx_hash.lower())
        .order_by(ScreenResult.created_at.desc())
        .limit(1)
    ).scalar_one_or_none()


def new_decision_id() -> str:
    return f"dec_{uuid.uuid4().hex}"


def get_meta_updated_at(db: Session, key: str) -> datetime | None:
    row = db.get(MetaKV, key)
    return row.updated_at if row else None


def get_meta(db: Session, key: str) -> str | None:
    row = db.get(MetaKV, key)
    return row.value if row else None


def set_meta(db: Session, key: str, value: str) -> None:
    now = datetime.now(timezone.utc)
    row = db.get(MetaKV, key)
    if row is None:
        # Pending adds in this transaction are invisible to some get paths — scan session.new.
        for obj in db.new:
            if isinstance(obj, MetaKV) and obj.key == key:
                obj.value = value
                obj.updated_at = now
                return
        db.add(MetaKV(key=key, value=value, updated_at=now))
        db.flush()
    else:
        row.value = value
        row.updated_at = now


def clear_meta(db: Session, key: str) -> None:
    """Drop a meta key (e.g. indexer cursor before a full vault backfill)."""
    row = db.get(MetaKV, key)
    if row is not None:
        db.delete(row)
        db.flush()


def get_kyt_entitlement(db: Session, wallet: str) -> KytEntitlement | None:
    addr = wallet.lower().strip()
    return db.execute(
        select(KytEntitlement).where(KytEntitlement.wallet == addr)
    ).scalar_one_or_none()


def has_active_kyt_entitlement(db: Session, wallet: str, *, now: datetime | None = None) -> bool:
    row = get_kyt_entitlement(db, wallet)
    if row is None:
        return False
    ts = now or datetime.now(timezone.utc)
    exp = row.expires_at
    if exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)
    return exp > ts


def upsert_kyt_entitlement(
    db: Session,
    *,
    wallet: str,
    tx_hash: str,
    chain_id: int,
    token: str,
    amount_raw: str,
    days: int | None = None,
) -> KytEntitlement:
    """Create or renew a year window using a never-before-seen fee tx. Caller commits."""
    from datetime import timedelta

    from sqlalchemy.exc import IntegrityError

    addr = wallet.lower().strip()
    txh = tx_hash.lower().strip()
    now = datetime.now(timezone.utc)
    period = int(days if days is not None else config.KYT_ENTITLEMENT_DAYS)
    expires = now + timedelta(days=period)

    # F-1: append-only ledger — tx_hash never reusable (KYT or KYC)
    if fee_tx_consumed(db, txh):
        raise ValueError("tx_hash already consumed for a compliance fee payment")

    db.add(
        KytFeePayment(
            tx_hash=txh,
            wallet=addr,
            chain_id=chain_id,
            token=token,
            amount_raw=amount_raw,
            created_at=now,
        )
    )

    row = get_kyt_entitlement(db, addr)
    if row is None:
        row = KytEntitlement(
            wallet=addr,
            tx_hash=txh,
            chain_id=chain_id,
            token=token,
            amount_raw=amount_raw,
            product="kyt_year_v1",
            paid_at=now,
            expires_at=expires,
        )
        db.add(row)
        try:
            db.flush()
        except IntegrityError as exc:
            raise ValueError("tx_hash already consumed for a KYT fee payment") from exc
        return row

    row.tx_hash = txh
    row.chain_id = chain_id
    row.token = token
    row.amount_raw = amount_raw
    row.paid_at = now
    row.expires_at = expires
    try:
        db.flush()
    except IntegrityError as exc:
        raise ValueError("tx_hash already consumed for a KYT fee payment") from exc
    return row


def fee_tx_consumed(db: Session, tx_hash: str) -> bool:
    """True if tx_hash was already used for KYT or KYC fee."""
    txh = tx_hash.lower().strip()
    for model in (KytFeePayment, KycFeePayment):
        prior = db.execute(select(model).where(model.tx_hash == txh)).scalar_one_or_none()
        if prior is not None:
            return True
    return False


def get_kyc_entitlement(db: Session, wallet: str) -> KycEntitlement | None:
    addr = wallet.lower().strip()
    return db.execute(
        select(KycEntitlement).where(KycEntitlement.wallet == addr)
    ).scalar_one_or_none()


def has_active_kyc_entitlement(db: Session, wallet: str, *, now: datetime | None = None) -> bool:
    row = get_kyc_entitlement(db, wallet)
    if row is None:
        return False
    ts = now or datetime.now(timezone.utc)
    exp = row.expires_at
    if exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)
    return exp > ts


def upsert_kyc_entitlement(
    db: Session,
    *,
    wallet: str,
    tx_hash: str,
    chain_id: int,
    token: str,
    amount_raw: str,
    days: int | None = None,
) -> KycEntitlement:
    """Create or renew zkKYC year window. Caller commits."""
    from datetime import timedelta

    from sqlalchemy.exc import IntegrityError

    addr = wallet.lower().strip()
    txh = tx_hash.lower().strip()
    now = datetime.now(timezone.utc)
    period = int(days if days is not None else config.KYC_ENTITLEMENT_DAYS)
    expires = now + timedelta(days=period)

    if fee_tx_consumed(db, txh):
        raise ValueError("tx_hash already consumed for a compliance fee payment")

    db.add(
        KycFeePayment(
            tx_hash=txh,
            wallet=addr,
            chain_id=chain_id,
            token=token,
            amount_raw=amount_raw,
            created_at=now,
        )
    )

    row = get_kyc_entitlement(db, addr)
    if row is None:
        row = KycEntitlement(
            wallet=addr,
            tx_hash=txh,
            chain_id=chain_id,
            token=token,
            amount_raw=amount_raw,
            product="kyc_year_v1",
            paid_at=now,
            expires_at=expires,
        )
        db.add(row)
        try:
            db.flush()
        except IntegrityError as exc:
            raise ValueError("tx_hash already consumed for a compliance fee payment") from exc
        return row

    row.tx_hash = txh
    row.chain_id = chain_id
    row.token = token
    row.amount_raw = amount_raw
    row.paid_at = now
    row.expires_at = expires
    try:
        db.flush()
    except IntegrityError as exc:
        raise ValueError("tx_hash already consumed for a compliance fee payment") from exc
    return row
