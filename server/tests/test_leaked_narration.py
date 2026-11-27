import asyncio
import datetime as dt
import json

from imagent_server import agent_view, diagnose, engine, queries, rules, screener

T0 = dt.datetime(2026, 11, 27, 6, 32)
LEAK = "I now have all the data. Let me compose and send the full fleet report to JB's personal Signal account."


def test_narration_caught_and_real_messages_not():
    for t in [LEAK, "Let me check the noon reports first.", "I'll call get_alerts_tool now", "Great, I have everything I need."]:
        assert rules.is_narration(t), t
    for t in ["Let me know if you need anything else. ATLAS VOYAGER is at 12.1 kn.",
              "Fleet report 27 Nov: ATLAS VOYAGER 12.1 kn, NORDIC PEARL at anchor.", "Here is the report.",
              "Let me compose " + "a long real report. " * 60]:
        assert not rules.is_narration(t), t


def test_message_text_from_tool_args():
    assert rules.message_text(json.dumps({"recipient": "JB", "message": LEAK})) == LEAK
    assert rules.message_text(json.dumps({"to": "x", "payload": {"body": "hi there", "subject": "s"}})) == "hi there"


def test_send_tools_by_name_and_settings():
    assert engine.sends_by_name("send_signal_group_message_tool") and engine.sends_by_name("notify_user")
    assert not engine.sends_by_name("read_group_messages_tool") and not engine.sends_by_name("resolve_signal_recipient_tool")
    es = {"message_tools": ["deliver_report"], "not_message_tools": ["send_push_notification_tool"]}
    assert engine.is_message_tool("deliver_report", es) and not engine.is_message_tool("send_push_notification_tool", es)


def test_rule_flags_the_sent_notes_as_high(monkeypatch):
    sent = [{"trace_id": "t1", "span_id": "s1", "name": "send_signal_message_tool", "agent_name": "bosun", "thread_id": "th",
             "start_time": T0, "input": json.dumps({"recipient": "JB", "message": LEAK})},
            {"trace_id": "t2", "span_id": "s2", "name": "send_signal_message_tool", "agent_name": "bosun", "thread_id": "th",
             "start_time": T0, "input": json.dumps({"recipient": "JB", "message": "Fleet report: all 12 vessels on schedule."})}]

    async def q(sql, params=None):
        return sent if "kind = 'tool'" in sql else []

    monkeypatch.setattr(rules, "query", q)
    issues, signals = asyncio.run(rules.leaked_narration("p", 7, engine.DEFAULTS))
    assert len(signals) == 1 and signals[0]["trace_id"] == "t1" and "working notes" in signals[0]["detail"]
    assert issues[0]["kind"] == "leaked_narration" and "send_signal_message_tool" in issues[0]["title"]
    assert rules.severity(issues[0]) == "high"


def test_screener_sees_what_was_sent():
    steps = [{"span_id": "a", "kind": "tool", "name": "send_signal_message_tool", "status": "ok", "status_message": "",
              "input_head": json.dumps({"message": LEAK}), "output_head": "ok", "output_len": 2}]
    text, _ = screener.outline({"input_head": ""}, steps, [], [], engine.DEFAULTS)
    assert "SENDS TO A PERSON" in text and "Let me compose" in text


def test_agent_view_marks_the_run_in_its_conversation(monkeypatch):
    spans = [{"span_id": "a", "parent_span_id": "", "trace_id": "t2", "project": "p", "kind": "agent", "name": "bosun",
              "thread_id": "th", "start_time": T0, "duration_ms": 10, "status": "ok", "input": "", "output": "", "events": []}]

    async def get_trace(t):
        return spans

    async def q(sql, params=None):
        if "is_root = 1" in sql:
            return [{"trace_id": t, "start_time": T0, "duration_ms": 1, "status": "ok",
                     "input_head": '{"messages": [{"role": "user", "content": "run ' + t + '"}]}', "output_head": ""} for t in ("t1", "t2", "t3")]
        return []

    async def none(*a, **k):
        return [] if a and isinstance(a[0], str) and a[0] == "t2" else None

    monkeypatch.setattr(queries, "get_trace", get_trace)
    monkeypatch.setattr(agent_view, "query", q)
    monkeypatch.setattr(agent_view, "_issues_for_trace", lambda t: asyncio.sleep(0, []))
    monkeypatch.setattr(diagnose, "get_diagnosis", lambda t: asyncio.sleep(0, None))
    text = asyncio.run(agent_view.trace_text("t2", "https://x"))
    assert "this is run 2 of 3" in text and "◀ THIS RUN" in text
    assert text.count("◀ THIS RUN") == 2 and "“run t2”" in text.split("◀ THIS RUN")[1].splitlines()[-1] + text and "https://x/p/p/traces/t1?view=agent" in text
