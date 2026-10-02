"""SQLAlchemy engine + session factory (connection pooling on, pre-ping for dead connections)."""
from collections.abc import Iterator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from app.config import get_settings

_settings = get_settings()
_db_url = _settings.database_url
_is_sqlite = _db_url.startswith("sqlite")
_env = (_settings.siphon_env or "").strip().lower()

if _is_sqlite and _env in {"prod", "production"}:
    raise RuntimeError(
        "sqlite database_url is not allowed when SIPHON_ENV/APP_ENV is production"
    )

_engine = create_engine(
    _db_url,
    pool_pre_ping=not _is_sqlite,
    connect_args={"check_same_thread": False} if _is_sqlite else {},
)

if _is_sqlite:
    # Local-dev only: create tables on first connect (no Alembic required for packs/purchase smoke).
    from app.repository.models import Base

    @event.listens_for(_engine, "connect")
    def _sqlite_fk(dbapi_conn, _connection_record):  # noqa: ANN001
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(_engine)

SessionLocal = sessionmaker(bind=_engine, autoflush=False, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    """FastAPI dependency: yield a session, always close it."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
