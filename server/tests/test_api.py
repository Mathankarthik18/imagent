"""End-to-end: SDK spans → POST /v1/traces → ClickHouse → read API.

Needs a reachable ClickHouse (``docker compose up -d clickhouse``); skipped otherwise.
"""

import urllib.request

import pytest
from fastapi.testclient import TestClient

import imagent

from .conftest import otlp_bytes


def _clickhouse_up() -> bool:
    try:
        return urllib.request.urlopen("http://localhost:8123/ping", timeout=1).read().strip() == b"Ok."
    except OSError:
        return False


pytestmark = pytest.mark.skipif(not _clickhouse_up(), reason="ClickHouse not running")


@pytest.fixture(scope="module")
def client():
    from imagent_server import db
    from imagent_server.main import app

    with TestClient(app) as c:
        c.portal.call(db.query, f"TRUNCATE TABLE {db.SPANS}")
        c.portal.call(db.query, f"TRUNCATE TABLE {db.RUNNING}")
        from imagent_server import experiments as _exp
        c.portal.call(db.query, f"TRUNCATE TABLE IF EXISTS {_exp.JOBS}")
        c.portal.call(db.query, f"TRUNCATE TABLE IF EXISTS {_exp.EXPERIMENTS}")
        from imagent_server import blueprints as _bp
        c.portal.call(db.query, f"TRUNCATE TABLE IF EXISTS {_bp.BLUEPRINTS}")
        from imagent_server import projects as _pr
        c.portal.call(db.query, f"TRUNCATE TABLE IF EXISTS {_pr.PROJECTS}")
        yield c


def test_ingest_requires_key(client):
    r = client.post("/v1/traces", content=b"", headers={"content-type": "application/x-protobuf"})
    assert r.status_code == 401


def test_roundtrip(client, sdk_spans):
    @imagent.observe("lookup_vessel", kind="tool")
    def lookup(imo):
        return {"imo": imo}

    @imagent.observe("email_router", kind="agent")
    def router(n):
        if n == 2:
            raise RuntimeError("classifier timeout")
        return lookup(str(n))

    for n in range(3):
        with imagent.context(thread_id="thread-A" if n < 2 else "thread-B", user_id="u1", tags=["email"]):
            try:
                router(n)
            except RuntimeError:
                pass

    r = client.post("/v1/traces", content=otlp_bytes(sdk_spans()),
                    headers={"content-type": "application/x-protobuf", "x-imagent-key": "ingest-secret"})
    assert r.status_code == 200, r.text

    traces = client.get("/api/traces", params={"project": "bosun-test"}).json()
    assert len(traces["items"]) == 3 and traces["has_more"] is False
    t = traces["items"][0]
    assert t["name"] == "email_router" and t["kind"] == "agent"
    assert t["span_count"] in (1, 2)

    errs = client.get("/api/traces", params={"status": "error"}).json()["items"]
    assert len(errs) == 1 and errs[0]["error_count"] == 1 and errs[0]["thread_id"] == "thread-B"

    found = client.get("/api/traces", params={"q": "lookup_vessel"}).json()["items"]
    assert len(found) == 2

    detail = client.get(f"/api/traces/{t['trace_id']}").json()
    assert {s["name"] for s in detail["spans"]} <= {"email_router", "lookup_vessel"}

    threads = client.get("/api/threads").json()["items"]
    by_id = {th["thread_id"]: th for th in threads}
    assert by_id["thread-A"]["trace_count"] == 2 and by_id["thread-B"]["error_count"] == 1

    thread = client.get("/api/threads/thread-A").json()["items"]
    assert len(thread) == 2 and thread[0]["start_time"] <= thread[1]["start_time"]

    stats = client.get("/api/stats").json()
    assert stats["summary"]["traces"] == 3 and stats["summary"]["error_traces"] == 1
    assert {row["name"] for row in stats["by_tool"]} == {"lookup_vessel"}
    assert stats["errors"][0]["message"].startswith("RuntimeError: classifier timeout")
    assert stats["series"]

    facets = client.get("/api/facets").json()
    assert "bosun-test" in facets["projects"] and "email" in facets["tags"]

    assert client.get("/api/traces/doesnotexist").status_code == 404


def test_thread_grouping_and_summary(client, sdk_spans):
    @imagent.observe("orphan_job", kind="agent")
    def orphan():
        return "no thread here"

    orphan()
    r = client.post("/v1/traces", content=otlp_bytes(sdk_spans()),
                    headers={"content-type": "application/x-protobuf", "x-imagent-key": "ingest-secret"})
    assert r.status_code == 200

    groups = client.get("/api/traces/by-thread", params={"project": "bosun-test"}).json()["items"]
    by_id = {g["thread_id"]: g for g in groups}
    assert set(by_id) == {"thread-A", "thread-B", ""}           # "" = (no thread) bucket
    assert by_id["thread-A"]["trace_count"] == 2 and by_id["thread-A"]["tool_calls"] == 2
    assert by_id["thread-B"]["error_traces"] == 1
    assert by_id[""]["last_trace_name"] == "orphan_job"

    by_errors = client.get("/api/traces/by-thread", params={"project": "bosun-test", "sort": "errors"}).json()["items"]
    assert by_errors[0]["thread_id"] == "thread-B"

    # Threads list excludes the unthreaded bucket and honours status=error
    threads = client.get("/api/threads", params={"status": "error"}).json()["items"]
    assert [t["thread_id"] for t in threads] == ["thread-B"]

    # Expanding a group: unthreaded traces via the sentinel, threaded via id
    none = client.get("/api/traces", params={"project": "bosun-test", "thread_id": "__none__"}).json()["items"]
    assert [t["name"] for t in none] == ["orphan_job"]
    b = client.get("/api/traces", params={"thread_id": "thread-B"}).json()["items"]
    assert b[0]["error_message"].startswith("RuntimeError: classifier timeout")

    summary = client.get("/api/threads/thread-A/summary").json()
    s = summary["summary"]
    assert s["traces"] == 2 and s["tool_calls"] == 2 and s["agents"] == ["email_router"]
    assert summary["by_tool"][0]["name"] == "lookup_vessel"
    assert client.get("/api/threads/nope/summary").status_code == 404


