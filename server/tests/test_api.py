"""End-to-end: SDK spans → POST /v1/traces → ClickHouse → read API.

Needs a reachable ClickHouse (``docker compose up -d clickhouse``); skipped otherwise.
"""

import urllib.request

import pytest
from fastapi.testclient import TestClient

import harness_moni as hm

from .conftest import otlp_bytes


def _clickhouse_up() -> bool:
    try:
        return urllib.request.urlopen("http://localhost:8123/ping", timeout=1).read().strip() == b"Ok."
    except OSError:
        return False


pytestmark = pytest.mark.skipif(not _clickhouse_up(), reason="ClickHouse not running")


@pytest.fixture(scope="module")
def client():
    from harness_server import db
    from harness_server.main import app

    with TestClient(app) as c:
        c.portal.call(db.query, f"TRUNCATE TABLE {db.SPANS}")
        c.portal.call(db.query, f"TRUNCATE TABLE {db.RUNNING}")
        yield c


def test_ingest_requires_key(client):
    r = client.post("/v1/traces", content=b"", headers={"content-type": "application/x-protobuf"})
    assert r.status_code == 401


def test_roundtrip(client, sdk_spans):
    @hm.observe("lookup_vessel", kind="tool")
    def lookup(imo):
        return {"imo": imo}

    @hm.observe("email_router", kind="agent")
    def router(n):
        if n == 2:
            raise RuntimeError("classifier timeout")
        return lookup(str(n))

    for n in range(3):
        with hm.harness_context(thread_id="thread-A" if n < 2 else "thread-B", user_id="u1", tags=["email"]):
            try:
                router(n)
            except RuntimeError:
                pass

    r = client.post("/v1/traces", content=otlp_bytes(sdk_spans()),
                    headers={"content-type": "application/x-protobuf", "x-harness-key": "ingest-secret"})
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
    @hm.observe("orphan_job", kind="agent")
    def orphan():
        return "no thread here"

    orphan()
    r = client.post("/v1/traces", content=otlp_bytes(sdk_spans()),
                    headers={"content-type": "application/x-protobuf", "x-harness-key": "ingest-secret"})
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
    tr = tp.get_tracer("harness_moni")
    t0 = time.time_ns() - 600 * 10**9          # 10 minutes ago → past the settle window
    ms = 10**6
    base = {"harness.thread_id": "thr-stitch"}

    def span(name, kind, start, end, parent=None, md=None, **attrs):
        ctx = set_span_in_context(parent) if parent is not None else None
        a = {**base, "harness.span_kind": kind, "harness.root": parent is None, **attrs}
        if md:
            a["harness.metadata"] = json.dumps(md)
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
                    headers={"content-type": "application/x-protobuf", "x-harness-key": "ingest-secret"})
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
    @hm.observe("chat_turn", kind="agent")
    def turn(state):
        return {"messages": [*state["messages"], {"role": "assistant", "content": [{"type": "text", "text": "Speed is 12.4 kn."}]}]}

    turn({"messages": [{"role": "system", "content": "You are Bosun."}, {"role": "user", "content": "How fast is  ATLAS?"}]})
    client.post("/v1/traces", content=otlp_bytes(sdk_spans()),
                headers={"content-type": "application/x-protobuf", "x-harness-key": "ingest-secret"})
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

    from harness_moni.pending import PendingSpanProcessor

    done, pending = InMemorySpanExporter(), InMemorySpanExporter()
    tp = TracerProvider(resource=Resource.create({"service.name": "live-test"}))
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    tp.add_span_processor(SimpleSpanProcessor(done))
    proc = PendingSpanProcessor(pending, delay_s=0, interval_s=3600)
    tp.add_span_processor(proc)
    tr = tp.get_tracer("harness_moni")
    post = lambda spans: client.post("/v1/traces", content=encode_spans(spans).SerializeToString(),
                                     headers={"content-type": "application/x-protobuf", "x-harness-key": "ingest-secret"})

    root = tr.start_span("orchestrator", attributes={"harness.span_kind": "agent", "harness.root": True, "harness.thread_id": "thr-live"})
    from opentelemetry.trace import set_span_in_context
    with tr.start_as_current_span("model", context=set_span_in_context(root), attributes={"harness.span_kind": "node", "harness.thread_id": "thr-live"}):
        with tr.start_as_current_span("glm", attributes={"harness.span_kind": "llm", "gen_ai.usage.input_tokens": 100,
                                                         "gen_ai.usage.output_tokens": 5, "harness.thread_id": "thr-live"}):
            pass
    tool = tr.start_span("task", context=set_span_in_context(root), attributes={"harness.span_kind": "tool", "harness.thread_id": "thr-live"})
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


def test_reprice_fixes_unpriced_and_doubled_streamed_names(client):
    import datetime as dt

    from harness_server import db, pricing
    from harness_server.price_sync import reprice

    now = dt.datetime.now(dt.timezone.utc)
    row = dict(zip(db.COLUMNS, [
        "reprice-test", "", "a" * 32, "b" * 16, "", 1, "glm", "llm", "ok", "", now, now, 1.0, "", "", "", "",
        "z-ai/glm-5.3-flashz-ai/glm-5.3-flash", "", 1_000_000, 0, 0, 0, 0.0, "unknown", None, "", "", [], "", {}, "",
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
