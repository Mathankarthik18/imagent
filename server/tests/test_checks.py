import asyncio
import datetime as dt

from imagent_server import checks, judge

T0 = dt.datetime(2026, 11, 1, tzinfo=dt.timezone.utc)
SPANS = [{"span_id": "r", "parent_span_id": "", "name": "orch", "kind": "agent", "status": "ok", "start_time": T0,
          "input": '{"messages": [{"role": "user", "content": "earliest thread with both addresses?"}]}', "output": "",
          "agent_name": "orch", "duration_ms": 1, "events": []},
         {"span_id": "m", "parent_span_id": "r", "name": "m", "kind": "llm", "status": "ok", "start_time": T0, "end_time": T0,
          "input": "", "output": '{"role": "assistant", "content": "Thread X is the earliest."}', "agent_name": "orch",
          "duration_ms": 1, "events": []}]
ISSUE = {"title": "States thread details it never fetched", "message": "…"}


def test_run_check_reads_verdict_and_passes_claims(monkeypatch):
    seen = {}

    def fake(msgs, cfg, **kw):
        seen["sys"] = msgs[0]["content"]
        seen["user"] = msgs[1]["content"]
        return 'Sure: {"result": "FAIL", "reason": "calls X earliest without fetching it"}', 0.002

    monkeypatch.setattr(judge, "_call", fake)
    res, why, cost = asyncio.run(checks.run_check({"instructions": "Fail if…"}, ISSUE, SPANS, {}, claims=["Says it can't confirm order"]))
    assert (res, cost) == ("fail", 0.002) and "earliest" in why
    assert "Says it can't confirm order" in seen["sys"] and "Thread X is the earliest." in seen["user"]

    monkeypatch.setattr(judge, "_call", lambda *a, **k: ('{"result": "maybe"}', 0.0))
    assert asyncio.run(checks.run_check({"instructions": "x"}, ISSUE, SPANS, {}))[0] == "skip"
