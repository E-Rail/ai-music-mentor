"""FastAPI entry point for development and same-origin production serving."""
from __future__ import annotations

import json
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app import config
from app.db import initialize_database, repositories
from app.routes.api import register_builtin_scores, router
from app.services import analysis_jobs
from app.services.file_store import local_file_store

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    initialize_database()
    register_builtin_scores()
    for storage_key in repositories.cleanup_expired():
        try:
            local_file_store.delete(storage_key)
        except OSError:
            logger.warning("Unable to delete expired artifact %s", storage_key)
    analysis_jobs.resume_pending_jobs()
    yield
    analysis_jobs.shutdown()


app = FastAPI(
    title="AI Music Mentor API",
    version="2.0.0",
    description="Deterministic piano practice analysis with an evidence-bound mentor.",
    lifespan=lifespan,
)

if config.APP_ENV == "development":
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:5173", "http://127.0.0.1:5173",
            "http://localhost:4173", "http://127.0.0.1:4173",
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


@app.middleware("http")
async def request_log(request: Request, call_next):
    request_id = request.headers.get("x-request-id", uuid.uuid4().hex[:16])
    started = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        logger.exception(json.dumps({
            "event": "request_failed", "requestId": request_id,
            "method": request.method, "path": request.url.path,
        }, ensure_ascii=False))
        raise
    latency_ms = round((time.perf_counter() - started) * 1000)
    response.headers["x-request-id"] = request_id
    logger.info(json.dumps({
        "event": "request", "requestId": request_id, "method": request.method,
        "path": request.url.path, "status": response.status_code,
        "latencyMs": latency_ms,
    }, ensure_ascii=False))
    return response


@app.exception_handler(RequestValidationError)
async def validation_error(_request: Request, exc: RequestValidationError):
    first = exc.errors()[0] if exc.errors() else {}
    location = ".".join(str(part) for part in first.get("loc", []))
    message = first.get("msg", "请求参数不合法")
    if location:
        message = f"{location}: {message}"
    return JSONResponse(status_code=422, content={
        "detail": {"code": "VALIDATION_ERROR", "message": message},
    })


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):
    logger.exception("Unhandled API error on %s", request.url.path, exc_info=exc)
    return JSONResponse(status_code=500, content={
        "detail": {"code": "INTERNAL_ERROR", "message": "服务器暂时无法处理请求，请稍后重试"},
    })


def _health() -> dict:
    return {"status": "ok", "version": "2.0.0"}


@app.get("/api/v1/health")
def health_v1() -> dict:
    return _health()


@app.get("/api/health", include_in_schema=False)
def health_legacy() -> dict:
    return _health()


@app.get("/api/v1/readiness")
def readiness() -> JSONResponse:
    database = repositories.ping()
    file_store = os.access(config.FILE_STORAGE_DIR, os.W_OK)
    ready = database and file_store
    return JSONResponse(
        status_code=200 if ready else 503,
        content={"status": "ready" if ready else "not_ready",
                 "checks": {"database": database, "fileStore": file_store}},
    )


app.include_router(router, prefix="/api/v1")
# Temporary compatibility alias for saved demo URLs and old offline scripts.
app.include_router(router, prefix="/api", include_in_schema=False)

class _BuiltWeb(StaticFiles):
    """Serve the built app so a rebuild is never half-visible.

    Vite fingerprints every asset and deletes the previous ones, so the only
    thing tying a browser to a build is index.html. Served without an explicit
    Cache-Control it gets *heuristically* cached — browsers are free to reuse it
    for a fraction of its age without asking — and after a rebuild that stale
    copy asks for a bundle that no longer exists. The page then sits on its boot
    message telling the reader to check a local service that is working
    perfectly.

    So: the HTML always revalidates, and the fingerprinted assets it names may
    be kept for ever, because their names change when their contents do.
    """

    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        if path.startswith("assets/") and "." in path.rsplit("/", 1)[-1]:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "no-cache"
        return response


if (config.WEB_DIST_DIR / "index.html").exists():
    app.mount("/", _BuiltWeb(directory=config.WEB_DIST_DIR, html=True), name="web")
