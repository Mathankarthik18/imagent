from imagent_server import github as g


def test_device_poll_states(monkeypatch):
    replies = iter([{"error": "authorization_pending"}, {"error": "slow_down", "interval": 10},
                    {"access_token": "ghu_x", "expires_in": 28800, "refresh_token": "ghr_y"}])
    monkeypatch.setattr(g, "_post_form", lambda url, fields: next(replies))
    monkeypatch.setattr(g, "_get", lambda cfg, url, **kw: {"login": "octo"})
    assert g.device_poll("dc")["status"] == "pending"
    r = g.device_poll("dc")
    assert r["status"] == "slow_down" and r["interval"] == 10
    r = g.device_poll("dc")
    assert r["status"] == "connected" and r["login"] == "octo" and r["token"] == "ghu_x" and r["refresh"] == "ghr_y" and r["expires"]


def test_needs_refresh():
    assert not g.needs_refresh({"github_expires": "", "github_refresh": "r"})
    assert g.needs_refresh({"github_expires": "2020-01-01T00:00:00+00:00", "github_refresh": "r"})
    assert not g.needs_refresh({"github_expires": "2999-01-01T00:00:00+00:00", "github_refresh": "r"})


def test_suggest_folder_votes_for_the_project_root(monkeypatch):
    g._cache.clear()
    tree = ["README.md", "bosun/pyproject.toml", "bosun/app/tools/cp.py", "bosun/app/agents/orchestrator.py",
            "web/package.json", "web/src/api.ts"]
    monkeypatch.setattr(g, "_all_paths", lambda cfg: tree)
    hits = {"update_cp_mistake_tool": ["bosun/app/tools/cp.py"], "bosun_orchestrator": ["bosun/app/agents/orchestrator.py", "web/src/api.ts"]}
    monkeypatch.setattr(g, "search", lambda cfg, name, limit=8: hits.get(name, []))
    r = g.suggest_folder({"repo": "o/r", "token": "t", "branch": "main", "path": ""}, ["update_cp_mistake_tool", "bosun_orchestrator"])
    assert r["path"] == "bosun"
