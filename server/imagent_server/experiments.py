"""Experiments: re-run recorded agent runs with different models through a connected runner.

Flow: the UI creates an experiment (source runs × variants × repeats) → one job per
combination is queued → the app's runner (imagent SDK, inside e.g. Bosun) claims jobs,
replays the real agent with tool outputs taken from the source run, and reports the
result trace → each result is scored against its source run with `compare`.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import time
import uuid
from typing import Any

from . import compare, live, queries
from .db import DB, SPANS, get_client, query

EXPERIMENTS = f"{DB}.experiments"
JOBS = f"{DB}.experiment_jobs"
CLAIM_TIMEOUT = dt.timedelta(minutes=30)
RUNNER_STALE_SECONDS = 30

DDL = [
    f"""
    CREATE TABLE IF NOT EXISTS {EXPERIMENTS} (
        id          String,
        project     String,
        name        String,
        agent       String,
        status      LowCardinality(String),
        config      String,
        created_at  DateTime64(3, 'UTC'),
        updated_at  DateTime64(3, 'UTC') DEFAULT now64(3)
    ) ENGINE = ReplacingMergeTree(updated_at) ORDER BY id
    """,
    f"""
    CREATE TABLE IF NOT EXISTS {JOBS} (
        id               String,
        experiment_id    String,
        agent            String,
        source_trace_id  String,
        variant          String,
        repeat           UInt16,
        status           LowCardinality(String),
        runner           String,
        result_trace_id  String,
        error            String,
        output           String,
        score            String,
        created_at       DateTime64(3, 'UTC'),
        claimed_at       Nullable(DateTime64(3, 'UTC')),
        finished_at      Nullable(DateTime64(3, 'UTC')),
        updated_at       DateTime64(3, 'UTC') DEFAULT now64(3)
    ) ENGINE = ReplacingMergeTree(updated_at) ORDER BY (experiment_id, id)
    """,
]

_JOB_COLS = ["id", "experiment_id", "agent", "source_trace_id", "variant", "repeat", "status", "runner",
             "result_trace_id", "error", "output", "score", "created_at", "claimed_at", "finished_at"]
_claim_lock = asyncio.Lock()
# runner_id → {"last_seen": epoch, "agents": [...], "host": str}
_runners: dict[str, dict[str, Any]] = {}


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


_last_version = 0.0


def _version() -> dt.datetime:
    """Strictly increasing row version so the latest job state always wins the merge."""
    global _last_version
    t = max(time.time(), _last_version + 0.001)
    _last_version = t
    return dt.datetime.fromtimestamp(t, tz=dt.timezone.utc)


async def ensure_schema() -> None:
    client = await get_client()
    for ddl in DDL:
        await client.command(ddl)


async def _write_job(job: dict[str, Any]) -> None:
    client = await get_client()
    row = [job.get(c) if c not in ("runner", "result_trace_id", "error", "output", "score") else (job.get(c) or "")
           for c in _JOB_COLS]
    await client.insert(JOBS, [row + [_version()]], column_names=[*_JOB_COLS, "updated_at"], settings={"async_insert": 0})


async def _jobs(where: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    return await query(f"SELECT {', '.join(_JOB_COLS)} FROM {JOBS} FINAL WHERE {where} ORDER BY created_at, id", params)


# ── runners ──────────────────────────────────────────────────────────────────
def touch_runner(runner_id: str, agents: list[dict[str, Any]], host: str) -> None:
    _runners[runner_id] = {"last_seen": time.time(), "agents": agents, "host": host}


def runners() -> list[dict[str, Any]]:
    now = time.time()
    return [{"runner_id": rid, "host": r["host"], "agents": r["agents"], "seconds_ago": round(now - r["last_seen"], 1)}
            for rid, r in _runners.items() if now - r["last_seen"] < RUNNER_STALE_SECONDS]


# ── experiments ──────────────────────────────────────────────────────────────
async def create(*, name: str, agent: str, project: str, source_trace_ids: list[str], variants: list[dict[str, Any]],
                 repeats: int, tool_mode: str) -> dict[str, Any]:
    exp_id = uuid.uuid4().hex[:12]
    now = _now()
    config = {"source_trace_ids": source_trace_ids, "variants": variants, "repeats": repeats, "tool_mode": tool_mode}
    client = await get_client()
    await client.insert(EXPERIMENTS, [[exp_id, project, name, agent, "running", json.dumps(config), now, _version()]],
                        column_names=["id", "project", "name", "agent", "status", "config", "created_at", "updated_at"],
                        settings={"async_insert": 0})
    rows = []
    for src in source_trace_ids:
        for v in variants:
            for r in range(repeats):
                rows.append([uuid.uuid4().hex[:16], exp_id, agent, src, v["name"], r, "queued", "", "", "", "", "",
                             now, None, None, _version()])
    await client.insert(JOBS, rows, column_names=[*_JOB_COLS, "updated_at"], settings={"async_insert": 0})
    return {"id": exp_id, "jobs": len(rows)}


async def _reap_stale() -> None:
    cutoff = _now() - CLAIM_TIMEOUT
    for j in await _jobs("status = 'running' AND claimed_at < {cutoff:DateTime64(3, 'UTC')}", {"cutoff": cutoff}):
        await _write_job({**j, "status": "error", "error": "Runner did not report back within 30 minutes", "finished_at": _now()})


def _fixtures(spans: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Recorded tool calls of the source run, in order — what the replay returns."""
    out = []
    for s in sorted(spans, key=lambda s: compare._ts(s["start_time"])):
        if s.get("kind") != "tool":
            continue
        out.append({"name": s["name"], "args": compare.canonical_args(s.get("input", "")),
                    "output": compare.readable(s.get("output", ""), roles=("tool",)), "status": s.get("status", "ok")})
    return out


