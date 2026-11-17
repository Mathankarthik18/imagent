"""Screener: a cheap model reads an outline of every run and flags the suspicious ones.

Each run is squeezed into a numbered outline — the user's request, one line per step (tool
calls with their arguments and the start of what came back, model calls and which tools they
asked for, errors, rule findings), and the start of the final answer — about 1–2k characters
instead of the hundreds of thousands a run can hold. Runs are screened in batches of ~20 per
agent, with that agent's system prompt (shortened) once per batch so prompt drift can be
judged, the project's agent overview, and the definitions of the categories it looks for.

The model answers with the runs it suspects: run, category, the step it points at, and why.
Those become signals on the run (stored like the rule checks') and, grouped by category and
place, issues on the board. Every run screened is recorded so it isn't read twice, and every
model call's cost counts against the project's monthly cap.

Run order: runs someone flagged or gave 👎, then runs with rule findings or errors, then the
rest (most recent first), up to the project's analysis level.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

from . import judge, rules
from .db import DB, SPANS, get_client, query
from .engine import CATEGORIES, FEEDBACK, LEVELS, model_categories

logger = logging.getLogger(__name__)

SCREENED = f"{DB}.screened"
USAGE = f"{DB}.engine_usage"

DDL = [
    f"""
    CREATE TABLE IF NOT EXISTS {SCREENED} (
        project     String,
        trace_id    String,
        flagged     UInt8,
        model       String,
        screened_at DateTime64(3, 'UTC') DEFAULT now64(3)
    ) ENGINE = ReplacingMergeTree(screened_at) ORDER BY (project, trace_id)
    TTL toDateTime(screened_at) + INTERVAL 120 DAY
    """,
    f"""
    CREATE TABLE IF NOT EXISTS {USAGE} (
        project  String,
        stage    LowCardinality(String),
        model    String,
        runs     UInt32,
        cost     Float64,
        at       DateTime64(3, 'UTC') DEFAULT now64(3)
    ) ENGINE = MergeTree ORDER BY (project, at)
    """,
]

MODEL_CATEGORIES = tuple(model_categories())
BATCH = 20
MAX_STEPS = 40          # outline lines per run (the rest are summarised)
SYSTEM_PROMPT_CHARS = 5000
_running: set[str] = set()


# ── Outline ─────────────────────────────────────────────────────────────────

def json_string_at(text: str, key: str, start: int = 0) -> str:
    """The value of the first ``"key": "…"`` at/after ``start`` in possibly-truncated JSON, decoded."""
    m = re.search(r'"%s":\s*"' % re.escape(key), text[start:])
    if not m:
        return ""
    i = start + m.end()
    out, esc = [], False
    for j in range(i, len(text)):
        c = text[j]
        if esc:
            esc = False
            continue
        if c == "\\":
            esc = True
            continue
        if c == '"':
            raw = text[i:j]
            break
        out.append(c)
    else:
        raw = text[i:]
        raw = raw[: raw.rfind("\\")] if raw.endswith("\\") else raw
    try:
        return json.loads(f'"{raw}"')
    except ValueError:
        return raw.replace("\\n", "\n").replace('\\"', '"')


def user_request(root_input: str) -> str:
    """The person's message: the last user message in the run's input (or the raw input)."""
    idx = root_input.rfind('"role": "user"')
    if idx == -1:
        idx = root_input.rfind('"role": "human"')
    if idx != -1:
        return json_string_at(root_input, "content", idx)
    return root_input


def system_prompt(llm_input: str) -> str:
    idx = llm_input.find('"role": "system"')
    return json_string_at(llm_input, "content", idx) if idx != -1 else ""


def _clip(s: str, n: int) -> str:
    s = re.sub(r"\s+", " ", s or "").strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def _size(n: int) -> str:
    return f"{n / 1000:.1f}k" if n >= 1000 else str(n)


_FAILED = re.compile(r'"error"\s*:|\b(not found|no results?|no records?|failed|exception|traceback|unauthori[sz]ed|'
                     r'forbidden|permission denied|timed? ?out|invalid|unavailable|does not exist|couldn\'t|could not)\b', re.I)


def looks_failed(out: str, size: int) -> bool:
    """A tool result that reads like a failure or nothing — a silent-tool-error candidate."""
    body = out.strip()
    return size <= 4 or body in ("[]", "{}", '""', "null", "None") or bool(_FAILED.search(body[:400]))


_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_PHONE = re.compile(r"(?<!\d)\+?\d[\d ()-]{8,}\d(?!\d)")


def personal_data(text: str) -> str:
    """'2 email addresses, 1 phone number' when an answer carries contact details ('' if none)."""
    bits = []
    for label, rx in (("email address", _EMAIL), ("phone number", _PHONE)):
        n = len(set(rx.findall(text or "")))
        if n:
            bits.append(f"{n} {label}{'es' if label.endswith('ss') and n > 1 else 's' if n > 1 else ''}")
    return ", ".join(bits)


def last_text(steps: list[dict[str, Any]], agent: str) -> str:
    """The final answer: the main agent's last model message with text (a sub-agent's last
    message is not the answer), else any model's last text."""
    texts = [(s.get("agent_name") or "", json_string_at(s.get("output_head") or "", "content"))
             for s in steps if s["kind"] == "llm"]
    texts = [(a, t) for a, t in texts if t.strip()]
    mine = [t for a, t in texts if agent and a == agent]
    return (mine or [t for _, t in texts] or [""])[-1]


