"""Blueprints: the structure of an AI application, as its agent framework describes it.

The SDK (`imagent.publish_blueprint(agent)`) reads the compiled agent — main agent,
sub-agents, models, prompts, tools, middleware, LangGraph nodes — and posts it here at
app startup. We keep the latest per (project, name) and, on read, layer live stats from
spans on top: every span carries the agent it ran in (`agent_name`), so per-agent model
usage, tool calls, latency, cost and errors are one grouped query each.
"""

from __future__ import annotations

import datetime as dt
import json
from typing import Any

from .db import DB, SPANS, get_client, query

BLUEPRINTS = f"{DB}.blueprints"

DDL = [
    f"""
    CREATE TABLE IF NOT EXISTS {BLUEPRINTS} (
        project     String,
        name        String,
        hash        String,
        framework   LowCardinality(String),
        blueprint   String CODEC(ZSTD(3)),
        first_seen  DateTime64(3, 'UTC'),
        updated_at  DateTime64(3, 'UTC') DEFAULT now64(3)
    ) ENGINE = ReplacingMergeTree(updated_at) ORDER BY (project, name)
    """,
]


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _count(agent: dict[str, Any]) -> dict[str, int]:
    subs = agent.get("subagents") or []
    inner = [_count(s) for s in subs]
    return {"agents": 1 + sum(c["agents"] for c in inner),
            "tools": len(agent.get("tools") or []) + sum(c["tools"] for c in inner)}


async def upsert(project: str, name: str, blueprint: dict[str, Any], hash_: str) -> dict[str, Any]:
    prev = await query(f"SELECT hash, first_seen FROM {BLUEPRINTS} FINAL WHERE project = {{p:String}} AND name = {{n:String}}",
                       {"p": project, "n": name})
    now = _now()
    first_seen = prev[0]["first_seen"] if prev else now
    changed = not prev or prev[0]["hash"] != hash_
    client = await get_client()
    await client.insert(BLUEPRINTS, [[project, name, hash_, str(blueprint.get("framework") or ""),
                                      json.dumps(blueprint, ensure_ascii=False), first_seen, now]],
                        column_names=["project", "name", "hash", "framework", "blueprint", "first_seen", "updated_at"],
                        settings={"async_insert": 0})
    return {"project": project, "name": name, "changed": changed}


async def list_blueprints(project: str | None = None) -> list[dict[str, Any]]:
    where = "WHERE project = {p:String}" if project else ""
    rows = await query(f"SELECT project, name, hash, framework, blueprint, first_seen, updated_at "
                       f"FROM {BLUEPRINTS} FINAL {where} ORDER BY updated_at DESC", {"p": project or ""})
    out = []
    for r in rows:
        bp = json.loads(r["blueprint"])
        root = bp.get("root") or {}
        out.append({"project": r["project"], "name": r["name"], "framework": r["framework"], "hash": r["hash"],
                    "versions": bp.get("versions") or {}, "model": (root.get("model") or {}).get("name", ""),
                    **_count(root), "first_seen": r["first_seen"], "updated_at": r["updated_at"]})
    return out


def agent_names(node: dict[str, Any]) -> list[str]:
    """The agent and every sub-agent under it, depth first."""
    return [n for n in [node.get("name") or ""] if n] + [x for c in node.get("subagents") or [] for x in agent_names(c)]


async def get(project: str, name: str, days: int = 7) -> dict[str, Any] | None:
    rows = await query(f"SELECT hash, blueprint, first_seen, updated_at FROM {BLUEPRINTS} FINAL "
                       f"WHERE project = {{p:String}} AND name = {{n:String}}", {"p": project, "n": name})
    if not rows:
        return None
    r = rows[0]
    bp = json.loads(r["blueprint"])
    return {"project": project, "name": name, "hash": r["hash"], "first_seen": r["first_seen"],
            "updated_at": r["updated_at"], "blueprint": bp,
            "stats": await stats(project, days, agent_names(bp.get("root") or {})), "days": days}


