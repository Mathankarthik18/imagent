"""Issue engine: settings, feedback and the agent overview it works from.

The engine reads production runs to find what goes wrong — including silent failures with
no error. A project chooses which failure categories to look for, a cheap model to screen
runs and a strong one to investigate, how many runs a scan reads, and a monthly spend cap.
The agent overview is a page about the app (what it does, its rules) that every scan reads;
the team edits it and the engine adds what it learns.

Feedback (a user's 👍/👎, a reviewer's score, or "Flag for engine") sends runs to the front
of the queue.
"""

from __future__ import annotations

import datetime as dt
import json
import re
import uuid
from typing import Any

from .db import DB, SPANS, get_client, query

FEEDBACK = f"{DB}.feedback"

DDL = [
    f"""
    CREATE TABLE IF NOT EXISTS {FEEDBACK} (
        project     String,
        id          String,
        trace_id    String,
        thread_id   String,
        score       Nullable(Float64),
        comment     String,
        key         LowCardinality(String),
        source      LowCardinality(String),
        user_id     String,
        created_at  DateTime64(3, 'UTC')
    ) ENGINE = MergeTree ORDER BY (project, trace_id, created_at)
    """,
]

# What the engine looks for. Rule categories are checked in code on every run; the others
# need a model to read the run.
CATEGORIES: dict[str, dict[str, str]] = {
    # ── answers ──
    "hallucination": {
        "label": "Hallucination", "group": "Answers", "how": "model",
        "definition": "The answer states facts — numbers, names, dates, statuses — that are not supported by the "
                      "tool results or context the agent had, or contradicts them. Includes answering confidently "
                      "after a tool returned nothing, an error or 'not found'.",
    },
    "task_evasion": {
        "label": "Task evasion", "group": "Answers", "how": "model",
        "definition": "The agent doesn't do what was asked although it could: deflects, answers a different "
                      "question, asks for information it already has or doesn't need, or does only part of the task "
                      "and presents it as done.",
    },
    "leaked_narration": {
        "label": "Leaked working notes", "group": "Answers", "how": "rule+model",
        "definition": "A person receives the agent's working notes instead of the real content: narration about its "
                      "own process ('I now have all the data', 'Let me compose and send the report…'), plans, or talk "
                      "about tools and steps — as the final answer or as the text of a message it sends (Signal, "
                      "email, Slack…). The message the person needed usually never went out.",
    },
    "response_truncation": {
        "label": "Response truncation", "group": "Answers", "how": "rule",
        "definition": "A model call stopped because it hit its output-token limit, so the answer (or a tool call) "
                      "was cut off mid-way.",
    },
    "missing_capability": {
        "label": "Missing capability awareness", "group": "Answers", "how": "model",
        "definition": "The agent says it can't do something one of its tools does, or claims to have done or be "
                      "able to do something it has no tool for (e.g. 'I've emailed them' with no send tool call).",
    },
    "feature_gap": {
        "label": "Feature gap", "group": "Answers", "how": "model",
        "definition": "The user asks for something the application has no way to do — no tool, data or agent "
                      "covers it — and the agent rightly can't help. A product gap to build, not a bug.",
    },
    # ── tools ──
    "silent_tool_error": {
        "label": "Silent tool error", "group": "Tools", "how": "model",
        "definition": "A tool reported its failure as normal output (e.g. {\"error\": …}, 'not found', an empty "
                      "result, a stack trace in the text) instead of raising, and the agent used it as if it were "
                      "a real result.",
    },
    "wrong_tool": {
        "label": "Wrong tool", "group": "Tools", "how": "model",
        "definition": "The agent used a tool that doesn't fit the request (or a sub-agent for the wrong job) when a "
                      "better-suited tool was available, or skipped the tool the request needed.",
    },
    "incorrect_tool_args": {
        "label": "Incorrect tool args", "group": "Tools", "how": "model",
        "definition": "Right tool, wrong arguments: the wrong entity (vessel, thread, date, id), a wrong format or "
                      "unit, a missing filter, or values that don't match what the user asked — whether or not the "
                      "tool complained.",
    },
    "failed_error_recovery": {
        "label": "Failed error recovery", "group": "Tools", "how": "model",
        "definition": "After a tool error or empty result the agent handles it badly: gives up when an obvious "
                      "retry or alternative existed, retries the same failing call blindly, or hides the failure "
                      "from the user.",
    },
    # ── behaviour ──
    "agent_looping": {
        "label": "Agent looping", "group": "Behaviour", "how": "rule+model",
        "definition": "The agent repeats the same tool call or step (same or near-same arguments) without making "
                      "progress, instead of changing approach or stopping.",
    },
    "flawed_plan": {
        "label": "Flawed plan", "group": "Behaviour", "how": "model",
        "definition": "The order or breakdown of steps can't reach the goal: steps in the wrong order, a needed "
                      "step missing, work split so results can't be combined, or effort spent on the wrong thing.",
    },
    "prompt_drift": {
        "label": "System prompt drift", "group": "Behaviour", "how": "model",
        "definition": "The agent breaks a rule or instruction from its system prompt — format, required fields, "
                      "scope, tone, do/don't rules — typically later in a long run.",
    },
    # ── safety & cost ──
    "guardrail_bypass": {
        "label": "Guardrail bypass", "group": "Safety & cost", "how": "rule+model",
        "definition": "An action that needs a person's approval ran without one, or the agent acted where its "
                      "instructions say to ask, refuse or stop.",
    },
    "pii_leak": {
        "label": "PII leak", "group": "Safety & cost", "how": "rule+model",
        "definition": "Personal or sensitive data — secrets (API keys, tokens, passwords), personal contact or "
                      "identity details, other customers' data — shows up where it isn't needed or goes to someone "
                      "who shouldn't get it.",
    },
    "context_explosion": {
        "label": "Context explosion", "group": "Safety & cost", "how": "rule",
        "definition": "The context the model reads grows until runs get slow, expensive or truncated: huge tool "
                      "outputs, history or documents piled into every call.",
    },
}


