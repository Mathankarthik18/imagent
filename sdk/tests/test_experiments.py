"""IMAGENT_EXPERIMENTS: captured agents replay with tools from the recording and the model
swapped per agent at call time."""

import asyncio
from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult

from imagent import experiments, replay
from imagent.runner import ReplayJob


class NamedModel(BaseChatModel):
    """Answers with its own model name, so a test can see which model ran."""
    model_name: str = "base"

    @property
    def _llm_type(self) -> str:
        return "named"

    def _generate(self, messages, stop=None, run_manager=None, **kw: Any) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=AIMessage(f"answered by {self.model_name}"))])


def _job(variant, agent="assistant"):
    return ReplayJob(job_id="j", experiment_id="e", agent=agent, variant=variant, model=str(variant.get("model", "")),
                     thread_id="experiment:e:j", tool_mode="recorded", source={},
                     raw={"history": [{"role": "system", "content": "sys"}, {"role": "user", "content": "hi"}]})


def _run(job, coro_fn):
    st = replay.ReplayState.from_job({"variant": job.variant, "fixtures": [], "agent": job.agent}, passthrough=set(), read_tools=set())

    async def go():
        with replay.activate(st):
            return await coro_fn(job)
    return asyncio.run(go())


def test_model_is_swapped_per_agent_at_call_time():
    replay.install()
    m = NamedModel()

    async def agent_call(job):
        return (await m.ainvoke("q", config={"metadata": {"lc_agent_name": job.agent}})).content

    assert _run(_job({"model": "everyone"}), agent_call) == "answered by everyone"
    assert _run(_job({"models": {"assistant": "just-me"}}), agent_call) == "answered by just-me"
    assert _run(_job({"models": {"someone_else": "x"}}), agent_call) == "answered by base"
    assert asyncio.run(m.ainvoke("q")).content == "answered by base"  # outside a replay: untouched


def test_captured_agent_replays_with_in_memory_state():
    from langgraph.graph import END, START, MessagesState, StateGraph

    replay.install()
    m = NamedModel()
    g = StateGraph(MessagesState)
    g.add_node("model", lambda s: {"messages": [m.invoke(s["messages"])]})
    g.add_edge(START, "model")
    g.add_edge("model", END)
    experiments.capture(g.compile(name="assistant"), "assistant")

    out = _run(_job({"model": "candidate"}), experiments._auto_replay)
    assert out == "answered by candidate"


def test_conversation_keeps_text_turns_only():
    msgs = experiments.conversation([
        {"role": "system", "content": "s"}, {"role": "user", "content": "a"},
        {"role": "assistant", "content": [{"type": "text", "text": "b"}]},
        {"role": "assistant", "content": "", "tool_calls": [{"name": "t"}]}, {"role": "tool", "content": "r"},
        {"role": "human", "content": "c"}])
    assert msgs == [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}, {"role": "user", "content": "c"}]


def test_agent_decorator_rebuilds_the_recorded_build_safely():
    import dataclasses
    import json

    from langgraph.graph import END, START, MessagesState, StateGraph
    from langgraph.store.memory import InMemoryStore

    import imagent
    from imagent import blueprint

    @dataclasses.dataclass
    class Ctx:
        org: str
        db: object = None
        dry_run: bool = False

    class LiveStore(InMemoryStore):
        """Stands in for a production store — must not reach the replay."""

    builds, seen = [], {}
    m = NamedModel()

    @imagent.agent("support_bot", replay_overrides={"ctx": {"db": None, "dry_run": True}})
    def build_agent(tone: str):
        builds.append(tone)

        def node(state, config):
            c = config["configurable"]
            seen.update(tone=tone, ctx=c["ctx"], store=type(c.get("store")).__name__)
            return {"messages": [m.invoke(state["messages"], config)]}
        g = StateGraph(MessagesState)
        g.add_node("model", node)
        g.add_edge(START, "model")
        g.add_edge("model", END)
        return g.compile(name="support_bot")

    blueprint.install_auto(publish=False)
    live_db = object()
    # Two production builds; the replay must use the one its source run was built with.
    a1 = build_agent("formal")
    build_agent("casual")
    out = a1.invoke({"messages": [{"role": "user", "content": "hi"}]},
                    {"configurable": {"ctx": Ctx("acme", db=live_db), "store": LiveStore(), "thread_id": "t1"}})
    assert out["messages"][-1].content == "answered by base" and seen["ctx"].db is live_db  # normal run untouched
    bid = experiments._latest["support_bot"]
    first = next(k for k, b in experiments._builds.items() if b["args"] == ("formal",))
    assert bid != first and experiments._builds[first]["configurable"]["ctx"].org == "acme"

    job = ReplayJob(job_id="j", experiment_id="e", agent="support_bot", variant={"model": "candidate"}, model="candidate",
                    thread_id="experiment:e:j", tool_mode="recorded", source={"metadata": json.dumps({"imagent_build": first})},
                    raw={"history": [{"role": "user", "content": "hi"}]})
    fn = imagent.runner._agents["support_bot"].fn
    assert _run(job, fn) == "answered by candidate"
    assert seen["tone"] == "formal" and builds[-1] == "formal"           # same build arguments as the source run
    assert seen["ctx"].org == "acme" and seen["ctx"].db is None and seen["ctx"].dry_run is True
    assert seen["store"] == "InMemoryStore"                               # never the live store


