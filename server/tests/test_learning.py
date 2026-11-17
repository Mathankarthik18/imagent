import asyncio
import datetime as dt
import json

from imagent_server import learning as L

T = dt.datetime(2026, 11, 17, 10, 0)


def ev(action, kind="hallucination", value="", reason="", minutes=0):
    return {"project": "p", "issue_id": "i", "kind": kind, "title": "Speed made up", "action": action, "value": value,
            "reason": reason, "at": T + dt.timedelta(minutes=minutes)}


def test_priorities_step_down_not_below_low_and_come_back():
    prefs, changes = L.apply(L.preferences(None), [ev("incorrect"), ev("ignored"), ev("resolved"), ev("incorrect")])
    assert prefs["categories"]["hallucination"]["priority"] == "low" and changes == ["hallucination: high → medium", "hallucination: medium → low"]
    prefs, _ = L.apply(prefs, [ev("pr_opened")])
    assert prefs["categories"]["hallucination"]["priority"] == "high"
    prefs, _ = L.apply(prefs, [ev("severity", value="medium")])
    assert prefs["categories"]["hallucination"]["priority"] == "medium"
    prefs, changes = L.apply(prefs, [ev("watching")])
    assert changes == []


def test_cap_and_text():
    prefs = {"categories": {"wrong_tool": {"priority": "low"}}, "rules": ["Test runs are not problems."]}
    assert L.cap(prefs, "wrong_tool", "high") == "low" and L.cap(prefs, "hallucination", "high") == "high"
    t = L.text(prefs)
    assert "Test runs are not problems." in t and "'wrong_tool' as low priority" in t
    assert L.text(L.preferences(None)) == ""


def test_learn_turns_reasons_into_rules_and_retries_on_failure(monkeypatch):
    saved = {}

    async def fake_query(sql, params=None):
        return [ev("incorrect", reason="u1/t1 ids are our test fixtures", minutes=1)]

    async def fake_update(project, **kw):
        saved.update(json.loads(kw["preferences"]))

    from imagent_server import judge, projects
    monkeypatch.setattr(L, "query", fake_query)
    monkeypatch.setattr(projects, "update", fake_update)
    monkeypatch.setattr(judge, "config_for", lambda p: {"key": "k", "model": "m", "base_url": "u"})
    monkeypatch.setattr(judge, "_call", lambda msgs, cfg, **kw: ('{"rules": ["Runs with ids like u1, t1 are tests — never file them."]}', 0.0))
    res = asyncio.run(L.learn("p", {}))
    assert saved["rules"] == ["Runs with ids like u1, t1 are tests — never file them."]
    assert saved["categories"]["hallucination"]["priority"] == "medium" and saved["pending"] == [] and res["learned"] == 2

    def boom(*a, **kw):
        raise RuntimeError("model down")
    monkeypatch.setattr(judge, "_call", boom)
    asyncio.run(L.learn("p", {}))
    assert saved["pending"] and saved["pending"][0]["reason"].startswith("u1/t1")  # kept for the next pass