def test_thread_spans_combined_tree(client):
    data = client.get("/api/threads/thread-A/spans").json()
    spans = data["spans"]
    assert data["truncated"] is False
    assert len({s["trace_id"] for s in spans}) == 2                 # both traces of the thread
    assert {s["name"] for s in spans} == {"email_router", "lookup_vessel"}
    assert "input" not in spans[0] and "output" not in spans[0]      # lightweight
    ids = {s["span_id"] for s in spans}
    assert all(s["parent_span_id"] in ids for s in spans if not s["is_root"])


def test_stitch_merges_broken_off_runs_by_time(client):
    """Bosun pattern: the orchestrator trace has its nodes, but every LLM/tool call
    inside them arrived as a separate one-span trace. Stitch merges them by time."""
    import json
    import time

    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
    from opentelemetry.trace import set_span_in_context

    exp = InMemorySpanExporter()
    tp = TracerProvider(resource=Resource.create({"service.name": "stitch-test"}))
    tp.add_span_processor(SimpleSpanProcessor(exp))
    tr = tp.get_tracer("imagent")
    t0 = time.time_ns() - 600 * 10**9          # 10 minutes ago → past the settle window
    ms = 10**6
    base = {"imagent.thread_id": "thr-stitch"}

    def span(name, kind, start, end, parent=None, md=None, **attrs):
        ctx = set_span_in_context(parent) if parent is not None else None
        a = {**base, "imagent.span_kind": kind, "imagent.root": parent is None, **attrs}
        if md:
            a["imagent.metadata"] = json.dumps(md)
        s = tr.start_span(name, context=ctx, start_time=t0 + start * ms, attributes=a)
        return s, end

    def done(pair):
        pair[0].end(end_time=t0 + pair[1] * ms)
        return pair[0]

    root = span("bosun_orchestrator", "agent", 0, 1000, **{"gen_ai.agent.name": "bosun_orchestrator"})
    model = span("model", "node", 5, 100, parent=root[0])
    tools = span("tools", "node", 110, 900, parent=root[0])
    # broken-off: orchestrator LLM call (inside "model")
    llm = span("glm", "llm", 10, 95, md={"langgraph_node": "model", "lc_agent_name": "bosun_orchestrator"})
    # broken-off: the `task` tool (inside "tools") with its subagent graph under it
    task = span("task", "tool", 120, 880, md={"langgraph_node": "tools", "lc_agent_name": "bosun_orchestrator"})
    sub = span("noon_report_ledger", "chain", 121, 879, parent=task[0])
    sub_model = span("model", "node", 130, 400, parent=sub[0])
    # broken-off: the subagent's LLM call (inside the subagent's "model", not the orchestrator's)
    sub_llm = span("glm", "llm", 140, 390, md={"langgraph_node": "model", "lc_agent_name": "noon_report_ledger"})
    for pair in (sub_llm, sub_model, sub, task, llm, tools, model, root):
        done(pair)

    from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
    r = client.post("/v1/traces", content=encode_spans(exp.get_finished_spans()).SerializeToString(),
                    headers={"content-type": "application/x-protobuf", "x-imagent-key": "ingest-secret"})
    assert r.status_code == 200
    before = client.get("/api/traces", params={"project": "stitch-test", "start": "2020-01-01T00:00:00Z"}).json()["items"]
    assert len(before) == 4

    assert client.post("/api/stitch").json()["merged"] == 3

    after = client.get("/api/traces", params={"project": "stitch-test", "start": "2020-01-01T00:00:00Z"}).json()["items"]
    assert len(after) == 1 and after[0]["name"] == "bosun_orchestrator" and after[0]["span_count"] == 8
    spans = {(s["name"], s["kind"], s["start_time"]): s for s in client.get(f"/api/traces/{after[0]['trace_id']}").json()["spans"]}
    by_id = {s["span_id"]: s for s in spans.values()}
    llms = sorted((s for s in spans.values() if s["kind"] == "llm"), key=lambda s: s["start_time"])
    assert by_id[llms[0]["parent_span_id"]]["name"] == "model"                     # orchestrator's model node
    assert by_id[by_id[llms[0]["parent_span_id"]]["parent_span_id"]]["name"] == "bosun_orchestrator"
    assert by_id[llms[1]["parent_span_id"]]["parent_span_id"] == next(s["span_id"] for s in spans.values() if s["name"] == "noon_report_ledger")
    task_span = next(s for s in spans.values() if s["name"] == "task")
    assert by_id[task_span["parent_span_id"]]["name"] == "tools"
    assert sum(1 for s in spans.values() if s["is_root"]) == 1
    assert client.post("/api/stitch").json()["merged"] == 0                        # idempotent


