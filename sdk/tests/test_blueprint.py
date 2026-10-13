"""Blueprint introspection degrades gracefully on a plain LangGraph graph (no create_agent internals)."""

from typing import TypedDict
from unittest.mock import MagicMock, patch

from langgraph.graph import END, START, StateGraph

import imagent
from imagent import blueprint


class S(TypedDict):
    x: int


def _graph():
    g = StateGraph(S)
    g.add_node("plan", lambda s: s)
    g.add_node("act", lambda s: s)
    g.add_edge(START, "plan")
    g.add_edge("plan", "act")
    g.add_edge("act", END)
    return g.compile(name="planner")


def test_describe_plain_langgraph():
    bp = blueprint.describe(_graph())
    root = bp["root"]
    assert bp["framework"] == "langgraph" and bp["schema"] == 1
    assert root["name"] == "planner"
    assert {n["id"] for n in root["graph"]["nodes"]} >= {"plan", "act", "__start__", "__end__"}
    assert {"source": "plan", "target": "act", "conditional": False} in root["graph"]["edges"]
    assert root["model"] is None and root["tools"] == [] and root["subagents"] == []


def test_describe_model_and_tool_shapes():
    m = MagicMock(spec=["model_name", "temperature", "_llm_type"])
    m.model_name, m.temperature, m._llm_type = "gpt-x", 0.2, "openai-chat"
    d = blueprint.describe_model(m)
    assert d["name"] == "gpt-x" and d["provider"] == "openai-chat" and d["params"] == {"temperature": 0.2}
    t = MagicMock()
    t.name, t.description, t.args = "read_file", "Read a file", {"path": {}}
    assert blueprint.describe_tool(t) == {"name": "read_file", "description": "Read a file", "args": ["path"], "builtin": True}


def test_publish_posts_to_server():
    cfg = MagicMock(endpoint="http://imagent", api_key="k", service="svc")
    with patch("imagent.runtime.get_config", return_value=cfg), patch("requests.post") as post:
        post.return_value.raise_for_status.return_value = None
        bp = imagent.publish_blueprint(_graph(), background=False)
    assert bp["root"]["name"] == "planner"
    url, kw = post.call_args.args[0], post.call_args.kwargs
    assert url == "http://imagent/api/blueprints" and kw["headers"] == {"x-imagent-key": "k"}
    assert kw["json"]["project"] == "svc" and kw["json"]["name"] == "planner" and len(kw["json"]["hash"]) == 16


def test_publish_is_noop_without_init():
    with patch("imagent.runtime.get_config", return_value=None):
        assert imagent.publish_blueprint(_graph(), background=False) is None


def test_first_run_publishes_automatically_once_and_skips_nested_graphs():
    from imagent import blueprint as b

    inner = _graph()  # "planner"
    outer_g = StateGraph(S)
    outer_g.add_node("delegate", lambda s: inner.invoke(s))  # a graph run inside another graph
    outer_g.add_edge(START, "delegate")
    outer_g.add_edge("delegate", END)
    outer = outer_g.compile(name="boss")

    b._known.clear()
    b.install_auto()
    sent = []
    with patch.object(b, "_send", side_effect=sent.append):
        outer.invoke({"x": 1})
        outer.invoke({"x": 2})
        list(outer.stream({"x": 3}))
    assert [bp["root"]["name"] for bp in sent] == ["boss"]  # once; the nested "planner" isn't its own app


def test_key_is_read_from_dotenv_when_not_in_environment(tmp_path, monkeypatch):
    from imagent import runtime

    (tmp_path / ".env").write_text('OTHER=1\nexport IMAGENT_API_KEY="imk_abc"  # project key\nIMAGENT_SERVICE=svc\n')
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("IMAGENT_API_KEY", raising=False)
    monkeypatch.delenv("IMAGENT_SERVICE", raising=False)
    monkeypatch.setattr(runtime, "_dotenv", None)
    assert runtime._env("API_KEY") == "imk_abc" and runtime._env("SERVICE") == "svc"
    monkeypatch.setenv("IMAGENT_SERVICE", "from-env")
    assert runtime._env("SERVICE") == "from-env"  # the real environment wins
    monkeypatch.setattr(runtime, "_dotenv", None)
