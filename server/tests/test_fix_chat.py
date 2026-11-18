import asyncio
import datetime as dt

import pytest

from imagent_server import diagnose, fix_chat

FILES = {"app/cp.py": "def f(c):\n    return c['x']\n"}


def test_parse_reply_and_revised_fix_checked_against_code():
    text = ('{"reply": "Use a default.", "fix": {"explanation": "default to 0", "changes": '
            '[{"path": "app/cp.py", "edits": [{"find": "c[\'x\']", "replace": "c.get(\'x\', 0)"}]}]}}')
    reply, fix = fix_chat.parse(text, FILES)
    assert reply == "Use a default."
    assert fix["changes"][0]["applies"] is True and "+    return c.get('x', 0)" in fix["changes"][0]["diff"]


def test_parse_no_fix_and_plain_text():
    assert fix_chat.parse('{"reply": "Yes, that is the cause.", "fix": null}', FILES) == ("Yes, that is the cause.", None)
    assert fix_chat.parse("just words", FILES) == ("just words", None)


def test_adopt_replaces_fix_keeps_original_and_refuses_after_pr(monkeypatch):
    T0 = dt.datetime(2026, 11, 1, tzinfo=dt.timezone.utc)
    old_fix = {"explanation": "old", "changes": []}
    new_fix = {"explanation": "new", "changes": [{"path": "app/cp.py", "edits": [{"find": "a", "replace": "b"}]}]}
    diag = {"target": "issue:i1", "project": "p", "status": "done", "note": "", "created_at": T0,
            "result": {"title": "t", "fix": old_fix}}
    saved = {}

    async def get_diag(t):
        return diag

    async def save(target, project, status, **kw):
        saved.update(kw)

    async def msgs(target, since=None):
        return [{"id": "m1", "role": "assistant", "content": "x", "fix": new_fix}]

    monkeypatch.setattr(diagnose, "get_diagnosis", get_diag)
    monkeypatch.setattr(diagnose, "_save", save)
    monkeypatch.setattr(fix_chat, "messages", msgs)
    out = asyncio.run(fix_chat.adopt("issue:i1", "m1"))
    assert out["fix"] == new_fix and out["original_fix"] == old_fix and out["fix_from"]["message"] == "m1"
    assert saved["result"]["fix"] == new_fix

    diag["result"]["fix_branch"] = {"pr_number": 7, "branch": "imagent/fix-x"}
    with pytest.raises(ValueError, match="already open"):
        asyncio.run(fix_chat.adopt("issue:i1", "m1"))


def test_pr_section_clips_and_labels():
    hist = [{"role": "user", "content": "why?"}, {"role": "error", "content": "boom"},
            {"role": "assistant", "content": "because " * 200}]
    lines = fix_chat.pr_section(hist)
    assert lines[0] == "### Discussion" and lines[1] == "- **Developer:** why?"
    assert lines[2].startswith("- **imagent:** because") and lines[2].endswith("…") and len(lines) == 4