def test_readable_previews_and_latest(client, sdk_spans):
    @imagent.observe("chat_turn", kind="agent")
    def turn(state):
        return {"messages": [*state["messages"], {"role": "assistant", "content": [{"type": "text", "text": "Speed is 12.4 kn."}]}]}

    turn({"messages": [{"role": "system", "content": "You are Bosun."}, {"role": "user", "content": "How fast is  ATLAS?"}]})
    client.post("/v1/traces", content=otlp_bytes(sdk_spans()),
                headers={"content-type": "application/x-protobuf", "x-imagent-key": "ingest-secret"})
    t = next(t for t in client.get("/api/traces", params={"name": "chat_turn"}).json()["items"])
    assert t["input_text"] == "How fast is ATLAS?"
    assert t["output_text"] == "Speed is 12.4 kn."
    assert client.get("/api/latest", params={"project": "bosun-test"}).json()["last_seen"]
    assert client.get("/api/latest", params={"project": "nope"}).json()["last_seen"] is None


def test_running_runs_live_progress(client):
    """A run whose root is still open: SDK sent "started" snapshots, children finished."""
    import time

    from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    from imagent.pending import PendingSpanProcessor

    done, pending = InMemorySpanExporter(), InMemorySpanExporter()
    tp = TracerProvider(resource=Resource.create({"service.name": "live-test"}))
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    tp.add_span_processor(SimpleSpanProcessor(done))
    proc = PendingSpanProcessor(pending, delay_s=0, interval_s=3600)
    tp.add_span_processor(proc)
    tr = tp.get_tracer("imagent")
    post = lambda spans: client.post("/v1/traces", content=encode_spans(spans).SerializeToString(),
                                     headers={"content-type": "application/x-protobuf", "x-imagent-key": "ingest-secret"})

    root = tr.start_span("orchestrator", attributes={"imagent.span_kind": "agent", "imagent.root": True, "imagent.thread_id": "thr-live"})
    from opentelemetry.trace import set_span_in_context
    with tr.start_as_current_span("model", context=set_span_in_context(root), attributes={"imagent.span_kind": "node", "imagent.thread_id": "thr-live"}):
        with tr.start_as_current_span("glm", attributes={"imagent.span_kind": "llm", "gen_ai.usage.input_tokens": 100,
                                                         "gen_ai.usage.output_tokens": 5, "imagent.thread_id": "thr-live"}):
            pass
    tool = tr.start_span("task", context=set_span_in_context(root), attributes={"imagent.span_kind": "tool", "imagent.thread_id": "thr-live"})
    time.sleep(0.01)
    proc.flush_pending()                      # root + tool are still open
    assert post(done.get_finished_spans()).status_code == 200
    assert post(pending.get_finished_spans()).status_code == 200

    runs = client.get("/api/running", params={"project": "live-test"}).json()["runs"]
    assert len(runs) == 1
    r = runs[0]
    assert r["name"] == "orchestrator" and r["thread_id"] == "thr-live" and r["stalled"] is False
    assert r["current"]["name"] == "task" and [p["name"] for p in r["path"]] == ["task"]
    assert r["done"]["llm"] == 1 and r["done"]["tokens"] == 105

    detail = client.get(f"/api/traces/{r['trace_id']}").json()
    assert detail["running"] is True
    assert {s["name"]: s["status"] for s in detail["spans"]} == {"model": "ok", "glm": "ok", "orchestrator": "running", "task": "running"}
    assert client.get("/api/threads/thr-live/spans").json()["running"] is True

    # finishing the run clears it
    tool.end()
    root.end()
    post([s for s in done.get_finished_spans() if s.name in {"task", "orchestrator"}])
    assert client.get("/api/running", params={"project": "live-test"}).json()["runs"] == []
    proc.shutdown()


def test_reaper_closes_runs_that_stopped_reporting(client):
    """The app restarted mid-run: the run's spans never finish. After the timeout the reaper
    closes them as failed, so the run leaves "Running now" and shows up as a failed trace."""
    import time

    from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
    from opentelemetry.trace import set_span_in_context

    from imagent.pending import PendingSpanProcessor
    from imagent_server import live

    pending = InMemorySpanExporter()
    tp = TracerProvider(resource=Resource.create({"service.name": "reap-test"}))
    proc = PendingSpanProcessor(pending, delay_s=0, interval_s=3600)
    tp.add_span_processor(proc)
    tr = tp.get_tracer("imagent")
    root = tr.start_span("orchestrator", attributes={"imagent.span_kind": "agent", "imagent.root": True})
    tr.start_span("glm", context=set_span_in_context(root), attributes={"imagent.span_kind": "llm"})
    time.sleep(0.01)
    proc.flush_pending()
    client.post("/v1/traces", content=encode_spans(pending.get_finished_spans()).SerializeToString(),
                headers={"content-type": "application/x-protobuf", "x-imagent-key": "ingest-secret"})
    runs = client.get("/api/running", params={"project": "reap-test"}).json()["runs"]
    assert len(runs) == 1
    trace_id = runs[0]["trace_id"]

    assert client.portal.call(live.reap_once) == 0  # within the timeout: still running
    assert client.portal.call(live.reap_once, 0) == 2
    assert client.get("/api/running", params={"project": "reap-test"}).json()["runs"] == []
    detail = client.get(f"/api/traces/{trace_id}").json()
    assert detail["running"] is False
    assert {s["name"]: s["status"] for s in detail["spans"]} == {"orchestrator": "error", "glm": "error"}
    assert all(s["status_message"].startswith("Didn't finish") for s in detail["spans"])
    assert client.portal.call(live.reap_once, 0) == 0  # idempotent
    proc.shutdown()


