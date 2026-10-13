"""AI judge: which answer is better — the original run's or the replay's?

Matching the original only says the replay *behaved* the same; the original can be the
worse answer. For every finished replay the judge sees the user's question, the tool data
the agent worked from (the recorded tool calls), and both answers — labelled X and Y in
random order, so it can't favour the original — and returns which is better, why, and
1–5 scores per answer: correct (against the tool data), complete, clear, plus the
project's own rubric when it has one.

Runs in the server (any OpenAI-compatible endpoint; OpenRouter by default), so it works
for every project and while the app is offline. Each project sets its own key and model in
Settings; IMAGENT_JUDGE_API_KEY on the server is the fallback for projects that don't.
A person's review of a replay overrides the judge.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import os
import random
import re
import urllib.error
import urllib.request
from typing import Any

from . import compare, queries

logger = logging.getLogger(__name__)

API_KEY = os.getenv("IMAGENT_JUDGE_API_KEY") or os.getenv("OPENROUTER_API_KEY", "")
DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_MODEL = "anthropic/claude-sonnet-5.5"
BASE_URL = (os.getenv("IMAGENT_JUDGE_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
MODEL = os.getenv("IMAGENT_JUDGE_MODEL") or DEFAULT_MODEL
MAX_TOOL_CHARS = 2_500
MAX_ANSWER_CHARS = 8_000
CRITERIA = ("correct", "complete", "clear")


def configured() -> bool:
    """A server-wide key is set (projects can still set their own)."""
    return bool(API_KEY)


def config_for(project: dict[str, Any] | None) -> dict[str, str] | None:
    """The judge a project uses: its own key/model from Settings, else the server's."""
    p = project or {}
    if p.get("judge_key"):
        return {"key": p["judge_key"], "model": p.get("judge_model") or DEFAULT_MODEL,
                "base_url": (p.get("judge_base_url") or DEFAULT_BASE_URL).rstrip("/"), "source": "project"}
    if API_KEY:
        return {"key": API_KEY, "model": p.get("judge_model") or MODEL, "base_url": BASE_URL, "source": "server"}
    return None


def status(project: dict[str, Any] | None = None) -> dict[str, Any]:
    cfg = config_for(project)
    return {"configured": cfg is not None, "model": cfg["model"] if cfg else "", "source": cfg["source"] if cfg else "",
            "base_url": cfg["base_url"] if cfg else ""}


SYSTEM = """You judge answers from an AI agent. Two answers (X and Y) were produced for the same user request
by the same agent with the same tool data. Decide which answer serves the user better.

Judge on:
- correct: every fact agrees with the tool data below; nothing invented. An answer that admits missing data beats one that makes it up.
- complete: answers every part of the request.
- clear: easy to read, direct, no padding.
{rubric}
Do not prefer an answer for being longer. If both are equally good, say "tie".

Reply with JSON only:
{{"better": "X" | "Y" | "tie", "reason": "<one or two sentences>",
  "scores": {{"X": {{{fields}}}, "Y": {{{fields}}}}}}}
Scores are integers 1-5."""


def _prompt(question: str, tools: list[dict[str, Any]], x: str, y: str, rubric: str) -> list[dict[str, str]]:
    fields = ", ".join(f'"{c}": n' for c in (*CRITERIA, *(("rubric",) if rubric else ())))
    rubric_line = f"- rubric: follows the project's rules:\n{rubric.strip()}\n" if rubric else ""
    tool_text = "\n\n".join(
        f"[{i + 1}] {t['name']}({t['args'][:400]})\n→ {t['output'][:MAX_TOOL_CHARS]}" for i, t in enumerate(tools)
    ) or "(the agent called no tools)"
    user = (f"## User request\n{question[:4000]}\n\n## Tool data the agent had\n{tool_text}\n\n"
            f"## Answer X\n{x[:MAX_ANSWER_CHARS] or '(empty)'}\n\n## Answer Y\n{y[:MAX_ANSWER_CHARS] or '(empty)'}")
    return [{"role": "system", "content": SYSTEM.format(rubric=rubric_line, fields=fields)}, {"role": "user", "content": user}]


