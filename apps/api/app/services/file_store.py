"""Artifact storage boundary.

Only this module knows that v1 uses the local filesystem. Repositories store opaque
keys, so an object-storage implementation can replace it without API changes.
"""
from __future__ import annotations

import hashlib
import os
import tempfile
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app import config
from app.db import repositories


@dataclass(frozen=True)
class StoredArtifact:
    artifact_id: str
    storage_key: str
    sha256: str
    size_bytes: int
    media_type: str
    original_name: str


class FileStore(ABC):
    @abstractmethod
    def put(self, *, kind: str, content: bytes, original_name: str,
            suffix: str, media_type: str, generated: bool = False) -> StoredArtifact:
        raise NotImplementedError

    @abstractmethod
    def resolve(self, storage_key: str) -> Path:
        raise NotImplementedError

    @abstractmethod
    def delete(self, storage_key: str) -> None:
        raise NotImplementedError


class LocalFileStore(FileStore):
    def __init__(self, root: Path = config.FILE_STORAGE_DIR) -> None:
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def put(self, *, kind: str, content: bytes, original_name: str,
            suffix: str, media_type: str, generated: bool = False) -> StoredArtifact:
        safe_kind = "".join(ch for ch in kind.lower() if ch.isalnum() or ch in "-_") or "other"
        safe_suffix = suffix.lower() if suffix.startswith(".") else f".{suffix.lower()}"
        safe_suffix = "".join(ch for ch in safe_suffix if ch.isalnum() or ch == ".")[:16]
        artifact_id = f"art_{uuid.uuid4().hex[:16]}"
        storage_key = f"{safe_kind}/{artifact_id}{safe_suffix}"
        target = self.resolve(storage_key)
        target.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temp_name = tempfile.mkstemp(prefix=f".{artifact_id}-", dir=target.parent)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, target)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)
        digest = hashlib.sha256(content).hexdigest()
        expires_at = None
        if generated:
            expires_at = datetime.now(timezone.utc) + timedelta(hours=config.GENERATED_RETENTION_HOURS)
        repositories.save_artifact({
            "id": artifact_id, "profileId": config.LOCAL_PROFILE_ID, "kind": safe_kind,
            "storageKey": storage_key, "originalName": Path(original_name).name,
            "mediaType": media_type, "sha256": digest, "sizeBytes": len(content),
            "generated": generated, "expiresAt": expires_at,
        })
        return StoredArtifact(artifact_id, storage_key, digest, len(content),
                              media_type, Path(original_name).name)

    def resolve(self, storage_key: str) -> Path:
        if not storage_key or Path(storage_key).is_absolute():
            raise ValueError("invalid storage key")
        path = (self.root / storage_key).resolve()
        try:
            path.relative_to(self.root)
        except ValueError as exc:
            raise ValueError("storage key escapes root") from exc
        return path

    def delete(self, storage_key: str) -> None:
        path = self.resolve(storage_key)
        if path.exists() and path.is_file():
            path.unlink()


local_file_store = LocalFileStore()


def artifact_path(artifact_id: str) -> Path | None:
    metadata = repositories.get_artifact(artifact_id)
    if not metadata:
        return None
    path = local_file_store.resolve(metadata["storageKey"])
    return path if path.exists() and path.is_file() else None