def test_reap_rows_closes_steps_left_open_by_a_finished_run():
    import datetime as dt

    from imagent_server import live

    now = dt.datetime.now(dt.timezone.utc)
    span = {"project": "p", "trace_id": "t", "span_id": "s", "parent_span_id": "r", "is_root": 0, "name": "glm",
            "kind": "llm", "start_time": now - dt.timedelta(minutes=10), "thread_id": "", "user_id": "",
            "agent_name": "", "model": "", "origin": "", "service": "p"}
    finished = {"t": {"last_end": now - dt.timedelta(minutes=9), "root_done": True}}
    rows = live.reap_rows([span], finished, now, timeout_s=3600)
    assert len(rows) == 1 and rows[0][7] == "error" and rows[0][8].startswith("Never finished")
    assert live.reap_rows([span], {"t": {**finished["t"], "root_done": False}}, now, timeout_s=3600) == []
    assert live.reap_rows([span], {"t": {"last_end": now, "root_done": True}}, now, timeout_s=3600) == []  # grace


def test_reprice_fixes_unpriced_and_doubled_streamed_names(client):
    import datetime as dt

    from imagent_server import db, pricing
    from imagent_server.price_sync import reprice

    now = dt.datetime.now(dt.timezone.utc)
    row = dict(zip(db.COLUMNS, [
        "reprice-test", "", "a" * 32, "b" * 16, "", 1, "glm", "llm", "ok", "", now, now, 1.0, "", "", "", "",
        "z-ai/glm-5.3-flashz-ai/glm-5.3-flash", "", 1_000_000, 0, 0, 0, 0.0, "unknown", None, "", "", [], "", {}, "",
        "", "",
    ]))
    client.portal.call(db.insert_spans, [list(row.values())])
    pricing.set_catalog({"glm-5-3-flash": pricing.Price(0.15, 0.5, 0.03)})
    try:
        assert client.portal.call(reprice, 1) >= 1
        r = client.portal.call(db.query, f"SELECT model, cost_usd, cost_source FROM {db.SPANS} WHERE project = 'reprice-test'")[0]
        assert r["model"] == "z-ai/glm-5.3-flash" and r["cost_source"] == "computed"
        assert r["cost_usd"] == pytest.approx(0.15)
        assert client.portal.call(reprice, 1) == 0                            # idempotent
    finally:
        pricing.set_catalog({})


def _post_spans(client, spans):
    from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
    r = client.post("/v1/traces", content=encode_spans(spans).SerializeToString(),
                    headers={"content-type": "application/x-protobuf", "x-imagent-key": "ingest-secret"})
    assert r.status_code == 200


def _agent_run(tracer, tools, answer, *, thread="", root_name="email_router", extra_root=None):
    """Synthetic agent run: root agent → llm → tool calls."""
    import json as _json
    attrs = {"imagent.span_kind": "agent", "imagent.root": True,
             "imagent.input": _json.dumps({"messages": [{"role": "user", "content": "Noon report NORD KUDU"}]}),
             "imagent.output": _json.dumps({"messages": [{"role": "assistant", "content": answer}]}), **(extra_root or {})}
    if thread:
        attrs["imagent.thread_id"] = thread
    with tracer.start_as_current_span(root_name, attributes=attrs) as root:
        with tracer.start_as_current_span("glm", attributes={"imagent.span_kind": "llm", "gen_ai.request.model": "x",
                                                            "imagent.input": _json.dumps([{"role": "user", "content": "Noon report NORD KUDU"}]),
                                                            "gen_ai.usage.input_tokens": 100, "gen_ai.usage.output_tokens": 10}):
            pass
        for name, args, out in tools:
            with tracer.start_as_current_span(name, attributes={"imagent.span_kind": "tool", "imagent.input": _json.dumps(args),
                                                                "imagent.output": _json.dumps({"role": "tool", "content": out})}):
                pass
    return format(root.get_span_context().trace_id, "032x")


