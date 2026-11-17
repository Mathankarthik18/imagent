"""Checks, regression examples and fix verification — keeping an issue honest after it's filed.

Check: for an issue the AI engine filed (hallucination, wrong tool, prompt drift …), the
investigating model writes a model-judged check — when it applies, what fails it, what passes
it. Before it's switched on it's tested: it must catch most of the issue's evidence runs and
pass most clean runs of the same agent (ones the screener read and didn't flag). A check that
misses gets one revision with its mistakes shown; one that still misses stays a draft (shown
with its scores; a person can switch it on anyway). Error, loop, context and guardrail issues
don't need one — their rule check already finds every new case.

Active checks run on new runs of the issue's agent at each scan (a few per check, counted
against the monthly cap). A run that fails becomes evidence for the issue, so the count is live
and a resolved issue re-opens.

Regression examples: each evidence run becomes an example — its input plus 1–3 one-line claims
a correct answer must satisfy.

Verify fix: replay the evidence runs on the app's current code (an experiment with recorded
tools, through the app's runner — e.g. while the fix branch is checked out) and grade each
replay with the check and its example's claims: "3/3 runs no longer show the problem".
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from . import diagnose, experiments, judge, queries, rules
from .db import DB, SPANS, get_client, query
from .engine import CATEGORIES, model_categories

logger = logging.getLogger(__name__)

CHECKS = f"{DB}.issue_checks"
CHECKED = f"{DB}.check_results"
EXAMPLES = f"{DB}.regression_examples"
VERIFY = f"{DB}.fix_verifications"

DDL = [
    f"""
    CREATE TABLE IF NOT EXISTS {CHECKS} (
        project     String,
        issue_id    String,
        status      LowCardinality(String),
        instructions String,
        caught      UInt32,
        evidence    UInt32,
        passed      UInt32,
        clean       UInt32,
        model       String,
        cost        Float64,
        created_at  DateTime64(3, 'UTC'),
        updated_at  DateTime64(3, 'UTC') DEFAULT now64(3)
    ) ENGINE = ReplacingMergeTree(updated_at) ORDER BY issue_id
    """,
    f"""
    CREATE TABLE IF NOT EXISTS {CHECKED} (
        issue_id String,
        trace_id String,
        result   LowCardinality(String),
        reason   String,
        at       DateTime64(3, 'UTC') DEFAULT now64(3)
    ) ENGINE = ReplacingMergeTree(at) ORDER BY (issue_id, trace_id)
    TTL toDateTime(at) + INTERVAL 120 DAY
    """,
    f"""
    CREATE TABLE IF NOT EXISTS {EXAMPLES} (
        project     String,
        issue_id    String,
        trace_id    String,
        request     String,
        claims      String,
        created_at  DateTime64(3, 'UTC') DEFAULT now64(3)
    ) ENGINE = ReplacingMergeTree(created_at) ORDER BY (issue_id, trace_id)
    """,
    f"""
    CREATE TABLE IF NOT EXISTS {VERIFY} (
        project       String,
        issue_id      String,
        experiment_id String,
        status        LowCardinality(String),
        results       String,
        created_at    DateTime64(3, 'UTC'),
        updated_at    DateTime64(3, 'UTC') DEFAULT now64(3)
    ) ENGINE = ReplacingMergeTree(updated_at) ORDER BY issue_id
    """,
]

AI_KINDS = tuple(model_categories())
TEST_EVIDENCE = 5     # evidence runs a new check is tested on
TEST_CLEAN = 5        # clean runs it must pass
MIN_CATCH = 0.6
MIN_PASS = 0.8
PER_SCAN = 12         # new runs each active check reads per scan
_running: set[str] = set()
_tasks: set[asyncio.Task] = set()


def _now():
    return diagnose._now()


def _spawn(coro) -> None:
    task = asyncio.get_running_loop().create_task(coro)
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


# ── Reading a run with a check ──────────────────────────────────────────────

RUN_SYSTEM = """You check one run of an AI agent application for one specific problem.

The problem: {title}
{description}

