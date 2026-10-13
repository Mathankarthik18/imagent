"""Projects: the home for one AI application — its blueprint, traces and experiments.

A project is created in the UI and gets an API key. The SDK sends with that key
(``IMAGENT_API_KEY``) and everything it sends — spans, the blueprint, the experiment
runner — lands in that project, whatever the app's service name is (so an app's API
and worker can both report into one project).

The project ``id`` is what span rows store in their ``project`` column; ``name`` is the
editable display name. Keys are stored hashed; the raw key is shown once at creation
or rotation.

Legacy: data sent with the server-wide ingest key (or with no key on an open server)
still goes to the project named after its ``service.name``; such names show up as
"unclaimed" until a project adopts them.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import re
import secrets
import time
from typing import Any

from .db import DB, SPANS, get_client, query

PROJECTS = f"{DB}.projects"
KEY_PREFIX = "imk_"

DDL = [
    f"""
    CREATE TABLE IF NOT EXISTS {PROJECTS} (
        id           String,
        name         String,
        description  String,
        key_hash     String,
        key_hint     String,
        archived     UInt8 DEFAULT 0,
        rubric       String DEFAULT '',
        judge_key    String DEFAULT '',
        judge_model  String DEFAULT '',
        judge_base_url String DEFAULT '',
        created_at   DateTime64(3, 'UTC'),
        updated_at   DateTime64(3, 'UTC') DEFAULT now64(3)
    ) ENGINE = ReplacingMergeTree(updated_at) ORDER BY id
    """,
]

DDL += [f"ALTER TABLE {PROJECTS} ADD COLUMN IF NOT EXISTS {c} String DEFAULT ''"
        for c in ("rubric", "judge_key", "judge_model", "judge_base_url")]

_COLS = ["id", "name", "description", "key_hash", "key_hint", "archived", "rubric",
         "judge_key", "judge_model", "judge_base_url", "created_at", "updated_at"]
_cache: dict[str, Any] = {"at": 0.0, "by_hash": {}}
CACHE_SECONDS = 10


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _hash(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def new_key() -> tuple[str, str, str]:
    """(raw key, hash, hint shown in the UI)."""
    raw = KEY_PREFIX + secrets.token_urlsafe(24)
    return raw, _hash(raw), f"{raw[:8]}…{raw[-4:]}"


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s[:48] or "project"


async def _write(row: dict[str, Any]) -> None:
    row["updated_at"] = _now()
    client = await get_client()
    await client.insert(PROJECTS, [[row[c] for c in _COLS]], column_names=_COLS,
                        settings={"async_insert": 0})
    _cache["at"] = 0.0


async def get(project_id: str) -> dict[str, Any] | None:
    rows = await query(f"SELECT * FROM {PROJECTS} FINAL WHERE id = {{id:String}}", {"id": project_id})
    return rows[0] if rows else None


def public(p: dict[str, Any]) -> dict[str, Any]:
    return {k: p[k] for k in ("id", "name", "description", "key_hint", "created_at", "updated_at")} | {
        "archived": bool(p["archived"]), "rubric": p.get("rubric") or "",
        # the judge key itself never leaves the server — only a hint
        "judge_model": p.get("judge_model") or "", "judge_base_url": p.get("judge_base_url") or "",
        "judge_key_hint": _hint(p.get("judge_key") or "")}


def _hint(key: str) -> str:
    return f"{key[:6]}…{key[-4:]}" if len(key) > 12 else ("set" if key else "")


async def create(name: str, description: str = "", project_id: str | None = None) -> dict[str, Any]:
    """New project with a fresh key. ``project_id`` adopts existing data stored under that name."""
    pid = project_id or slugify(name)
    if not project_id:
        base, n = pid, 2
        while await get(pid) or await _has_data(pid):
            pid, n = f"{base}-{n}", n + 1
    elif await get(pid):
        raise ValueError(f"project '{pid}' already exists")
    raw, h, hint = new_key()
    row = {"id": pid, "name": name.strip() or pid, "description": description.strip(), "key_hash": h, "key_hint": hint,
           "archived": 0, "rubric": "", "judge_key": "", "judge_model": "", "judge_base_url": "", "created_at": _now()}
    await _write(row)
    return public(row) | {"key": raw}


async def update(project_id: str, *, name: str | None = None, description: str | None = None,
                 archived: bool | None = None, rubric: str | None = None, judge_key: str | None = None,
                 judge_model: str | None = None, judge_base_url: str | None = None) -> dict[str, Any] | None:
    p = await get(project_id)
    if not p:
        return None
    if name is not None and name.strip():
        p["name"] = name.strip()
    if description is not None:
        p["description"] = description.strip()
    if archived is not None:
        p["archived"] = int(archived)
    if rubric is not None:
        p["rubric"] = rubric.strip()[:4000]
    if judge_key is not None:  # "" removes it
        p["judge_key"] = judge_key.strip()
    if judge_model is not None:
        p["judge_model"] = judge_model.strip()
    if judge_base_url is not None:
        p["judge_base_url"] = judge_base_url.strip()
    await _write(p)
    return public(p)


async def rotate_key(project_id: str) -> dict[str, Any] | None:
    p = await get(project_id)
    if not p:
        return None
    raw, p["key_hash"], p["key_hint"] = new_key()
    await _write(p)
    return public(p) | {"key": raw}


async def project_for_key(key: str) -> str | None:
    """Project id for a project API key (cached briefly), else None."""
    if not key.startswith(KEY_PREFIX):
        return None
    if time.time() - _cache["at"] > CACHE_SECONDS:
        rows = await query(f"SELECT id, key_hash FROM {PROJECTS} FINAL WHERE archived = 0")
        _cache["by_hash"] = {r["key_hash"]: r["id"] for r in rows}
        _cache["at"] = time.time()
    return _cache["by_hash"].get(_hash(key))


async def _has_data(project_id: str) -> bool:
    rows = await query(f"SELECT 1 FROM {SPANS} WHERE project = {{p:String}} LIMIT 1", {"p": project_id})
    return bool(rows)


async def list_projects() -> dict[str, Any]:
    """Projects with 24h activity, plus project names in the data that no project owns yet."""
    rows = await query(f"SELECT * FROM {PROJECTS} FINAL WHERE archived = 0 ORDER BY created_at")
    activity = await query(f"""
        SELECT project,
               uniqExactIf(trace_id, is_root = 1 AND origin = '' AND start_time >= now() - INTERVAL 1 DAY) AS runs_24h,
               sumIf(cost_usd, origin = '' AND start_time >= now() - INTERVAL 1 DAY) AS cost_24h,
               countIf(status = 'error' AND origin = '' AND start_time >= now() - INTERVAL 1 DAY) AS errors_24h,
               uniqExactIf(trace_id, is_root = 1 AND origin = '') AS runs_total,
               max(start_time) AS last_trace,
               groupUniqArrayIf(service, service != '') AS services
        FROM {SPANS} GROUP BY project""")
    act = {a["project"]: a for a in activity}
    owned = {r["id"] for r in rows}
    empty = {"runs_24h": 0, "cost_24h": 0.0, "errors_24h": 0, "runs_total": 0, "last_trace": None, "services": []}
    projects = [public(r) | {k: act.get(r["id"], empty)[k] for k in empty} for r in rows]
    unclaimed = [{"id": a["project"], "runs_total": a["runs_total"], "last_trace": a["last_trace"]}
                 for a in activity if a["project"] not in owned]
    return {"projects": projects, "unclaimed": unclaimed}


async def with_judge() -> list[str]:
    """Projects that set their own judge key."""
    rows = await query(f"SELECT id FROM {PROJECTS} FINAL WHERE archived = 0 AND judge_key != ''")
    return [r["id"] for r in rows]
