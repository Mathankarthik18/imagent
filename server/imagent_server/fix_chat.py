"""Discuss a diagnosis: a conversation with the project's model about the root cause and the fix.

The model sees what the diagnosis saw — the run, the diagnosis itself, the source files it read
(re-read at the repo's latest commit) — plus the conversation so far. It answers, and when the
developer and it agree the fix should change, it proposes a complete revised fix as exact edits.
A revised fix is only a proposal until someone adopts it ("Use this version"), which replaces the
diagnosis's fix; "Create fix branch" then commits that version.

Conversations are saved per target ("issue:<id>" / "trace:<id>"), so teammates see why a fix
changed, and the latest exchange goes into the PR description.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import uuid
from typing import Any

from . import diagnose, github, judge, queries
from .db import DB, get_client, query

logger = logging.getLogger(__name__)

CHATS = f"{DB}.fix_chats"
DDL = [
    f"""
    CREATE TABLE IF NOT EXISTS {CHATS} (
        target      String,
        id          String,
        role        LowCardinality(String),
        content     String CODEC(ZSTD(3)),
        fix         String CODEC(ZSTD(3)),
        cost        Float64,
        created_at  DateTime64(3, 'UTC')
    ) ENGINE = MergeTree ORDER BY (target, created_at, id)
    """,
]
_COLS = ["target", "id", "role", "content", "fix", "cost", "created_at"]

MAX_HISTORY = 24          # messages of the conversation sent back to the model
MAX_MESSAGE = 4000        # characters a person can send
_thinking: set[str] = set()
_tasks: set[asyncio.Task] = set()

SYSTEM = """You are a senior engineer discussing a diagnosis you made of a problem in an AI agent application
with the developer who will ship the fix. Below are the production run, your diagnosis, the proposed fix,
and the source files involved{code_note}.

Answer the developer's question directly and concisely (a few short paragraphs at most; markdown is fine).
Ground every claim in the run and the code shown; say plainly when you can't tell. If the developer points
out something you got wrong, re-check and say so — don't defend a wrong diagnosis.

Only when the fix should change (the developer asks for a change, or you now see a better fix) include a
revised fix. It REPLACES the current fix entirely, so list every edit it needs, not just the new ones. Edits
follow the same rules: "find" is copied character-for-character from the file shown (same indentation, no
line-number prefix) and occurs exactly once; "replace" is the new text; a new file uses "find": "".
Otherwise set "fix" to null.

Reply with JSON only:
{{"reply": "<your answer to the developer>",
  "fix": null | {{"explanation": "<what the revised fix changes and why>",
                 "changes": [{{"path": "<repo path>", "edits": [{{"find": "<exact existing text>", "replace": "<new text>"}}]}}]}}}}"""


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


async def messages(target: str, since: dt.datetime | None = None) -> list[dict[str, Any]]:
    """The conversation — only since ``since`` (the current diagnosis) when given."""
    rows = await query(f"SELECT * FROM {CHATS} WHERE target = {{t:String}}"
                       + (" AND created_at >= {s:DateTime64(3, 'UTC')}" if since else "") + " ORDER BY created_at, id",
                       {"t": target, "s": since} if since else {"t": target})
    out = []
    for r in rows:
        fix = diagnose._load(r["fix"]) if r["fix"] else None
        out.append({"id": r["id"], "role": r["role"], "content": r["content"], "fix": fix or None,
                    "cost": r["cost"], "at": r["created_at"]})
    return out


async def _add(target: str, role: str, content: str, *, fix: dict[str, Any] | None = None, cost: float = 0.0) -> dict[str, Any]:
    row = {"target": target, "id": uuid.uuid4().hex[:12], "role": role, "content": content,
           "fix": json.dumps(fix, default=str) if fix else "", "cost": float(cost), "created_at": _now()}
    client = await get_client()
    await client.insert(CHATS, [[row[c] for c in _COLS]], column_names=_COLS, settings={"async_insert": 0})
    return row


def thinking(target: str) -> bool:
    return target in _thinking


async def ask(target: str, text: str) -> dict[str, Any]:
    """Save the developer's message and answer it in the background (the UI follows along)."""
    text = (text or "").strip()[:MAX_MESSAGE]
    if not text:
        raise ValueError("write a message first")
    d = await diagnose.get_diagnosis(target)
    if not d or d["status"] != "done":
        raise ValueError("diagnose this first")
    if target in _thinking:
        raise RuntimeError("still answering the last message")
    _thinking.add(target)
    try:
        msg = await _add(target, "user", text)
    except Exception:
        _thinking.discard(target)
        raise
    task = asyncio.get_running_loop().create_task(_answer(target, d))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return msg


