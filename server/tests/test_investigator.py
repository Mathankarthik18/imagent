import datetime as dt

from imagent_server import diagnose as d, investigator as inv

T0 = dt.datetime(2026, 11, 1, tzinfo=dt.timezone.utc)


def test_parse_decisions():
    real_new = inv.parse('{"real": true, "why": "w", "issue": "new", "title": "t", "description": "x", "severity": "HIGH"}', set())
    assert real_new["issue"] == "new" and real_new["severity"] == "high"
    existing = inv.parse('{"real": true, "why": "w", "issue": "abc123", "severity": "low"}', {"abc123"})
    assert existing["issue"] == "abc123"
    made_up = inv.parse('{"real": true, "why": "w", "issue": "zzz", "severity": "odd"}', {"abc123"})
    assert made_up["issue"] == "new" and made_up["severity"] == "medium"
    assert inv.parse('{"real": false, "why": "backed by tool data", "issue": null}', set())["real"] is False
    assert inv.parse("no json", set()) is None


def test_board_marks_dismissed_issues():
    text = inv._board([{"id": "a1", "kind": "hallucination", "status": "incorrect", "status_reason": "test data",
                        "title": "Speed made up", "message": ""},
                       {"id": "b2", "kind": "wrong_tool", "status": "open", "status_reason": "", "title": "Uses KB", "message": "m"}])
    assert "DISMISSED as not a problem: test data" in text and "a1" in text and "[Wrong tool, open] Uses KB — m" in text


def _f(i="a", runs=3, last=T0):
    return {"id": i, "runs": runs, "first_seen": T0, "last_seen": last}


def test_people_choices_stick_and_resolved_reopens():
    for status in ("watching", "fixing", "incorrect", "ignored"):
        rows, fresh = d.merge([_f(runs=9, last=T0 + dt.timedelta(days=1))], {"a": _f() | {"status": status, "level": "high"}})
        assert rows[0]["status"] == status and rows[0]["level"] == "high" and fresh == []
    rows, fresh = d.merge([_f(runs=9, last=T0 + dt.timedelta(days=2))],
                          {"a": _f() | {"status": "resolved", "resolved_at": T0 + dt.timedelta(days=1)}})
    assert rows[0]["status"] == "open" and "Re-opened" in rows[0]["status_reason"] and fresh == ["a"]


def test_stale_open_issues_close():
    old = {"a": _f(last=d._now() - dt.timedelta(days=30)) | {"status": "open"},
           "b": _f(i="b", last=d._now() - dt.timedelta(days=1)) | {"status": "open"},
           "c": _f(i="c", last=d._now() - dt.timedelta(days=30)) | {"status": "watching"}}
    closed = d.stale(old, touched=set())
    assert [c["id"] for c in closed] == ["a"] and closed[0]["status"] == "resolved"


def test_conversation_before_reads_cut_input():
    raw = ('[{"role": "system", "content": "You are Bosun' + "x" * 50 + '…[truncated 9999 chars]…'
           ' {"role": "user", "content": "find the noon thread"}, {"role": "assistant", "content": "", "tool_calls": '
           '[{"id": "c1", "name": "get_thread", "args": {}}]}, {"role": "tool", "content": "Master confirmed 22 Oct 13:57"},'
           ' {"role": "assistant", "content": "Found it."}, {"role": "user", "content": "draft a chase"}]')
    spans = [{"span_id": "m", "kind": "llm", "start_time": T0, "input": raw}]
    text = inv.conversation_before(spans, {})
    assert "user: find the noon thread" in text and "[calls get_thread]" in text and "22 Oct 13:57" in text
    assert "draft a chase" not in text and "You are Bosun" not in text
