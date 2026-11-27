"""Rule checks: issue categories found from the trace data alone, on every run, with no model.

- Context explosion: a model call that reads more tokens than the project's limit (grouped by
  agent), and a tool that returns more text than the limit (grouped by tool). A tool's real
  output size counts what the SDK cut off ("…[truncated N chars]…").
- Guardrail bypass: a tool the project marked as needing approval that really ran (not
  refused, not rejected) with no approval recorded before it — neither in the same run nor
  earlier in the same conversation. Approvals are recorded by the SDK (a run paused for a
  person → ``imagent.interrupt``; the resumed run → ``imagent.resume``), so runs from before
  the app's SDK recorded approvals are not judged.

Each finding is a signal on one step of one run (stored, so later stages and the trace view
can use them) and the signals are grouped into issues on the Issues board.
"""

from __future__ import annotations

import json
import re
from typing import Any

from .db import DB, SPANS, get_client, query

SIGNALS = f"{DB}.signals"

DDL = [
    f"""
    CREATE TABLE IF NOT EXISTS {SIGNALS} (
        project     String,
        trace_id    String,
        span_id     String,
        category    LowCardinality(String),
        rule        LowCardinality(String),
        issue_id    String,
        location    String,
        agent       String,
        thread_id   String,
        value       Float64,
        detail      String,
        start_time  DateTime64(6, 'UTC'),
        inserted_at DateTime64(3, 'UTC') DEFAULT now64(3)
    ) ENGINE = ReplacingMergeTree(inserted_at)
    ORDER BY (project, trace_id, span_id, rule)
    TTL toDateTime(start_time) + INTERVAL 90 DAY
    """,
    # verdict: '' waiting for the investigator (screener findings), 'confirmed', 'rejected'
    f"ALTER TABLE {SIGNALS} ADD COLUMN IF NOT EXISTS verdict LowCardinality(String) DEFAULT ''",
    f"ALTER TABLE {SIGNALS} ADD COLUMN IF NOT EXISTS note String DEFAULT ''",
]

_COLS = ["project", "trace_id", "span_id", "category", "rule", "issue_id", "location", "agent", "thread_id",
         "value", "detail", "start_time", "verdict", "note"]

# Output of a guarded tool that did NOT do the action: refused by policy, or a person said no.
_REFUSED = re.compile(r"permission_denied|not_approved|was rejected|nothing was done|requires approval", re.I)
_APPROVE = re.compile(r"\bapprove", re.I)


def _id(project: str, kind: str, key: str) -> str:
    from .diagnose import issue_id
    return issue_id(project, kind, key)


def _fmt(n: float) -> str:
    return f"{n / 1_000_000:.1f}M" if n >= 1_000_000 else f"{n / 1000:.0f}k" if n >= 1000 else f"{n:.0f}"


