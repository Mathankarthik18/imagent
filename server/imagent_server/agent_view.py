"""Agent view: a run or an issue as one plain-text document a coding agent can read in one go.

A person clicks through a run step by step; a coding agent (Claude Code driving the browser, or
anything that fetches a page) should get everything that matters from a single read: the request,
the answer, every step, the failures in full with their stack traces, each tool call's input and
output, and the issue and diagnosis the run belongs to. Long payloads keep their start and end.
"""

from __future__ import annotations

import json
from typing import Any

from . import compare, diagnose, queries
from .db import query
from .rules import SIGNALS

MAX_TOOL_CALLS = 40      # tool calls shown with their input and output
TOOL_IO = 1500           # characters kept of each tool input / output
FAILED_IO = 5000         # … of a failed step's input / output
STACK = 6000             # … of a stack trace
TEXT = 4000              # … of the request and the final answer


def clip(text: Any, n: int) -> str:
    """Keep the start and the end — the end of an error or a tool result is often what matters."""
    t = text if isinstance(text, str) else json.dumps(text, default=str)
    t = (t or "").strip()
    if len(t) <= n:
        return t
    head = int(n * 0.6)
    return f"{t[:head]}\n…[{len(t) - n} characters cut]…\n{t[-(n - head):]}"


def _block(text: str) -> str:
    """Fence that can't be closed by the content."""
    fence = "````" if "```" in text else "```"
    return f"{fence}\n{text or '(empty)'}\n{fence}"


def _ms(v: Any) -> str:
    ms = float(v or 0)
    return f"{ms / 1000:.2f}s" if ms >= 1000 else f"{ms:.0f}ms"


def _link(base: str, project: str, path: str, agent: bool = False) -> str:
    return f"{base.rstrip('/')}/p/{project}/{path}{'?view=agent' if agent else ''}"


def _stack(span: dict[str, Any]) -> str:
    for e in span.get("events") or []:
        st = (e.get("attributes") or {}).get("exception.stacktrace")
        if st:
            return str(st)
    return ""


async def _issues_for_trace(trace_id: str) -> list[dict[str, Any]]:
    ids = [r["issue_id"] for r in await query(
        f"SELECT DISTINCT issue_id FROM {SIGNALS} FINAL WHERE trace_id = {{t:String}} AND issue_id != ''",
        {"t": trace_id})]
    rows = await query(f"SELECT id FROM {diagnose.ISSUES} FINAL WHERE has(trace_ids, {{t:String}})", {"t": trace_id})
    ids += [r["id"] for r in rows if r["id"] not in ids]
    out = []
    for i in ids[:5]:
        issue = await diagnose.get_issue(i)
        if issue:
            out.append(issue)
    return out


def _diagnosis_text(d: dict[str, Any] | None, heading: str = "##") -> str:
    if not d:
        return f"{heading} Diagnosis\nNot diagnosed yet (open the issue and press Diagnose)."
    if d["status"] == "running":
        return f"{heading} Diagnosis\nRunning now."
    if d["status"] == "error":
        return f"{heading} Diagnosis\nFailed: {d.get('error', '')}"
    r = d["result"]
    parts = [f"{heading} Diagnosis — {r.get('title', '')}",
             f"Category: {r.get('category', '')} · confidence: {r.get('confidence', '')} · model: {r.get('model', '')}"
             + (f" · code: {r['repo']['repo']}@{r['repo']['branch']} {r['repo']['commit']}" if r.get("repo") else ""),
             f"\n**Summary:** {r.get('summary', '')}",
             f"\n**Root cause:**\n{r.get('root_cause', '')}"]
    if r.get("evidence"):
        parts.append("\n**Evidence:**\n" + "\n".join(f"- {e}" for e in r["evidence"]))
    fix = r.get("fix") or {}
    parts.append(f"\n**Suggested fix**{' (revised in discussion)' if r.get('fix_from') else ''}:\n{fix.get('explanation', '') or '(none)'}")
    for c in fix.get("changes") or []:
        state = "applies cleanly" if c.get("applies") else "needs adjusting" if c.get("applies") is False else ""
        parts.append(f"\nChange to `{c.get('path', '')}`{' — ' + state if state else ''}:\n" + _block(clip(c.get("diff", ""), 8000)))
    if r.get("files"):
        parts.append("\nFiles read: " + ", ".join(f["path"] for f in r["files"]))
    if r.get("verify"):
        parts.append(f"\n**How to check the fix:**\n{r['verify']}")
    if r.get("fix_branch"):
        fb = r["fix_branch"]
        parts.append(f"\nFix PR: #{fb.get('pr_number')} {fb.get('pr_url', '')} (branch {fb.get('branch', '')})")
    if r.get("code_error"):
        parts.append(f"\nNote: {r['code_error']}")
    return "\n".join(parts)


