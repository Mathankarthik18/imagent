import datetime as dt

from imagent_server import screener as s

T = dt.datetime(2026, 11, 17, 10, 0)


def test_json_string_at_handles_truncation_and_escapes():
    text = '{"role": "assistant", "content": "ATLAS did \\"12.4 kn\\"\\nyesterday'  # cut mid-string
    assert s.json_string_at(text, "content") == 'ATLAS did "12.4 kn"\nyesterday'
    assert s.user_request('{"messages": [{"role": "user", "content": "speed of ATLAS?"}]}') == "speed of ATLAS?"
    assert s.system_prompt('[{"role": "system", "content": "You are Bosun.\\nNever guess."}, {"role": "user"') == "You are Bosun.\nNever guess."


def test_outline_numbers_steps_and_shows_evidence():
    run = {"input_head": '{"messages": [{"role": "user", "content": "speed of ATLAS last voyage"}]}'}
    steps = [
        {"span_id": "a", "kind": "tool", "name": "get_vessel_index_tool", "agent_name": "vessel_qa", "status": "ok",
         "status_message": "", "input_tokens": 0, "input_head": '{"name": "Atlas"}',
         "output_head": '{"error": "vessel not found"}', "output_len": 28, "interrupt": 0},
        {"span_id": "b", "kind": "llm", "name": "m", "agent_name": "vessel_qa", "status": "ok", "status_message": "",
         "input_tokens": 5200, "input_head": "", "output_head": '{"role": "assistant", "content": "ATLAS averaged 12.4 kn."}',
         "output_len": 60, "interrupt": 0},
    ]
    text, ids = s.outline(run, steps, [], [{"key": "user", "score": 0.0, "comment": "made up"}])
    assert ids == ["a", "b"]
    assert "request: speed of ATLAS last voyage" in text and "[1] tool get_vessel_index_tool" in text
    assert "vessel not found" in text and "final answer: ATLAS averaged 12.4 kn." in text
    assert "user rated 👎: made up" in text


def test_parse_flags_keeps_only_known_runs_and_categories():
    reply = 'ok {"flags": [{"run": "abc", "category": "hallucination", "step": 2, "reason": "r"},' \
            ' {"run": "zzz", "category": "hallucination", "step": 1, "reason": "x"},' \
            ' {"run": "abc", "category": "made_up", "step": 1, "reason": "y"}]}'
    assert s.parse_flags(reply, {"abc"}, ["hallucination"]) == [{"run": "abc", "category": "hallucination", "step": 2, "reason": "r"}]
    assert s.parse_flags("no json", {"abc"}, ["hallucination"]) == []


def test_tool_message_is_unwrapped():
    steps = [{"span_id": "a", "kind": "tool", "name": "list_fleet_tool", "agent_name": "o", "status": "ok", "status_message": "",
              "input_tokens": 0, "input_head": "{}", "output_head": '{"role": "tool", "content": "{\\"count\\": 19}"}',
              "output_len": 40, "interrupt": 0}]
    text, _ = s.outline({"input_head": ""}, steps, [], [])
    assert '{"count": 19}' in text


def test_long_run_shows_start_and_end_and_main_agents_answer():
    def llm(i, agent, text):
        return {"span_id": f"s{i}", "kind": "llm", "name": "m", "agent_name": agent, "status": "ok", "status_message": "",
                "input_tokens": 10, "input_head": "", "output_head": '{"role": "assistant", "content": "%s"}' % text,
                "output_len": 30, "interrupt": 0}
    steps = [llm(i, "sub", f"sub {i}") for i in range(99)] + [llm(99, "orch", "FLEET REPORT")]
    text, ids = s.outline({"input_head": "", "agent": "orch"}, steps, [], [])
    assert len(ids) == 100 and "[1] model" in text and "[100] model" in text and "steps in between not shown" in text
    assert "final answer: FLEET REPORT" in text
    assert s.last_text([llm(0, "orch", "A"), llm(1, "sub", "B")], "orch") == "A"


def test_hints_for_silent_errors_and_personal_data():
    assert s.looks_failed('{"error": "vessel not found"}', 30) and s.looks_failed("[]", 2)
    assert not s.looks_failed('{"count": 19, "vessels": []}', 900)
    assert s.personal_data("Mail ops@example.com or call +44 20 7946 0958") == "1 email address, 1 phone number"
    assert s.personal_data("IMO 9629706, 12.4 kn") == ""
    tool = {"span_id": "a", "kind": "tool", "name": "get_vessel", "agent_name": "o", "status": "ok", "status_message": "",
            "input_tokens": 0, "input_head": "{}", "output_head": '{"error": "not found"}', "output_len": 22, "interrupt": 0}
    text, _ = s.outline({"input_head": ""}, [tool], [], [])
    assert "⚠ looks like an error/empty result" in text
    msgs = s._prompt([("r1", text)], ["missing_capability"], "", "", "", ["send_email", "list_fleet_tool"])
    assert "The tools this agent has: send_email, list_fleet_tool" in msgs[0]["content"]