def test_compare_and_experiment_lifecycle(client):
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    exp_ = InMemorySpanExporter()
    tp = TracerProvider(resource=Resource.create({"service.name": "exp-test"}))
    tp.add_span_processor(SimpleSpanProcessor(exp_))
    tr = tp.get_tracer("imagent")
    src = _agent_run(tr, [("lookup_vessel", {"name": "NORD KUDU"}, "imo 9623740"), ("create_task", {"title": "Check noon"}, "T-1")],
                     "Created task T-1.")
    _post_spans(client, exp_.get_finished_spans())
    exp_.clear()

    # Phase 1: compare two runs directly
    other = _agent_run(tr, [("lookup_vessel", {"name": "NORD KUDU"}, "imo 9623740")], "No task needed.")
    _post_spans(client, exp_.get_finished_spans())
    exp_.clear()
    c = client.get("/api/compare", params={"a": src, "b": other}).json()
    assert c["missing_tools"] == ["create_task"] and c["extra_tools"] == [] and c["verdict"] == "diverged"
    assert [r["status"] for r in c["rows"]] == ["same", "only_a"]
    assert c["outputs"]["a"] == "Created task T-1." and c["metrics"]["a"]["tool_calls"] == 2

    # Phase 2: no runner → can't create
    body = {"agent": "email", "project": "exp-test", "source_trace_ids": [src],
            "variants": [{"name": "glm", "model": "z-ai/glm"}], "repeats": 1}
    assert client.post("/api/experiments", json={**body, "project": ""}).status_code == 422
    key = {"x-imagent-key": "ingest-secret"}
    agents = [{"name": "email", "source_root": "email_router"}]
    assert client.post("/api/runner/claim", json={"runner_id": "r1", "agents": agents, "project": "exp-test"}, headers=key).status_code == 204
    assert client.get("/api/runners", params={"project": "exp-test"}).json()[0]["agents"][0]["name"] == "email"
    assert client.get("/api/runners", params={"project": "other"}).json() == []
    assert client.post("/api/runner/claim", json={"runner_id": "r1", "agents": agents, "project": "exp-test"}).status_code == 401  # needs ingest key

    created = client.post("/api/experiments", json=body).json()
    assert created["jobs"] == 1
    job = client.post("/api/runner/claim", json={"runner_id": "r1", "agents": agents, "project": "exp-test"}, headers=key).json()
    assert job["variant"]["model"] == "z-ai/glm" and job["source"]["trace_id"] == src
    assert [f["name"] for f in job["fixtures"]] == ["lookup_vessel", "create_task"]
    assert job["fixtures"][0]["output"] == "imo 9623740"
    assert job["history"] == [{"role": "user", "content": "Noon report NORD KUDU"}]
    assert job["thread_id"].startswith("experiment:")
    assert client.post("/api/runner/claim", json={"runner_id": "r1", "agents": agents, "project": "exp-test"}, headers=key).status_code == 204

    # The runner's replay: same lookup (recorded), skipped the task → a regression vs baseline.
    res = _agent_run(tr, [("lookup_vessel", {"name": "NORD KUDU"}, "imo 9623740")], "No task needed.",
                     thread=job["thread_id"], root_name="replay:email")
    _post_spans(client, exp_.get_finished_spans())
    client.post("/api/runner/complete", json={"job_id": job["job_id"], "trace_id": res, "status": "ok", "output": "No task needed."},
                headers=key)

    d = client.get(f"/api/experiments/{created['id']}").json()
    assert d["status"] == "done" and d["sources"][0]["input_text"] == "Noon report NORD KUDU"
    score = d["jobs"][0]["score"]
    assert score["verdict"] == "diverged" and score["missing_tools"] == ["create_task"]
    assert score["metrics"]["tool_calls"] == 1 and score["baseline_metrics"]["tool_calls"] == 2
    lst = client.get("/api/experiments", params={"project": "exp-test"}).json()
    assert lst[0]["jobs"]["done"] == 1 and lst[0]["variants"] == ["glm"]

    # Replays stay in their project, marked as experiments, and never inflate normal views.
    since = {"project": "exp-test", "start": "2020-01-01T00:00:00Z"}
    names = [t["name"] for t in client.get("/api/traces", params=since).json()["items"]]
    assert "replay:email" not in names and "email_router" in names
    exp_names = [t["name"] for t in client.get("/api/traces", params={**since, "origin": "experiment"}).json()["items"]]
    assert exp_names == ["replay:email"]
    assert client.get("/api/experiments", params={"project": "other"}).json() == []