The check:
{instructions}
{claims}
Reply with JSON only: {{"result": "fail" | "pass" | "skip", "reason": "<one sentence with the evidence>"}}
- fail: the run shows the problem{claims_fail}.
- pass: the situation the check is about comes up and the run handles it correctly.
- skip: the situation doesn't come up in this run."""


async def run_check(check: dict[str, Any], issue: dict[str, Any], spans: list[dict[str, Any]], cfg: dict[str, str],
                    claims: list[str] | None = None) -> tuple[str, str, float]:
    """(result, reason, cost) for one run."""
    from .investigator import earlier_turns, evidence_context
    context = evidence_context(spans, None, tools_budget=15_000, history=await earlier_turns(spans))
    claim_text = ("\nThis run is a regression example; a correct run must also satisfy:\n" + "\n".join(f"- {c}" for c in claims)
                  if claims else "")
    msgs = [{"role": "system", "content": RUN_SYSTEM.format(
                title=issue["title"], description=issue.get("message", ""), instructions=check["instructions"],
                claims=claim_text, claims_fail=" or breaks one of those claims" if claims else "")},
            {"role": "user", "content": context}]
    text, cost = await asyncio.to_thread(judge._call, msgs, cfg, max_tokens=4000, timeout=120, title="imagent check")
    try:
        d = diagnose._json(text, "result")
    except ValueError:
        return "skip", "the check's reply couldn't be read", cost
    res = str(d.get("result", "skip")).lower()
    return (res if res in ("fail", "pass", "skip") else "skip"), str(d.get("reason", ""))[:500], cost


# ── Writing and testing a check ─────────────────────────────────────────────

PROPOSE = """You write an automatic check for a problem found in an AI agent application, and a
regression example for each run that showed it.

The problem ({category}): {title}
{description}

How it showed up in each evidence run (the investigator's notes):
{notes}
{previous}
Write the check as instructions for a reviewer who reads ONE run: when the check applies, exactly
what makes the run FAIL (the problem is present), and what a correct run looks like (PASS). Be specific
to this problem, not the whole category. Then, for each evidence run, write 1–3 one-sentence claims
a correct answer to that run's request must satisfy.

Reply with JSON only:
{{"check": "<the instructions, 3–8 sentences>",
  "examples": [{{"run": "<run id>", "claims": ["...", "..."]}}]}}"""


