"""SQLAlchemy engine/session setup shared by repositories and migrations."""
from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from app import config

_CONNECT_ARGS = {"check_same_thread": False} if config.DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(
    config.DATABASE_URL,
    future=True,
    pool_pre_ping=True,
    connect_args=_CONNECT_ARGS,
)

if config.DATABASE_URL.startswith("sqlite"):
    @event.listens_for(engine, "connect")
    def _set_sqlite_pragmas(dbapi_connection, _connection_record) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()

SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, class_=Session)


@contextmanager
def session_scope() -> Iterator[Session]:
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def initialize_database() -> None:
    # Alembic owns release migrations; create_all keeps the source checkout one-command.
    from app.db.models import Base

    Base.metadata.create_all(bind=engine)
    from app.db.repositories import ensure_local_profile

    ensure_local_profile()
