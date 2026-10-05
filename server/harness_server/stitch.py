"""Merge broken-off LangGraph runs back into the trace they ran inside.

Some runtimes (seen with deepagents + astream_events) hand the tracer LLM/tool
callbacks whose parent run is unknown, so each call lands as its own one-span
trace beside the real run. Those spans still carry LangGraph metadata (node,
agent) and exact timings, so a periodic pass re-parents each orphan under the
span that was running at that moment — preferring the matching node name
("model"/"tools") inside the matching agent — and rewrites the orphan's whole
trace into the parent trace.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from .db import COLUMNS, SPANS, query

logger = logging.getLogger(__name__)

TOLERANCE_US = 5_000          # clock/rounding slack when testing containment
SETTLE_SECONDS = 20           # let a run's parent spans arrive before judging it
GIVE_UP_SECONDS = 15 * 60     # stop retrying an unmatched orphan after this long
INTERVAL_SECONDS = 30
LOOKBACK = dt.timedelta(days=2)

_unmatched_since: dict[str, float] = {}  # orphan span_id → first time we failed to place it


@dataclass
class _S:
    span_id: str
    trace_id: str
    parent: str
    name: str
    kind: str
    start: int
    end: int
    agent: str
    lg_node: str
    lc_agent: str
    is_root: bool
    ancestors: set[str] = field(default_factory=set)

    @property
    def is_orphan(self) -> bool:
        return self.is_root and bool(self.lg_node)


def _us(t: dt.datetime) -> int:
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.timezone.utc)
    return int(t.timestamp() * 1_000_000)


def plan(rows: list[dict[str, Any]]) -> dict[str, tuple[str, str]]:
    """Given every span of one thread, return {orphan_trace_id: (new_parent_span_id, new_trace_id)}."""
    spans = {r["span_id"]: _S(
        span_id=r["span_id"], trace_id=r["trace_id"], parent=r["parent_span_id"], name=r["name"], kind=r["kind"],
        start=_us(r["start_time"]), end=_us(r["end_time"]), agent=r["agent_name"], lg_node=r["lg_node"],
        lc_agent=r["lc_agent"], is_root=bool(r["is_root"]),
    ) for r in rows}
    for s in spans.values():  # names of every ancestor (incl. self) — "is this inside agent X?"
        cur: _S | None = s
        hops = 0
        while cur is not None and hops < 200:
            s.ancestors.add(cur.name)
            if cur.agent:
                s.ancestors.add(cur.agent)
            cur = spans.get(cur.parent)
            hops += 1

    chosen: dict[str, str] = {}        # orphan span_id → new parent span_id
    trace_parent: dict[str, str] = {}  # orphan trace_id → trace it now hangs under
    assigned: dict[str, int] = {}      # parent span_id → orphans already placed under it
    for o in sorted((s for s in spans.values() if s.is_orphan), key=lambda s: s.start):
        best: tuple[int, int, int, str] | None = None
        for c in spans.values():
            if c.trace_id == o.trace_id or c.kind in {"llm", "embedding"}:
                continue
            if not (c.start <= o.start + TOLERANCE_US and c.end >= o.end - TOLERANCE_US):
                continue
            score = 0
            if c.kind == "node" and c.name == o.lg_node:
                score += 4
            if o.lc_agent and o.lc_agent in c.ancestors:
                score += 2
            if c.kind in {"node", "tool"}:
                score += 1
            # Tightest window first (ms granularity), then spread parallel siblings
            # (e.g. two concurrent "tools" tasks) across equally good parents.
            cand = (score, -((c.end - c.start) // 1000), -assigned.get(c.span_id, 0), c.span_id)
            if best is None or cand > best:
                best = cand
        if best is None:
            continue
        target = spans[best[3]].trace_id
        t, hops = target, 0                 # cycle guard: target must not hang under this orphan
        while t in trace_parent and hops < 500:
            t = trace_parent[t]
            hops += 1
        if t == o.trace_id:
            continue
        chosen[o.span_id] = best[3]
        assigned[best[3]] = assigned.get(best[3], 0) + 1
        trace_parent[o.trace_id] = target

    def final_trace(trace_id: str) -> str:
        hops = 0
        while trace_id in trace_parent and hops < 500:
            trace_id = trace_parent[trace_id]
            hops += 1
        return trace_id

    return {spans[o].trace_id: (parent, final_trace(spans[o].trace_id)) for o, parent in chosen.items()}


async def _thread_rows(project: str, thread_id: str, start: dt.datetime, end: dt.datetime) -> list[dict[str, Any]]:
    return await query(f"""
        SELECT span_id, trace_id, parent_span_id, name, kind, start_time, end_time, agent_name, is_root,
               JSONExtractString(metadata, 'langgraph_node') AS lg_node,
               JSONExtractString(metadata, 'lc_agent_name') AS lc_agent
        FROM {SPANS}
        WHERE project = {{project:String}} AND start_time >= {{start:DateTime64(6, 'UTC')}} AND start_time < {{end:DateTime64(6, 'UTC')}}
          AND trace_id IN (SELECT trace_id FROM {SPANS} WHERE project = {{project:String}} AND thread_id = {{thread_id:String}}
                           AND start_time >= {{start:DateTime64(6, 'UTC')}} AND start_time < {{end:DateTime64(6, 'UTC')}})
        LIMIT 1 BY span_id
    """, {"project": project, "thread_id": thread_id, "start": start, "end": end})


async def _rewrite(old_trace: str, new_trace: str, root_span: str, new_parent: str) -> None:
    from .db import get_client

    client = await get_client()
    cols = list(COLUMNS)
    select_cols = []
    for c in cols:
        if c == "trace_id":
            select_cols.append("{new:String} AS trace_id")
        elif c == "parent_span_id":
            select_cols.append("if(span_id = {root:String}, {parent:String}, parent_span_id) AS parent_span_id")
        elif c == "is_root":
            select_cols.append("if(span_id = {root:String}, 0, is_root) AS is_root")
        elif c == "attributes":
            select_cols.append("if(span_id = {root:String}, mapUpdate(attributes, map('harness.stitched', 'time')), attributes) AS attributes")
        else:
            select_cols.append(c)
    params = {"old": old_trace, "new": new_trace, "root": root_span, "parent": new_parent}
    await client.command(
        f"INSERT INTO {SPANS} ({', '.join(cols)}) SELECT {', '.join(select_cols)} FROM {SPANS} WHERE trace_id = {{old:String}}",
        parameters=params, settings={"async_insert": 0, "prefer_column_name_to_alias": 1})
    await client.command(f"DELETE FROM {SPANS} WHERE trace_id = {{old:String}}", parameters=params,
                         settings={"lightweight_deletes_sync": 2})


async def stitch_once(lookback: dt.timedelta = LOOKBACK) -> int:
    """One pass over recent orphans. Returns the number of traces merged."""
    now = dt.datetime.now(dt.timezone.utc)
    orphans = await query(f"""
        SELECT project, thread_id, span_id, min(start_time) AS start_time, max(end_time) AS end_time
        FROM {SPANS}
        WHERE is_root = 1 AND thread_id != '' AND JSONExtractString(metadata, 'langgraph_node') != ''
          AND start_time >= {{since:DateTime64(6, 'UTC')}} AND end_time < {{settled:DateTime64(6, 'UTC')}}
        GROUP BY project, thread_id, span_id
    """, {"since": now - lookback, "settled": now - dt.timedelta(seconds=SETTLE_SECONDS)})
    mono = time.monotonic()
    orphans = [o for o in orphans if mono - _unmatched_since.get(o["span_id"], mono) < GIVE_UP_SECONDS]
    if not orphans:
        return 0

    threads: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for o in orphans:
        threads.setdefault((o["project"], o["thread_id"]), []).append(o)

    merged = 0
    for (project, thread_id), items in threads.items():
        lo = min(o["start_time"] for o in items) - dt.timedelta(hours=6)
        hi = max(o["end_time"] for o in items) + dt.timedelta(hours=1)
        rows = await _thread_rows(project, thread_id, lo, hi)
        moves = plan(rows)
        roots = {r["trace_id"]: r["span_id"] for r in rows if r["is_root"] and r["lg_node"]}
        for old_trace, (parent, new_trace) in moves.items():
            await _rewrite(old_trace, new_trace, roots[old_trace], parent)
            merged += 1
        placed = {roots[t] for t in moves}
        for o in items:
            if o["span_id"] in placed:
                _unmatched_since.pop(o["span_id"], None)
            else:
                _unmatched_since.setdefault(o["span_id"], mono)
    if merged:
        logger.info("stitched %d broken-off runs back into their parent traces", merged)
    return merged


async def run_forever() -> None:
    while True:
        try:
            await stitch_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("stitch pass failed")
        await asyncio.sleep(INTERVAL_SECONDS)