def outline(run: dict[str, Any], steps: list[dict[str, Any]], findings: list[dict[str, Any]],
            feedback: list[dict[str, Any]]) -> tuple[str, list[str]]:
    """A run as a short numbered outline, and the span id behind each step number."""
    ids: list[str] = []
    lines = [f"request: {_clip(user_request(run.get('input_head') or ''), 400) or '(not captured)'}"]
    for fb in feedback:
        score = fb["score"]
        who = ("flagged by the team" if fb["key"] == "flag" else "user comment" if score is None
               else "user rated 👎" if score < 0.5 else "user rated 👍")
        lines.append(f"feedback: {who}{': ' + _clip(fb['comment'], 200) if fb['comment'] else ''}")
    # Long runs: the start and the end (where the answer is), numbered by their place in the run.
    head, tail = MAX_STEPS * 5 // 8, MAX_STEPS * 3 // 8
    keep = set(range(len(steps))) if len(steps) <= MAX_STEPS else set(range(head)) | set(range(len(steps) - tail, len(steps)))
    for idx, s in enumerate(steps):
        ids.append(s["span_id"])
        if idx not in keep:
            if idx == head:
                lines.append(f"… {len(steps) - head - tail} steps in between not shown …")
            continue
        n = idx + 1
        err = f" ERROR: {_clip(s['status_message'], 160)}" if s["status"] == "error" else ""
        paused = " (paused for approval)" if s.get("interrupt") else ""
        if s["kind"] == "tool":
            out = s.get("output_head") or ""
            if out.lstrip().startswith('{"role"'):  # a tool message: show what the tool returned, unescaped
                out = json_string_at(out, "content") or out
            warn = " ⚠ looks like an error/empty result" if not err and looks_failed(out, s["output_len"]) else ""
            lines.append(f"[{n}] tool {s['name']}({_clip(s.get('input_head') or '', 160)}) → {_size(s['output_len'])} chars: "
                         f"{_clip(out, 220)}{err}{paused}{warn}")
        elif s["kind"] == "llm":
            out = s.get("output_head") or ""
            calls = re.findall(r'"name":\s*"([^"]+)"', out[out.find('"tool_calls"'):]) if '"tool_calls"' in out else []
            text = json_string_at(out, "content")
            what = f"asks for {', '.join(calls[:6])}" if calls else f"writes: {_clip(text, 160)}"
            lines.append(f"[{n}] model ({s['agent_name'] or '-'}, {_size(s['input_tokens'])} tokens in) {what}{err}")
        else:
            lines.append(f"[{n}] {s['kind']} {s['name']}{err}{paused}")
    final = last_text(steps, run.get("agent") or "")
    for f in findings:
        lines.append(f"rule check: {f['detail']}")
    pii = personal_data(final)
    lines.append(f"final answer: {_clip(final, 700) or '(none — failed or cut off)'}"
                 f"{' ⚠ contains ' + pii if pii else ''}")
    return "\n".join(lines), ids


