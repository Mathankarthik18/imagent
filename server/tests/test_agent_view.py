import asyncio

from imagent_server import agent_view, diagnose, queries

SPANS = [
    {"span_id": "a", "parent_span_id": "", "trace_id": "t1", "project": "p", "kind": "agent", "name": "fleet_assistant",
     "agent_name": "fleet_assistant", "start_time": "2026-11-26 04:07:43", "duration_ms": 211, "status": "ok",
     "input": '{"messages": [{"role": "user", "content": "Speed of CAPE HARMONY?"}]}', "output": "", "events": []},
    {"span_id": "b", "parent_span_id": "a", "trace_id": "t1", "project": "p", "kind": "tool", "name": "latest_noon_report",
     "start_time": "2026-11-26 04:07:44", "duration_ms": 24, "status": "error",
     "status_message": "TimeoutError: noon_reports query exceeded 5s", "input": '{"vessel": "CAPE HARMONY"}', "output": "",
     "events": [{"attributes": {"exception.stacktrace": "Traceback ...\nTimeoutError: noon_reports query exceeded 5s"}}]},
]


def test_clip_keeps_start_and_end():
    t = "A" * 100 + "MIDDLE" + "Z" * 100
    c = agent_view.clip(t, 50)
    assert c.startswith("A") and c.endswith("Z") and "characters cut" in c and "MIDDLE" not in c


def test_trace_text_has_everything_in_one_page(monkeypatch):
    async def get_trace(t):
        return SPANS

    async def no_issues(t):
        return []

    async def no_diag(t):
        return None

    monkeypatch.setattr(queries, "get_trace", get_trace)
    monkeypatch.setattr(agent_view, "_issues_for_trace", no_issues)
    monkeypatch.setattr(diagnose, "get_diagnosis", no_diag)
    text = asyncio.run(agent_view.trace_text("t1", "https://imagent.example"))
    assert "# imagent run t1" in text and "FAILED" in text
    assert "Speed of CAPE HARMONY?" in text
    assert "TimeoutError: noon_reports query exceeded 5s" in text and "Traceback" in text
    assert "## Tool calls (1)" in text and '{"vessel": "CAPE HARMONY"}' in text
    assert "https://imagent.example/p/p/traces/t1" in text


def test_missing_run_is_none(monkeypatch):
    async def none(t):
        return []

    monkeypatch.setattr(queries, "get_trace", none)
    assert asyncio.run(agent_view.trace_text("nope")) is None