def test_blueprint_publish_and_live_stats(client):
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    bp = {"schema": 1, "framework": "deepagents", "versions": {"deepagents": "0.7.9"}, "root": {
        "name": "router", "description": "", "model": {"name": "x", "class": "C", "provider": "p", "params": {}},
        "system_prompt": "You route.", "middleware": [{"name": "ToolErrorMiddleware", "hooks": []}],
        "graph": {"nodes": [{"id": "model", "type": "model"}], "edges": []},
        "tools": [{"name": "lookup_vessel", "description": "", "args": ["name"], "builtin": False},
                  {"name": "never_used", "description": "", "args": [], "builtin": False}],
        "subagents": [{"name": "noon_agent", "description": "Noon reports", "model": None, "system_prompt": "",
                       "middleware": [], "graph": {"nodes": [], "edges": []}, "tools": [], "subagents": []}]}}
    key = {"x-imagent-key": "ingest-secret"}
    body = {"project": "bp-test", "name": "router", "hash": "h1", "blueprint": bp}
    assert client.post("/api/blueprints", json=body).status_code == 401
    assert client.post("/api/blueprints", json=body, headers=key).json()["changed"] is True
    assert client.post("/api/blueprints", json=body, headers=key).json()["changed"] is False

    exp_ = InMemorySpanExporter()
    tp = TracerProvider(resource=Resource.create({"service.name": "bp-test"}))
    tp.add_span_processor(SimpleSpanProcessor(exp_))
    tr, who = tp.get_tracer("imagent"), {"gen_ai.agent.name": "router"}  # the SDK stamps every span with its agent
    with tr.start_as_current_span("router", attributes={"imagent.span_kind": "agent", "imagent.root": True, **who}):
        with tr.start_as_current_span("x", attributes={"imagent.span_kind": "llm", "gen_ai.request.model": "x", **who}):
            pass
        with tr.start_as_current_span("lookup_vessel", attributes={"imagent.span_kind": "tool", **who}):
            pass
        # A sub-agent run as older SDKs recorded it: a `chain` under the `task` tool, every span
        # inside still stamped with the main agent's name.
        with tr.start_as_current_span("tools", attributes={"imagent.span_kind": "node", **who}):
            with tr.start_as_current_span("task", attributes={"imagent.span_kind": "tool", **who}):
                with tr.start_as_current_span("noon_agent", attributes={"imagent.span_kind": "chain", **who}):
                    with tr.start_as_current_span("model", attributes={"imagent.span_kind": "node", **who}):
                        with tr.start_as_current_span("y", attributes={"imagent.span_kind": "llm", "gen_ai.request.model": "y", **who}):
                            pass
                    with tr.start_as_current_span("tools", attributes={"imagent.span_kind": "node", **who}):
                        with tr.start_as_current_span("noon_lookup", attributes={"imagent.span_kind": "tool", **who}):
                            pass
    _post_spans(client, exp_.get_finished_spans())

    listed = [b for b in client.get("/api/blueprints").json() if b["project"] == "bp-test"]
    assert listed[0]["agents"] == 2 and listed[0]["tools"] == 2 and listed[0]["framework"] == "deepagents"
    got = client.get("/api/blueprints/bp-test/router").json()
    assert got["blueprint"]["root"]["subagents"][0]["name"] == "noon_agent"
    s = got["stats"]["router"]
    assert s["runs"] == 1 and s["llm_calls"] == 1 and s["models"][0]["model"] == "x"
    assert s["tools"]["lookup_vessel"]["calls"] == 1 and "never_used" not in s["tools"]
    assert "noon_lookup" not in s["tools"] and [m["model"] for m in s["models"]] == ["x"]
    sub = got["stats"]["noon_agent"]
    assert sub["runs"] == 1 and sub["llm_calls"] == 1 and sub["models"][0]["model"] == "y"
    assert list(sub["tools"]) == ["noon_lookup"]
    assert client.get("/api/blueprints/bp-test/nope").status_code == 404


def test_project_key_routes_spans_blueprint_and_runner(client):
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    created = client.post("/api/projects", json={"name": "Fleet Ops"}).json()
    pid, key = created["id"], {"x-imagent-key": created["key"]}
    assert pid == "fleet-ops" and created["key"].startswith("imk_") and created["key_hint"] in created["key_hint"]
    assert client.post("/api/projects", json={"name": "Fleet Ops"}).json()["id"] == "fleet-ops-2"  # never collides

    # Two services of one app, sending with the project key, land in the same project.
    for service in ("fleet-api", "fleet-worker"):
        exp_ = InMemorySpanExporter()
        tp = TracerProvider(resource=Resource.create({"service.name": service}))
        tp.add_span_processor(SimpleSpanProcessor(exp_))
        _agent_run(tp.get_tracer("imagent"), [], "ok", root_name=f"run-{service}")
        from .conftest import otlp_bytes
        r = client.post("/v1/traces", content=otlp_bytes(exp_.get_finished_spans()),
                        headers={**key, "content-type": "application/x-protobuf"})
        assert r.status_code == 200
    names = {t["name"] for t in client.get("/api/traces", params={"project": pid, "start": "2020-01-01T00:00:00Z"}).json()["items"]}
    assert names == {"run-fleet-api", "run-fleet-worker"}
    listed = {p["id"]: p for p in client.get("/api/projects").json()["projects"]}
    assert sorted(listed[pid]["services"]) == ["fleet-api", "fleet-worker"] and listed[pid]["runs_total"] == 2
    assert "key" not in listed[pid] and "key_hash" not in listed[pid]

    # Blueprint + runner pick the project from the key, ignoring what the body claims.
    bp = {"schema": 1, "framework": "langgraph", "versions": {}, "root": {"name": "ops", "description": "", "model": None,
          "system_prompt": "", "middleware": [], "graph": {"nodes": [], "edges": []}, "tools": [], "subagents": []}}
    client.post("/api/blueprints", json={"project": "spoofed", "name": "ops", "hash": "h", "blueprint": bp}, headers=key)
    assert [b["name"] for b in client.get("/api/blueprints", params={"project": pid}).json()] == ["ops"]
    assert client.get("/api/blueprints", params={"project": "spoofed"}).json() == []
    client.post("/api/runner/claim", json={"runner_id": "rk", "agents": [{"name": "ops"}], "project": "spoofed"}, headers=key)
    assert [r["runner_id"] for r in client.get("/api/runners", params={"project": pid}).json()] == ["rk"]

    # Unknown / rotated keys are refused.
    assert client.post("/v1/traces", content=b"", headers={"x-imagent-key": "imk_nope"}).status_code == 401
    rotated = client.post(f"/api/projects/{pid}/rotate-key").json()
    assert rotated["key"] != created["key"]
    assert client.post("/api/blueprints", json={"name": "ops", "hash": "h", "blueprint": bp}, headers=key).status_code == 401

    # Existing data can be adopted by a project under its current name.
    adopted = client.post("/api/projects", json={"name": "Bosun test", "adopt": "bosun-test"}).json()
    assert adopted["id"] == "bosun-test"
    assert client.post("/api/projects", json={"name": "again", "adopt": "bosun-test"}).status_code == 409
    renamed = client.patch("/api/projects/bosun-test", json={"name": "Bosun (test)"}).json()
    assert renamed["name"] == "Bosun (test)"
    assert "bosun-test" not in {u["id"] for u in client.get("/api/projects").json()["unclaimed"]}