async def trace_text(trace_id: str, base: str = "", *, with_issues: bool = True, tool_calls: int = MAX_TOOL_CALLS) -> str | None:
    spans = await queries.get_trace(trace_id)
    if not spans:
        return None
    root = compare.agent_span(spans) or spans[0]
    project = root.get("project", "")
    errors = [s for s in spans if s.get("status") == "error"]
    tools = [s for s in spans if s.get("kind") == "tool"]
    llms = [s for s in spans if s.get("kind") == "llm"]
    tokens = sum(int(s.get("input_tokens") or 0) + int(s.get("output_tokens") or 0) for s in llms)
    cost = sum(float(s.get("cost_usd") or 0) for s in spans)
    out = [f"# imagent run {trace_id}",
           "",
           "This is imagent's agent view of one run of an AI agent app: everything in one page, for a coding agent.",
           f"Human view: {_link(base, project, 'traces/' + trace_id)}",
           "",
           f"- Agent: {root.get('agent_name') or root.get('name', '')}",
           f"- Status: {'FAILED — ' + str(len(errors)) + ' step(s) errored' if errors else 'ok'}",
           f"- Started: {root.get('start_time')} · took {_ms(root.get('duration_ms'))}",
           f"- {len(spans)} steps · {len(llms)} model calls · {len(tools)} tool calls · {tokens:,} tokens · ${cost:.4f}",
           ]
    if root.get("thread_id"):
        out.append(f"- Conversation (thread): {root['thread_id']}")
    if root.get("user_id"):
        out.append(f"- User: {root['user_id']}")
    models = sorted({s.get("model") for s in llms if s.get("model")})
    if models:
        out.append(f"- Models: {', '.join(models)}")

    request = compare.readable(root.get("input", ""), roles=("user", "human"))
    out += ["", "## Request", clip(request, TEXT) or "(not captured)",
            "", "## Final answer", clip(diagnose.final_answer(spans, root), TEXT) or "(none — the run failed or was cut off)"]

    if errors:
        out += ["", f"## Failed steps ({len(errors)})"]
        for n, s in enumerate(errors, 1):
            out += ["", f"### {n}. [{s.get('kind') or 'step'}] {s['name']} — {_ms(s.get('duration_ms'))}",
                    f"Error: {s.get('status_message') or '(no message)'}",
                    "Input:", _block(clip(s.get("input", ""), FAILED_IO)),
                    "Output:", _block(clip(s.get("output", ""), FAILED_IO))]
            st = _stack(s)
            if st:
                out += ["Stack trace:", _block(clip(st, STACK))]

    out += ["", "## Steps (in order; children indented)", _block(diagnose.outline(spans, errors[0] if errors else None, max_lines=400))]

    if tools:
        shown = tools[:tool_calls]
        out += ["", f"## Tool calls ({len(tools)}{f', first {len(shown)} shown' if len(shown) < len(tools) else ''})"]
        for n, s in enumerate(shown, 1):
            flag = " — ERROR" if s.get("status") == "error" else ""
            out += ["", f"### {n}. {s['name']} — {_ms(s.get('duration_ms'))}{flag}",
                    "Input:", _block(clip(s.get("input", ""), TOOL_IO)),
                    "Output:", _block(clip(s.get("output", ""), TOOL_IO))]

    if with_issues:
        issues = await _issues_for_trace(trace_id)
        if issues:
            out += ["", f"## Issues this run is part of ({len(issues)})"]
            for i in issues:
                out += ["", f"### {i['title']}",
                        f"{i['kind']} · severity {i.get('severity', '')} · {i['status']} · {i['runs']} runs affected · "
                        f"agent view: {_link(base, project, 'issues/' + i['id'], agent=True)}",
                        _diagnosis_text(await diagnose.get_diagnosis(f"issue:{i['id']}"), heading="####")]
        d = await diagnose.get_diagnosis(f"trace:{trace_id}")
        if d:
            out += ["", _diagnosis_text(d, heading="## Run")]
    return "\n".join(out) + "\n"


async def issue_text(issue_id: str, base: str = "") -> str | None:
    from . import fix_chat, investigator
    i = await diagnose.get_issue(issue_id)
    if not i:
        return None
    project = i["project"]
    out = [f"# imagent issue {issue_id}: {i['title']}",
           "",
           "This is imagent's agent view of an issue: a problem that keeps happening in an AI agent app's production runs.",
           f"Human view: {_link(base, project, 'issues/' + issue_id)}",
           "",
           f"- Kind: {i['kind']} · severity: {i.get('severity', '')} · status: {i['status']}",
           f"- Where: {i.get('location', '')}{' · agent ' + i['agent'] if i.get('agent') else ''}",
           f"- {i['runs']} runs affected · {i.get('failed_runs', 0)} failed · {i.get('events', 0)} occurrences · "
           f"first seen {i['first_seen']} · last seen {i['last_seen']}"]
    if i.get("message"):
        out += ["", "## What was detected", clip(i["message"], TEXT)]
    if i.get("status_reason"):
        out.append(f"\nStatus note: {i['status_reason']}")
    d = await diagnose.get_diagnosis(f"issue:{issue_id}")
    out += ["", _diagnosis_text(d)]
    if d and d.get("status") == "done":
        talk = [m for m in await fix_chat.messages(f"issue:{issue_id}", d["created_at"]) if m["role"] != "error"]
        if talk:
            out += ["", "## Discussion about the fix"]
            out += [f"- **{'Developer' if m['role'] == 'user' else 'imagent'}:** {clip(m['content'], 1500)}" for m in talk[-12:]]
    ev = await investigator.evidence(issue_id, limit=20)
    if ev:
        out += ["", f"## Affected runs ({len(ev)} shown)"]
        out += [f"- {e['start_time']} · {e['trace_id']} · {clip(e.get('note') or e.get('detail') or '', 300)} · "
                f"agent view: {_link(base, project, 'traces/' + e['trace_id'], agent=True)}" for e in ev]
    elif i.get("trace_ids"):
        out += ["", "## Affected runs"]
        out += [f"- {t} · agent view: {_link(base, project, 'traces/' + t, agent=True)}" for t in i["trace_ids"]]
    latest = (ev[0]["trace_id"] if ev else (i.get("trace_ids") or [None])[0])
    if latest:
        run = await trace_text(latest, base, with_issues=False, tool_calls=15)
        if run:
            out += ["", "---", "", "## The latest affected run, in full", "", run.replace("\n# imagent run", "\n### imagent run", 1)]
    return "\n".join(out) + "\n"