# ── Selection ───────────────────────────────────────────────────────────────

async def candidates(project: str, days: int, limit: int) -> list[dict[str, Any]]:
    """Unscreened production runs, most worth reading first. A run that is a single tool call
    (a script or test calling a tool directly) has no answer to judge and is skipped."""
    return await query(f"""
        SELECT r.trace_id AS trace_id, r.name AS name, r.agent_name AS agent, r.start_time AS start_time,
               r.status AS status, left(r.input, 3000) AS input_head,
               (r.trace_id IN (SELECT trace_id FROM {FEEDBACK} WHERE project = {{p:String}}
                                AND (key = 'flag' OR score < 0.5))) AS disliked,
               (r.trace_id IN (SELECT trace_id FROM {rules.SIGNALS} WHERE project = {{p:String}})) AS ruled
        FROM {SPANS} AS r
        WHERE r.project = {{p:String}} AND r.is_root = 1 AND r.origin = '' AND r.kind != 'tool'
          AND r.start_time >= now() - INTERVAL {{days:UInt32}} DAY
          AND r.trace_id NOT IN (SELECT trace_id FROM {SCREENED} WHERE project = {{p:String}})
        ORDER BY disliked DESC, ruled DESC, (r.status = 'error') DESC, r.start_time DESC
        LIMIT {{n:UInt32}}""", {"p": project, "days": days, "n": limit})


async def _steps(trace_ids: list[str]) -> dict[str, list[dict[str, Any]]]:
    rows = await query(f"""
        SELECT trace_id, span_id, kind, name, agent_name, status, left(status_message, 300) AS status_message,
               input_tokens, left(input, 300) AS input_head, left(output, 1500) AS output_head,
               length(output) + toUInt64OrZero(extract(output, 'truncated (\\\\d+) chars')) AS output_len,
               attributes['imagent.interrupt'] != '' AS interrupt
        FROM {SPANS}
        WHERE trace_id IN {{ids:Array(String)}} AND kind IN ('tool', 'llm') AND is_root = 0
        ORDER BY trace_id, start_time
        LIMIT 1 BY trace_id, span_id""", {"ids": trace_ids})
    out: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        out.setdefault(r["trace_id"], []).append(r)
    return out


async def _system_prompts(project: str, agents: list[str]) -> dict[str, tuple[str, list[str]]]:
    """Each agent's system prompt (shortened) and the names of the tools it has."""
    rows = await query(f"""
        SELECT agent_name, argMax(left(input, {{n:UInt32}}), start_time) AS head,
               argMax(attributes['imagent.tools'], start_time) AS tools FROM {SPANS}
        WHERE project = {{p:String}} AND kind = 'llm' AND agent_name IN {{a:Array(String)}}
          AND start_time >= now() - INTERVAL 7 DAY
        GROUP BY agent_name""", {"p": project, "a": agents, "n": SYSTEM_PROMPT_CHARS * 2})
    return {r["agent_name"]: (system_prompt(r["head"])[:SYSTEM_PROMPT_CHARS],
                              list(dict.fromkeys(re.findall(r'"name":\s*"([^"]+)"', r["tools"] or ""))))
            for r in rows}


async def _side(trace_ids: list[str]) -> tuple[dict[str, list], dict[str, list]]:
    sig = await query(f"SELECT trace_id, detail FROM {rules.SIGNALS} FINAL WHERE trace_id IN {{ids:Array(String)}} "
                      f"AND rule != 'screener'", {"ids": trace_ids})
    fb = await query(f"SELECT trace_id, key, score, comment FROM {FEEDBACK} WHERE trace_id IN {{ids:Array(String)}}",
                     {"ids": trace_ids})
    a: dict[str, list] = {}
    b: dict[str, list] = {}
    for r in sig:
        a.setdefault(r["trace_id"], []).append(r)
    for r in fb:
        b.setdefault(r["trace_id"], []).append(r)
    return a, b


# ── Screening ───────────────────────────────────────────────────────────────