async def _context(d: dict[str, Any]) -> tuple[str, dict[str, str], str]:
    """The run + diagnosis + code as the model's briefing; the full text of the files shown; a code note."""
    from . import projects
    r, target = d["result"], d["target"]
    issue = await diagnose.get_issue(target[6:]) if target.startswith("issue:") else None
    parts: list[str] = []
    spans = await queries.get_trace(r["trace_id"]) if r.get("trace_id") else []
    if spans:
        focus_id = (r.get("focus") or {}).get("span_id")
        parts.append(diagnose._run_context(spans, diagnose.focus_span(spans, focus_id), issue, d.get("note", "")))
    else:
        parts.append("## The run\n(no longer stored — rely on the diagnosis below)")
    fix = r.get("fix") or {}
    current = [{"path": c["path"], "edits": c.get("edits") or []} for c in fix.get("changes") or []]
    parts.append("## Your diagnosis\n" + json.dumps({
        "title": r.get("title"), "summary": r.get("summary"), "root_cause": r.get("root_cause"),
        "evidence": r.get("evidence"), "confidence": r.get("confidence"), "verify": r.get("verify")}, indent=1))
    parts.append("## The current proposed fix\n" + json.dumps({"explanation": fix.get("explanation", ""),
                                                                "changes": current}, indent=1))
    files: dict[str, str] = {}
    note = ""
    paths = list(dict.fromkeys([f["path"] for f in r.get("files") or []] + [c["path"] for c in current]))
    proj = await projects.get(d["project"])
    try:
        gh = await github.config_for_project(proj) if paths else None
    except Exception as exc:  # noqa: BLE001 — discuss without code, and say why
        gh, note = None, f" (the code couldn't be read: {github.explain(exc)})"
    shown, total = [], 0
    for p in paths if gh and gh.get("token") else []:
        try:
            text = await asyncio.to_thread(github.read, gh, p)
        except Exception as exc:  # noqa: BLE001
            logger.info("fix chat: could not read %s: %s", p, exc)
            continue
        files[p] = text
        lines = next((f.get("lines") or [] for f in r.get("files") or [] if f["path"] == p), [])
        win = diagnose._window(text, lines, min(diagnose.MAX_FILE_CHARS, diagnose.MAX_CODE_CHARS - total))
        if not win:
            break
        total += len(win)
        shown.append(f"### {p}\n```\n{win}\n```")
    if shown:
        parts.append(f"## Source files (latest {gh['repo']})\n" + "\n\n".join(shown))
    elif paths and not note:
        note = " (the code isn't available — connect GitHub in Settings to discuss exact edits)"
    return "\n\n".join(parts), files, note


async def _answer(target: str, d: dict[str, Any]) -> None:
    from . import projects
    try:
        proj = await projects.get(d["project"])
        cfg = judge.config_for(proj)
        if cfg is None:
            raise RuntimeError("no model to answer with — add an API key under Settings › AI model")
        briefing, files, note = await _context(d)
        history = (await messages(target, d["created_at"]))[-MAX_HISTORY:]
        msgs = [{"role": "system", "content": SYSTEM.format(code_note=note)},
                {"role": "user", "content": briefing + "\n\nThe developer's questions follow."},
                {"role": "assistant", "content": '{"reply": "Understood — ask away.", "fix": null}'}]
        for m in history:
            if m["role"] == "user":
                msgs.append({"role": "user", "content": m["content"]})
            elif m["role"] == "assistant":
                msgs.append({"role": "assistant", "content": json.dumps({"reply": m["content"], "fix": m["fix"]})})
        text, cost = await asyncio.to_thread(judge._call, msgs, cfg, max_tokens=8000, timeout=240, title="imagent fix chat")
        reply, fix = parse(text, files)
        await _add(target, "assistant", reply, fix=fix, cost=cost)
    except Exception as exc:  # noqa: BLE001 — show the failure in the conversation
        logger.warning("fix chat %s failed: %s", target, exc)
        await _add(target, "error", f"Couldn't answer: {exc}"[:600])
    finally:
        _thinking.discard(target)


def parse(text: str, files: dict[str, str]) -> tuple[str, dict[str, Any] | None]:
    """The reply and, if any, the revised fix with its diffs checked against the code."""
    try:
        out = diagnose._json(text, "reply")
    except ValueError:
        return text.strip()[:8000] or "(empty reply)", None
    reply = str(out.get("reply") or "").strip()[:8000] or "(empty reply)"
    raw = out.get("fix")
    if not isinstance(raw, dict):
        return reply, None
    changes = [c for c in (diagnose.build_change(ch, files) for ch in raw.get("changes") or []) if c]
    if not changes and not raw.get("explanation"):
        return reply, None
    return reply, {"explanation": str(raw.get("explanation", ""))[:4000], "changes": changes}


async def adopt(target: str, message_id: str) -> dict[str, Any]:
    """Make a revised fix from the conversation the diagnosis's fix."""
    d = await diagnose.get_diagnosis(target)
    if not d or d["status"] != "done":
        raise ValueError("diagnose this first")
    r = d["result"]
    if r.get("fix_branch"):
        fb = r["fix_branch"]
        raise ValueError(f"A PR is already open for this fix (#{fb.get('pr_number')}) — push changes to its branch "
                         f"{fb.get('branch')} on GitHub, or close it and diagnose again.")
    m = next((m for m in await messages(target, d["created_at"]) if m["id"] == message_id), None)
    if not m or not m.get("fix"):
        raise ValueError("that message has no revised fix")
    result = r | {"fix": m["fix"], "fix_from": {"message": message_id, "at": _now().isoformat()}}
    if "original_fix" not in r:
        result["original_fix"] = r.get("fix")
    await diagnose._save(target, d["project"], "done", result=result, note=d["note"], created_at=d["created_at"])
    return result


def pr_section(history: list[dict[str, Any]], limit: int = 8) -> list[str]:
    """The discussion that shaped the fix, for the PR description."""
    talk = [m for m in history if m["role"] in ("user", "assistant")][-limit:]
    if not talk:
        return []
    def clip(s: str) -> str:
        s = " ".join(s.split())
        return s if len(s) <= 500 else s[:497] + "…"
    return ["### Discussion", *[f"- **{'Developer' if m['role'] == 'user' else 'imagent'}:** {clip(m['content'])}" for m in talk], ""]
