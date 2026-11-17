import datetime as dt

from imagent_server import rules

T = dt.datetime(2026, 11, 17, 10, 0)


def _ran(trace, thread="th", minutes=0, output='{"ok": true}', name="send_email"):
    return {"trace_id": trace, "span_id": "s" + trace, "name": name, "agent_name": "orch", "thread_id": thread,
            "start_time": T + dt.timedelta(minutes=minutes), "output": output}


def test_bypass_needs_an_approval_before_it():
    approvals = [{"trace_id": "t2", "thread_id": "th", "start_time": T + dt.timedelta(minutes=5),
                  "resume": '{"decisions": [{"type": "approve"}]}'}]
    ran = [
        _ran("t1", minutes=1),                                   # before any approval → bypass
        _ran("t2", minutes=6),                                   # the approved (resumed) run
        _ran("t3", minutes=9),                                   # later in the same chat → allowed for this chat
        _ran("t4", thread="other", minutes=9),                   # another chat, no approval → bypass
        _ran("t5", thread="other", minutes=10, output='{"error": "not_approved", "message": "nothing was done"}'),
    ]
    assert [r["trace_id"] for r in rules.find_bypasses(ran, approvals)] == ["t1", "t4"]


def test_rejected_resume_is_not_an_approval():
    approvals = [{"trace_id": "t1", "thread_id": "th", "start_time": T, "resume": '{"decisions": [{"type": "reject"}]}'}]
    assert [r["trace_id"] for r in rules.find_bypasses([_ran("t1", minutes=1)], approvals)] == ["t1"]


def test_group_into_issues():
    sig = [rules._signal("p", {"trace_id": f"t{i}", "span_id": f"s{i}", "agent_name": "vessel_qa", "thread_id": "",
                               "start_time": T + dt.timedelta(minutes=i)}, "context_explosion", "big_context",
                         "ctx-model:vessel_qa", "vessel_qa", 100_000 + i * 50_000, "d") for i in range(3)]
    [issue] = rules._group("p", sig, title=lambda k, loc, worst, rule: f"{loc} up to {rules._fmt(worst)}")
    assert issue["runs"] == 3 and issue["title"] == "vessel_qa up to 200k" and issue["trace_ids"][0] == "t2"
    assert rules.severity(issue) == "medium"
    assert rules.severity(issue | {"runs": 1, "peak": 22.0}) == "high"
