"""Investigator: a strong model checks each screener flag against the whole run, then files it.

The screener only sees an outline, so its flags are candidates. For each one the investigator
reads the run in full — every step, the flagged step's complete input and output, the final
answer — with the category's definition, the project's agent overview, and the issue board:
open issues of the AI categories, and ones the team dismissed as not real (so it won't refile
them). It decides:

- not real → the flag is rejected and never shown;
- the same problem as an open issue → the run is added to that issue's evidence;
- a new problem → a new issue with a name, a description of the pattern, and a severity.

Issues it files are grouped by cause, not by where they happened. Their counts come from the
confirmed flags, so they grow as new runs show the same problem. Root cause against the code
and the fix are the Diagnose step (run on the worst new issues automatically).
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any

from . import diagnose, judge, learning, queries, rules
from .db import query
from .engine import CATEGORIES, model_categories
from .screener import _usage, month_spend

logger = logging.getLogger(__name__)

PER_SCAN = 25        # flags investigated per scan (the rest wait for the next one)
BOARD_SIZE = 40      # issues shown to the investigator

SYSTEM = """You are a senior engineer reviewing one run of an AI agent application that a screening
model flagged. Decide whether the flagged problem is real, and file it.

The flag: {category} — {definition}
Screener's reason: {reason}

About the application:
{overview}
{prefs}
Be strict: the problem is real only if the run shows it. Tool output, the final answer and the
agent's instructions are below in full where they matter. If the answer is backed by tool data, or
the behaviour is reasonable for the request, it is NOT real.