def test_judge_and_review_decide_which_answer_is_better(client):
    import json as _json
    from unittest.mock import patch

    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    from imagent_server import experiments, judge

    exp_ = InMemorySpanExporter()
    tp = TracerProvider(resource=Resource.create({"service.name": "judge-test"}))
    tp.add_span_processor(SimpleSpanProcessor(exp_))
    tr = tp.get_tracer("imagent")
    src = _agent_run(tr, [("lookup_vessel", {"name": "BOA"}, "noon 19 Aug")], "I don't know.")
    _post_spans(client, exp_.get_finished_spans())
    exp_.clear()

    key = {"x-imagent-key": "ingest-secret"}
    agents = [{"name": "jbot", "source_root": "email_router"}]
    body = {"agent": "jbot", "project": "judge-test", "source_trace_ids": [src], "variants": [{"name": "new", "model": "m"}]}
    created = client.post("/api/experiments", json=body).json()
    job = client.post("/api/runner/claim", json={"runner_id": "rj", "agents": agents, "project": "judge-test"}, headers=key).json()
    res = _agent_run(tr, [("lookup_vessel", {"name": "BOA"}, "noon 19 Aug")], "Last noon report: 19 Aug.", thread=job["thread_id"])
    _post_spans(client, exp_.get_finished_spans())
    client.post("/api/runner/complete", json={"job_id": job["job_id"], "trace_id": res, "status": "ok"}, headers=key)

    # The judge sees X/Y in random order; its "X"/"Y" answer is mapped back to original/new.
    seen = {}

    def fake_call(messages, cfg=None):
        seen["prompt"], seen["cfg"] = messages[1]["content"], cfg
        return _json.dumps({"better": "Y", "reason": "Y uses the tool data.",
                            "scores": {"X": {"correct": 2, "complete": 2, "clear": 4}, "Y": {"correct": 5, "complete": 5, "clear": 5}}}), 0.004
    with patch.object(judge, "_call", side_effect=fake_call), patch("random.random", return_value=0.9):  # no flip: X = original
        verdict = client.portal.call(judge.judge_pair, src, res, "Always give dates as DD MMM YYYY.")
    assert verdict["better"] == "new" and verdict["scores"]["new"]["correct"] == 5 and verdict["cost"] == 0.004
    assert "noon 19 Aug" in seen["prompt"] and "Last noon report: 19 Aug." in seen["prompt"] and "I don't know." in seen["prompt"]
    with patch.object(judge, "_call", side_effect=fake_call), patch("random.random", return_value=0.1):  # flipped: X = new
        assert client.portal.call(judge.judge_pair, src, res, "")["better"] == "original"

    # The worker's own query finds it (all projects, and filtered to projects with a judge).
    assert job["job_id"] in [j["id"] for j in client.portal.call(lambda: experiments.unjudged(limit=50))]
    assert [j["id"] for j in client.portal.call(lambda: experiments.unjudged(projects=["judge-test"]))] == [job["job_id"]]
    assert client.portal.call(lambda: experiments.unjudged(projects=["other"])) == []
    client.portal.call(experiments.save_judgement, job["job_id"], verdict)
    assert client.portal.call(lambda: experiments.unjudged(projects=["judge-test"])) == []
    d = client.get(f"/api/experiments/{created['id']}").json()
    assert d["jobs"][0]["judgement"]["better"] == "new"
    lst = client.get("/api/experiments", params={"project": "judge-test"}).json()
    assert lst[0]["results"][0]["better"] == {"new": 1, "tie": 0, "original": 0}

    # A person's review wins over the judge; clearing it falls back to the judge.
    assert client.post(f"/api/experiments/jobs/{job['job_id']}/review", json={"better": "original", "note": "wrong vessel"}).json()["ok"]
    lst = client.get("/api/experiments", params={"project": "judge-test"}).json()
    assert lst[0]["results"][0]["better"] == {"new": 0, "tie": 0, "original": 1}
    client.post(f"/api/experiments/jobs/{job['job_id']}/review", json={"better": None})
    assert client.get("/api/experiments", params={"project": "judge-test"}).json()[0]["results"][0]["better"]["new"] == 1
    assert client.post("/api/experiments/jobs/nope/review", json={"better": "tie"}).status_code == 404



