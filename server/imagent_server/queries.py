"""Read-side SQL. All user input goes through server-side query parameters."""

from __future__ import annotations

import datetime as dt
import json
from dataclasses import dataclass
from typing import Any

from .db import SPANS, query


@dataclass
class Filters:
    start: dt.datetime
    end: dt.datetime
    project: str | None = None
    environment: str | None = None
    q: str | None = None
    status: str | None = None          # "error" → traces with ≥1 error span
    model: str | None = None
    agent: str | None = None
    thread_id: str | None = None
    user_id: str | None = None
    tag: str | None = None
    name: str | None = None


def _base_where(f: Filters, params: dict[str, Any], alias: str = "") -> list[str]:
    p = f"{alias}." if alias else ""
    params["start"], params["end"] = f.start, f.end
    where = [f"{p}start_time >= {{start:DateTime64(6, 'UTC')}}", f"{p}start_time < {{end:DateTime64(6, 'UTC')}}"]
    if f.project:
        params["project"] = f.project
        where.append(f"{p}project = {{project:String}}")
    else:
        where.append(f"NOT endsWith({p}project, '/experiments')")  # replays never inflate normal views
    if f.environment:
        params["environment"] = f.environment
        where.append(f"{p}environment = {{environment:String}}")
    return where


def _trace_match(f: Filters, params: dict[str, Any]) -> list[str]:
    """Span-level predicates; a trace matches if any of its spans match."""
    conds: list[str] = []
    if f.q:
        params["q"] = f.q
        conds.append("(positionCaseInsensitive(name, {q:String}) > 0 OR positionCaseInsensitive(input, {q:String}) > 0"
                     " OR positionCaseInsensitive(output, {q:String}) > 0 OR trace_id = {q:String}"
                     " OR thread_id = {q:String})")
    if f.model:
        params["model"] = f.model
        conds.append("model = {model:String}")
    if f.agent:
        params["agent"] = f.agent
        conds.append("agent_name = {agent:String}")
    if f.thread_id and f.thread_id != NO_THREAD:
        params["thread_id"] = f.thread_id
        conds.append("thread_id = {thread_id:String}")
    if f.user_id:
        params["user_id"] = f.user_id
        conds.append("user_id = {user_id:String}")
    if f.tag:
        params["tag"] = f.tag
        conds.append("has(tags, {tag:String})")
    if f.name:
        params["name"] = f.name
        conds.append("is_root = 1 AND name = {name:String}")
    if f.status == "error":
        conds.append("status = 'error'")
    return conds


_TRACE_AGG = """
    trace_id,
    any(project) AS project,
    min(start_time) AS start_time,
    max(end_time) AS end_time,
    dateDiff('millisecond', min(start_time), max(end_time)) AS duration_ms,
    if(argMinIf(name, start_time, is_root = 1) != '', argMinIf(name, start_time, is_root = 1), argMin(name, start_time)) AS name,
    if(argMinIf(kind, start_time, is_root = 1) != '', argMinIf(kind, start_time, is_root = 1), argMin(kind, start_time)) AS kind,
    anyIf(thread_id, thread_id != '') AS thread_id,
    anyIf(user_id, user_id != '') AS user_id,
    argMinIf(agent_name, start_time, agent_name != '') AS agent_name,
    groupUniqArrayIf(model, model != '') AS models,
    groupUniqArrayArray(tags) AS tags,
    sum(input_tokens) AS input_tokens,
    sum(output_tokens) AS output_tokens,
    sum(cache_read_tokens) AS cache_read_tokens,
    sum(cost_usd) AS cost_usd,
    countIf(kind = 'llm') AS llm_calls,
    countIf(kind = 'tool') AS tool_calls,
    countIf(status = 'error') AS error_count,
    substring(argMinIf(status_message, start_time, status = 'error'), 1, 300) AS error_message,
    count() AS span_count,
    argMin(input, if(is_root = 1, 0, 1) * 1e18 + toUnixTimestamp64Micro(start_time)) AS root_input,
    argMin(output, if(is_root = 1, 0, 1) * 1e18 + toUnixTimestamp64Micro(start_time)) AS root_output
"""


