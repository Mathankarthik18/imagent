"""Issues: find what keeps going wrong in an app's runs, and diagnose why — down to the code.

Scan (every few hours, or on demand): production runs of a project are grouped into issues —
the same error (numbers and ids masked) from the same place, or a tool called over and over
in one run (a loop). Each issue keeps its counts, first/last seen and recent example runs;
an issue someone resolved re-opens when it happens again.

Diagnose (an issue, or any single run): the model reads the run — the step tree, the failing
step's input/output and stack trace — and, when the project connected its GitHub repo, the
files behind the failure: ones named in the stack trace, ones that mention the agent/tool,
and ones it asks for from the repo's file list. It returns the root cause, evidence and a
proposed fix as diffs. Nothing is written to the repo; each diff is marked with whether it
applies to the file as read.

Uses the project's judge model and key (Settings).
"""

from __future__ import annotations

import asyncio
import datetime as dt
import difflib
import hashlib
import json
import logging
import os
import re
from typing import Any

from . import compare, github, judge, queries
from .db import DB, SPANS, get_client, query

logger = logging.getLogger(__name__)

ISSUES = f"{DB}.issues"
DIAGNOSES = f"{DB}.diagnoses"

DDL = [
    f"""
    CREATE TABLE IF NOT EXISTS {ISSUES} (
        project        String,
        id             String,
        kind           LowCardinality(String),
        title          String,
        location       String,
        agent          String,
        message        String,
        runs           UInt64,
        events         UInt64,
        failed_runs    UInt64,
        first_seen     DateTime64(3, 'UTC'),
        last_seen      DateTime64(3, 'UTC'),
        trace_ids      Array(String),
        status         LowCardinality(String),
        resolved_at    Nullable(DateTime64(3, 'UTC')),
        updated_at     DateTime64(3, 'UTC') DEFAULT now64(3)
    ) ENGINE = ReplacingMergeTree(updated_at) ORDER BY (project, id)
    """,
    # One diagnosis per target: an issue ("issue:<id>") or a single run ("trace:<trace_id>").
    f"""
    CREATE TABLE IF NOT EXISTS {DIAGNOSES} (
        target      String,
        project     String,
        status      LowCardinality(String),
        result      String CODEC(ZSTD(3)),
        error       String,
        note        String,
        created_at  DateTime64(3, 'UTC'),
        updated_at  DateTime64(3, 'UTC') DEFAULT now64(3)
    ) ENGINE = ReplacingMergeTree(updated_at) ORDER BY target
    """,
]

_ISSUE_COLS = ["project", "id", "kind", "title", "location", "agent", "message", "runs", "events", "failed_runs",
               "first_seen", "last_seen", "trace_ids", "status", "resolved_at"]
_DIAG_COLS = ["target", "project", "status", "result", "error", "note", "created_at"]

WINDOW_DAYS = 7
LOOP_MIN_CALLS = int(os.getenv("IMAGENT_LOOP_MIN_CALLS", "12"))
SCAN_SECONDS = float(os.getenv("IMAGENT_SCAN_HOURS", "6")) * 3600
AUTO_DIAGNOSE = int(os.getenv("IMAGENT_AUTO_DIAGNOSE", "3"))  # new issues diagnosed per project per scan
MAX_FILES = 8
MAX_CODE_CHARS = 90_000
MAX_FILE_CHARS = 24_000
MAX_TREE_PATHS = 2_500
_running: set[str] = set()
_tasks: set[asyncio.Task] = set()  # keep background diagnoses referenced until done


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


# ── Scan ────────────────────────────────────────────────────────────────────

# Masks what varies between occurrences of one error: ids, hex, numbers, quoted values.
_MASK = r"'[^']{0,200}'|\"[^\"]{0,200}\"|[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}|\b[0-9a-fA-F]{12,}\b|\d+"


def fingerprint(message: str) -> str:
    m = re.sub(_MASK, "#", message or "")
    return re.sub(r"\s+", " ", m).strip()[:240]


def issue_id(project: str, kind: str, key: str) -> str:
    return hashlib.sha1(f"{project}|{kind}|{key}".encode()).hexdigest()[:12]


