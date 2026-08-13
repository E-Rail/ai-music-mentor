"""Time the mentor call across models and hosts, with the app's own request shape.

The mentor does not stream, so what a student waits for is the *last* token, not
the first: a host with a quick start and slow generation still leaves them
watching a spinner. This measures both, using the real `MentorResponse` schema
and a prompt of realistic size, so the numbers mean what the mentor means.

    .venv/bin/python scripts/bench_mentor_models.py
    MODELS=deepseek/deepseek-v4-flash,qwen/qwen3-32b ROUNDS=3 .venv/bin/python \
        scripts/bench_mentor_models.py

Reads MENTOR_API_KEY from the environment or .env. Each round is one paid call,
so keep ROUNDS small.
"""
from __future__ import annotations

import json
import os
import statistics
import sys
import time
from pathlib import Path

import httpx

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "apps/api"))

from app.schemas.models import (  # noqa: E402
    ExercisePlannerResponse, MentorChatResponse, MentorResponse,
)

#: The mentor makes three shapes of structured call. The exercise plan is the
#: one that used to cost two minutes, so a latency claim that only covers the
#: short explanation is not a claim about the demo.
SCHEMAS = {
    "explain": MentorResponse,
    "chat": MentorChatResponse,
    "plan": ExercisePlannerResponse,
}

ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
ROUNDS = int(os.environ.get("ROUNDS", "2"))
#: Candidates that support structured output and write usable Chinese.
DEFAULT_MODELS = [
    "deepseek/deepseek-v4-flash",     # what the app uses today
    "qwen/qwen3-235b-a22b-2507",
    "qwen/qwen3-30b-a3b-instruct-2507",
    "openai/gpt-oss-120b",
    "minimax/minimax-m2.5",
    "deepseek/deepseek-chat-v3.1",
]
MODELS = [m.strip() for m in os.environ.get("MODELS", ",".join(DEFAULT_MODELS)).split(",") if m.strip()]
#: Empty string means "let OpenRouter choose"; a slug pins one host.
ORDERS = [o.strip() for o in os.environ.get("ORDERS", "").split(",")]
#: "none" turns private thinking off. It is the biggest single lever here: the
#: mentor explains metrics that are already computed, and reasoning tokens are
#: charged against the same ceiling as the answer — so they cost latency twice,
#: once generating them and again when a truncated answer has to be re-asked.
REASONING = [r.strip() for r in os.environ.get("REASONING", "low").split(",") if r.strip()]
SCHEMA = SCHEMAS[os.environ.get("SCHEMA", "explain")]

SYSTEM = (
    "你是一位钢琴陪练老师。依据给定的诊断数据，用简体中文向学生解释这次演奏的问题，"
    "语气具体、可执行，不要编造数据里没有的事实。只返回符合 schema 的 JSON。"
)
# A diagnosis payload of the size the mentor actually receives.
DIAGNOSIS = {
    "overall": 67.0,
    "metrics": [
        {"id": "pitch", "score": 77.8, "detail": "12 个音符中 3 个音高错误"},
        {"id": "rhythm", "score": 81.8, "detail": "第 2 小节整体偏快 40ms"},
        {"id": "tempo", "score": 74.1, "detail": "速度从 92 漂移到 101"},
        {"id": "dynamics", "score": 62.0, "detail": "力度对比不足"},
        {"id": "articulation", "score": 70.5, "detail": "连奏处有断点"},
        {"id": "fluency", "score": 0.0, "detail": "算法输出，可能不可靠"},
    ],
    "errors": [
        {"id": f"e{i}", "measureNo": 1 + i // 2, "beat": 1.0 + (i % 2),
         "expected": "A4", "actual": "B♭4", "deltaMs": 35 + i}
        for i in range(10)
    ],
}


#: With fallbacks on, `order` is only a preference — OpenRouter will route past
#: a pinned host whenever it likes, which makes a latency measurement meaningless
#: and a pinned production setting a fiction. Off by default when a host is named.
ALLOW_FALLBACKS = os.environ.get("ALLOW_FALLBACKS", "").lower() in {"1", "true", "yes"}


def request_body(model: str, order: str, reasoning: str) -> dict:
    provider: dict = {"require_parameters": True,
                      "allow_fallbacks": ALLOW_FALLBACKS or not order}
    if order:
        provider["order"] = [order]
    return {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": json.dumps(DIAGNOSIS, ensure_ascii=False)},
        ],
        "temperature": 0.2,
        "max_tokens": 4000,
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": SCHEMA.__name__,
                "strict": True,
                "schema": SCHEMA.model_json_schema(),
            },
        },
        "reasoning": ({"enabled": False, "exclude": True} if reasoning == "none"
                      else {"effort": reasoning, "exclude": True}),
        "provider": provider,
        "stream": True,
    }