async def context_explosion(project: str, days: int, cfg: dict[str, Any]) -> tuple[list[dict], list[dict]]:
    """(issues, signals) for model calls and tool outputs over the project's limits."""
    params = {"p": project, "days": days, "tok": int(cfg["context_tokens_limit"]), "chars": int(cfg["tool_output_chars_limit"])}
    calls = await query(f"""
        SELECT trace_id, span_id, agent_name, thread_id, model, input_tokens AS value, start_time
        FROM {SPANS}
        WHERE project = {{p:String}} AND origin = '' AND kind = 'llm' AND input_tokens > {{tok:UInt64}}
          AND start_time >= now() - INTERVAL {{days:UInt32}} DAY
        ORDER BY start_time DESC LIMIT 5000""", params)
    outputs = await query(f"""
        SELECT trace_id, span_id, name, agent_name, thread_id, value, start_time FROM (
            SELECT trace_id, span_id, name, agent_name, thread_id, start_time,
                   length(output) + toUInt64OrZero(extract(output, 'truncated (\\\\d+) chars')) AS value
            FROM {SPANS}
            WHERE project = {{p:String}} AND origin = '' AND kind = 'tool'
              AND start_time >= now() - INTERVAL {{days:UInt32}} DAY)
        WHERE value > {{chars:UInt64}}
        ORDER BY start_time DESC LIMIT 5000""", params)
    signals: list[dict] = []
    for c in calls:
        where = c["agent_name"] or c["model"] or "model call"
        signals.append(_signal(project, c, "context_explosion", "big_context", "ctx-model:" + where, where,
                               c["value"], f"model call read {_fmt(c['value'])} tokens (limit {_fmt(cfg['context_tokens_limit'])})"))
    for o in outputs:
        signals.append(_signal(project, o, "context_explosion", "big_tool_output", "ctx-tool:" + o["name"], o["name"],
                               o["value"], f"{o['name']} returned {_fmt(o['value'])} characters (limit {_fmt(cfg['tool_output_chars_limit'])})"))
    limits = {"big_context": cfg["context_tokens_limit"], "big_tool_output": cfg["tool_output_chars_limit"]}
    issues = _group(project, signals, title=lambda key, loc, worst, rule: (
        f"Model calls in {loc} read up to {_fmt(worst)} tokens" if rule == "big_context"
        else f"{loc} returns up to {_fmt(worst)} characters into the context"), limits=limits)
    return issues, signals


async def guardrail_bypass(project: str, days: int, cfg: dict[str, Any]) -> tuple[list[dict], list[dict], dict[str, Any]]:
    """(issues, signals, status) for guarded tools that ran with no approval recorded."""
    tools = cfg.get("guarded_tools") or []
    if not tools:
        return [], [], {"guardrail": "no tools marked as needing approval"}
    since_rows = await query(f"""
        SELECT min(start_time) AS since FROM {SPANS}
        WHERE project = {{p:String}} AND (attributes['imagent.interrupt'] != '' OR attributes['imagent.resume'] != '')""",
                             {"p": project})
    since = since_rows[0]["since"] if since_rows else None
    if not since or since.year < 2000:
        return [], [], {"guardrail": "waiting for approval data — restart the app with the current SDK"}
    params = {"p": project, "days": days, "tools": tools, "since": since}
    ran = await query(f"""
        SELECT trace_id, span_id, name, agent_name, thread_id, start_time, input, output
        FROM {SPANS}
        WHERE project = {{p:String}} AND origin = '' AND kind = 'tool' AND name IN {{tools:Array(String)}}
          AND status = 'ok' AND attributes['imagent.interrupt'] = ''
          AND start_time >= greatest(now() - INTERVAL {{days:UInt32}} DAY, {{since:DateTime64(6)}})
        ORDER BY start_time LIMIT 5000""", params)
    if not ran:
        return [], [], {"guardrail": "ok"}
    approvals = await query(f"""
        SELECT trace_id, thread_id, start_time, attributes['imagent.resume'] AS resume FROM {SPANS}
        WHERE project = {{p:String}} AND attributes['imagent.resume'] != ''
          AND start_time >= {{since:DateTime64(6)}} - INTERVAL 1 DAY""", params)
    signals = []
    for r in find_bypasses(ran, approvals):
        signals.append(_signal(project, r, "guardrail_bypass", "no_approval", "guard:" + r["name"], r["name"], 1,
                               f"{r['name']} ran with no approval recorded in this run or earlier in the conversation"))
    issues = _group(project, signals, title=lambda key, loc, worst, rule: f"{loc} ran without approval")
    return issues, signals, {"guardrail": "ok"}