async def detect(project: str, days: int = WINDOW_DAYS) -> list[dict[str, Any]]:
    """Issues in a project's production runs over the last ``days``."""
    params = {"p": project, "days": days}
    errors = await query(f"""
        SELECT
            fp,
            argMax(name, rank) AS location,
            argMax(agent_name, rank) AS agent,
            argMax(status_message, start_time) AS message,
            uniqExact(trace_id) AS runs,
            count() AS events,
            uniqExactIf(trace_id, is_root = 1) AS failed_runs,
            min(start_time) AS first_seen,
            max(start_time) AS last_seen,
            arraySlice(arrayReverseSort(x -> x.2, groupArray((trace_id, start_time))), 1, 8) AS recent
        FROM (
            SELECT trace_id, name, agent_name, status_message, start_time, is_root,
                   multiIf(kind = 'tool', 4, kind = 'llm', 3, kind = 'node', 2, kind = 'agent', 1, 0) AS rank,
                   if(status_message = '', concat('error in ', name),
                      trim(replaceRegexpAll(left(status_message, 400), {{mask:String}}, '#'))) AS fp
            FROM {SPANS}
            WHERE project = {{p:String}} AND origin = '' AND status = 'error'
              AND start_time >= now() - INTERVAL {{days:UInt32}} DAY
        )
        GROUP BY fp
        ORDER BY runs DESC
        LIMIT 200
    """, params | {"mask": _MASK})
    loops = await query(f"""
        SELECT name AS location, any(ag) AS agent, count() AS runs, sum(n) AS events, max(n) AS worst,
               min(f_at) AS first_seen, max(l_at) AS last_seen,
               arraySlice(arrayReverseSort(x -> x.2, groupArray((trace_id, l_at))), 1, 8) AS recent
        FROM (
            SELECT trace_id, name, any(agent_name) AS ag, count() AS n,
                   min(start_time) AS f_at, max(start_time) AS l_at
            FROM {SPANS}
            WHERE project = {{p:String}} AND origin = '' AND kind = 'tool'
              AND start_time >= now() - INTERVAL {{days:UInt32}} DAY
            GROUP BY trace_id, name
            HAVING n >= {{min:UInt32}}
        )
        GROUP BY name
        ORDER BY runs DESC
        LIMIT 50
    """, params | {"min": LOOP_MIN_CALLS})

    out, seen = [], set()
    for e in errors:
        key = fingerprint(e["fp"])
        if key in seen:
            continue
        seen.add(key)
        msg = (e["message"] or "").strip()
        out.append({
            "project": project, "id": issue_id(project, "error", key), "kind": "error",
            "title": (msg.splitlines()[0][:160] if msg else f"{e['location']} failed"),
            "location": e["location"], "agent": e["agent"] or "", "message": msg[:2000],
            "runs": e["runs"], "events": e["events"], "failed_runs": e["failed_runs"],
            "first_seen": e["first_seen"], "last_seen": e["last_seen"], "trace_ids": [t[0] for t in e["recent"]],
        })
    for lp in loops:
        out.append({
            "project": project, "id": issue_id(project, "loop", lp["location"]), "kind": "loop",
            "title": f"{lp['location']} called up to {lp['worst']}× in one run",
            "location": lp["location"], "agent": lp["agent"] or "", "message": "",
            "runs": lp["runs"], "events": lp["events"], "failed_runs": 0,
            "first_seen": lp["first_seen"], "last_seen": lp["last_seen"], "trace_ids": [t[0] for t in lp["recent"]],
        })
    return out


def severity(i: dict[str, Any]) -> str:
    if i["kind"] == "error" and (i["failed_runs"] >= 3 or i["runs"] >= 20):
        return "high"
    if i["runs"] >= 5 or i["failed_runs"] >= 1:
        return "medium"
    return "low"


async def _issues(project: str) -> dict[str, dict[str, Any]]:
    rows = await query(f"SELECT * FROM {ISSUES} FINAL WHERE project = {{p:String}}", {"p": project})
    return {r["id"]: r for r in rows}


async def _write_issues(rows: list[dict[str, Any]]) -> None:
    if rows:
        client = await get_client()
        await client.insert(ISSUES, [[r[c] for c in _ISSUE_COLS] for r in rows], column_names=_ISSUE_COLS,
                            settings={"async_insert": 0})


def _ts(v: Any) -> dt.datetime:
    if isinstance(v, dt.datetime):
        return v if v.tzinfo else v.replace(tzinfo=dt.timezone.utc)
    return dt.datetime.fromisoformat(str(v)).replace(tzinfo=dt.timezone.utc)


