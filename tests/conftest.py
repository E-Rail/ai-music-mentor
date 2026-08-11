"""Keep the test suite completely isolated from the desktop user's library."""
from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path


_TEST_DATA_DIR = Path(tempfile.mkdtemp(prefix="ai-music-mentor-tests-"))

# These values must be set before any test imports ``app.config``. python-dotenv
# does not override an existing process variable, so the developer's local
# .env remains untouched and tests cannot write placeholder scores to data/app.db.
os.environ["DATA_DIR"] = str(_TEST_DATA_DIR)
os.environ["DATABASE_URL"] = f"sqlite:///{_TEST_DATA_DIR / 'app.db'}"
os.environ["FILE_STORAGE_DIR"] = str(_TEST_DATA_DIR / "files")
os.environ["SCORE_STORAGE_DIR"] = str(_TEST_DATA_DIR / "files" / "scores")
os.environ["SESSION_STORAGE_DIR"] = str(_TEST_DATA_DIR / "files" / "sessions")
os.environ["GENERATED_STORAGE_DIR"] = str(_TEST_DATA_DIR / "files" / "generated")


def pytest_sessionfinish(session, exitstatus) -> None:
    del session, exitstatus
    shutil.rmtree(_TEST_DATA_DIR, ignore_errors=True)