SYSTEM = """You review runs of an AI agent application and flag the ones where something went wrong
that the logs don't show as an error. You see each run as a numbered outline: the user's request,
its steps ([n] tool calls with arguments and the start of what came back; model calls and the tools
they asked for), rule-check findings, feedback, and the start of the final answer.

Look ONLY for these problems:
{categories}

About the application:
{overview}
{prefs}
{prompt}
Rules:
- Flag a run only when the outline itself shows the problem; quote the evidence in the reason.
- Outputs are shortened: don't flag a fact just because you can't see its source — only when the
  visible tool results contradict it, are empty/errors/'not found', or the step that should have
  fetched it never ran.
- Prefer missing a borderline case to a false alarm. Most runs are fine.
- "step" is the [n] of the step most to blame (0 if it's the final answer).
- ⚠ marks are hints from simple checks (an error-looking tool result, contact details in the answer) —
  not findings. Flag only when the category's definition is actually met.

Reply with JSON only:
{{"flags": [{{"run": "<run id>", "category": "<one of: {ids}>", "step": <n>, "reason": "<one sentence with the evidence>"}}]}}
Use "flags": [] when every run looks fine."""


def _prompt(batch: list[tuple[str, str]], cats: list[str], overview: str, sys_prompt: str,
            prefs: str = "", tools: list[str] | None = None) -> list[dict[str, str]]:
    cat_text = "\n".join(f"- {c}: {CATEGORIES[c]['label']} — {CATEGORIES[c]['definition']}" for c in cats)
    prompt = (f"\nThe agent's system prompt (shortened) — rules it must follow:\n<<<\n{sys_prompt}\n>>>\n"
              if sys_prompt and "prompt_drift" in cats else "")
    if tools and {"missing_capability", "feature_gap", "wrong_tool"} & set(cats):
        prompt += f"\nThe tools this agent has: {', '.join(tools[:120])}\n"
    sysmsg = SYSTEM.format(categories=cat_text, overview=overview.strip() or "(no overview written yet)",
                           prefs=prefs, prompt=prompt, ids=", ".join(cats))
    runs = "\n\n".join(f"=== run {rid} ===\n{text}" for rid, text in batch)
    return [{"role": "system", "content": sysmsg}, {"role": "user", "content": runs}]


def parse_flags(text: str, run_ids: set[str], cats: list[str]) -> list[dict[str, Any]]:
    m = re.search(r"\{.*\}", text, re.S)
    try:
        data = json.loads(m.group(0)) if m else {}
    except ValueError:
        data = {}
    out = []
    for f in data.get("flags") or []:
        if not isinstance(f, dict):
            continue
        rid = str(f.get("run", "")).strip()
        cat = str(f.get("category", "")).strip()
        if rid in run_ids and cat in cats:
            try:
                step = int(f.get("step") or 0)
            except (TypeError, ValueError):
                step = 0
            out.append({"run": rid, "category": cat, "step": step, "reason": str(f.get("reason", ""))[:500]})
    return out


async def month_spend(project: str) -> float:
    rows = await query(f"SELECT sum(cost) AS c FROM {USAGE} WHERE project = {{p:String}} AND at >= toStartOfMonth(now())",
                       {"p": project})
    return float(rows[0]["c"] or 0) if rows else 0.0


async def _usage(project: str, stage: str, model: str, runs: int, cost: float) -> None:
    client = await get_client()
    await client.insert(USAGE, [[project, stage, model, runs, cost]], column_names=["project", "stage", "model", "runs", "cost"],
                        settings={"async_insert": 0})


async def _mark(project: str, done: list[tuple[str, bool]], model: str) -> None:
    if done:
        client = await get_client()
        await client.insert(SCREENED, [[project, t, int(f), model] for t, f in done],
                            column_names=["project", "trace_id", "flagged", "model"], settings={"async_insert": 0})