def _history(spans: list[dict[str, Any]], root: dict[str, Any]) -> list[dict[str, Any]]:
    """Messages of the source run's first model call — the full conversation the agent saw
    (chat follow-ups keep earlier turns in a checkpointer, not in the root input)."""
    llms = sorted((s for s in spans if s.get("kind") == "llm"), key=lambda s: compare._ts(s["start_time"]))
    if not llms:
        return []
    try:
        msgs = json.loads(llms[0].get("input") or "[]")
    except ValueError:
        return []  # truncated capture — fall back to the root input
    return msgs if isinstance(msgs, list) and all(isinstance(m, dict) for m in msgs) else []


async def claim(runner_id: str, agents: list[dict[str, Any]], host: str) -> dict[str, Any] | None:
    touch_runner(runner_id, agents, host)
    names = [a["name"] for a in agents]
    if not names:
        return None
    async with _claim_lock:
        await _reap_stale()
        queued = await _jobs("status = 'queued' AND agent IN {names:Array(String)}", {"names": names})
        if not queued:
            return None
        job = queued[0]
        await _write_job({**job, "status": "running", "runner": runner_id, "claimed_at": _now()})
    exp = await get_experiment_row(job["experiment_id"])
    config = json.loads(exp["config"]) if exp else {}
    variant = next((v for v in config.get("variants", []) if v["name"] == job["variant"]), {"name": job["variant"]})
    spans = await queries.get_trace(job["source_trace_id"])
    root = compare.agent_span(spans) or {}
    return {
        "job_id": job["id"], "experiment_id": job["experiment_id"], "agent": job["agent"],
        "variant": variant, "repeat": job["repeat"], "tool_mode": config.get("tool_mode", "recorded"),
        "source": {"trace_id": job["source_trace_id"], "name": root.get("name", ""), "input": root.get("input", ""),
                   "thread_id": root.get("thread_id", ""), "user_id": root.get("user_id", ""),
                   "metadata": root.get("metadata", ""), "project": root.get("project", "")},
        "fixtures": _fixtures(spans),
        "history": _history(spans, root),
        "thread_id": f"experiment:{job['experiment_id']}:{job['id']}",
    }


async def complete(job_id: str, *, trace_id: str, status: str, error: str, output: str) -> None:
    rows = await _jobs("id = {id:String}", {"id": job_id})
    if not rows:
        return
    await _write_job({**rows[0], "status": "done" if status == "ok" else "error", "result_trace_id": trace_id,
                      "error": error[:4000], "output": output[:20000], "finished_at": _now()})


async def get_experiment_row(exp_id: str) -> dict[str, Any] | None:
    rows = await query(f"SELECT * FROM {EXPERIMENTS} FINAL WHERE id = {{id:String}}", {"id": exp_id})
    return rows[0] if rows else None


async def _score(job: dict[str, Any]) -> dict[str, Any] | None:
    """Compare a finished job's trace with its source; cached once the result trace has landed."""
    if job.get("score"):
        return json.loads(job["score"])
    if job["status"] != "done" or not job["result_trace_id"]:
        return None
    result = await queries.get_trace(job["result_trace_id"])
    if not result or await live.open_spans(trace_ids=[job["result_trace_id"]]):
        return None  # spans still arriving
    source = await queries.get_trace(job["source_trace_id"])
    c = compare.compare(source, result)
    score = {k: c[k] for k in ("verdict", "tool_match", "args_match", "output_similarity", "missing_tools", "extra_tools")}
    score["metrics"] = c["metrics"]["b"]
    score["baseline_metrics"] = c["metrics"]["a"]
    score["output"] = c["outputs"]["b"][:400]
    await _write_job({**job, "score": json.dumps(score)})
    return score