def _content_text(msg: str) -> str:
    """Text of a serialized chat message: string content, or its text blocks joined."""
    return (f"if(JSONType({msg}, 'content') = 'String', JSONExtractString({msg}, 'content'), "
            f"arrayStringConcat(arrayMap(b -> JSONExtractString(b, 'text'), JSONExtractArrayRaw({msg}, 'content')), ' '))")


def _messages(col: str) -> str:
    """Message list in a payload: {"messages": [...]}, a bare list, or one level down
    (``@observe`` captures kwargs, e.g. {"state": {"messages": [...]}})."""
    return (f"multiIf(JSONType({col}, 'messages') = 'Array', JSONExtractArrayRaw({col}, 'messages'), "
            f"JSONType({col}) = 'Array', JSONExtractArrayRaw({col}), "
            f"JSONType({col}, 1, 'messages') = 'Array', JSONExtractArrayRaw({col}, 1, 'messages'), [])")


def _readable(col: str, roles: tuple[str, ...]) -> str:
    """One readable line from a captured payload: the last message from ``roles``
    (LangGraph state or a message list), else a message's content, else a JSON
    string, else the raw text — always trimmed to 400 chars."""
    role_list = ", ".join(f"'{r}'" for r in roles)
    picked = f"arrayFilter(x -> JSONExtractString(x, 'role') IN ({role_list}) AND {_content_text('x')} != '', {_messages(col)})"
    return f"""substring(trimBoth(replaceRegexpAll(multiIf(
        NOT isValidJSON({col}), {col},
        length({picked}) > 0, {_content_text(f'arrayElement({picked}, -1)')},
        JSONType({col}) = 'String', JSONExtractString({col}),
        JSONHas({col}, 'content'), {_content_text(col)},
        {col}), '\\s+', ' ')), 1, 400)"""


_TRACE_TEXT = f"""
    {_readable('root_input', ('user', 'human'))} AS input_text,
    {_readable('root_output', ('assistant', 'ai'))} AS output_text,
    substring(root_input, 1, {{preview:UInt32}}) AS input_preview,
    substring(root_output, 1, {{preview:UInt32}}) AS output_preview
"""


NO_THREAD = "__none__"  # thread_id filter value selecting traces without a thread

_THREAD_SORTS = {
    "recent": "max(end_time) DESC",
    "cost": "sum(cost_usd) DESC, max(end_time) DESC",
    "errors": "countIf(error_count > 0) DESC, max(end_time) DESC",
    "traces": "count() DESC, max(end_time) DESC",
    "duration": "dateDiff('millisecond', min(start_time), max(end_time)) DESC",
    "tokens": "sum(input_tokens + output_tokens) DESC",
}


def _trace_subquery(f: Filters, params: dict[str, Any], preview_chars: int = 300) -> str:
    """One row per trace (filters applied); the building block for trace and thread lists."""
    params["preview"] = preview_chars
    where = _base_where(f, params)
    match = _trace_match(f, params)
    if match:
        where.append(f"trace_id IN (SELECT trace_id FROM {SPANS} WHERE {' AND '.join(_base_where(f, params) + match)})")
    having = ""
    if f.thread_id == NO_THREAD:
        having = "HAVING countIf(thread_id != '') = 0"
    return f"""
        SELECT {_TRACE_AGG}
        FROM {SPANS}
        WHERE {' AND '.join(where)}
        GROUP BY trace_id
        {having}
    """


async def list_traces(f: Filters, limit: int = 50, offset: int = 0, order: str = "desc",
                      preview_chars: int = 300) -> dict[str, Any]:
    params: dict[str, Any] = {"limit": limit + 1, "offset": offset}
    direction = "ASC" if order == "asc" else "DESC"
    sql = f"""
        SELECT * EXCEPT (root_input, root_output), {_TRACE_TEXT}
        FROM ({_trace_subquery(f, params, preview_chars)})
        ORDER BY start_time {direction}
        LIMIT {{limit:UInt32}} OFFSET {{offset:UInt32}}
    """
    rows = await query(sql, params)
    return {"items": rows[:limit], "has_more": len(rows) > limit}