async def response_truncation(project: str, days: int) -> tuple[list[dict], list[dict]]:
    """Model calls that stopped at their output-token limit (finish reason length / max_tokens)."""
    rows = await query(f"""
        SELECT trace_id, span_id, agent_name, thread_id, model, start_time, output_tokens AS value
        FROM {SPANS}
        WHERE project = {{p:String}} AND origin = '' AND kind = 'llm'
          AND match(lower(attributes['gen_ai.response.finish_reasons']), 'length|max_tokens')
          AND start_time >= now() - INTERVAL {{days:UInt32}} DAY
        ORDER BY start_time DESC LIMIT 5000""", {"p": project, "days": days})
    signals = []
    for r in rows:
        where = r["agent_name"] or r["model"] or "model call"
        signals.append(_signal(project, r, "response_truncation", "hit_token_limit", "trunc:" + where, where, r["value"],
                               f"model call stopped at its output limit after {_fmt(r['value'])} tokens — the answer or tool call was cut off"))
    issues = _group(project, signals, title=lambda key, loc, worst, rule: f"Model output cut off at the token limit in {loc}")
    return issues, signals


# Secrets the agent itself writes — in its messages or in the arguments it sends to tools (never
# the prompts it was given, which can legitimately hold keys).
SECRET_RE = (r"sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16}"
             r"|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|imk_[A-Za-z0-9_-]{20,}"
             r"|-----BEGIN [A-Z ]*PRIVATE KEY-----"
             # the SDK masks secrets before they leave the app — the marker still means the agent wrote one
             r"|\[REDACTED_(?:API_KEY|PRIVATE_KEY|AWS_KEY|GITHUB_TOKEN|SLACK_TOKEN|JWT|CARD)\]|Bearer \[REDACTED\]"
             r"|(?i:password|passwd|pwd)\\?\"?\s*[:=]\s*\\?\"?[^\s\"\\]{6,}")


async def secrets(project: str, days: int) -> tuple[list[dict], list[dict]]:
    """Secrets (API keys, tokens, private keys, passwords) in what the agent wrote or sent."""
    rows = await query(f"""
        SELECT trace_id, span_id, kind, name, agent_name, thread_id, start_time,
               extract(if(kind = 'llm', output, input), {{re:String}}) AS hit
        FROM {SPANS}
        WHERE project = {{p:String}} AND origin = ''
          AND ((kind = 'llm' AND match(output, {{re:String}})) OR (kind = 'tool' AND match(input, {{re:String}})))
          AND start_time >= now() - INTERVAL {{days:UInt32}} DAY
        ORDER BY start_time DESC LIMIT 2000""", {"p": project, "days": days, "re": SECRET_RE})
    signals = []
    for r in rows:
        hit = r["hit"] or ""
        masked = ("a secret (" + hit.strip("[]").replace("REDACTED_", "").replace("_", " ").lower() + ", masked by the SDK)"
                  if "REDACTED" in hit else (hit[:6] + "…") if hit else "a secret")
        if r["kind"] == "tool":
            loc, detail = f"secret sent to {r['name']}", f"the agent passed {masked} to {r['name']}"
        else:
            loc, detail = "secret in answers", f"the agent wrote {masked} in a message"
        signals.append(_signal(project, r, "pii_leak", "secret", "pii:" + loc, loc, 1, detail))
    issues = _group(project, signals, title=lambda key, loc, worst, rule: loc[0].upper() + loc[1:])
    return issues, signals


# ── Leaked working notes ────────────────────────────────────────────────────
# What a person receives (a final answer, or the text of a message a tool sends) that is really the
# agent narrating its own work: "I now have all the data. Let me compose and send the report…".
NARRATION = re.compile(
    r"^\W*(?:(?:great|okay|ok|perfect|alright|good|now|so)[,!.]?\s+)*(?:"
    r"i\s+(?:now\s+)?have\s+(?:all\s+)?(?:the\s+|everything\s+i\s+need|enough\s+)?(?:data|information|info|details|results|context|everything)"
    r"|let\s+me\s+(?:now\s+|first\s+|also\s+)?(?:compose|draft|write|send|prepare|compile|put\s+together|check|look|fetch|get|call|use|search|gather|create|format|summari[sz]e|pull|query|find|review|analy[sz]e|start|begin|try)"
    r"|i(?:'ll|\s+will|\s+am\s+going\s+to|'m\s+going\s+to)\s+(?:now\s+|first\s+)?(?:compose|draft|write|send|prepare|compile|call|use|fetch|check|search|gather|pull|query|look|start|begin|create)"
    r"|now\s+(?:i(?:'ll|\s+will)|let\s+me|i\s+need\s+to)"
    r"|next,?\s+i(?:'ll|\s+will|\s+need\s+to)"
    r"|i\s+need\s+to\s+(?:call|use|check|fetch|look\s+up|gather|query|run)"
    r"|(?:first|step\s*\d+)[,:]\s+i(?:'ll|\s+will)"
    r")", re.I)
