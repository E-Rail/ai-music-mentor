"""Add bounded local AI mentor memory.

Revision ID: 0002
Revises: 0001
"""
from __future__ import annotations

from alembic import op

from app.db.models import MentorMemoryRecord

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    MentorMemoryRecord.__table__.create(bind=op.get_bind(), checkfirst=True)


def downgrade() -> None:
    MentorMemoryRecord.__table__.drop(bind=op.get_bind(), checkfirst=True)
