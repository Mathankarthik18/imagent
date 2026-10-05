"""Runs in progress: spans reported as started (running_spans) that haven't finished yet."""

from __future__ import annotations

import datetime as dt
from typing import Any

from .db import RUNNING, SPANS, query

LOOKBACK_HOURS = 6        # older unfinished spans are treated as dead, not running
STALL_SECONDS = 5 * 60    # no new span for this long → flagged stalled


async def open_spans(*, project: str | None = None, trace_ids: list[str] | None = None,
                     thread_id: str | None = None) -> list[dict[str, Any]]:
    params: dict[str, Any] = {}
    where = [f"start_time > now64(6) - INTERVAL {LOOKBACK_HOURS} HOUR"]
    if project:
        params["project"] = project
        where.append("project = {project:String}")
    if trace_ids is not None:
        if not trace_ids:
            return []
        params["trace_ids"] = trace_ids
        where.append("trace_id IN {trace_ids:Array(String)}")
    if thread_id is not None:
        params["thread_id"] = thread_id
        where.append("thread_id = {thread_id:String}")
    w = " AND ".join(where)
    return await query(f"""
        SELECT project, trace_id, span_id, parent_span_id, is_root, name, kind, start_time,
               thread_id, user_id, agent_name, model
        FROM {RUNNING} FINAL
        WHERE {w}
          AND span_id NOT IN (SELECT span_id FROM {SPANS}
                              WHERE trace_id IN (SELECT trace_id FROM {RUNNING} WHERE {w}))
        ORDER BY start_time
    """, params)


def _utc(t: dt.datetime) -> dt.datetime:
    return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)


async def running_runs(project: str | None) -> dict[str, Any]:
    now = dt.datetime.now(dt.timezone.utc)
    spans = await open_spans(project=project)
    by_trace: dict[str, list[dict[str, Any]]] = {}
    for s in spans:
        by_trace.setdefault(s["trace_id"], []).append(s)
    if not by_trace:
        return {"runs": [], "server_time": now.isoformat()}

    done_rows = await query(f"""
        SELECT trace_id, countIf(kind = 'llm') AS llm, countIf(kind = 'tool') AS tools, count() AS spans,
               sum(input_tokens + output_tokens) AS tokens, sum(cost_usd) AS cost,
               countIf(status = 'error') AS errors, max(end_time) AS last_end
        FROM {SPANS} WHERE trace_id IN {{ids:Array(String)}}
        GROUP BY trace_id
    """, {"ids": list(by_trace)})
    done = {r["trace_id"]: r for r in done_rows}

    runs = []
    for trace_id, open_list in by_trace.items():
        ids = {s["span_id"]: s for s in open_list}
        roots = [s for s in open_list if s["parent_span_id"] not in ids]
        root = min(roots, key=lambda s: s["start_time"])
        current = max(open_list, key=lambda s: s["start_time"])
        path, cur, hops = [], current, 0
        while cur is not None and cur is not root and hops < 50:
            path.append({"name": cur["name"], "kind": cur["kind"]})
            cur = ids.get(cur["parent_span_id"])
            hops += 1
        path.reverse()
        d = done.get(trace_id, {})
        last_end = _utc(d["last_end"]) if d.get("last_end") else None
        last_start = _utc(current["start_time"])
        last_activity = max(t for t in (last_end, last_start) if t is not None)
        runs.append({
            "trace_id": trace_id,
            "project": root["project"],
            "thread_id": root["thread_id"] or next((s["thread_id"] for s in open_list if s["thread_id"]), ""),
            "user_id": root["user_id"],
            "name": root["name"],
            "kind": root["kind"],
            "agent_name": root["agent_name"],
            "started": _utc(root["start_time"]).isoformat(),
            "current": {"name": current["name"], "kind": current["kind"], "model": current["model"],
                        "started": last_start.isoformat()},
            "path": path,
            "open_spans": len(open_list),
            "done": {"llm": d.get("llm", 0), "tools": d.get("tools", 0), "spans": d.get("spans", 0),
                     "tokens": d.get("tokens", 0), "cost": d.get("cost", 0.0), "errors": d.get("errors", 0)},
            "last_activity": last_activity.isoformat(),
            "stalled": (now - last_activity).total_seconds() > STALL_SECONDS,
        })
    runs.sort(key=lambda r: r["started"], reverse=True)
    return {"runs": runs, "server_time": now.isoformat()}


_SPAN_DEFAULTS = {
    "environment": "", "status": "running", "status_message": "", "duration_ms": 0.0, "session_id": "",
    "provider": "", "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0,
    "cost_usd": 0.0, "cost_source": "", "ttft_ms": None, "input": "", "output": "", "tags": [], "metadata": "",
    "attributes": {}, "events": [],
}


def as_span(row: dict[str, Any]) -> dict[str, Any]:
    """An open span shaped like a finished one (status "running", no payloads yet)."""
    return {**_SPAN_DEFAULTS, **row, "end_time": row["start_time"]}