async def get_trace(trace_id: str) -> list[dict[str, Any]]:
    sql = f"""
        SELECT * EXCEPT (inserted_at)
        FROM {SPANS}
        WHERE trace_id = {{trace_id:String}}
        ORDER BY start_time
        LIMIT 1 BY span_id
    """
    rows = await query(sql, {"trace_id": trace_id})
    for r in rows:
        r["events"] = json.loads(r["events"]) if r.get("events") else []
    return rows


async def thread_groups(f: Filters, *, sort: str = "recent", include_unthreaded: bool = False,
                        limit: int = 50, offset: int = 0) -> dict[str, Any]:
    """Traces matching the filters, grouped by thread. ``thread_id == ''`` is the
    "(no thread)" bucket when ``include_unthreaded``."""
    params: dict[str, Any] = {"limit": limit + 1, "offset": offset}
    sub = _trace_subquery(f, params, preview_chars=200)
    where = "" if include_unthreaded else "WHERE thread_id != ''"
    sql = f"""
        SELECT
            thread_id,
            any(project) AS project,
            count() AS trace_count,
            min(start_time) AS first_seen,
            max(end_time) AS last_seen,
            dateDiff('millisecond', min(start_time), max(end_time)) AS duration_ms,
            anyIf(user_id, user_id != '') AS user_id,
            groupUniqArrayIf(agent_name, agent_name != '') AS agents,
            groupUniqArrayArray(models) AS models,
            sum(input_tokens) AS input_tokens,
            sum(output_tokens) AS output_tokens,
            sum(input_tokens + output_tokens) AS total_tokens,
            sum(cache_read_tokens) AS cache_read_tokens,
            sum(cost_usd) AS cost_usd,
            sum(llm_calls) AS llm_calls,
            sum(tool_calls) AS tool_calls,
            countIf(error_count > 0) AS error_traces,
            sum(error_count) AS error_count,
            argMax(name, start_time) AS last_trace_name,
            {_readable('argMin(root_input, start_time)', ('user', 'human'))} AS first_input_text,
            {_readable('argMax(root_input, start_time)', ('user', 'human'))} AS last_input_text
        FROM ({sub})
        {where}
        GROUP BY thread_id
        ORDER BY {_THREAD_SORTS.get(sort, _THREAD_SORTS["recent"])}
        LIMIT {{limit:UInt32}} OFFSET {{offset:UInt32}}
    """
    rows = await query(sql, params)
    return {"items": rows[:limit], "has_more": len(rows) > limit}


async def thread_summary(thread_id: str, f: Filters) -> dict[str, Any]:
    params: dict[str, Any] = {"thread_id": thread_id}
    where = " AND ".join(_base_where(f, params) + ["thread_id = {thread_id:String}"])
    summary = await query(f"""
        SELECT
            any(project) AS project,
            min(start_time) AS first_seen,
            max(end_time) AS last_seen,
            dateDiff('millisecond', min(start_time), max(end_time)) AS duration_ms,
            uniqExact(trace_id) AS traces,
            countIf(kind = 'llm') AS llm_calls,
            countIf(kind = 'tool') AS tool_calls,
            sum(input_tokens) AS input_tokens,
            sum(output_tokens) AS output_tokens,
            sum(cache_read_tokens) AS cache_read_tokens,
            sum(cost_usd) AS cost_usd,
            countIf(status = 'error') AS error_spans,
            uniqExactIf(trace_id, status = 'error') AS error_traces,
            quantileIf(0.95)(duration_ms, kind = 'llm') AS llm_p95_ms,
            groupUniqArrayIf(agent_name, agent_name != '') AS agents,
            groupUniqArrayIf(model, model != '') AS models,
            groupUniqArrayIf(user_id, user_id != '') AS users,
            groupUniqArrayArray(tags) AS tags
        FROM {SPANS} WHERE {where}
    """, params)
    by_model = await query(f"""
        SELECT model, count() AS calls, sum(input_tokens + output_tokens) AS tokens, sum(cost_usd) AS cost_usd
        FROM {SPANS} WHERE {where} AND kind = 'llm'
        GROUP BY model ORDER BY sum(cost_usd) DESC
    """, params)
    by_tool = await query(f"""
        SELECT name, count() AS calls, countIf(status = 'error') AS errors, avg(duration_ms) AS avg_ms
        FROM {SPANS} WHERE {where} AND kind = 'tool'
        GROUP BY name ORDER BY calls DESC
    """, params)
    s = summary[0] if summary else {}
    return {"summary": s if s.get("traces") else None, "by_model": by_model, "by_tool": by_tool}


