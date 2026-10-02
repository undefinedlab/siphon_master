"""Read-only gateway view of the executor's note table (Supabase/Postgres note DB).

The gateway reads the same `notes` table the executor writes, via its OWN lightweight read model (a
cross-framework Flask-SQLAlchemy import would need app context). This is reading a shared table, not
reimplementing logic — the whitelisting (never exposing ciphertext/iv/secrets) lives in note_service.
The note DB URL defaults to the gateway DB for local dev (the executor does the same).
"""
from sqlalchemy import Integer, String, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

from app.config import get_settings


class NoteBase(DeclarativeBase):
    pass


class NoteRow(NoteBase):
    __tablename__ = "notes"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    wallet: Mapped[str] = mapped_column(String, index=True)
    ciphertext: Mapped[str] = mapped_column(String)  # never serialized out
    iv: Mapped[str] = mapped_column(String)          # never serialized out
    commitment: Mapped[str] = mapped_column(String)
    nullifier_hash: Mapped[str] = mapped_column(String)
    chain_id: Mapped[int] = mapped_column(Integer)
    asset: Mapped[str] = mapped_column(String)
    spent: Mapped[str] = mapped_column(String)


_engine = None
_Session = None


def _note_session():
    global _engine, _Session
    if _Session is None:
        settings = get_settings()
        url = settings.note_db_url or settings.database_url
        _engine = create_engine(url, pool_pre_ping=True)
        _Session = sessionmaker(bind=_engine, expire_on_commit=False)
    return _Session()