# Tools that send something to a person (their text is what the person reads). Read-style names
# (get_/list_/search_…) never count, so search_emails or get_messages aren't mistaken for senders.
_SENDS = re.compile(r"send|reply|notify|post|message|signal|e?mail|slack|sms|whatsapp|telegram|teams|broadcast", re.I)
_READS = re.compile(r"^(get|list|search|read|fetch|find|lookup|query|load|count|check|draft|resolve|validate|preview|format|parse)_", re.I)


def sends_by_name(name: str) -> bool:
    return bool(_SENDS.search(name)) and not _READS.search(name)


def is_message_tool(name: str, es: dict[str, Any]) -> bool:
    """Does this tool send a message to a person — auto-detected by name, adjusted in Settings."""
    if name in (es.get("not_message_tools") or []):
        return False
    return name in (es.get("message_tools") or []) or sends_by_name(name)


def model_categories() -> list[str]:
    """Categories a model reads runs for (the screener, investigator and per-issue checks)."""
    return [k for k, c in CATEGORIES.items() if "model" in c["how"]]

LEVELS = {"reduced": 50, "standard": 200, "expanded": 1000}  # runs read per scan

DEFAULTS: dict[str, Any] = {
    "enabled": True,
    "categories": list(CATEGORIES),
    "screener_model": "~anthropic/claude-haiku-latest",
    "investigator_model": "",            # empty: the project's judge model
    "level": "standard",
    "monthly_cap_usd": 20.0,
    "guarded_tools": [],                 # tools that must not run without a person's approval
    "message_tools": [],                 # tools that send a message to a person, on top of the auto-detected ones
    "not_message_tools": [],             # auto-detected as sending, but don't
    "context_tokens_limit": 100_000,     # one model call reading more than this is flagged
    "tool_output_chars_limit": 50_000,   # one tool returning more than this is flagged
}