_LITE_SPAN_COLUMNS = """trace_id, span_id, parent_span_id, is_root, name, kind, status, substring(status_message, 1, 300) AS status_message,
    start_time, end_time, duration_ms, agent_name, model, input_tokens, output_tokens, cache_read_tokens, cost_usd"""


async def thread_spans(thread_id: str, f: Filters, limit: int = 5000) -> dict[str, Any]:
    """Every span of every trace in a thread, without payloads — for the combined tree.
    Matched by trace (not span) so spans that didn't carry the thread id still come along."""
    params: dict[str, Any] = {"thread_id": thread_id, "limit": limit + 1}
    base = " AND ".join(_base_where(f, params))
    rows = await query(f"""
        SELECT {_LITE_SPAN_COLUMNS}
        FROM {SPANS}
        WHERE {base}
          AND trace_id IN (SELECT trace_id FROM {SPANS} WHERE {base} AND thread_id = {{thread_id:String}})
        ORDER BY start_time
        LIMIT 1 BY span_id
        LIMIT {{limit:UInt32}}
    """, params)
    return {"spans": rows[:limit], "truncated": len(rows) > limit}


def bucket_seconds(start: dt.datetime, end: dt.datetime) -> int:
    span = (end - start).total_seconds()
    for limit, bucket in ((3 * 3600, 300), (12 * 3600, 900), (2 * 86400, 3600), (14 * 86400, 6 * 3600)):
        if span <= limit:
            return bucket
    return 86400