TOOL_TALK = re.compile(r"\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+_tool\b|\btool\s+call|\bcall(?:ing)?\s+the\s+\w+\s+tool\b", re.I)
_TEXT_KEYS = ("message", "text", "body", "content", "html", "msg", "caption", "markdown", "summary", "report", "note")
# Cheap pre-filters for ClickHouse (the exact check is is_narration, in Python).
_HAS_TOOL_CALLS = r'"tool_calls"\s*:\s*\[\s*\{'
_NOTE_HINT = (r"(?i)(i (now )?have (all )?(the )?(data|information|details|everything)|let me (now |first )?"
              r"(compose|draft|write|send|prepare|compile|put together|check|look|fetch|get|call|use|search|gather)"
              r"|i('ll| will) (now )?(compose|draft|write|send|prepare|call|use|fetch)|_tool\b)")
MAX_NOTE = 600  # longer than this and it's a real message that merely starts with a phrase like "Let me…"


def message_text(raw: str) -> str:
    """The words a person reads, from a send tool's arguments (or a model message)."""
    raw = raw or ""
    try:
        data = json.loads(raw)
    except ValueError:
        from .screener import json_string_at
        return json_string_at(raw, "content") if raw.lstrip().startswith("{") else raw
    found: list[str] = []

    def walk(v: Any, key: str = "") -> None:
        if isinstance(v, dict):
            for k, x in v.items():
                walk(x, str(k).lower())
        elif isinstance(v, list):
            for x in v:
                walk(x, key)
        elif isinstance(v, str) and (key in _TEXT_KEYS or not key):
            found.append(v)
    walk(data)
    return max(found, key=len) if found else ""


def is_narration(text: str) -> bool:
    t = (text or "").strip()
    if not t or len(t) > MAX_NOTE:
        return False
    return bool(NARRATION.search(t[:300]) or TOOL_TALK.search(t))