async def propose(issue_id: str) -> dict[str, Any]:
    """Write, test (and once revise) a check for an issue; save it and the regression examples."""
    from . import projects, screener
    issue = await diagnose.get_issue(issue_id)
    if not issue:
        raise ValueError("issue not found")
    if issue["kind"] not in AI_KINDS:
        raise ValueError("this issue's rule check already finds every new case")
    proj = await projects.get(issue["project"])
    base = judge.config_for(proj)
    if base is None:
        raise ValueError("no AI model key — set one under Settings › AI model")
    from .engine import settings as engine_settings
    es = engine_settings(proj)
    cfg = base | {"model": es.get("investigator_model") or base["model"]}
    check_cfg = base | {"model": es.get("screener_model") or base["model"]}
    ev = await query(f"""
        SELECT trace_id, any(note) AS note, any(detail) AS detail FROM {rules.SIGNALS} FINAL
        WHERE issue_id = {{i:String}} AND verdict = 'confirmed' GROUP BY trace_id LIMIT {{n:UInt32}}""",
                     {"i": issue_id, "n": TEST_EVIDENCE})
    if not ev:
        raise ValueError("no evidence runs to test a check on")
    clean = await query(f"""
        SELECT s.trace_id AS trace_id FROM {screener.SCREENED} AS s
        INNER JOIN (SELECT trace_id FROM {SPANS} WHERE project = {{p:String}} AND is_root = 1
                    AND (agent_name = {{a:String}} OR name = {{a:String}})) AS r ON r.trace_id = s.trace_id
        WHERE s.project = {{p:String}} AND s.flagged = 0
        ORDER BY s.screened_at DESC LIMIT {{n:UInt32}}""",
                        {"p": issue["project"], "a": issue["agent"] or issue["location"], "n": TEST_CLEAN})
    notes = "\n".join(f"- run {e['trace_id'][:10]}: {e['note'] or e['detail']}" for e in ev)
    cost, previous, best = 0.0, "", None
    for attempt in range(2):
        msg = PROPOSE.format(category=CATEGORIES.get(issue["kind"], {}).get("label", issue["kind"]), title=issue["title"],
                             description=issue.get("message", ""), notes=notes, previous=previous)
        text, c = await asyncio.to_thread(judge._call, [{"role": "user", "content": msg}], cfg, max_tokens=8000,
                                          timeout=180, title="imagent check writer")
        cost += c
        d = diagnose._json(text, "check")
        check = {"instructions": str(d.get("check", ""))[:4000]}
        examples = {str(x.get("run", ""))[:10]: [str(c)[:300] for c in (x.get("claims") or [])][:3]
                    for x in d.get("examples") or [] if isinstance(x, dict)}
        caught, passed, misses = 0, 0, []
        for e in ev:
            res, why, c = await run_check(check, issue, await queries.get_trace(e["trace_id"]), check_cfg)
            cost += c
            caught += res == "fail"
            if res != "fail":
                misses.append(f"- evidence run {e['trace_id'][:10]} should FAIL but got {res}: {why}")
        for r in clean:
            res, why, c = await run_check(check, issue, await queries.get_trace(r["trace_id"]), check_cfg)
            cost += c
            passed += res != "fail"
            if res == "fail":
                misses.append(f"- clean run {r['trace_id'][:10]} should PASS or SKIP but failed: {why}")
        score = {"caught": caught, "evidence": len(ev), "passed": passed, "clean": len(clean)}
        good = caught >= MIN_CATCH * len(ev) and (not clean or passed >= MIN_PASS * len(clean))
        best = (check, examples, score, good)
        if good or not misses:
            break
        previous = "\nYour previous check made these mistakes — fix them:\n" + "\n".join(misses[:8]) + \
                   f"\nPrevious check:\n{check['instructions']}\n"
    check, examples, score, good = best
    row = {"project": issue["project"], "issue_id": issue_id, "status": "active" if good else "draft",
           "instructions": check["instructions"], **score, "model": check_cfg["model"], "cost": round(cost, 5),
           "created_at": _now()}
    client = await get_client()
    cols = list(row)
    await client.insert(CHECKS, [[row[c] for c in cols]], column_names=cols, settings={"async_insert": 0})
    ex_rows = []
    for e in ev:
        spans = await queries.get_trace(e["trace_id"])
        root = diagnose.compare.agent_span(spans) or {}
        req = diagnose.compare.readable(root.get("input", ""), roles=("user", "human"))[:4000]
        ex_rows.append([issue["project"], issue_id, e["trace_id"], req, json.dumps(examples.get(e["trace_id"][:10], []))])
    if ex_rows:
        await client.insert(EXAMPLES, ex_rows, column_names=["project", "issue_id", "trace_id", "request", "claims"],
                            settings={"async_insert": 0})
    from .screener import _usage
    await _usage(issue["project"], "check", cfg["model"], len(ev) + len(clean), cost)
    return row


