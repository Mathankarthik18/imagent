import datetime as dt

from imagent_server import diagnose as d

T0 = dt.datetime(2026, 11, 1, tzinfo=dt.timezone.utc)


def test_fingerprint_masks_what_varies():
    a = d.fingerprint("Vessel 'ATLAS' not found (imo 9876543, id 65f1a2b3c4d5e6f7a8b9c0d1)")
    b = d.fingerprint("Vessel 'NORDIC' not found (imo 1234567, id 75f1a2b3c4d5e6f7a8b9c0d9)")
    assert a == b


def _found(i, runs=3, last=T0):
    return {"id": i, "runs": runs, "first_seen": T0, "last_seen": last}


def test_merge_new_unchanged_and_regressed():
    rows, fresh = d.merge([_found("a")], {})
    assert fresh == ["a"] and rows[0]["status"] == "open"
    old = rows[0]
    rows, fresh = d.merge([_found("a")], {"a": old})
    assert rows == [] and fresh == []  # nothing changed: nothing written
    resolved = old | {"status": "resolved", "resolved_at": T0 + dt.timedelta(hours=1)}
    rows, fresh = d.merge([_found("a", runs=4, last=T0 + dt.timedelta(hours=2))], {"a": resolved})
    assert fresh == ["a"] and rows[0]["status"] == "open" and rows[0]["resolved_at"] is None
    ignored = old | {"status": "ignored"}
    rows, _ = d.merge([_found("a", runs=9)], {"a": ignored})
    assert rows[0]["status"] == "ignored"  # ignoring sticks


def test_stack_files_match_repo_paths_innermost_first():
    st = ('Traceback (most recent call last):\n'
          '  File "/srv/app/.venv/lib/python3.13/site-packages/langchain/tools.py", line 10, in run\n'
          '  File "/Users/me/bosun/app/agents/orchestrator.py", line 1532, in run_orchestrator\n'
          '  File "/Users/me/bosun/app/tools/vessel.py", line 88, in vessel_speed\n'
          'KeyError: imo')
    paths = ["bosun/app/agents/orchestrator.py", "bosun/app/tools/vessel.py", "bosun/app/main.py"]
    assert d.stack_files([st], paths) == [("bosun/app/tools/vessel.py", 88), ("bosun/app/agents/orchestrator.py", 1532)]


def test_diff_applies():
    src = "def f(x):\n    return x['imo']\n"
    good = "--- a/f.py\n+++ b/f.py\n@@ -1,2 +1,2 @@\n def f(x):\n-    return x['imo']\n+    return x.get('imo')\n"
    bad = "@@\n-    return x['mmsi']\n+    return 1\n"
    assert d.diff_applies(good, src) and not d.diff_applies(bad, src)


def test_focus_is_deepest_failed_step():
    spans = [
        {"span_id": "r", "parent_span_id": "", "name": "agent", "kind": "agent", "status": "error", "start_time": T0},
        {"span_id": "t", "parent_span_id": "r", "name": "vessel_speed", "kind": "tool", "status": "error", "start_time": T0},
        {"span_id": "m", "parent_span_id": "r", "name": "llm", "kind": "llm", "status": "ok", "start_time": T0},
    ]
    assert d.focus_span(spans)["span_id"] == "t"
    assert d.focus_span(spans, "m")["span_id"] == "m"


def test_json_reads_nested_reply():
    text = 'Thinking…\n```json\n{"summary": "s", "fix": {"changes": [{"path": "a", "diff": "x"}]}, "evidence": []}\n```'
    assert d._json(text, "summary")["fix"]["changes"][0]["path"] == "a"


def test_diagnose_reads_stack_files_and_checks_the_diff(monkeypatch):
    import asyncio
    import json as _json

    from imagent_server import github

    src = "def update_cp_mistake(config):\n    ctx = config['configurable']['bosun_context']\n    return ctx\n"
    files = {"bosun/app/tools/cp.py": src, "bosun/app/main.py": "app = 1\n"}
    monkeypatch.setattr(github, "tree", lambda gh: list(files))
    monkeypatch.setattr(github, "branch", lambda gh: "main")
    monkeypatch.setattr(github, "head_commit", lambda gh: "abc1234567890")
    monkeypatch.setattr(github, "search", lambda gh, term, limit=8: [])
    monkeypatch.setattr(github, "read", lambda gh, p: files[p])
    prompts = []

    def fake_call(messages, cfg=None, **kw):
        prompts.append(messages[-1]["content"])
        if "Repository files" in messages[-1]["content"]:
            return '{"files": ["bosun/app/main.py"]}', 0.001
        return _json.dumps({
            "title": "Missing context", "category": "code_bug", "summary": "The tool reads bosun_context that isn't passed.",
            "root_cause": "cp.py line 2", "evidence": ["KeyError: 'bosun_context'"],
            "fix": {"explanation": "Use .get", "changes": [{"path": "bosun/app/tools/cp.py", "diff":
                "@@ -1,3 +1,3 @@\n def update_cp_mistake(config):\n-    ctx = config['configurable']['bosun_context']\n+    ctx = config['configurable'].get('bosun_context')\n     return ctx\n"}]},
            "verify": "re-run", "confidence": "high"}), 0.01

    from imagent_server import judge
    monkeypatch.setattr(judge, "_call", fake_call)
    stack = ('Traceback (most recent call last):\n  File "/srv/bosun/app/tools/cp.py", line 2, in update_cp_mistake\n'
             "KeyError: 'bosun_context'")
    spans = [
        {"span_id": "r", "parent_span_id": "", "name": "orchestrator", "kind": "agent", "status": "error", "start_time": T0,
         "input": '{"messages": [{"role": "user", "content": "fix the CP"}]}', "output": "", "events": []},
        {"span_id": "t", "parent_span_id": "r", "name": "update_cp_mistake_tool", "kind": "tool", "status": "error",
         "status_message": "KeyError: 'bosun_context'", "start_time": T0, "input": "{}", "output": "",
         "events": [{"name": "exception", "attributes": {"exception.stacktrace": stack}}]},
    ]
    out = asyncio.run(d.diagnose(spans, cfg={"model": "m", "key": "k", "base_url": "u"},
                                 gh={"repo": "o/r", "token": "t", "branch": "", "path": "bosun"}))
    assert out["focus"]["name"] == "update_cp_mistake_tool"
    assert [f["path"] for f in out["files"]] == ["bosun/app/tools/cp.py", "bosun/app/main.py"]  # stack file first
    assert out["fix"]["changes"][0]["applies"] is True
    assert out["repo"]["commit"] == "abc1234567"
    assert "KeyError" in prompts[-1] and "bosun_context" in prompts[-1]
    assert out["cost"] == 0.011