def merge(found: list[dict[str, Any]], existing: dict[str, dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
    """Rows to write, and ids of issues that are new (or came back after being resolved)."""
    rows, fresh = [], []
    for f in found:
        old = existing.get(f["id"])
        status, resolved_at = "open", None
        if old:
            status, resolved_at = old["status"], old.get("resolved_at")
            first = min(_ts(old["first_seen"]), _ts(f["first_seen"]))
            f["first_seen"] = first
            if status == "resolved" and resolved_at and _ts(f["last_seen"]) > _ts(resolved_at):
                status, resolved_at = "open", None  # it happened again after the fix
                fresh.append(f["id"])
            unchanged = (old["runs"] == f["runs"] and _ts(old["last_seen"]) == _ts(f["last_seen"])
                         and old["status"] == status)
            if unchanged:
                continue
        else:
            fresh.append(f["id"])
        rows.append(f | {"status": status, "resolved_at": resolved_at})
    return rows, fresh


async def scan(project: str, *, days: int = WINDOW_DAYS, auto_diagnose: int = AUTO_DIAGNOSE) -> dict[str, Any]:
    found = await detect(project, days)
    rows, fresh = merge(found, await _issues(project))
    await _write_issues(rows)
    started = 0
    if auto_diagnose and fresh:
        from . import projects
        proj = await projects.get(project)
        if judge.config_for(proj):
            ranked = sorted((f for f in found if f["id"] in fresh), key=lambda i: (severity(i) != "high", -i["runs"]))
            for i in ranked[:auto_diagnose]:
                if await start(f"issue:{i['id']}", project):
                    started += 1
    return {"issues": len(found), "updated": len(rows), "new": len(fresh), "diagnosing": started}


async def list_issues(project: str, status: str = "open") -> list[dict[str, Any]]:
    where = "" if status == "all" else "AND status = {s:String}"
    rows = await query(f"""
        SELECT * FROM {ISSUES} FINAL WHERE project = {{p:String}} {where}
        ORDER BY last_seen DESC LIMIT 500""", {"p": project, "s": status})
    diags = await query(f"""
        SELECT target, status, result FROM {DIAGNOSES} FINAL
        WHERE project = {{p:String}} AND startsWith(target, 'issue:')""", {"p": project})
    by = {d["target"][6:]: d for d in diags}
    out = []
    for r in rows:
        d = by.get(r["id"])
        res = _load(d["result"]) if d and d["status"] == "done" else {}
        out.append(r | {"severity": severity(r), "diagnosis_status": d["status"] if d else "",
                        "summary": res.get("summary", ""), "category": res.get("category", "")})
    order = {"high": 0, "medium": 1, "low": 2}
    out.sort(key=lambda i: (order[i["severity"]], -_ts(i["last_seen"]).timestamp()))
    return out


async def get_issue(issue: str) -> dict[str, Any] | None:
    rows = await query(f"SELECT * FROM {ISSUES} FINAL WHERE id = {{id:String}}", {"id": issue})
    return rows[0] | {"severity": severity(rows[0])} if rows else None


async def set_status(issue: str, status: str) -> dict[str, Any] | None:
    i = await get_issue(issue)
    if not i:
        return None
    i["status"] = status
    i["resolved_at"] = _now() if status == "resolved" else None
    await _write_issues([i])
    return i | {"severity": severity(i)}


# ── Diagnose ────────────────────────────────────────────────────────────────

def _load(raw: str) -> dict[str, Any]:
    try:
        v = json.loads(raw or "{}")
    except ValueError:
        return {}
    return v if isinstance(v, dict) else {}


async def _save(target: str, project: str, status: str, *, result: dict[str, Any] | None = None, error: str = "",
                note: str = "", created_at: dt.datetime | None = None) -> None:
    client = await get_client()
    row = {"target": target, "project": project, "status": status, "result": json.dumps(result or {}, default=str),
           "error": error[:1000], "note": note[:2000], "created_at": created_at or _now()}
    await client.insert(DIAGNOSES, [[row[c] for c in _DIAG_COLS]], column_names=_DIAG_COLS, settings={"async_insert": 0})


async def get_diagnosis(target: str) -> dict[str, Any] | None:
    rows = await query(f"SELECT * FROM {DIAGNOSES} FINAL WHERE target = {{t:String}}", {"t": target})
    if not rows:
        return None
    r = rows[0]
    return {"target": r["target"], "status": r["status"], "error": r["error"], "note": r["note"],
            "created_at": r["created_at"], "updated_at": r["updated_at"], "result": _load(r["result"])}


async def start(target: str, project: str, note: str = "") -> bool:
    """Diagnose in the background (marked running before this returns, so the UI can follow
    it). False when this target is already being diagnosed."""
    if target in _running:
        return False
    _running.add(target)
    created = _now()
    try:
        await _save(target, project, "running", note=note, created_at=created)
    except Exception:
        _running.discard(target)
        raise
    task = asyncio.get_running_loop().create_task(_run(target, project, note, created))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return True


async def _run(target: str, project: str, note: str, created: dt.datetime) -> None:
    from . import projects
    try:
        proj = await projects.get(project)
        cfg = judge.config_for(proj)
        if cfg is None:
            raise RuntimeError("No model to diagnose with — add an API key under Settings › Judging")
        kind, ident = target.split(":", 1)
        issue = None
        if kind == "issue":
            issue = await get_issue(ident)
            if not issue or not issue["trace_ids"]:
                raise RuntimeError("this issue has no example runs left (they may have aged out)")
            trace_id = issue["trace_ids"][0]
        else:
            trace_id = ident
        spans = await queries.get_trace(trace_id)
        if not spans:
            raise RuntimeError(f"run {trace_id} not found")
        try:
            gh = await github.config_for_project(proj)
        except Exception as exc:  # noqa: BLE001 — diagnose from the run alone, and say why
            gh, gh_error = None, str(exc)
        else:
            gh_error = ""
        result = await diagnose(spans, cfg=cfg, gh=gh, issue=issue, note=note,
                                rubric=(proj or {}).get("rubric", ""))
        if gh_error and not result.get("code_error"):
            result["code_error"] = f"Couldn't read the repo: {gh_error}"[:300]
        await _save(target, project, "done", result=result | {"trace_id": trace_id}, note=note, created_at=created)
    except Exception as exc:  # noqa: BLE001 — surface the failure on the diagnosis
        logger.warning("diagnosis %s failed: %s", target, exc)
        await _save(target, project, "error", error=str(exc), note=note, created_at=created)
    finally:
        _running.discard(target)


def focus_span(spans: list[dict[str, Any]], span_id: str | None = None) -> dict[str, Any] | None:
    """The step to explain: the given one, else the deepest failed step, else the run itself."""
    if span_id:
        hit = next((s for s in spans if s["span_id"] == span_id), None)
        if hit:
            return hit
    errs = [s for s in spans if s.get("status") == "error"]
    failed_parents = {s.get("parent_span_id") for s in errs}
    leaves = [s for s in errs if s["span_id"] not in failed_parents]
    if leaves:
        return min(leaves, key=lambda s: compare._ts(s["start_time"]))
    return compare.agent_span(spans)


def _clip(text: str, n: int) -> str:
    text = text or ""
    return text if len(text) <= n else text[: n // 2] + f"\n…[{len(text) - n} chars cut]…\n" + text[-n // 2:]


def stacktraces(spans: list[dict[str, Any]]) -> list[str]:
    out = []
    for s in spans:
        for e in s.get("events") or []:
            a = e.get("attributes") or {}
            st = a.get("exception.stacktrace")
            if st and st not in out:
                out.append(str(st))
    return out


def outline(spans: list[dict[str, Any]], focus: dict[str, Any] | None, max_lines: int = 160) -> str:
    """The run as an indented step tree, with errors inline."""
    kids: dict[str, list[dict[str, Any]]] = {}
    ids = {s["span_id"] for s in spans}
    for s in sorted(spans, key=lambda s: compare._ts(s["start_time"])):
        kids.setdefault(s.get("parent_span_id") if s.get("parent_span_id") in ids else "", []).append(s)
    lines: list[str] = []

    def walk(pid: str, depth: int) -> None:
        for s in kids.get(pid, []):
            if len(lines) >= max_lines:
                return
            bits = [f"{'  ' * depth}- [{s.get('kind') or 'span'}] {s['name']}"]
            if s.get("model"):
                bits.append(f"model={s['model']}")
            bits.append(f"{int(s.get('duration_ms') or 0)}ms")
            if s.get("status") == "error":
                bits.append(f"ERROR: {(s.get('status_message') or '').splitlines()[0][:200] if s.get('status_message') else ''}")
            if focus and s["span_id"] == focus["span_id"]:
                bits.append("  ◀ focus")
            lines.append(" ".join(bits))
            walk(s["span_id"], depth + 1)

    walk("", 0)
    if len(lines) >= max_lines:
        lines.append(f"… ({len(spans)} steps in all)")
    return "\n".join(lines)


_STACK_FILE = re.compile(r'File "([^"]+)", line (\d+)|at .*?\(?([\w./\\-]+\.(?:ts|tsx|js|mjs)):(\d+)')


def app_frames(stacks: list[str]) -> list[str]:
    """Source paths in stack traces that are the app's own code (not installed libraries)."""
    out: list[str] = []
    for st in stacks:
        for m in _STACK_FILE.finditer(st):
            raw = (m.group(1) or m.group(3) or "").replace("\\", "/")
            if raw and not any(x in raw for x in ("site-packages/", "/lib/python", "node_modules/", "<frozen", "<string>")) \
                    and raw not in out:
                out.append(raw)
    return out


def stack_files(stacks: list[str], paths: list[str]) -> list[tuple[str, int]]:
    """Repo files (and line numbers) named in stack traces, innermost first."""
    found: list[tuple[str, int]] = []
    for st in stacks:
        for m in _STACK_FILE.finditer(st):
            raw, line = (m.group(1), m.group(2)) if m.group(1) else (m.group(3), m.group(4))
            raw = raw.replace("\\", "/")
            if "site-packages/" in raw or "/lib/python" in raw or "node_modules/" in raw:
                continue
            best = max((p for p in paths if raw.endswith("/" + p) or raw == p or p.endswith(raw.lstrip("./"))
                        or raw.endswith("/" + p.split("/", 1)[-1])), key=len, default=None)
            if best and (best, int(line)) not in found:
                found.append((best, int(line)))
    return list(reversed(found))


def _window(text: str, lines: list[int], limit: int = MAX_FILE_CHARS) -> str:
    """A file numbered, or — when too long — the parts around the lines that matter."""
    src = text.splitlines()
    numbered = [f"{i + 1:>5}  {l}" for i, l in enumerate(src)]
    whole = "\n".join(numbered)
    if len(whole) <= limit or not lines:
        return _clip(whole, limit)
    keep: set[int] = set(range(0, 30))
    for n in lines:
        keep |= set(range(max(0, n - 80), min(len(src), n + 40)))
    out, last = [], -1
    for i in sorted(keep):
        if i >= len(numbered):
            break
        if i != last + 1:
            out.append("        …")
        out.append(numbered[i])
        last = i
    return _clip("\n".join(out), limit)


PICK_SYSTEM = """You are debugging an AI agent application. Given a failing run and the repository's file list,
choose the source files most likely to contain the root cause or the fix: the failing tool/agent's code,
its prompt files, the model/config setup it uses. Prefer application code over tests and docs.
Reply with JSON only: {"files": ["path", ...]} — at most %d paths, copied exactly from the list."""

SYSTEM = """You are a senior engineer diagnosing a problem in an AI agent application from a production run{code_hint}.

Find the root cause — not the symptom. Typical causes: a tool raising on unexpected input, a tool returning
data the model misreads, a prompt that is ambiguous or missing a rule, a model too weak for the step,
wrong configuration, an external service failing, a missing guard that lets the agent loop.
Base every claim on the run and the code shown; say what you could not verify.

Propose the smallest fix that removes the cause. When source files are shown, give the fix as exact edits
to those files (real paths). Each edit replaces one passage: "find" is copied character-for-character from the
file — same indentation, WITHOUT the line-number prefix — and long enough to occur only once; "replace" is the
new text. To add a new file use "find": "" and the whole file as "replace". Without source, describe the change
precisely instead and leave changes empty.

Reply with JSON only:
{{"title": "<short name of the problem>",
  "category": "tool_error" | "code_bug" | "prompt" | "model" | "config" | "external" | "loop" | "other",
  "summary": "<one or two sentences: what goes wrong and why>",
  "root_cause": "<the explanation, with file/line references when you have the code>",
  "evidence": ["<fact from the run or the code>", ...],
  "fix": {{"explanation": "<what to change and why it fixes it>",
          "changes": [{{"path": "<repo path>", "edits": [{{"find": "<exact existing text>", "replace": "<new text>"}}]}}]}},
  "verify": "<how to confirm the fix: what to re-run or check>",
  "confidence": "high" | "medium" | "low"}}"""


def _run_context(spans: list[dict[str, Any]], focus: dict[str, Any] | None, issue: dict[str, Any] | None,
                 note: str) -> str:
    root = compare.agent_span(spans) or {}
    parts = []
    if issue:
        parts.append(f"## Issue\n{issue['title']}\nKind: {issue['kind']} · in {issue['location']}"
                     f"{' (agent ' + issue['agent'] + ')' if issue['agent'] else ''} · {issue['runs']} runs affected, "
                     f"{issue['failed_runs']} ended in failure, {issue['events']} occurrences, "
                     f"first seen {issue['first_seen']}, last seen {issue['last_seen']}.\nThe run below is the latest example.")
    if note:
        parts.append(f"## What the developer noticed\n{note}")
    q = compare.readable(root.get("input", ""), roles=("user", "human"))
    parts.append(f"## User request\n{_clip(q, 3000) or '(not captured)'}")
    parts.append(f"## Run steps\n{outline(spans, focus)}")
    if focus:
        parts.append(f"## Focus step: [{focus.get('kind')}] {focus['name']}"
                     f"{' — ' + focus['status_message'][:1500] if focus.get('status_message') else ''}\n"
                     f"Input:\n{_clip(focus.get('input', ''), 4000) or '(none)'}\n\nOutput:\n{_clip(focus.get('output', ''), 3000) or '(none)'}")
        if issue and issue["kind"] == "loop":
            calls = [s for s in spans if s.get("kind") == "tool" and s["name"] == issue["location"]]
            sample = "\n".join(f"- in: {_clip(s.get('input', ''), 300)}\n  out: {_clip(s.get('output', ''), 300)}"
                               for s in calls[:6])
            parts.append(f"## Repeated calls to {issue['location']} ({len(calls)} in this run), first few\n{sample}")
    answer = compare.readable(root.get("output", ""))
    parts.append(f"## Final answer\n{_clip(answer, 2500) or '(none — the run failed or was cut off)'}")
    stacks = stacktraces(spans)
    if stacks:
        parts.append("## Stack trace\n" + _clip(stacks[0], 6000))
    return "\n\n".join(parts)


async def _gather_code(gh: dict[str, str], spans: list[dict[str, Any]], focus: dict[str, Any] | None,
                       issue: dict[str, Any] | None, context: str, cfg: dict[str, str]) -> tuple[list[dict[str, Any]], float, dict[str, str]]:
    """Read the source files behind the failure. Returns files, LLM cost, repo info."""
    paths = await asyncio.to_thread(github.tree, gh)
    info = {"repo": gh["repo"], "branch": await asyncio.to_thread(github.branch, gh),
            "commit": (await asyncio.to_thread(github.head_commit, gh))[:10]}
    wanted: dict[str, list[int]] = {}
    stacks = stacktraces(spans)
    matched = stack_files(stacks, paths)
    for p, line in matched[:4]:
        wanted.setdefault(p, []).append(line)
    # App files the stack trace names that this repo/branch doesn't have: likely the wrong repo,
    # branch or folder — say so instead of guessing from other files.
    have = {p for p, _ in matched}
    info["missing"] = ["/".join(f.split("/")[-3:]) for f in app_frames(stacks)
                       if not any(f.endswith("/" + h) or f.endswith("/" + h.split("/", 1)[-1]) for h in have)][:5]
    terms = [t for t in {(focus or {}).get("name", ""), (issue or {}).get("location", ""), (issue or {}).get("agent", "")}
             if t and len(t) >= 4 and t not in {"LangGraph", "agent", "model", "tools"}]
    for t in terms[:2]:
        for p in await asyncio.to_thread(github.search, gh, t, 4):
            if p in paths:
                wanted.setdefault(p, [])
    cost = 0.0
    if len(wanted) < MAX_FILES:
        listing = "\n".join(paths[:MAX_TREE_PATHS])
        more = f"\n… and {len(paths) - MAX_TREE_PATHS} more" if len(paths) > MAX_TREE_PATHS else ""
        already = "\n".join(wanted) or "(none)"
        msgs = [{"role": "system", "content": PICK_SYSTEM % (MAX_FILES - len(wanted))},
                {"role": "user", "content": f"{_clip(context, 12000)}\n\n## Already selected\n{already}\n\n## Repository files\n{listing}{more}"}]
        text, cost = await asyncio.to_thread(judge._call, msgs, cfg, max_tokens=4000, timeout=180, title="imagent diagnose")
        picked = _json(text, "files").get("files") or []
        for p in picked:
            if isinstance(p, str) and p in paths and len(wanted) < MAX_FILES:
                wanted.setdefault(p, [])
    files, total = [], 0
    for p, lines in wanted.items():
        try:
            text = await asyncio.to_thread(github.read, gh, p)
        except Exception as exc:  # noqa: BLE001 — a missing file shouldn't sink the diagnosis
            logger.info("diagnose: could not read %s: %s", p, exc)
            continue
        shown = _window(text, lines, min(MAX_FILE_CHARS, MAX_CODE_CHARS - total))
        if not shown:
            break
        total += len(shown)
        files.append({"path": p, "lines": lines, "text": text, "shown": shown})
        if total >= MAX_CODE_CHARS:
            break
    return files, cost, info


def _json(text: str, key: str) -> dict[str, Any]:
    """The last JSON object in a reply that has ``key``."""
    for raw in reversed(re.findall(r"\{(?:[^{}]|\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})*\}", text, re.S)):
        try:
            d = json.loads(raw)
        except ValueError:
            continue
        if isinstance(d, dict) and key in d:
            return d
    try:  # a reply that is a single JSON object with deeper nesting than the regex handles
        start, end = text.index("{"), text.rindex("}")
        d = json.loads(text[start:end + 1])
        if isinstance(d, dict) and key in d:
            return d
    except ValueError:
        pass
    raise ValueError(f"the model's reply has no JSON with '{key}': {text[:200]}")


class EditError(ValueError):
    pass


def apply_edits(text: str | None, edits: list[dict[str, str]], path: str = "") -> str:
    """The file after the edits. Each "find" must occur exactly once (a new file: no text, find "")."""
    if text is None:
        if len(edits) == 1 and not edits[0]["find"]:
            return edits[0]["replace"]
        raise EditError(f"{path} doesn't exist")
    for e in edits:
        n = text.count(e["find"]) if e["find"] else 0
        if n != 1:
            raise EditError(f"{path}: {'a passage to change is no longer in the file' if n == 0 else 'a passage to change appears more than once'}"
                            f" — {e['find'].strip().splitlines()[0][:80] if e['find'].strip() else '(empty)'}")
        text = text.replace(e["find"], e["replace"], 1)
    return text


def unified(path: str, before: str | None, after: str) -> str:
    return "".join(difflib.unified_diff((before or "").splitlines(keepends=True), after.splitlines(keepends=True),
                                        fromfile=f"a/{path}" if before is not None else "/dev/null", tofile=f"b/{path}", n=3))


def build_change(ch: Any, files: dict[str, str]) -> dict[str, Any] | None:
    """A proposed change as edits + the diff they make (or the model's own diff, for older replies)."""
    if not isinstance(ch, dict):
        return None
    path = str(ch.get("path", "")).strip().lstrip("/")
    edits = [{"find": str(e.get("find") or ""), "replace": str(e.get("replace") or "")}
             for e in ch.get("edits") or [] if isinstance(e, dict)]
    if edits:
        before = files.get(path)
        try:
            after = apply_edits(before, edits, path)
            return {"path": path, "edits": edits, "diff": unified(path, before, after)[:30000], "applies": True}
        except EditError as exc:
            return {"path": path, "edits": edits, "applies": False, "problem": str(exc)[:300],
                    "diff": "\n".join(f"-{l}" for e in edits for l in e["find"].splitlines())
                            + "\n" + "\n".join(f"+{l}" for e in edits for l in e["replace"].splitlines())}
    if ch.get("diff"):
        diff = str(ch["diff"])[:20000]
        return {"path": path, "diff": diff, "applies": diff_applies(diff, files[path]) if path in files else None}
    return None


def diff_applies(diff: str, text: str) -> bool:
    """Every removed and context line of the diff is in the file (ignoring indentation drift)."""
    have = {l.strip() for l in text.splitlines()}
    needed = [l[1:].strip() for l in diff.splitlines()
              if l[:1] in ("-", " ") and not l.startswith("---") and l[1:].strip()]
    return bool(needed) and all(l in have for l in needed)


async def diagnose(spans: list[dict[str, Any]], *, cfg: dict[str, str], gh: dict[str, str] | None = None,
                   issue: dict[str, Any] | None = None, note: str = "", rubric: str = "",
                   span_id: str | None = None) -> dict[str, Any]:
    focus = focus_span(spans, span_id)
    context = _run_context(spans, focus, issue, note)
    if rubric:
        context += f"\n\n## The team's rules for a good answer\n{rubric[:2000]}"
    files: list[dict[str, Any]] = []
    cost, repo, code_error = 0.0, None, ""
    if gh:
        try:
            files, cost, repo = await _gather_code(gh, spans, focus, issue, context, cfg)
        except Exception as exc:  # noqa: BLE001 — diagnose from the run alone
            code_error = f"Couldn't read the repo: {exc}"[:300]
            logger.warning("diagnose: %s", code_error)
    if repo and repo.get("missing") and not code_error:
        code_error = (f"The stack trace points at {', '.join(repo['missing'])}, which isn't in "
                      f"{repo['repo']}@{repo['branch']}{'/' + gh['path'] if gh and gh.get('path') else ''} — check the repo, "
                      "branch and folder in Settings › Source code, then diagnose again.")
    code = "\n\n".join(f"### {f['path']}\n```\n{f['shown']}\n```" for f in files)
    user = context + (f"\n\n## Source files ({repo['repo']} @ {repo['branch']} {repo['commit']})\n{code}" if files else "")
    hint = " and the source files involved" if files else ""
    msgs = [{"role": "system", "content": SYSTEM.format(code_hint=hint)}, {"role": "user", "content": user}]
    text, c2 = await asyncio.to_thread(judge._call, msgs, cfg, max_tokens=12000, timeout=300, title="imagent diagnose")
    out = _json(text, "summary")
    by_path = {f["path"]: f["text"] for f in files}
    fix = out.get("fix") if isinstance(out.get("fix"), dict) else {}
    changes = [c for c in (build_change(ch, by_path) for ch in fix.get("changes") or []) if c]
    return {
        "title": str(out.get("title", ""))[:200], "category": str(out.get("category", "other")),
        "summary": str(out.get("summary", ""))[:1200], "root_cause": str(out.get("root_cause", ""))[:6000],
        "evidence": [str(e)[:600] for e in (out.get("evidence") or [])][:10],
        "fix": {"explanation": str(fix.get("explanation", ""))[:4000], "changes": changes},
        "verify": str(out.get("verify", ""))[:1500], "confidence": str(out.get("confidence", "low")),
        "focus": {"span_id": focus["span_id"], "name": focus["name"], "kind": focus.get("kind")} if focus else None,
        "files": [{"path": f["path"], "lines": f["lines"]} for f in files], "repo": repo, "code_error": code_error,
        "model": cfg["model"], "cost": round(cost + c2, 6), "at": _now().isoformat(),
    }


# ── Fix branch ──────────────────────────────────────────────────────────────

class StaleFix(RuntimeError):
    """The code changed since the diagnosis: its edits no longer apply."""


def _pr_body(r: dict[str, Any], issue: dict[str, Any] | None) -> str:
    lines = [f"**{r.get('summary', '')}**", ""]
    if issue:
        lines += [f"Issue: {issue['title']} — {issue['runs']} runs affected, {issue['failed_runs']} failed "
                  f"(last seen {issue['last_seen']}).", ""]
    lines += ["### Root cause", r.get("root_cause", ""), ""]
    if r.get("evidence"):
        lines += ["### Evidence", *[f"- {e}" for e in r["evidence"]], ""]
    lines += ["### Fix", r.get("fix", {}).get("explanation", ""), ""]
    if r.get("verify"):
        lines += ["### How to check", r["verify"], ""]
    lines += [f"_Diagnosed by imagent from run `{r.get('trace_id', '')}` with {r.get('model', '')} "
              f"({r.get('confidence', '')} confidence). Review before merging._"]
    return "\n".join(lines)


async def create_fix(target: str) -> dict[str, Any]:
    """Apply a diagnosis's edits to the latest code on a new branch and open a draft PR."""
    from . import projects
    d = await get_diagnosis(target)
    if not d or d["status"] != "done":
        raise ValueError("diagnose this first")
    r = d["result"]
    changes = [c for c in r.get("fix", {}).get("changes", []) if c.get("edits")]
    if not changes:
        raise ValueError("this diagnosis has no code edits to commit — connect GitHub and diagnose again")
    if r.get("fix_branch"):
        return r["fix_branch"]
    proj = await projects.get(d["project"])
    gh = await github.config_for_project(proj)
    if not gh or not gh.get("token"):
        raise ValueError("connect GitHub in Settings first")
    base, head = await asyncio.to_thread(github.latest, gh)
    new: dict[str, str] = {}
    for c in changes:
        before = await asyncio.to_thread(github.read_at, gh, c["path"], head)
        try:
            new[c["path"]] = apply_edits(new.get(c["path"], before), c["edits"], c["path"])
        except EditError as exc:
            raise StaleFix(f"The code changed since this diagnosis ({exc}). Diagnose again on the latest code.") from exc
    issue = await get_issue(target[6:]) if target.startswith("issue:") else None
    slug = re.sub(r"[^a-z0-9]+", "-", (r.get("title") or "fix").lower()).strip("-")[:40] or "fix"
    branch = f"imagent/fix-{(issue or {}).get('id') or target.split(':', 1)[1][:8]}-{slug}"
    title = f"Fix: {r.get('title') or (issue or {}).get('title') or 'issue found by imagent'}"[:120]
    made = await asyncio.to_thread(github.create_fix_branch, gh, base_sha=head, branch_name=branch, files=new,
                                   message=f"{title}\n\n{r.get('summary', '')}\n\nDiagnosed by imagent.")
    pr = await asyncio.to_thread(github.open_pr, gh, head=made["branch"], base=base, title=title, body=_pr_body(r, issue))
    out = made | {"base": base, "pr_number": pr["number"], "pr_url": pr["url"], "draft": pr["draft"], "at": _now().isoformat()}
    await _save(target, d["project"], "done", result=r | {"fix_branch": out}, note=d["note"],
                created_at=d["created_at"])
    return out


# ── Background ──────────────────────────────────────────────────────────────

async def worker() -> None:
    """Scan every project for issues every few hours (first pass a minute after start)."""
    from . import projects
    await asyncio.sleep(60)
    while True:
        try:
            rows = await query(f"SELECT id FROM {projects.PROJECTS} FINAL WHERE archived = 0")
            for r in rows:
                try:
                    res = await scan(r["id"])
                    if res["new"]:
                        logger.info("issues scan %s: %s", r["id"], res)
                except Exception as exc:  # noqa: BLE001 — one project must not stop the rest
                    logger.warning("issues scan %s failed: %s", r["id"], exc)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("issues worker: %s", exc)
        await asyncio.sleep(SCAN_SECONDS)
