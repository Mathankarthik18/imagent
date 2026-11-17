import json

from imagent_server import engine


def test_settings_defaults_and_overrides():
    s = engine.settings({"engine": json.dumps({"level": "expanded", "categories": ["hallucination", "bogus"], "junk": 1})})
    assert s["level"] == "expanded" and s["categories"][0] == "hallucination" and "wrong_tool" not in s["categories"]
    assert "junk" not in s
    assert engine.settings(None)["categories"] == list(engine.CATEGORIES)
    assert engine.settings({"engine": "not json"})["level"] == "standard"


def test_clean_validates_patch():
    cur = engine.settings(None)
    out = engine.clean({"level": "huge", "monthly_cap_usd": -5, "guarded_tools": [" send_email ", "send_email", ""],
                        "context_tokens_limit": 10}, cur)
    assert out["level"] == "standard" and out["monthly_cap_usd"] == 0.0
    assert out["guarded_tools"] == ["send_email"] and out["context_tokens_limit"] == 1000


def test_new_categories_start_on_for_old_saves():
    old = engine.settings({"engine": json.dumps({"categories": ["hallucination"]})})  # saved before the 15
    assert "hallucination" in old["categories"] and "wrong_tool" not in old["categories"]
    assert "silent_tool_error" in old["categories"] and "pii_leak" in old["categories"]
    saved = engine.clean({"categories": ["hallucination"]}, engine.settings(None))
    assert engine.settings({"engine": json.dumps(saved)})["categories"] == ["hallucination"]