def test_apply_edits_exact_once():
    src = "def f(c):\n    return c['configurable']['bosun_context']\n"
    edit = {"find": "    return c['configurable']['bosun_context']", "replace": "    return c['configurable'].get('bosun_context')"}
    assert ".get('bosun_context')" in d.apply_edits(src, [edit], "f.py")
    import pytest
    with pytest.raises(d.EditError):
        d.apply_edits(src, [{"find": "nope", "replace": "x"}], "f.py")
    with pytest.raises(d.EditError):
        d.apply_edits("a\na\n", [{"find": "a", "replace": "b"}], "f.py")  # ambiguous
    assert d.apply_edits(None, [{"find": "", "replace": "new file\n"}], "n.py") == "new file\n"


def test_build_change_makes_a_real_diff():
    src = "x = 1\ny = 2\n"
    c = d.build_change({"path": "/a.py", "edits": [{"find": "y = 2", "replace": "y = 3"}]}, {"a.py": src})
    assert c["applies"] and c["path"] == "a.py" and "-y = 2" in c["diff"] and "+y = 3" in c["diff"]
    bad = d.build_change({"path": "a.py", "edits": [{"find": "z = 9", "replace": "z = 0"}]}, {"a.py": src})
    assert bad["applies"] is False and "no longer in the file" in bad["problem"]


def test_create_fix_commits_on_latest_and_refuses_stale(monkeypatch):
    import asyncio

    import pytest

    from imagent_server import github, projects

    diag = {"target": "trace:t1", "project": "p", "status": "done", "note": "", "created_at": T0, "result": {
        "title": "Missing context", "summary": "s", "root_cause": "r", "confidence": "high", "model": "m", "trace_id": "t1",
        "fix": {"explanation": "e", "changes": [{"path": "app/cp.py", "edits": [{"find": "c['x']", "replace": "c.get('x')"}]}]}}}
    saved = {}

    async def get_diag(t):
        return diag

    async def save(target, project, status, **kw):
        saved.update(kw)

    async def get_proj(pid):
        return {"id": "p"}

    async def gh_cfg(p):
        return {"repo": "o/r", "token": "t", "branch": "", "path": ""}

    monkeypatch.setattr(d, "get_diagnosis", get_diag)
    monkeypatch.setattr(d, "_save", save)
    monkeypatch.setattr(projects, "get", get_proj)
    monkeypatch.setattr(github, "config_for_project", gh_cfg)
    monkeypatch.setattr(github, "latest", lambda cfg: ("main", "sha1"))
    files = {"app/cp.py": "def f(c):\n    return c['x']\n"}
    monkeypatch.setattr(github, "read_at", lambda cfg, p, ref: files.get(p))
    made = {}

    def branch(cfg, **kw):
        made.update(kw)
        return {"branch": kw["branch_name"], "commit": "c1", "url": "u"}

    monkeypatch.setattr(github, "create_fix_branch", branch)
    monkeypatch.setattr(github, "open_pr", lambda cfg, **kw: {"number": 7, "url": "pr", "draft": True})
    out = asyncio.run(d.create_fix("trace:t1"))
    assert out["pr_number"] == 7 and out["branch"].startswith("imagent/fix-t1-missing-context")
    assert made["base_sha"] == "sha1" and made["files"]["app/cp.py"] == "def f(c):\n    return c.get('x')\n"
    assert saved["result"]["fix_branch"]["pr_url"] == "pr"

    diag["result"].pop("fix_branch", None)
    files["app/cp.py"] = "def f(c):\n    return c['y']\n"  # someone changed the code
    with pytest.raises(d.StaleFix):
        asyncio.run(d.create_fix("trace:t1"))


def test_app_frames_skip_libraries():
    st = ('  File "/x/.venv/lib/python3.13/site-packages/langchain_core/tools/base.py", line 1, in run\n'
          '  File "/Users/me/bosun/app/tools/master_report_tools.py", line 218, in master_report_coverage_tool\n')
    assert d.app_frames([st]) == ["/Users/me/bosun/app/tools/master_report_tools.py"]