def settings(project: dict[str, Any] | None) -> dict[str, Any]:
    """The project's engine settings over the defaults."""
    raw = (project or {}).get("engine") or ""
    try:
        saved = json.loads(raw) if raw else {}
    except ValueError:
        saved = {}
    out = DEFAULTS | {k: v for k, v in saved.items() if k in DEFAULTS}
    # Categories added to imagent after the project saved its choice start on.
    known = saved.get("known") or _FIRST_FIVE
    out["categories"] = [c for c in out["categories"] if c in CATEGORIES] + \
        [c for c in CATEGORIES if c not in known and c not in out["categories"]] if "categories" in saved else list(CATEGORIES)
    if out["level"] not in LEVELS:
        out["level"] = "standard"
    return out


_FIRST_FIVE = ("hallucination", "wrong_tool", "prompt_drift", "guardrail_bypass", "context_explosion")


def clean(patch: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    """Validate a settings change from the UI; returns the full new settings."""
    out = dict(current)
    for k, v in patch.items():
        if k not in DEFAULTS:
            continue
        if k == "categories":
            v = [c for c in v if c in CATEGORIES]
        elif k == "level" and v not in LEVELS:
            continue
        elif k in ("guarded_tools", "message_tools", "not_message_tools"):
            v = sorted({str(t).strip() for t in v if str(t).strip()})[:200]
        elif k in ("monthly_cap_usd",):
            v = max(0.0, float(v))
        elif k in ("context_tokens_limit", "tool_output_chars_limit"):
            v = max(1000, int(v))
        elif k in ("screener_model", "investigator_model"):
            v = str(v).strip()[:200]
        elif k == "enabled":
            v = bool(v)
        out[k] = v
    out["known"] = list(CATEGORIES)  # what existed when this was saved
    return out


# ── Feedback ────────────────────────────────────────────────────────────────

_COLS = ["project", "id", "trace_id", "thread_id", "score", "comment", "key", "source", "user_id", "created_at"]


async def _latest_trace_in_thread(project: str, thread_id: str, at: dt.datetime) -> str:
    rows = await query(f"""
        SELECT trace_id FROM {SPANS}
        WHERE project = {{p:String}} AND thread_id = {{t:String}} AND is_root = 1
          AND start_time <= {{at:DateTime64(6)}} + INTERVAL 5 SECOND
        ORDER BY start_time DESC LIMIT 1""", {"p": project, "t": thread_id, "at": at.replace(tzinfo=None)})
    return rows[0]["trace_id"] if rows else ""


async def add_feedback(project: str, *, trace_id: str = "", thread_id: str = "", score: float | None = None,
                       comment: str = "", key: str = "user", source: str = "app", user_id: str = "",
                       at: dt.datetime | None = None) -> dict[str, Any]:
    at = at or dt.datetime.now(dt.timezone.utc)
    if not trace_id and thread_id:
        trace_id = await _latest_trace_in_thread(project, thread_id, at)
    row = {"project": project, "id": uuid.uuid4().hex[:16], "trace_id": trace_id, "thread_id": thread_id,
           "score": score, "comment": comment[:4000], "key": key[:40] or "user", "source": source[:40] or "app",
           "user_id": user_id[:200], "created_at": at}
    client = await get_client()
    await client.insert(FEEDBACK, [[row[c] for c in _COLS]], column_names=_COLS, settings={"async_insert": 0})
    return row


async def feedback_for(trace_id: str) -> list[dict[str, Any]]:
    return await query(f"SELECT * FROM {FEEDBACK} WHERE trace_id = {{t:String}} ORDER BY created_at DESC",
                       {"t": trace_id})


async def tools(project: str, days: int = 30) -> list[dict[str, Any]]:
    """The app's tools with how often each ran and paused for approval — to pick guarded tools from."""
    rows = await query(f"""
        SELECT name, count() AS calls,
               countIf(attributes['imagent.interrupt'] != '') AS paused
        FROM {SPANS}
        WHERE project = {{p:String}} AND origin = '' AND kind = 'tool'
          AND start_time >= now() - INTERVAL {{d:UInt32}} DAY
        GROUP BY name ORDER BY calls DESC LIMIT 300""", {"p": project, "d": days})
    for r in rows:
        r["sends"] = sends_by_name(r["name"])  # auto-detected as sending a message to a person
    return rows
