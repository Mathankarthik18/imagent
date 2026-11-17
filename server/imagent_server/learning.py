"""Learning from the team: what people do with issues becomes preferences the engine follows.

Every action a person takes on an issue is recorded. At each scan the new ones turn into the
project's preferences (shown and editable under Settings › Agent overview):

- Incorrectly flagged, Ignore, or resolving by hand → that category's priority drops one level
  (high → medium → low; never below low). The engine then caps new issues in it at that level
  and the screener only flags clear-cut cases of it.
- Changing an issue's severity → that category's priority becomes what the person chose.
- Opening a fix PR → the category matters: its priority goes back up to high.
- The reasons people give ("these are test runs", "the CP table is allowed here") are turned
  into short general rules by the investigating model; the screener and investigator read them.

Automatic changes (closing stale issues, re-opening ones that came back) teach nothing.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
from typing import Any

from . import judge
from .db import DB, get_client, query

logger = logging.getLogger(__name__)

EVENTS = f"{DB}.issue_events"

DDL = [
    f"""
    CREATE TABLE IF NOT EXISTS {EVENTS} (
        project   String,
        issue_id  String,
        kind      LowCardinality(String),
        title     String,
        action    LowCardinality(String),
        value     String,
        reason    String,
        at        DateTime64(3, 'UTC') DEFAULT now64(3)
    ) ENGINE = MergeTree ORDER BY (project, at)
    """,
]

LEVELS = ("low", "medium", "high")
MAX_RULES = 30


def preferences(project: dict[str, Any] | None) -> dict[str, Any]:
    raw = (project or {}).get("preferences") or ""
    try:
        p = json.loads(raw) if raw else {}
    except ValueError:
        p = {}
    return {"categories": p.get("categories") or {}, "rules": p.get("rules") or [], "learned_at": p.get("learned_at") or "",
            "pending": p.get("pending") or []}


def clean(p: dict[str, Any]) -> dict[str, Any]:
    """Preferences as edited in Settings: priorities must be levels, rules short strings."""
    cats = {str(k): {"priority": v.get("priority") if v.get("priority") in LEVELS else "high", "why": str(v.get("why", ""))[:300]}
            for k, v in (p.get("categories") or {}).items() if isinstance(v, dict)}
    rules = [str(r).strip()[:300] for r in p.get("rules") or [] if str(r).strip()][:MAX_RULES]
    return {"categories": cats, "rules": rules, "learned_at": str(p.get("learned_at") or ""), "pending": p.get("pending") or []}


def cap(prefs: dict[str, Any], kind: str, level: str) -> str:
    """A severity, no higher than the category's learned priority."""
    pr = (prefs.get("categories") or {}).get(kind, {}).get("priority")
    if pr in LEVELS and level in LEVELS and LEVELS.index(level) > LEVELS.index(pr):
        return pr
    return level


def text(prefs: dict[str, Any]) -> str:
    """Preferences as instructions for the screener and investigator ('' when there are none)."""
    lines = [f"- {r}" for r in prefs.get("rules") or []]
    for cat, c in (prefs.get("categories") or {}).items():
        if c.get("priority") == "low":
            lines.append(f"- The team rates '{cat}' as low priority: flag it only when it is clear-cut and consequential.")
    return "The team's preferences (learned from how they handled past issues — follow them):\n" + "\n".join(lines) if lines else ""


async def log(issue: dict[str, Any], action: str, value: str = "", reason: str = "") -> None:
    """Record a person's action on an issue."""
    client = await get_client()
    await client.insert(EVENTS, [[issue["project"], issue["id"], issue["kind"], issue["title"][:300], action, value, reason[:1000]]],
                        column_names=["project", "issue_id", "kind", "title", "action", "value", "reason"],
                        settings={"async_insert": 0})