def test_project_sets_its_own_judge_key_and_model(client):
    from unittest.mock import patch

    from imagent_server import judge

    pid = client.post("/api/projects", json={"name": "Judge cfg"}).json()["id"]
    assert client.get("/api/judge", params={"project": pid}).json()["configured"] is False

    p = client.patch(f"/api/projects/{pid}", json={"judge_key": "sk-or-v1-secretsecret1234", "judge_model": "anthropic/claude-opus-5.5"}).json()
    assert p["judge_key_hint"] == "sk-or-…1234" and "judge_key" not in p                # never echoed back
    assert "secretsecret" not in str(client.get(f"/api/projects/{pid}").json())
    assert "secretsecret" not in str(client.get("/api/projects").json())
    st = client.get("/api/judge", params={"project": pid}).json()
    assert st == {"configured": True, "model": "anthropic/claude-opus-5.5", "source": "project", "base_url": "https://openrouter.ai/api/v1"}

    calls = []
    with patch.object(judge, "_call", side_effect=lambda m, cfg=None: calls.append(cfg) or ('{"ok": true}', 0.0001)):
        assert client.post(f"/api/projects/{pid}/judge/test", json={}).json()["ok"] is True             # the saved key
        client.post(f"/api/projects/{pid}/judge/test", json={"key": "sk-new", "model": "x/y"})          # a key not saved yet
    assert calls[0]["key"] == "sk-or-v1-secretsecret1234" and calls[1] == {**calls[1], "key": "sk-new", "model": "x/y"}

    client.patch(f"/api/projects/{pid}", json={"judge_key": ""})                           # remove it
    assert client.get("/api/judge", params={"project": pid}).json()["configured"] is False
    assert client.post(f"/api/projects/{pid}/judge/test", json={}).json()["ok"] is False


def test_live_jobs_wait_for_a_live_connection(client):
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    exp_ = InMemorySpanExporter()
    tp = TracerProvider(resource=Resource.create({"service.name": "live-test"}))
    tp.add_span_processor(SimpleSpanProcessor(exp_))
    src = _agent_run(tp.get_tracer("imagent"), [], "ok")
    _post_spans(client, exp_.get_finished_spans())

    key = {"x-imagent-key": "ingest-secret"}
    body = {"agent": "lbot", "project": "live-test", "source_trace_ids": [src], "variants": [{"name": "v", "model": "m"}]}
    live = client.post("/api/experiments", json={**body, "tool_mode": "live"}).json()
    claim = {"runner_id": "rl", "agents": [{"name": "lbot"}], "project": "live-test"}

    # No live connection yet (the agent hasn't run since the app started): the live job waits.
    assert client.post("/api/runner/claim", json={**claim, "live_agents": []}, headers=key).status_code == 204
    # A recorded job for the same agent is not held back.
    rec = client.post("/api/experiments", json=body).json()
    got = client.post("/api/runner/claim", json={**claim, "live_agents": []}, headers=key).json()
    assert got["experiment_id"] == rec["id"] and got["tool_mode"] == "recorded"
    # Once the agent has run, the live job goes out.
    got = client.post("/api/runner/claim", json={**claim, "live_agents": ["lbot"]}, headers=key).json()
    assert got["experiment_id"] == live["id"] and got["tool_mode"] == "live"


def test_new_experiment_helpers_agents_in_runs_and_models(client):
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    exp_ = InMemorySpanExporter()
    tp = TracerProvider(resource=Resource.create({"service.name": "helpers-test"}))
    tp.add_span_processor(SimpleSpanProcessor(exp_))
    tr = tp.get_tracer("imagent")
    with tr.start_as_current_span("boss", attributes={"imagent.span_kind": "agent", "imagent.root": True, "gen_ai.agent.name": "boss"}) as root:
        for agent, model in (("boss", "m-big"), ("noon", "m-small"), ("noon", "m-small")):
            with tr.start_as_current_span(model, attributes={"imagent.span_kind": "llm", "gen_ai.request.model": model,
                                                             "gen_ai.agent.name": agent}):
                pass
    _post_spans(client, exp_.get_finished_spans())
    tid = format(root.get_span_context().trace_id, "032x")

    agents = client.get("/api/experiments/source-agents", params={"trace_ids": tid}).json()
    assert {a["agent"]: a["llm_calls"] for a in agents} == {"noon": 2, "boss": 1}
    assert client.get("/api/experiments/source-agents", params={"trace_ids": ""}).json() == []
    c = client.get("/api/experiments/candidates", params={"project": "helpers-test", "root_name": "boss", "agents": "noon"}).json()
    assert c["trace_ids"] == [tid] and c["total"] == 1
    assert client.get("/api/experiments/candidates", params={"project": "helpers-test", "root_name": "boss", "agents": "nobody"}).json()["total"] == 0
    assert client.get("/api/experiments/candidates", params={"project": "helpers-test", "root_name": "boss", "agents": "boss"}).json()["total"] == 1
    m = client.get("/api/models", params={"project": "helpers-test"}).json()
    assert [u["model"] for u in m["used"]] == ["m-small", "m-big"] and isinstance(m["catalog"], list)