def _call(messages: list[dict[str, str]], cfg: dict[str, str] | None = None) -> tuple[str, float]:
    cfg = cfg or {"key": API_KEY, "model": MODEL, "base_url": BASE_URL}
    # Reasoning models (GLM, o-series, …) spend tokens thinking before they answer — leave room.
    body = json.dumps({"model": cfg["model"], "messages": messages, "temperature": 0, "max_tokens": 6000,
                       "usage": {"include": True}}).encode()
    req = urllib.request.Request(f"{cfg['base_url']}/chat/completions", data=body, method="POST", headers={
        "Authorization": f"Bearer {cfg['key']}", "Content-Type": "application/json", "X-Title": "imagent judge"})
    with urllib.request.urlopen(req, timeout=120) as r:  # noqa: S310 — endpoint from config
        data = json.loads(r.read())
    msg = data["choices"][0]["message"]
    text = msg.get("content") or ""
    if not text.strip():  # some reasoning models put the final JSON in their reasoning field
        text = msg.get("reasoning") or msg.get("reasoning_content") or ""
    if not text.strip():
        finish = data["choices"][0].get("finish_reason")
        raise ValueError(f"the judge model returned an empty answer (finish_reason={finish}) — try a non-reasoning model")
    return text, float((data.get("usage") or {}).get("cost") or 0)


def _parse(text: str) -> dict[str, Any]:
    """The last JSON object in the reply that has a verdict (reasoning text may contain drafts)."""
    candidates = re.findall(r"\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}", text, re.S)
    for raw in reversed(candidates):
        try:
            d = json.loads(raw)
        except ValueError:
            continue
        if isinstance(d, dict) and "better" in d:
            return d
    raise ValueError(f"judge reply has no verdict JSON: {text[:200]}")


def _question(spans: list[dict[str, Any]]) -> str:
    root = compare.agent_span(spans) or {}
    q = compare.readable(root.get("input", ""), roles=("user", "human"))
    if q:
        return q
    llms = sorted((s for s in spans if s.get("kind") == "llm"), key=lambda s: compare._ts(s["start_time"]))
    return compare.readable(llms[0].get("input", ""), roles=("user", "human")) if llms else ""


async def test(cfg: dict[str, str]) -> dict[str, Any]:
    """One tiny call to check a key/model pair works."""
    try:
        text, cost = await asyncio.to_thread(_call, [{"role": "user", "content": 'Reply with JSON only: {"ok": true}'}], cfg)
        return {"ok": True, "model": cfg["model"], "reply": text[:80], "cost": cost}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:300]
        return {"ok": False, "error": f"HTTP {exc.code}: {detail}"}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)[:300]}


async def judge_pair(source_id: str, result_id: str, rubric: str = "", cfg: dict[str, str] | None = None) -> dict[str, Any]:
    """Judge original (source run) vs replay. Returns better ∈ original|new|tie, reason, scores."""
    source = await queries.get_trace(source_id)
    result = await queries.get_trace(result_id)
    c = compare.compare(source, result)
    from .experiments import _fixtures

    tools = _fixtures(source)
    original, new = c["outputs"]["a"], c["outputs"]["b"]
    flip = random.random() < 0.5  # X/Y order randomised: the judge can't tell which is the original
    x, y = (new, original) if flip else (original, new)
    text, cost = await asyncio.to_thread(_call, _prompt(_question(source), tools, x, y, rubric), cfg)
    out = _parse(text)
    who = {"X": "new" if flip else "original", "Y": "original" if flip else "new", "tie": "tie"}
    raw = str(out.get("better", "tie")).strip()
    better = who.get("tie" if raw.lower() == "tie" else raw.upper(), "tie")
    scores = out.get("scores") or {}
    return {
        "better": better, "reason": str(out.get("reason", ""))[:600], "model": (cfg or {}).get("model", MODEL), "cost": cost,
        "scores": {who["X"]: scores.get("X") or {}, who["Y"]: scores.get("Y") or {}},
        "at": dt.datetime.now(dt.timezone.utc).isoformat(),
    }


async def worker(poll_seconds: float = 5.0) -> None:
    """Judge finished replays that haven't been judged yet."""
    from . import experiments, projects

    failures: dict[str, int] = {}
    while True:
        try:
            # Only projects that have a judge (their own key, or the server's).
            judged = None if configured() else await projects.with_judge()
            for job in await experiments.unjudged(limit=5, projects=judged):
                if failures.get(job["id"], 0) >= 3:
                    continue
                try:
                    if not await experiments._score(job):
                        continue  # the replay's trace is still arriving — judge complete answers only
                    exp = await experiments.get_experiment_row(job["experiment_id"])
                    proj = await projects.get(exp["project"]) if exp else None
                    cfg = config_for(proj)
                    if cfg is None:
                        continue
                    verdict = await judge_pair(job["source_trace_id"], job["result_trace_id"], (proj or {}).get("rubric", ""), cfg)
                    await experiments.save_judgement(job["id"], verdict)
                except Exception as exc:  # noqa: BLE001 — one bad job must not stop the worker
                    failures[job["id"]] = failures.get(job["id"], 0) + 1
                    logger.warning("judge failed for job %s: %s", job["id"], exc)
                    if failures[job["id"]] >= 3:
                        await experiments.save_judgement(job["id"], {"error": str(exc)[:300]})
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("judge worker: %s", exc)
        await asyncio.sleep(poll_seconds)