def start_propose(issue_id: str) -> bool:
    if f"propose:{issue_id}" in _running:
        return False
    _running.add(f"propose:{issue_id}")

    async def go():
        try:
            await propose(issue_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("check for %s failed: %s", issue_id, exc)
            client = await get_client()
            i = await diagnose.get_issue(issue_id)
            if i:
                await client.insert(CHECKS, [[i["project"], issue_id, "failed", str(exc)[:1000], 0, 0, 0, 0, "", 0.0, _now()]],
                                    column_names=["project", "issue_id", "status", "instructions", "caught", "evidence",
                                                  "passed", "clean", "model", "cost", "created_at"], settings={"async_insert": 0})
        finally:
            _running.discard(f"propose:{issue_id}")
    _spawn(go())
    return True


async def get_check(issue_id: str) -> dict[str, Any] | None:
    rows = await query(f"SELECT * FROM {CHECKS} FINAL WHERE issue_id = {{i:String}}", {"i": issue_id})
    if not rows:
        return {"status": "writing"} if f"propose:{issue_id}" in _running else None
    return rows[0] | ({"status": "writing"} if f"propose:{issue_id}" in _running else {})


async def set_check_status(issue_id: str, status: str) -> dict[str, Any] | None:
    c = await get_check(issue_id)
    if not c or c.get("status") == "writing":
        return None
    c = {k: c[k] for k in ("project", "issue_id", "instructions", "caught", "evidence", "passed", "clean", "model", "cost", "created_at")}
    c["status"] = status
    client = await get_client()
    await client.insert(CHECKS, [list(c.values())], column_names=list(c), settings={"async_insert": 0})
    return c


async def examples(issue_id: str) -> list[dict[str, Any]]:
    rows = await query(f"SELECT trace_id, request, claims FROM {EXAMPLES} FINAL WHERE issue_id = {{i:String}}", {"i": issue_id})
    return [r | {"claims": json.loads(r["claims"] or "[]")} for r in rows]


# ── Running checks on new runs ──────────────────────────────────────────────

async def run_active(project: str, proj: dict[str, Any], es: dict[str, Any], days: int) -> dict[str, Any]:
    """Each active check reads a few new runs of its agent; failures become evidence."""
    from .screener import _usage, month_spend
    base = judge.config_for(proj)
    if base is None:
        return {"checked": 0}
    cfg = base | {"model": es.get("screener_model") or base["model"]}
    checks = await query(f"""
        SELECT c.* FROM {CHECKS} AS c FINAL
        INNER JOIN (SELECT id, status FROM {diagnose.ISSUES} FINAL) AS i ON i.id = c.issue_id
        WHERE c.project = {{p:String}} AND c.status = 'active' AND i.status NOT IN ('ignored', 'incorrect')""", {"p": project})
    spent = await month_spend(project)
    cost, checked, failed = 0.0, 0, 0
    for c in checks:
        issue = await diagnose.get_issue(c["issue_id"])
        if not issue:
            continue
        runs = await query(f"""
            SELECT trace_id, agent_name, start_time FROM {SPANS}
            WHERE project = {{p:String}} AND is_root = 1 AND origin = '' AND kind != 'tool'
              AND (agent_name = {{a:String}} OR name = {{a:String}})
              AND start_time >= greatest(now() - INTERVAL {{d:UInt32}} DAY, {{since:DateTime64(3)}})
              AND trace_id NOT IN (SELECT trace_id FROM {CHECKED} WHERE issue_id = {{i:String}})
              AND trace_id NOT IN (SELECT trace_id FROM {rules.SIGNALS} WHERE issue_id = {{i:String}})
            ORDER BY start_time DESC LIMIT {{n:UInt32}}""",
                           {"p": project, "a": issue["agent"] or issue["location"], "d": days, "i": c["issue_id"],
                            "since": c["created_at"].replace(tzinfo=None), "n": PER_SCAN})
        results = []
        for r in runs:
            if spent + cost >= es["monthly_cap_usd"]:
                break
            spans = await queries.get_trace(r["trace_id"])
            try:
                res, why, cc = await run_check(c, issue, spans, cfg)
            except Exception as exc:  # noqa: BLE001
                logger.warning("check %s on %s failed: %s", c["issue_id"], r["trace_id"], exc)
                continue
            cost += cc
            checked += 1
            results.append([c["issue_id"], r["trace_id"], res, why])
            if res == "fail":
                failed += 1
                root = diagnose.compare.agent_span(spans) or {}
                sig = rules._signal(project, {"trace_id": r["trace_id"], "span_id": root.get("span_id", r["trace_id"]),
                                              "agent_name": r["agent_name"], "thread_id": "", "start_time": r["start_time"]},
                                    issue["kind"], "check", "check:" + c["issue_id"], issue["location"], 1, why)
                await rules.save_signals([sig | {"issue_id": c["issue_id"], "verdict": "confirmed", "note": why}])
        if results:
            client = await get_client()
            await client.insert(CHECKED, results, column_names=["issue_id", "trace_id", "result", "reason"], settings={"async_insert": 0})
    if checked:
        await _usage(project, "check", cfg["model"], checked, cost)
    return {"checked": checked, "failed": failed, "cost": round(cost, 4)}


# ── Verify a fix ────────────────────────────────────────────────────────────

async def start_verify(issue_id: str) -> dict[str, Any]:
    """Replay the issue's regression examples on the app's current code."""
    issue = await diagnose.get_issue(issue_id)
    if not issue:
        raise ValueError("issue not found")
    check = await get_check(issue_id)
    if not check or check.get("status") not in ("active", "draft"):
        raise ValueError("create a check for this issue first")
    ex = await examples(issue_id)
    if not ex:
        raise ValueError("this issue has no regression examples yet")
    first = await queries.get_trace(ex[0]["trace_id"])
    root = diagnose.compare.agent_span(first) or {}
    agent = root.get("name") or issue["agent"]
    runners = [r for r in experiments.runners(issue["project"]) if any(a["name"] == agent for a in r.get("agents", []))]
    if not runners:
        raise ValueError(f"no app is connected that can replay '{agent}' — start your app with IMAGENT_EXPERIMENTS=true "
                         "(on the fix branch) and try again")
    exp = await experiments.create(name=f"Verify fix: {issue['title'][:80]}", agent=agent, project=issue["project"],
                                   source_trace_ids=[e["trace_id"] for e in ex][:5],
                                   variants=[{"name": "current code", "model": ""}], repeats=1, tool_mode="recorded")
    await _save_verify(issue, exp["id"], "running", [])
    return {"experiment_id": exp["id"], "runs": exp["jobs"]}


async def _save_verify(issue: dict[str, Any], exp_id: str, status: str, results: list[dict[str, Any]]) -> None:
    client = await get_client()
    await client.insert(VERIFY, [[issue["project"], issue["id"], exp_id, status, json.dumps(results, default=str), _now()]],
                        column_names=["project", "issue_id", "experiment_id", "status", "results", "created_at"],
                        settings={"async_insert": 0})


async def get_verify(issue_id: str) -> dict[str, Any] | None:
    rows = await query(f"SELECT * FROM {VERIFY} FINAL WHERE issue_id = {{i:String}}", {"i": issue_id})
    if not rows:
        return None
    r = rows[0]
    return {"experiment_id": r["experiment_id"], "status": r["status"], "results": json.loads(r["results"] or "[]"),
            "updated_at": r["updated_at"]}


async def grade_verifications() -> None:
    """Grade verifications whose replays have all finished."""
    from . import projects
    from .engine import settings as engine_settings
    for v in await query(f"SELECT * FROM {VERIFY} FINAL WHERE status = 'running'"):
        jobs = await experiments._jobs("experiment_id = {e:String}", {"e": v["experiment_id"]})
        if not jobs or any(j["status"] in ("queued", "running") for j in jobs):
            continue
        issue = await diagnose.get_issue(v["issue_id"])
        check = await get_check(v["issue_id"])
        proj = await projects.get(v["project"])
        base = judge.config_for(proj)
        if not issue or not check or base is None:
            continue
        es = engine_settings(proj)
        cfg = base | {"model": es.get("investigator_model") or base["model"]}
        ex = {e["trace_id"]: e["claims"] for e in await examples(v["issue_id"])}
        results, cost = [], 0.0
        for j in jobs:
            if j["status"] != "done" or not j["result_trace_id"]:
                results.append({"source": j["source_trace_id"], "result": "error", "reason": j["error"] or "the replay failed"})
                continue
            spans = await queries.get_trace(j["result_trace_id"])
            res, why, c = await run_check(check, issue, spans, cfg, claims=ex.get(j["source_trace_id"]))
            cost += c
            results.append({"source": j["source_trace_id"], "replay": j["result_trace_id"], "result": res, "reason": why})
        from .screener import _usage
        await _usage(v["project"], "verify", cfg["model"], len(results), cost)
        await _save_verify(issue, v["experiment_id"], "done", results)


async def verify_worker(poll_seconds: float = 20.0) -> None:
    while True:
        try:
            await grade_verifications()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("fix verification: %s", exc)
        await asyncio.sleep(poll_seconds)