def test_unlabelled_calls_belong_to_the_replayed_agent():
    """A plain LangGraph graph doesn't label LLM calls with an agent — a pick for the
    replayed agent itself must still apply."""
    replay.install()
    m = NamedModel()

    async def plain_call(job):
        return (await m.ainvoke("q")).content

    assert _run(_job({"models": {"assistant": "picked"}}), plain_call) == "answered by picked"
    assert _run(_job({"models": {"other": "x"}}), plain_call) == "answered by base"


def test_ready_at_init_inside_a_server_loop_and_rebuild_from_portable_args():
    import enum
    import json

    from langgraph.graph import END, START, MessagesState, StateGraph

    import imagent
    from imagent import experiments as ex

    async def inside_loop():
        ex._app_loop = None
        ex._started = False
        with patch_thread():
            ex.start()
        return ex.ready()
    assert asyncio.run(inside_loop()) is True  # uvicorn imports the app inside its loop

    class Profile(str, enum.Enum):
        CHAT = "chat"

    built = []
    m = NamedModel()

    @imagent.agent("restartable")
    def build_agent(tools, profile=Profile.CHAT, task_id=None):
        built.append((tools, profile, task_id))
        g = StateGraph(MessagesState)
        g.add_node("model", lambda s: {"messages": [m.invoke(s["messages"])]})
        g.add_edge(START, "model")
        g.add_edge("model", END)
        return g.compile(name="restartable")

    build_agent([object()], profile=Profile.CHAT, task_id="T-1")
    portable = ex._builds[ex._latest["restartable"]]["portable"]
    assert portable == {"tools": [], "profile": "chat", "task_id": "T-1"}  # objects emptied, enum → value

    # After a restart the in-memory build is gone — the run's metadata still rebuilds it.
    job = ReplayJob(job_id="j", experiment_id="e", agent="restartable", variant={"model": "new"}, model="new",
                    thread_id="experiment:e:j", tool_mode="recorded",
                    source={"metadata": json.dumps({"imagent_build": "old-process-7", "imagent_build_args": portable})},
                    raw={"history": [{"role": "user", "content": "hi"}]})
    assert _run(job, imagent.runner._agents["restartable"].fn) == "answered by new"
    assert built[-1] == ([], "chat", "T-1")


class patch_thread:
    """Don't start the real polling thread in tests."""
    def __enter__(self):
        import threading
        self._orig = threading.Thread.start
        threading.Thread.start = lambda self: None
    def __exit__(self, *a):
        import threading
        threading.Thread.start = self._orig


def test_openrouter_prefix_is_dropped_for_openrouter_clients():
    class Routed(NamedModel):
        openai_api_base: str = "https://openrouter.ai/api/v1"

    assert replay.provider_model_id(Routed(), "openrouter/anthropic/claude-haiku-5.5") == "anthropic/claude-haiku-5.5"
    assert replay.provider_model_id(NamedModel(), "openrouter/anthropic/claude-haiku-5.5") == "openrouter/anthropic/claude-haiku-5.5"
    assert replay.provider_model_id(Routed(), "anthropic/claude-haiku-5.5") == "anthropic/claude-haiku-5.5"