def one_call(client: httpx.Client, key: str, model: str, order: str,
             reasoning: str) -> dict:
    """Stream one call so first-token and last-token are separately visible.

    Every failure is returned rather than raised: one host timing out must not
    end a sweep whose whole purpose is finding the ones that do not.
    """
    try:
        return _stream_once(client, key, model, order, reasoning)
    except httpx.TimeoutException:
        return {"error": "timed out"}
    except Exception as exc:  # noqa: BLE001 - a sweep reports, it does not crash
        return {"error": f"{type(exc).__name__}: {exc}"[:120]}


def _stream_once(client: httpx.Client, key: str, model: str, order: str,
                 reasoning: str) -> dict:
    started = time.perf_counter()
    first_token_at: float | None = None
    served_by = None
    chunks = 0
    reasoning_chunks = 0
    text: list[str] = []
    with client.stream(
        "POST", ENDPOINT,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json=request_body(model, order, reasoning),
    ) as response:
        if response.status_code != 200:
            response.read()
            return {"error": f"HTTP {response.status_code}: {response.text[:160]}"}
        for line in response.iter_lines():
            if not line.startswith("data: "):
                continue
            body = line[6:]
            if body == "[DONE]":
                break
            try:
                event = json.loads(body)
            except json.JSONDecodeError:
                continue
            if event.get("error"):
                return {"error": str(event["error"])[:120]}
            served_by = event.get("provider") or served_by
            delta = (event.get("choices") or [{}])[0].get("delta") or {}
            if delta.get("reasoning"):
                reasoning_chunks += 1
            piece = delta.get("content")
            if piece:
                if first_token_at is None:
                    first_token_at = time.perf_counter()
                chunks += 1
                text.append(piece)
    total = time.perf_counter() - started
    joined = "".join(text)
    ok = False
    try:
        SCHEMA.model_validate(json.loads(joined))
        ok = True
    except Exception:
        pass
    return {
        "ttftMs": None if first_token_at is None else round((first_token_at - started) * 1000),
        "totalMs": round(total * 1000),
        "chars": len(joined),
        "chunks": chunks,
        "servedBy": served_by,
        "valid": ok,
        "reasoningChunks": reasoning_chunks,
    }


def main() -> None:
    key = os.environ.get("MENTOR_API_KEY", "")
    if not key:
        for line in (REPO_ROOT / ".env").read_text().splitlines():
            if line.startswith("MENTOR_API_KEY="):
                key = line.split("=", 1)[1].strip()
    if not key:
        raise SystemExit("MENTOR_API_KEY not set and not found in .env")

    print(f"{'model':<36} {'host':<14} {'think':<5} {'ttft':>7} {'total':>8} "
          f"{'worst':>8} {'chars':>6}  ok")
    print("-" * 99)
    summary: list[tuple[str, str, float, float, bool]] = []
    with httpx.Client(timeout=httpx.Timeout(connect=10, read=180, write=10, pool=10)) as client:
        for model in MODELS:
          for reasoning in REASONING:
            for order in ORDERS:
                runs = [one_call(client, key, model, order, reasoning)
                        for _ in range(ROUNDS)]
                good = [r for r in runs if "error" not in r and r["ttftMs"] is not None]
                if not good:
                    reason = runs[0].get("error") or (
                        f"only reasoning, no answer ({runs[0].get('reasoningChunks')} chunks)"
                        if runs[0].get("reasoningChunks") else "no tokens returned")
                    print(f"{model:<36} {(order or 'auto')[:14]:<14} {reasoning:<5} "
                          f"{'—':>7} {'—':>8} {'—':>6}  {reason[:40]}")
                    continue
                ttft = statistics.median(r["ttftMs"] for r in good)
                total = statistics.median(r["totalMs"] for r in good)
                worst = max(r["totalMs"] for r in good)
                chars = statistics.median(r["chars"] for r in good)
                host = good[-1]["servedBy"] or order or "?"
                valid = all(r["valid"] for r in good)
                print(f"{model:<36} {host[:14]:<14} {reasoning:<5} {ttft:>6.0f}ms "
                      f"{total:>7.0f}ms {worst:>7.0f}ms {chars:>6.0f}  "
                      f"{'yes' if valid else 'NO'}")
                summary.append((f"{model} [think={reasoning}]", host, ttft, total, valid))

    print("\nfastest to finish (what the student waits for):")
    for model, host, ttft, total, valid in sorted(summary, key=lambda r: r[3])[:6]:
        print(f"  {total:>7.0f}ms  ttft {ttft:>5.0f}ms  {model} via {host}"
              f"{'' if valid else '   [schema NOT honoured]'}")


if __name__ == "__main__":
    main()