async def leaked_narration(project: str, days: int, cfg: dict[str, Any]) -> tuple[list[dict], list[dict]]:
    """Final answers and sent messages that are the agent's working notes, not the content."""
    from .engine import is_message_tool
    params = {"p": project, "days": days}
    sent = await query(f"""
        SELECT trace_id, span_id, name, agent_name, thread_id, start_time, left(input, 20000) AS input
        FROM {SPANS}
        WHERE project = {{p:String}} AND origin = '' AND kind = 'tool' AND status = 'ok'
          AND length(input) < 20000
          AND match(lower(name), 'send|reply|notify|post|message|signal|mail|slack|sms|whatsapp|telegram|teams|broadcast')
          AND start_time >= now() - INTERVAL {{days:UInt32}} DAY
        ORDER BY start_time DESC LIMIT 5000""", params)
    extra = [t for t in cfg.get("message_tools") or [] if t]
    if extra:
        sent += await query(f"""
            SELECT trace_id, span_id, name, agent_name, thread_id, start_time, left(input, 20000) AS input
            FROM {SPANS}
            WHERE project = {{p:String}} AND origin = '' AND kind = 'tool' AND status = 'ok' AND name IN {{t:Array(String)}}
              AND start_time >= now() - INTERVAL {{days:UInt32}} DAY
            ORDER BY start_time DESC LIMIT 2000""", params | {"t": extra})
    signals: list[dict] = []
    seen: set[str] = set()
    for r in sent:
        if r["span_id"] in seen or not is_message_tool(r["name"], cfg):
            continue
        seen.add(r["span_id"])
        text = message_text(r["input"])
        if is_narration(text):
            signals.append(_signal(project, r, "leaked_narration", "narration", "narr:" + r["name"], r["name"], len(text),
                                   f"{r['name']} sent the agent's working notes to a person instead of the message: "
                                   f"“{text.strip()[:200]}”"))
    # Short model messages without tool calls that start like narration — kept only if it's the
    # run's last model message (its answer), not a note before the next step.
    notes = await query(f"""
        SELECT trace_id, span_id, agent_name, thread_id, start_time, end_time, left(output, 4000) AS output
        FROM {SPANS}
        WHERE project = {{p:String}} AND origin = '' AND kind = 'llm' AND length(output) < 4000
          AND NOT match(output, {{calls:String}})
          AND match(output, {{note:String}})
          AND start_time >= now() - INTERVAL {{days:UInt32}} DAY
        ORDER BY start_time DESC LIMIT 2000""", params | {"calls": _HAS_TOOL_CALLS, "note": _NOTE_HINT})
    if notes:
        last = {r["trace_id"]: r["span_id"] for r in await query(f"""
            SELECT trace_id, argMax(span_id, end_time) AS span_id FROM {SPANS}
            WHERE trace_id IN {{t:Array(String)}} AND kind = 'llm' GROUP BY trace_id""",
                                                              {"t": list({n["trace_id"] for n in notes})})}
        for r in notes:
            if last.get(r["trace_id"]) != r["span_id"]:
                continue
            text = message_text(r["output"])
            if is_narration(text):
                signals.append(_signal(project, r, "leaked_narration", "narration", "narr:final answer", "final answer",
                                       len(text), f"the run's answer is the agent's working notes, not an answer: “{text.strip()[:200]}”"))
    issues = _group(project, signals, title=lambda key, loc, worst, rule: (
        "Final answers are the agent's working notes, not the answer" if loc == "final answer"
        else f"{loc} sends the agent's working notes instead of the message"))
    return issues, signals


def find_bypasses(ran: list[dict], approvals: list[dict]) -> list[dict]:
    """Guarded tool calls that did the action with no approval before them (same run, or earlier
    in the same conversation)."""
    approved_traces = {a["trace_id"] for a in approvals if _APPROVE.search(a["resume"] or "")}
    by_thread: dict[str, list] = {}
    for a in approvals:
        if a["thread_id"] and _APPROVE.search(a["resume"] or ""):
            by_thread.setdefault(a["thread_id"], []).append(a["start_time"])
    out = []
    for r in ran:
        if _REFUSED.search(r.get("output") or ""):
            continue  # refused or rejected: nothing was done
        if r["trace_id"] in approved_traces:
            continue
        if r["thread_id"] and any(t <= r["start_time"] for t in by_thread.get(r["thread_id"], [])):
            continue  # approved earlier in this conversation ("allow for this chat")
        out.append(r)
    return out


def _signal(project: str, row: dict, category: str, rule: str, key: str, location: str, value: float,
            detail: str) -> dict:
    return {"project": project, "trace_id": row["trace_id"], "span_id": row["span_id"], "category": category,
            "rule": rule, "issue_id": _id(project, category, key), "location": location,
            "agent": row.get("agent_name") or "", "thread_id": row.get("thread_id") or "", "value": float(value),
            "detail": detail, "start_time": row["start_time"], "_key": key,
            # rule checks are facts; the screener's findings wait for the investigator
            "verdict": "" if rule == "screener" else "confirmed", "note": ""}