def test_live_mode_runs_every_tool_and_keeps_the_real_context():
    import dataclasses
    import json

    from langchain_core.tools import tool
    from langgraph.graph import END, START, MessagesState, StateGraph

    import imagent
    from imagent import blueprint

    executed = []

    @tool
    def create_task(title: str) -> str:
        """Create a task."""
        executed.append(title)
        return "T-9"

    @dataclasses.dataclass
    class Ctx:
        db: object = None
        dry_run: bool = False

    seen = {}
    live_db = object()

    @imagent.agent("live_bot", replay_overrides={"ctx": {"db": None, "dry_run": True}})
    def build_agent():
        def node(state, config):
            seen["ctx"] = config["configurable"]["ctx"]
            create_task.invoke({"title": "from replay"}, config)
            return {"messages": [{"role": "assistant", "content": "done"}]}
        g = StateGraph(MessagesState)
        g.add_node("n", node)
        g.add_edge(START, "n")
        g.add_edge("n", END)
        return g.compile(name="live_bot")

    blueprint.install_auto(publish=False)
    build_agent().invoke({"messages": [{"role": "user", "content": "x"}]}, {"configurable": {"ctx": Ctx(db=live_db), "thread_id": "t"}})
    executed.clear()
    bid = experiments._latest["live_bot"]
    fixtures = [{"name": "create_task", "args": '{"title": "from replay"}', "output": "recorded T-1"}]

    def job(mode):
        return ReplayJob(job_id="j", experiment_id="e", agent="live_bot", variant={}, model="", thread_id="experiment:e:j",
                         tool_mode=mode, source={"metadata": json.dumps({"imagent_build": bid})},
                         raw={"history": [{"role": "user", "content": "x"}], "fixtures": fixtures})

    def run(j):
        st = replay.ReplayState.from_job({"variant": {}, "fixtures": fixtures, "agent": "live_bot", "tool_mode": j.tool_mode},
                                         passthrough=set(), read_tools=set())
        async def go():
            with replay.activate(st):
                return await imagent.runner._agents["live_bot"].fn(j)
        return asyncio.run(go())

    replay.install()
    run(job("recorded"))
    assert executed == [] and seen["ctx"].db is None and seen["ctx"].dry_run is True   # default: nothing real happens
    run(job("live"))
    assert executed == ["from replay"]                                                   # full access: the tool really ran
    assert seen["ctx"].db is live_db and seen["ctx"].dry_run is False                    # with the run's real context


def test_live_replay_of_a_run_from_before_a_restart_borrows_connections_keeps_identity():
    import dataclasses
    import json

    from langgraph.graph import END, START, MessagesState, StateGraph

    import imagent
    from imagent import blueprint

    @dataclasses.dataclass
    class Ctx:
        user_id: str
        org_id: str
        db: object = None

    seen = {}

    @imagent.agent("restart_bot", replay_overrides={"ctx": {"db": None}})
    def build_agent():
        def node(state, config):
            seen["ctx"] = config["configurable"]["ctx"]
            return {"messages": [{"role": "assistant", "content": "ok"}]}
        g = StateGraph(MessagesState)
        g.add_node("n", node)
        g.add_edge(START, "n")
        g.add_edge("n", END)
        return g.compile(name="restart_bot")

    blueprint.install_auto(publish=False)
    live_db = object()
    # A run in *this* process, by another user: provides the live connection.
    build_agent().invoke({"messages": [{"role": "user", "content": "x"}]},
                         {"configurable": {"ctx": Ctx("someone-else", "org-2", db=live_db), "thread_id": "t"}})
    # The recorded run came from an earlier process — its build id is unknown here.
    md = {"imagent_build": "old-process-1", "imagent_build_args": {}, "user_id": "u-original", "org_id": "org-1"}
    job = ReplayJob(job_id="j", experiment_id="e", agent="restart_bot", variant={}, model="", thread_id="experiment:e:j",
                    tool_mode="live", source={"metadata": json.dumps(md)}, raw={"history": [{"role": "user", "content": "x"}]})
    st = replay.ReplayState.from_job({"variant": {}, "fixtures": [], "agent": "restart_bot", "tool_mode": "live"},
                                     passthrough=set(), read_tools=set())

    async def go():
        with replay.activate(st):
            return await imagent.runner._agents["restart_bot"].fn(job)
    assert asyncio.run(go()) == "ok"
    assert seen["ctx"].db is live_db                                       # live connection borrowed
    assert (seen["ctx"].user_id, seen["ctx"].org_id) == ("u-original", "org-1")   # identity of the recorded run


def test_decorated_agent_publishes_its_blueprint_at_startup_without_a_run():
    import threading
    from unittest.mock import MagicMock, patch

    from langgraph.graph import END, START, MessagesState, StateGraph

    import imagent
    from imagent import blueprint, experiments as ex

    def build_agent(tools):
        g = StateGraph(MessagesState)
        g.add_node("n", lambda s: s)
        g.add_edge(START, "n")
        g.add_edge("n", END)
        return g.compile(name="startup_bot")

    sent, timers = [], []
    cfg = MagicMock(auto_blueprint=True)
    with patch("imagent.runtime.get_config", return_value=cfg), patch.object(blueprint, "_send", side_effect=sent.append), \
         patch.object(threading, "Timer", side_effect=lambda d, fn: timers.append(fn) or MagicMock()):
        ex._app_loop = None
        ex._startup_builds.clear()                       # earlier tests' agents
        imagent.agent("startup_bot")(build_agent)      # declared after init(): scheduled right away
        assert len(timers) == 1 and not sent             # not built during import
        timers[0]()                                      # …a moment after startup
    assert [bp["root"]["name"] for bp in sent] == ["startup_bot"]