async def stats(f: Filters) -> dict[str, Any]:
    params: dict[str, Any] = {}
    where = " AND ".join(_base_where(f, params))
    params["bucket"] = bucket_seconds(f.start, f.end)

    summary_sql = f"""
        SELECT
            uniqExact(trace_id) AS traces,
            countIf(kind = 'llm') AS llm_calls,
            countIf(kind = 'tool') AS tool_calls,
            sum(input_tokens) AS input_tokens,
            sum(output_tokens) AS output_tokens,
            sum(cache_read_tokens) AS cache_read_tokens,
            sum(cache_write_tokens) AS cache_write_tokens,
            sum(cost_usd) AS cost_usd,
            countIf(status = 'error') AS error_spans,
            uniqExactIf(trace_id, status = 'error') AS error_traces,
            quantileIf(0.5)(duration_ms, kind = 'llm') AS llm_p50_ms,
            quantileIf(0.95)(duration_ms, kind = 'llm') AS llm_p95_ms,
            quantileIf(0.5)(ttft_ms, kind = 'llm' AND ttft_ms IS NOT NULL) AS ttft_p50_ms,
            quantileIf(0.95)(duration_ms, is_root = 1) AS root_p95_ms,
            countIf(kind = 'llm' AND cost_source = 'unknown') AS unpriced_llm_calls
        FROM {SPANS} WHERE {where}
    """
    series_sql = f"""
        SELECT
            toStartOfInterval(start_time, toIntervalSecond({{bucket:UInt32}})) AS t,
            uniqExact(trace_id) AS traces,
            countIf(kind = 'llm') AS llm_calls,
            sum(cost_usd) AS cost_usd,
            sum(input_tokens) AS input_tokens,
            sum(output_tokens) AS output_tokens,
            sum(cache_read_tokens) AS cache_read_tokens,
            countIf(status = 'error') AS errors,
            quantileIf(0.5)(duration_ms, kind = 'llm') AS llm_p50_ms,
            quantileIf(0.95)(duration_ms, kind = 'llm') AS llm_p95_ms
        FROM {SPANS} WHERE {where}
        GROUP BY t
        ORDER BY t WITH FILL
            FROM toStartOfInterval(toDateTime({{start:DateTime64(6, 'UTC')}}, 'UTC'), toIntervalSecond({{bucket:UInt32}}))
            TO toDateTime({{end:DateTime64(6, 'UTC')}}, 'UTC')
            STEP toIntervalSecond({{bucket:UInt32}})
    """
    by_model_sql = f"""
        SELECT model, provider, count() AS calls, sum(input_tokens) AS input_tokens,
               sum(output_tokens) AS output_tokens, sum(cache_read_tokens) AS cache_read_tokens,
               sum(cost_usd) AS cost_usd, avg(duration_ms) AS avg_ms,
               quantile(0.95)(duration_ms) AS p95_ms, countIf(status = 'error') AS errors
        FROM {SPANS} WHERE {where} AND kind = 'llm'
        GROUP BY model, provider ORDER BY sum(cost_usd) DESC, calls DESC LIMIT 50
    """
    by_agent_sql = f"""
        SELECT if(agent_name = '', '(none)', agent_name) AS agent, uniqExact(trace_id) AS traces,
               countIf(kind = 'llm') AS llm_calls, countIf(kind = 'tool') AS tool_calls,
               sum(cost_usd) AS cost_usd, sum(input_tokens + output_tokens) AS tokens,
               countIf(status = 'error') AS errors, quantileIf(0.95)(duration_ms, is_root = 1) AS p95_ms
        FROM {SPANS} WHERE {where}
        GROUP BY agent ORDER BY sum(cost_usd) DESC, traces DESC LIMIT 50
    """
    by_tool_sql = f"""
        SELECT name, count() AS calls, countIf(status = 'error') AS errors,
               avg(duration_ms) AS avg_ms, quantile(0.95)(duration_ms) AS p95_ms
        FROM {SPANS} WHERE {where} AND kind = 'tool'
        GROUP BY name ORDER BY calls DESC LIMIT 50
    """
    errors_sql = f"""
        SELECT name, kind, substring(status_message, 1, 300) AS message, count() AS count,
               max(start_time) AS last_seen, any(trace_id) AS sample_trace_id
        FROM {SPANS} WHERE {where} AND status = 'error'
        GROUP BY name, kind, message ORDER BY count DESC LIMIT 25
    """
    summary = await query(summary_sql, params)
    return {
        "bucket_seconds": params["bucket"],
        "summary": summary[0] if summary else {},
        "series": await query(series_sql, params),
        "by_model": await query(by_model_sql, params),
        "by_agent": await query(by_agent_sql, params),
        "by_tool": await query(by_tool_sql, params),
        "errors": await query(errors_sql, params),
    }


async def facets(f: Filters) -> dict[str, list[str]]:
    params: dict[str, Any] = {}
    where = " AND ".join(_base_where(f, params))
    rows = await query(f"""
        SELECT
            groupUniqArray(200)(project) AS projects,
            groupUniqArrayIf(200)(environment, environment != '') AS environments,
            groupUniqArrayIf(200)(model, model != '') AS models,
            groupUniqArrayIf(200)(agent_name, agent_name != '') AS agents,
            groupUniqArrayIf(200)(name, is_root = 1) AS root_names,
            groupUniqArrayArray(200)(tags) AS tags
        FROM {SPANS} WHERE {where}
    """, params)
    return {k: sorted(v) for k, v in (rows[0] if rows else {}).items()}


async def latest(project: str | None) -> dict[str, Any]:
    params: dict[str, Any] = {}
    where = ""
    if project:
        params["project"] = project
        where = "WHERE project = {project:String}"
    rows = await query(f"SELECT max(start_time) AS last_seen, count() > 0 AS has_data FROM {SPANS} {where}", params)
    row = rows[0] if rows else {}
    return {"last_seen": row.get("last_seen") if row.get("has_data") else None}


async def projects() -> list[str]:
    rows = await query(f"SELECT DISTINCT project FROM {SPANS} ORDER BY project")
    return [r["project"] for r in rows]