def _group(project: str, signals: list[dict], title, limits: dict[str, float] | None = None) -> list[dict]:
    """Signals → one issue per (category, place): counts, first/last seen, recent runs."""
    groups: dict[str, list[dict]] = {}
    for s in signals:
        groups.setdefault(s["issue_id"], []).append(s)
    issues = []
    for iid, ss in groups.items():
        ss.sort(key=lambda s: s["start_time"], reverse=True)
        traces = list(dict.fromkeys(s["trace_id"] for s in ss))
        worst = max(s["value"] for s in ss)
        issues.append({
            "project": project, "id": iid, "kind": ss[0]["category"],
            "title": title(ss[0]["_key"], ss[0]["location"], worst, ss[0]["rule"]),
            "location": ss[0]["location"], "agent": ss[0]["agent"], "message": ss[0]["detail"],
            "runs": len(traces), "events": len(ss), "failed_runs": 0,
            "first_seen": ss[-1]["start_time"], "last_seen": ss[0]["start_time"], "trace_ids": traces[:8],
            "peak": worst / limits[ss[0]["rule"]] if limits and limits.get(ss[0]["rule"]) else 0.0,
        })
    return issues


async def save_signals(signals: list[dict]) -> None:
    if signals:
        client = await get_client()
        await client.insert(SIGNALS, [[s[c] for c in _COLS] for s in signals], column_names=_COLS,
                            settings={"async_insert": 0})


async def detect(project: str, days: int, cfg: dict[str, Any]) -> tuple[list[dict], dict[str, Any]]:
    """Rule-found issues for the categories the project turned on (signals are saved)."""
    issues: list[dict] = []
    signals: list[dict] = []
    status: dict[str, Any] = {}
    if not cfg.get("enabled", True):
        return [], {"rules": "engine off"}
    cats = set(cfg.get("categories") or [])
    if "context_explosion" in cats:
        i, s = await context_explosion(project, days, cfg)
        issues += i
        signals += s
    if "response_truncation" in cats:
        i, s = await response_truncation(project, days)
        issues += i
        signals += s
    if "pii_leak" in cats:
        i, s = await secrets(project, days)
        issues += i
        signals += s
    if "leaked_narration" in cats:
        i, s = await leaked_narration(project, days, cfg)
        issues += i
        signals += s
    if "guardrail_bypass" in cats:
        i, s, st = await guardrail_bypass(project, days, cfg)
        issues += i
        signals += s
        status |= st
    await save_signals(signals)
    return issues, status


async def for_trace(trace_id: str) -> list[dict[str, Any]]:
    return await query(f"""
        SELECT span_id, category, rule, issue_id, location, value, detail, verdict, note FROM {SIGNALS} FINAL
        WHERE trace_id = {{t:String}} AND verdict != 'rejected' ORDER BY category, value DESC""", {"t": trace_id})


async def focus_for(issue_id: str, trace_id: str) -> str | None:
    """The step a rule issue points at in one of its runs (the biggest one)."""
    rows = await query(f"""
        SELECT span_id FROM {SIGNALS} FINAL WHERE issue_id = {{i:String}} AND trace_id = {{t:String}}
        ORDER BY value DESC LIMIT 1""", {"i": issue_id, "t": trace_id})
    return rows[0]["span_id"] if rows else None


def severity(issue: dict[str, Any]) -> str | None:
    """Severity for engine categories (None: an error/loop issue)."""
    if issue["kind"] == "guardrail_bypass" or (issue["kind"] == "pii_leak" and issue.get("location", "").startswith("secret")):
        return "high"  # an unapproved action or a leaked secret is serious however often it happens
    if issue["kind"] == "leaked_narration":
        # a person got notes instead of a message: serious when it went out as a message
        return "high" if issue.get("location") != "final answer" else "medium" if issue["runs"] >= 2 else "low"
    if issue["kind"] == "response_truncation":
        return "medium" if issue["runs"] >= 3 else "low"
    from .engine import model_categories
    if issue["kind"] in model_categories():  # filed by the investigator (which usually sets the level itself)
        return "high" if issue["runs"] >= 5 else "medium" if issue["runs"] >= 2 else "low"
    if issue["kind"] == "context_explosion":
        peak = issue.get("peak") or 0  # worst case ÷ the limit
        if peak >= 10 or (issue["runs"] >= 5 and peak >= 3):
            return "high"
        return "medium" if issue["runs"] >= 3 or peak >= 3 else "low"
    return None