def apply(prefs: dict[str, Any], events: list[dict[str, Any]]) -> tuple[dict[str, Any], list[str]]:
    """New category priorities from actions (oldest first). Returns (prefs, what changed)."""
    cats = {k: dict(v) for k, v in (prefs.get("categories") or {}).items()}
    changes = []
    for e in events:
        c = cats.setdefault(e["kind"], {"priority": "high", "why": ""})
        before = c["priority"]
        if e["action"] in ("incorrect", "ignored", "resolved"):
            c["priority"] = LEVELS[max(0, LEVELS.index(before) - 1)]
            c["why"] = f"{'Marked incorrectly flagged' if e['action'] == 'incorrect' else e['action'].capitalize()}: {e['title'][:120]}"
        elif e["action"] == "severity" and e["value"] in LEVELS:
            c["priority"] = e["value"]
            c["why"] = f"Severity set to {e['value']} on: {e['title'][:120]}"
        elif e["action"] == "pr_opened":
            c["priority"] = "high"
            c["why"] = f"A fix PR was opened for: {e['title'][:120]}"
        if c["priority"] != before:
            changes.append(f"{e['kind']}: {before} → {c['priority']}")
    return prefs | {"categories": cats}, changes


RULES_PROMPT = """You maintain short rules for an AI that reviews runs of an agent application and files
problems. People dismissed some of its issues and said why. Turn those reasons into general rules the
reviewer should follow next time (e.g. "Runs whose ids look like test data (u1, t1, CPM-2026-0001) are
tests — never file them"). Keep existing rules unless a new reason contradicts them; merge
duplicates; drop nothing important. At most {n} rules, each one sentence.

Existing rules:
{rules}

Newly dismissed issues and the reasons given:
{reasons}

Reply with JSON only: {{"rules": ["...", "..."]}}"""


async def learn(project: str, proj: dict[str, Any] | None) -> dict[str, Any]:
    """Fold actions since the last pass into the project's preferences."""
    from . import projects
    prefs = preferences(proj)
    since = prefs["learned_at"] or "1970-01-01T00:00:00+00:00"
    events = await query(f"""
        SELECT * FROM {EVENTS} WHERE project = {{p:String}} AND at > {{s:DateTime64(3)}} ORDER BY at""",
                         {"p": project, "s": dt.datetime.fromisoformat(since).replace(tzinfo=None)})
    if not events:
        return {"learned": 0}
    prefs, changes = apply(prefs, events)
    # reasons not yet turned into rules (a failed pass keeps them for the next one)
    reasons = (prefs.get("pending") or []) + [
        {"kind": e["kind"], "title": e["title"], "reason": e["reason"]}
        for e in events if e["action"] in ("incorrect", "ignored") and e["reason"].strip()]
    prefs["pending"] = []
    cfg = judge.config_for(proj)
    if reasons and cfg:
        msg = RULES_PROMPT.format(n=MAX_RULES, rules="\n".join(f"- {r}" for r in prefs["rules"]) or "(none)",
                                  reasons="\n".join(f"- [{e['kind']}] {e['title']}: {e['reason']}" for e in reasons))
        try:
            reply, _ = await asyncio.to_thread(judge._call, [{"role": "user", "content": msg}], cfg,
                                               max_tokens=2000, timeout=120, title="imagent learning")
            from .diagnose import _json
            new_rules = [str(r).strip()[:300] for r in _json(reply, "rules").get("rules") or [] if str(r).strip()]
            if new_rules:
                prefs["rules"] = new_rules[:MAX_RULES]
                changes.append(f"rules: {len(new_rules)}")
        except Exception as exc:  # noqa: BLE001 — keep the priorities; turn the reasons into rules next time
            logger.warning("learning rules for %s failed: %s", project, exc)
            prefs["pending"] = reasons
    elif reasons:
        prefs["pending"] = reasons
    prefs["learned_at"] = max(e["at"] for e in events).replace(tzinfo=dt.timezone.utc).isoformat()
    return await _save(projects, project, prefs, changes)


async def _save(projects_mod, project: str, prefs: dict[str, Any], changes: list[str]) -> dict[str, Any]:
    await projects_mod.update(project, preferences=json.dumps(prefs))
    return {"learned": len(changes), "changes": changes}