async def stats(project: str, days: int, names: list[str] | None = None) -> dict[str, Any]:
    """Live numbers per agent / model / tool from the project's spans in the window.

    A model or tool call belongs to the agent whose graph ran it: its parent is a graph node
    ("model", "tools") and that node's parent is the agent's run span. Owning by the tree works
    for spans recorded before the SDK stamped sub-agents correctly (their ``agent_name`` was the
    main agent's); the ``agent_name`` column is the fallback. Never reads payload or metadata
    columns — a week of them doesn't fit a small ClickHouse."""
    names = sorted(set(names or []))
    where = "project = {p:String} AND origin = '' AND start_time >= now() - toIntervalDay({d:UInt32})"
    params = {"p": project, "d": days, "names": names}
    # A main agent's run is an `agent` span; a deepagents sub-agent run is a `chain` (older SDKs)
    # or `agent` span named after it, under the `task` tool.
    runs_of = f"kind IN ('agent', 'chain') AND name IN {{names:Array(String)}}"
    owner = f"""(SELECT n.span_id AS node_id, any(a.name) AS owner
                 FROM (SELECT span_id, parent_span_id FROM {SPANS} WHERE {where} AND kind = 'node') AS n
                 INNER JOIN (SELECT span_id, name FROM {SPANS} WHERE {where} AND {runs_of}) AS a
                   ON n.parent_span_id = a.span_id
                 GROUP BY n.span_id)"""
    who = "if(o.owner != '', o.owner, toString(s.agent_name))"
    agents = await query(f"""
        SELECT name, kind, count() AS runs, countIf(status = 'error') AS errors,
               quantile(0.5)(duration_ms) AS p50, quantile(0.95)(duration_ms) AS p95, max(start_time) AS last_run
        FROM {SPANS} WHERE {where} AND kind IN ('agent', 'chain') AND name != '' GROUP BY name, kind""", params)
    llm = await query(f"""
        SELECT {who} AS agent, s.model AS model, count() AS calls, countIf(s.status = 'error') AS errors,
               sum(s.input_tokens) AS input_tokens, sum(s.output_tokens) AS output_tokens, sum(s.cost_usd) AS cost,
               quantile(0.5)(s.duration_ms) AS p50, quantile(0.95)(s.duration_ms) AS p95
        FROM (SELECT parent_span_id, model, status, input_tokens, output_tokens, cost_usd, duration_ms,
                     agent_name FROM {SPANS} WHERE {where} AND kind = 'llm') AS s
        LEFT JOIN {owner} AS o ON s.parent_span_id = o.node_id
        GROUP BY agent, model""", params)
    tools = await query(f"""
        SELECT {who} AS agent, s.name AS name, count() AS calls, countIf(s.status = 'error') AS errors,
               quantile(0.5)(s.duration_ms) AS p50, quantile(0.95)(s.duration_ms) AS p95, max(s.start_time) AS last_call
        FROM (SELECT parent_span_id, name, status, duration_ms, start_time, agent_name
                     FROM {SPANS} WHERE {where} AND kind = 'tool') AS s
        LEFT JOIN {owner} AS o ON s.parent_span_id = o.node_id
        GROUP BY agent, name""", params)

    out: dict[str, dict[str, Any]] = {}

    def agent(n: str) -> dict[str, Any]:
        return out.setdefault(n, {"runs": 0, "errors": 0, "p50": None, "p95": None, "last_run": None, "cost": 0.0,
                                  "llm_calls": 0, "tokens": 0, "models": [], "tools": {}})

    for m in llm:
        s = agent(m["agent"])
        s["llm_calls"] += m["calls"]
        s["tokens"] += m["input_tokens"] + m["output_tokens"]
        s["cost"] += m["cost"]
        s["models"].append({"model": m["model"], "calls": m["calls"], "errors": m["errors"], "cost": m["cost"],
                            "p50": m["p50"], "p95": m["p95"]})
    for t in tools:
        agent(t["agent"])["tools"][t["name"]] = {"calls": t["calls"], "errors": t["errors"], "p50": t["p50"],
                                                 "p95": t["p95"], "last_call": t["last_call"]}
    # Prefer the agent span when a name has both kinds.
    by_name: dict[str, dict[str, Any]] = {}
    for a in agents:
        if a["kind"] == "agent" or a["name"] not in by_name:
            by_name[a["name"]] = a
    known = set(names)
    for a in by_name.values():
        if a["kind"] == "chain" and a["name"] not in known and a["name"] not in out:
            continue  # LangGraph plumbing ("model", "tools", ...) — only count chains of known agents
        s = agent(a["name"])
        s.update(runs=a["runs"], errors=a["errors"], p50=a["p50"], p95=a["p95"], last_run=a["last_run"])
    for s in out.values():
        s["models"].sort(key=lambda m: -m["calls"])
    return out