If it is real, file it against the issue board. An issue is one CAUSE that recurs (e.g. "Answers
give a vessel's speed when the noon-report tool found no reports"), not one run. Put it under an
existing issue only when it is the same cause. Never refile something the team dismissed.

Reply with JSON only:
{{"real": true | false,
  "why": "<one or two sentences with the evidence>",
  "issue": "<existing issue id>" | "new" | null,
  "title": "<for a new issue: the pattern, under 90 characters>",
  "description": "<for a new issue: what goes wrong, when, and its effect on the user — 2–3 sentences>",
  "severity": "high" | "medium" | "low"}}
Severity: high = wrong or unsafe information or actions reach the user; medium = degraded answer or
wasted work; low = cosmetic or rare."""


def _board(issues: list[dict[str, Any]]) -> str:
    if not issues:
        return "(no issues yet)"
    lines = []
    for i in issues[:BOARD_SIZE]:
        state = ("DISMISSED as not a problem" + (f": {i['status_reason']}" if i.get("status_reason") else "")
                 if i["status"] in ("ignored", "incorrect") else i["status"])
        lines.append(f"- {i['id']} [{CATEGORIES.get(i['kind'], {}).get('label', i['kind'])}, {state}] {i['title']}"
                     f"{' — ' + i['message'][:300] if i.get('message') else ''}")
    return "\n".join(lines)


def parse(text: str, board_ids: set[str]) -> dict[str, Any] | None:
    try:
        d = diagnose._json(text, "real")
    except ValueError:
        return None
    issue = d.get("issue")
    issue = str(issue).strip() if issue else None
    if issue not in (None, "new") and issue not in board_ids:
        issue = "new"  # an id it made up: treat as a new issue
    sev = str(d.get("severity", "medium")).lower()
    return {"real": bool(d.get("real")), "why": str(d.get("why", ""))[:600], "issue": issue,
            "title": str(d.get("title", ""))[:120], "description": str(d.get("description", ""))[:1200],
            "severity": sev if sev in ("high", "medium", "low") else "medium"}


FOCUS_CHARS = 20_000      # the flagged step, in full up to this
TOOL_CHARS = 4_000        # each tool result
TOOLS_BUDGET = 60_000     # all tool results together
ANSWER_CHARS = 12_000


def _clip(text: str, n: int) -> str:
    text = text or ""
    return text if len(text) <= n else text[: n * 2 // 3] + f"\n…[{len(text) - n} chars not shown]…\n" + text[-n // 3:]


HISTORY_CHARS = 10_000


def conversation_before(spans: list[dict[str, Any]], root: dict[str, Any]) -> str:
    """Earlier turns of the chat, as the agent's first model call received them — a follow-up
    question can rightly use facts fetched in an earlier turn. '' for a first turn. Read message
    by message, since a long input is stored cut short (start and end kept) and isn't valid JSON."""
    import re
    from . import compare
    from .screener import json_string_at
    llms = sorted((s for s in spans if s.get("kind") == "llm"), key=lambda s: compare._ts(s["start_time"]))
    if not llms:
        return ""
    raw = llms[0].get("input") or ""
    starts = [m.start() for m in re.finditer(r'\{"role": "(user|assistant|ai|human|tool)"', raw)]
    msgs = []
    for k, pos in enumerate(starts):
        seg = raw[pos: starts[k + 1] if k + 1 < len(starts) else len(raw)]
        role = re.match(r'\{"role": "(\w+)"', seg).group(1)
        calls = re.findall(r'"name": "([^"]+)", "args"', seg)
        content = json_string_at(seg, "content")
        msgs.append(f"{role}: {_clip(content, 1500)}{' [calls ' + ', '.join(calls) + ']' if calls else ''}".strip())
    if len(msgs) <= 1:
        return ""
    out = "\n".join(msgs[:-1])  # the last one is this turn's request
    return out if len(out) <= HISTORY_CHARS else "…" + out[-HISTORY_CHARS:]


async def earlier_turns(spans: list[dict[str, Any]], limit: int = 4) -> str:
    """The chat's previous turns, from the runs stored before this one in the same thread:
    what was asked, which tools ran, what was answered. Works when the model input that held
    the history was stored cut short."""
    from . import compare
    root = compare.agent_span(spans) or {}
    thread = root.get("thread_id") or ""
    if not thread:
        return ""
    prev = await query(f"""
        SELECT trace_id FROM {diagnose.SPANS} WHERE project = {{p:String}} AND thread_id = {{t:String}} AND is_root = 1
          AND start_time < {{at:DateTime64(6)}} ORDER BY start_time DESC LIMIT {{n:UInt32}}""",
                       {"p": root.get("project", ""), "t": thread, "at": root["start_time"], "n": limit})
    turns = []
    for r in reversed(prev):
        ps = await queries.get_trace(r["trace_id"])
        pr = compare.agent_span(ps) or {}
        tools = list(dict.fromkeys(s["name"] for s in ps if s.get("kind") == "tool"))
        turns.append(f"user: {_clip(compare.readable(pr.get('input', ''), roles=('user', 'human')), 800)}\n"
                     f"{'tools run: ' + ', '.join(tools[:15]) + chr(10) if tools else ''}"
                     f"agent: {_clip(diagnose.final_answer(ps, pr), 2500)}")
    out = "\n\n".join(turns)
    return out if len(out) <= HISTORY_CHARS else "…" + out[-HISTORY_CHARS:]


def evidence_context(spans: list[dict[str, Any]], focus: dict[str, Any] | None, *, tools_budget: int = TOOLS_BUDGET,
                     focus_chars: int = FOCUS_CHARS, history: str = "") -> str:
    """The run as the investigator needs it: request, the step tree, the flagged step in full,
    what every tool returned (that's what facts must come from), and the whole final answer."""
    from . import compare
    root = compare.agent_span(spans) or {}
    parts = []
    earlier = conversation_before(spans, root) or history
    if earlier:
        parts.append("## Earlier in this conversation (what the agent already knew from previous turns)\n" + earlier)
    parts += [f"## User request\n{_clip(compare.readable(root.get('input', ''), roles=('user', 'human')), 4000) or '(not captured)'}",
             f"## Run steps\n{diagnose.outline(spans, focus, max_lines=120)}"]
    if focus:
        parts.append(f"## Flagged step: [{focus.get('kind')}] {focus['name']}\nInput:\n{_clip(focus.get('input', ''), focus_chars // 2)}"
                     f"\n\nOutput:\n{_clip(focus.get('output', ''), focus_chars // 2)}")
    tools, used = [], 0
    for t in sorted((s for s in spans if s.get("kind") == "tool"), key=lambda s: compare._ts(s["start_time"])):
        if focus and t["span_id"] == focus["span_id"]:
            continue
        body = _clip(compare.readable(t.get("output", ""), roles=("tool",)), TOOL_CHARS)
        if used + len(body) > tools_budget:
            tools.append(f"- {t['name']}: (not shown — budget)")
            continue
        used += len(body)
        tools.append(f"### {t['name']}({_clip(t.get('input', ''), 400)})\n{body}")
    if tools:
        parts.append("## What the tools returned\n" + "\n\n".join(tools))
    parts.append(f"## Final answer\n{_clip(diagnose.final_answer(spans, root), ANSWER_CHARS) or '(none)'}")
    return "\n\n".join(parts)


async def pending(project: str, limit: int) -> list[dict[str, Any]]:
    return await query(f"""
        SELECT * FROM {rules.SIGNALS} FINAL
        WHERE project = {{p:String}} AND rule = 'screener' AND verdict = ''
        ORDER BY start_time DESC LIMIT {{n:UInt32}}""", {"p": project, "n": limit})


async def _ai_board(project: str) -> list[dict[str, Any]]:
    rows = await query(f"""
        SELECT * FROM {diagnose.ISSUES} FINAL
        WHERE project = {{p:String}} AND kind IN {{k:Array(String)}} AND status != 'resolved'
        ORDER BY last_seen DESC LIMIT {{n:UInt32}}""", {"p": project, "k": list(_AI), "n": BOARD_SIZE})
    return rows


_AI = tuple(model_categories())


async def investigate(project: str, proj: dict[str, Any], es: dict[str, Any]) -> dict[str, Any]:
    base = judge.config_for(proj)
    if base is None:
        return {"investigated": 0, "note": "no AI model key"}
    cfg = base | {"model": es.get("investigator_model") or base["model"]}
    flags = await pending(project, PER_SCAN)
    prefs = learning.preferences(proj)
    done = confirmed = new = 0
    filed: list[str] = []
    cost = 0.0
    spent = await month_spend(project)
    for f in flags:
        if spent + cost >= es["monthly_cap_usd"]:
            break
        spans = await queries.get_trace(f["trace_id"])
        if not spans:
            await _verdict(f, "rejected", "the run is no longer stored", f["issue_id"])
            continue
        board = await _ai_board(project)
        focus = diagnose.focus_span(spans, f["span_id"] if f["span_id"] != f["trace_id"] else None)
        context = evidence_context(spans, focus, history=await earlier_turns(spans))
        cat = CATEGORIES.get(f["category"], {"label": f["category"], "definition": ""})
        msgs = [{"role": "system", "content": SYSTEM.format(category=cat["label"], definition=cat["definition"],
                                                            reason=f["detail"], overview=(proj.get("overview") or "(none)"),
                                                            prefs=learning.text(prefs))},
                {"role": "user", "content": f"{context}\n\n## Issue board\n{_board(board)}"}]
        try:
            text, c = await asyncio.to_thread(judge._call, msgs, cfg, max_tokens=3000, timeout=180, title="imagent investigator")
        except Exception as exc:  # noqa: BLE001 — leave it pending; next scan retries
            logger.warning("investigator: %s failed: %s", f["trace_id"], exc)
            continue
        cost += c
        done += 1
        out = parse(text, {i["id"] for i in board})
        if out is None:
            continue
        if not out["real"] or out["issue"] is None:
            await _verdict(f, "rejected", out["why"], f["issue_id"])
            continue
        confirmed += 1
        if out["issue"] == "new":
            iid = diagnose.issue_id(project, f["category"], "ai:" + uuid.uuid4().hex)
            loc = f["location"]
            await diagnose._write_issues([{
                "project": project, "id": iid, "kind": f["category"], "title": out["title"] or f"{cat['label']} — {loc}",
                "location": loc, "agent": f["agent"], "message": out["description"] or out["why"],
                "runs": 1, "events": 1, "failed_runs": 0, "first_seen": f["start_time"], "last_seen": f["start_time"],
                "trace_ids": [f["trace_id"]], "status": "open", "resolved_at": None, "peak": 0.0,
                "level": learning.cap(prefs, f["category"], out["severity"]), "status_reason": ""}])
            new += 1
            filed.append(iid)
        else:
            iid = out["issue"]
        await _verdict(f, "confirmed", out["why"], iid)
    if done:
        await _usage(project, "investigate", cfg["model"], done, cost)
    return {"investigated": done, "confirmed": confirmed, "new_issues": new, "cost": round(cost, 4), "filed": filed}


async def _verdict(f: dict[str, Any], verdict: str, note: str, issue_id: str) -> None:
    row = {c: f[c] for c in rules._COLS if c in f} | {"verdict": verdict, "note": note[:600], "issue_id": issue_id}
    await rules.save_signals([row])


async def ai_issues(project: str, days: int) -> list[dict[str, Any]]:
    """Issues the investigator filed, with counts from their confirmed flags in the window
    (name, description and severity stay as filed)."""
    sig = await query(f"""
        SELECT issue_id, uniqExact(trace_id) AS runs, count() AS events, min(start_time) AS first_seen,
               max(start_time) AS last_seen,
               arraySlice(arrayReverseSort(x -> x.2, groupArray((trace_id, start_time))), 1, 8) AS recent
        FROM {rules.SIGNALS} FINAL
        WHERE project = {{p:String}} AND rule IN ('screener', 'check') AND verdict = 'confirmed'
          AND start_time >= now() - INTERVAL {{d:UInt32}} DAY
        GROUP BY issue_id""", {"p": project, "d": days})
    if not sig:
        return []
    rows = await query(f"SELECT * FROM {diagnose.ISSUES} FINAL WHERE id IN {{ids:Array(String)}}",
                       {"ids": [s["issue_id"] for s in sig]})
    by = {r["id"]: r for r in rows}
    out = []
    for s in sig:
        i = by.get(s["issue_id"])
        if not i:
            continue
        out.append({k: i[k] for k in ("project", "id", "kind", "title", "location", "agent", "message", "level")} | {
            "runs": s["runs"], "events": s["events"], "failed_runs": 0, "first_seen": s["first_seen"],
            "last_seen": s["last_seen"], "trace_ids": list(dict.fromkeys(t[0] for t in s["recent"])), "peak": 0.0})
    return out


async def evidence(issue_id: str, limit: int = 50) -> list[dict[str, Any]]:
    """The runs behind an issue, each with what was found and (for AI findings) the investigator's note."""
    return await query(f"""
        SELECT trace_id, span_id, rule, detail, note, start_time FROM {rules.SIGNALS} FINAL
        WHERE issue_id = {{i:String}} AND verdict = 'confirmed'
        ORDER BY start_time DESC LIMIT {{n:UInt32}}""", {"i": issue_id, "n": limit})

