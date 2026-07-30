"""FastAPI 入口。开发：uvicorn app.main:app --reload --port 8000"""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.routes.api import register_builtin_scores, router

app = FastAPI(title="AI Music Mentor API", version="1.0.0")

# 开发环境放开 localhost；答辩环境应只允许同源 HTTPS 域名
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173",
                   "http://localhost:4173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):
    return JSONResponse(status_code=500,
                        content={"code": "INTERNAL_ERROR",
                                 "message": str(exc)})


@app.on_event("startup")
def startup() -> None:
    register_builtin_scores()


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


app.include_router(router, prefix="/api")