async def detail(exp_id: str) -> dict[str, Any] | None:
    exp = await get_experiment_row(exp_id)
    if not exp:
        return None
    await _reap_stale()
    jobs = await _jobs("experiment_id = {id:String}", {"id": exp_id})
    for j in jobs:
        j["score"] = await _score(j)
    config = json.loads(exp["config"])
    sources = []
    for tid in config["source_trace_ids"]:
        spans = await queries.get_trace(tid)
        root = compare.agent_span(spans) or {}
        sources.append({"trace_id": tid, "name": root.get("name", ""), "start_time": root.get("start_time"),
                        "input_text": compare.readable(root.get("input", ""), roles=("user", "human"))[:300],
                        "output_text": compare.readable(root.get("output", ""))[:300],
                        "metrics": compare.metrics(spans)})
    pending = sum(j["status"] in ("queued", "running") for j in jobs)
    status = "running" if pending else ("failed" if jobs and all(j["status"] == "error" for j in jobs) else "done")
    if status != exp["status"]:
        client = await get_client()
        await client.insert(EXPERIMENTS, [[exp["id"], exp["project"], exp["name"], exp["agent"], status, exp["config"],
                                           exp["created_at"], _version()]],
                            column_names=["id", "project", "name", "agent", "status", "config", "created_at", "updated_at"],
                            settings={"async_insert": 0})
    return {"id": exp["id"], "name": exp["name"], "agent": exp["agent"], "project": exp["project"], "status": status,
            "created_at": exp["created_at"], "config": config, "sources": sources, "jobs": jobs}


async def list_experiments(limit: int = 50) -> list[dict[str, Any]]:
    exps = await query(f"SELECT * FROM {EXPERIMENTS} FINAL ORDER BY created_at DESC LIMIT {{limit:UInt32}}", {"limit": limit})
    if not exps:
        return []
    counts = await query(f"""
        SELECT experiment_id, count() AS total, countIf(status = 'done') AS done, countIf(status = 'error') AS failed,
               countIf(status IN ('queued', 'running')) AS pending
        FROM {JOBS} FINAL WHERE experiment_id IN {{ids:Array(String)}} GROUP BY experiment_id
    """, {"ids": [e["id"] for e in exps]})
    by = {c["experiment_id"]: c for c in counts}
    out = []
    for e in exps:
        cfg = json.loads(e["config"])
        out.append({"id": e["id"], "name": e["name"], "agent": e["agent"], "project": e["project"], "status": e["status"],
                    "created_at": e["created_at"], "variants": [v["name"] for v in cfg["variants"]],
                    "sources": len(cfg["source_trace_ids"]), "repeats": cfg["repeats"], "tool_mode": cfg["tool_mode"],
                    "jobs": by.get(e["id"], {"total": 0, "done": 0, "failed": 0, "pending": 0})})
    return out


async def cancel(exp_id: str) -> int:
    n = 0
    async with _claim_lock:
        for j in await _jobs("experiment_id = {id:String} AND status = 'queued'", {"id": exp_id}):
            await _write_job({**j, "status": "error", "error": "Cancelled", "finished_at": _now()})
            n += 1
    return n


async def recent_sources(project: str | None, root_name: str, limit: int = 20) -> list[dict[str, Any]]:
    """Recent finished runs whose root span is `root_name` — candidates to replay."""
    params: dict[str, Any] = {"name": root_name, "limit": limit}
    where = "is_root = 1 AND name = {name:String} AND NOT startsWith(thread_id, 'experiment:')"
    if project:
        params["project"] = project
        where += " AND project = {project:String}"
    rows = await query(f"""
        SELECT trace_id, any(project) AS project, min(start_time) AS start_time, any(thread_id) AS thread_id,
               any(input) AS input, any(output) AS output
        FROM {SPANS} WHERE {where}
        GROUP BY trace_id ORDER BY min(start_time) DESC LIMIT {{limit:UInt32}}
    """, params)
    return [{"trace_id": r["trace_id"], "project": r["project"], "start_time": r["start_time"], "thread_id": r["thread_id"],
             "input_text": compare.readable(r["input"], roles=("user", "human"))[:200],
             "output_text": compare.readable(r["output"])[:200]} for r in rows]
