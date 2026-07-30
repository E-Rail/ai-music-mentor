"""环境配置（对应方案 13.1 环境变量）。"""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[3]   # ai-music-mentor/
DATA_DIR = Path(os.environ.get("DATA_DIR", BASE_DIR / "data"))

APP_ENV = os.environ.get("APP_ENV", "development")
DATABASE_URL = os.environ.get("DATABASE_URL", f"sqlite:///{DATA_DIR}/app.db")
SCORE_STORAGE_DIR = Path(os.environ.get("SCORE_STORAGE_DIR", DATA_DIR / "scores"))
SESSION_STORAGE_DIR = Path(os.environ.get("SESSION_STORAGE_DIR", DATA_DIR / "sessions"))
GENERATED_STORAGE_DIR = Path(os.environ.get("GENERATED_STORAGE_DIR", DATA_DIR / "generated"))
FIXTURES_DIR = Path(os.environ.get("FIXTURES_DIR", BASE_DIR / "packages" / "score-fixtures"))

MENTOR_PROVIDER = os.environ.get("MENTOR_PROVIDER", "rules")   # rules | llm
MENTOR_API_KEY = os.environ.get("MENTOR_API_KEY", "")
MENTOR_TIMEOUT_SECONDS = float(os.environ.get("MENTOR_TIMEOUT_SECONDS", "8"))
ANALYSIS_MAX_SECONDS = float(os.environ.get("ANALYSIS_MAX_SECONDS", "5"))

MAX_SCORE_BYTES = 5 * 1024 * 1024   # 5 MB
MAX_MEASURES = 200

for d in (SCORE_STORAGE_DIR, SESSION_STORAGE_DIR, GENERATED_STORAGE_DIR):
    d.mkdir(parents=True, exist_ok=True)