async def screen(project: str, proj: dict[str, Any], es: dict[str, Any], days: int) -> dict[str, Any]:
    """Screen up to the analysis level of unscreened runs. Returns counts; signals are saved."""
    cats = [c for c in es["categories"] if c in MODEL_CATEGORIES]
    base = judge.config_for(proj)
    if not cats:
        return {"screened": 0, "note": "no AI categories on"}
    if base is None:
        return {"screened": 0, "note": "no AI model key"}
    cfg = base | {"model": es["screener_model"] or base["model"]}
    spent = await month_spend(project)
    if spent >= es["monthly_cap_usd"]:
        return {"screened": 0, "note": f"monthly cap reached (${spent:.2f} of ${es['monthly_cap_usd']:.2f})"}
    runs = await candidates(project, days, LEVELS[es["level"]])
    if not runs:
        return {"screened": 0, "flagged": 0, "cost": 0.0}
    by_agent: dict[str, list[dict]] = {}
    for r in runs:
        by_agent.setdefault(r["agent"] or r["name"], []).append(r)
    prompts = await _system_prompts(project, list(by_agent))
    overview = proj.get("overview") or ""
    from . import learning
    prefs = learning.text(learning.preferences(proj))
    screened = flagged = 0
    cost = 0.0
    for agent, group in by_agent.items():
        sys_prompt, tools = prompts.get(agent, ("", []))
        for i in range(0, len(group), BATCH):
            if spent + cost >= es["monthly_cap_usd"]:
                return {"screened": screened, "flagged": flagged, "cost": round(cost, 4), "note": "monthly cap reached"}
            chunk = group[i:i + BATCH]
            ids = [r["trace_id"] for r in chunk]
            steps = await _steps(ids)
            findings, feedback = await _side(ids)
            short = {r["trace_id"][:10]: r for r in chunk}
            texts, spans = [], {}
            for sid, r in short.items():
                text, step_ids = outline(r, steps.get(r["trace_id"], []), findings.get(r["trace_id"], []),
                                         feedback.get(r["trace_id"], []))
                texts.append((sid, text))
                spans[sid] = step_ids
            try:
                reply, c = await asyncio.to_thread(judge._call, _prompt(texts, cats, overview, sys_prompt, prefs, tools), cfg,
                                                   max_tokens=4000, timeout=180, title="imagent screener")
            except Exception as exc:  # noqa: BLE001 — try the next batch; these stay unscreened
                logger.warning("screener batch failed for %s: %s", project, exc)
                continue
            cost += c
            flags = parse_flags(reply, set(short), cats)
            signals = []
            for f in flags:
                r = short[f["run"]]
                step_ids = spans[f["run"]]
                span_id = step_ids[f["step"] - 1] if 1 <= f["step"] <= len(step_ids) else ""
                step = next((s for s in steps.get(r["trace_id"], []) if s["span_id"] == span_id), None)
                location = (step["name"] if step and step["kind"] == "tool" else None) or r["agent"] or r["name"]
                signals.append(rules._signal(project, {"trace_id": r["trace_id"], "span_id": span_id or r["trace_id"],
                                                       "agent_name": r["agent"], "thread_id": "", "start_time": r["start_time"]},
                                             f["category"], "screener", f"ai:{f['category']}:{location}", location, 1, f["reason"]))
            await rules.save_signals(signals)
            await _mark(project, [(r["trace_id"], any(f["run"] == sid for f in flags)) for sid, r in short.items()], cfg["model"])
            await _usage(project, "screen", cfg["model"], len(chunk), c)
            screened += len(chunk)
            flagged += len({f["run"] for f in flags})
    return {"screened": screened, "flagged": flagged, "cost": round(cost, 4)}


def start(project: str, proj: dict[str, Any], es: dict[str, Any], days: int) -> bool:
    """Screen in the background (a scan returns right away). False when one is already running."""
    if project in _running:
        return False
    _running.add(project)

    async def run() -> None:
        try:
            res = await screen(project, proj, es, days)
            logger.info("screener %s: %s", project, res)
            from . import diagnose, investigator
            inv = await investigator.investigate(project, proj, es)  # confirm and file what was flagged
            logger.info("investigator %s: %s", project, inv)
            from . import checks
            for iid in inv.get("filed", [])[:3]:  # every new issue gets a check, tested on its evidence
                await checks.propose(iid)
            ran = await checks.run_active(project, proj, es, days)  # existing checks read new runs
            logger.info("checks %s: %s", project, ran)
            if inv.get("investigated") or ran.get("failed"):
                await diagnose.scan(project, days=days, screen=False)
        except Exception as exc:  # noqa: BLE001
            logger.warning("screener %s failed: %s", project, exc)
        finally:
            _running.discard(project)

    task = asyncio.get_running_loop().create_task(run())
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return True


_tasks: set[asyncio.Task] = set()


def status(project: str) -> bool:
    return project in _running

