import json

from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.tools import tool
from langgraph.graph import START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition

from imagent import replay
from imagent import semconv as sc

CALLS: list[str] = []


@tool
def lookup_vessel(name: str) -> str:
    """Look up a vessel."""
    CALLS.append(f"lookup_vessel:{name}")
    return json.dumps({"name": name, "imo": "9623740", "source": "LIVE"})


@tool
def create_task(title: str) -> str:
    """Create an ops task (a write)."""
    CALLS.append(f"create_task:{title}")
    return "T-LIVE"


class M(FakeMessagesListChatModel):
    def bind_tools(self, tools, **kwargs):
        return self


def graph(script):
    model = M(responses=script)

    def call(state: MessagesState):
        return {"messages": [model.invoke(state["messages"])]}

    g = StateGraph(MessagesState)
    g.add_node("model", call)
    g.add_node("tools", ToolNode([lookup_vessel, create_task]))
    g.add_edge(START, "model")
    g.add_conditional_edges("model", tools_condition)
    g.add_edge("tools", "model")
    return g.compile(name="agent")


def tc(name, args, i):
    return AIMessage(content="", tool_calls=[{"id": f"c{i}", "name": name, "args": args}])


def fixtures_from(spans):
    """What the server sends: recorded tool calls of the source run."""
    out = []
    for s in sorted(spans, key=lambda s: s.start_time):
        if s.attributes.get(sc.SPAN_KIND) == "tool":
            out.append({"name": s.name, "args": s.attributes[sc.INPUT],
                        "output": json.loads(s.attributes[sc.OUTPUT])["content"], "status": "ok"})
    return out


def test_replay_returns_recorded_outputs_and_flags_new_calls(spans):
    replay.install()
    CALLS.clear()
    # Source run: lookup → create_task → answer (tools execute for real)
    graph([tc("lookup_vessel", {"name": "NORD KUDU"}, 1), tc("create_task", {"title": "Check noon"}, 2),
           AIMessage("Task created.")]).invoke({"messages": [HumanMessage("noon report?")]})
    assert CALLS == ["lookup_vessel:NORD KUDU", "create_task:Check noon"]
    fixtures = fixtures_from(spans.all())
    assert [f["name"] for f in fixtures] == ["lookup_vessel", "create_task"]
    spans.exporter.clear()
    CALLS.clear()

    # Replay with a "different model": same lookup, a lookup the source never made, no task.
    state = replay.ReplayState.from_job({"tool_mode": "recorded", "fixtures": fixtures, "variant": {"model": "cheap"}},
                                        passthrough=set(), read_tools=set())
    with replay.activate(state):
        assert replay.model_override("default-model") == "cheap"
        out = graph([tc("lookup_vessel", {"name": "NORD KUDU"}, 1), tc("lookup_vessel", {"name": "ATLAS"}, 2),
                     AIMessage("No task needed.")]).invoke({"messages": [HumanMessage("noon report?")]})
    assert replay.model_override("default-model") == "default-model"   # outside replay
    assert CALLS == []                                                # nothing executed for real
    tool_msgs = [m for m in out["messages"] if m.type == "tool"]
    assert '"source": "LIVE"' in tool_msgs[0].content                 # recorded output from the source run
    assert tool_msgs[1].content == replay.NOT_RECORDED
    assert [e["mode"] for e in state.events] == ["recorded", "not_recorded"]

    tool_spans = [s for s in spans.all() if s.attributes.get(sc.SPAN_KIND) == "tool"]
    tags = sorted(t for s in tool_spans for t in s.attributes.get(sc.TAGS, []))
    assert tags == ["replay:mode:not_recorded", "replay:mode:recorded"]
    agent_span = next(s for s in spans.all() if s.name == "agent")
    assert all(s.context.trace_id == agent_span.context.trace_id for s in tool_spans)  # still nested in the run


def test_live_reads_mode_runs_reads_and_stubs_writes(spans):
    replay.install()
    CALLS.clear()
    state = replay.ReplayState.from_job({"tool_mode": "live_reads", "fixtures": [], "variant": {}},
                                        passthrough=set(), read_tools={"lookup_vessel"})
    with replay.activate(state):
        out = graph([tc("lookup_vessel", {"name": "ATLAS"}, 1), tc("create_task", {"title": "x"}, 2),
                     AIMessage("done")]).invoke({"messages": [HumanMessage("go")]})
    assert CALLS == ["lookup_vessel:ATLAS"]                            # the write never ran
    assert [m.content for m in out["messages"] if m.type == "tool"][1] == replay.STUBBED
    assert [e["mode"] for e in state.events] == ["live", "stubbed"]


def test_passthrough_tool_runs_normally(spans):
    replay.install()
    CALLS.clear()
    state = replay.ReplayState.from_job({"tool_mode": "recorded", "fixtures": [], "variant": {}},
                                        passthrough={"lookup_vessel"}, read_tools=set())
    with replay.activate(state):
        graph([tc("lookup_vessel", {"name": "X"}, 1), AIMessage("ok")]).invoke({"messages": [HumanMessage("go")]})
    assert CALLS == ["lookup_vessel:X"]
    assert state.events == []


def test_repeated_identical_calls_replay_in_order():
    st = replay.ReplayState.from_job({"fixtures": [
        {"name": "t", "args": '{"a": 1}', "output": "first"}, {"name": "t", "args": '{"a": 1}', "output": "second"}]},
        passthrough=set(), read_tools=set())
    assert st.resolve("t", {"a": 1})[1]["output"] == "first"
    assert st.resolve("t", {"a": 1})[1]["output"] == "second"
    assert st.resolve("t", {"a": 1})[0] == "not_recorded"


async def test_runner_wrapper_span_carries_experiment_thread(spans, monkeypatch):
    from imagent import runner

    posted = {}
    monkeypatch.setattr(runner, "_post", lambda path, body: posted.update({path: body}) or (200, {}))

    async def agent(job):
        return f"replayed {job.input['vessel']}"

    runner.register_agent("t_agent", agent, source_root="process_email")
    await runner._run_job({"job_id": "j1", "experiment_id": "e1", "agent": "t_agent", "variant": {"name": "v", "model": "m"},
                           "thread_id": "experiment:e1:j1", "tool_mode": "recorded", "fixtures": [],
                           "source": {"trace_id": "abc", "input": '{"vessel": "ATLAS"}'}})
    wrapper = next(s for s in spans.all() if s.name == "replay:t_agent")
    assert wrapper.attributes[sc.THREAD_ID] == "experiment:e1:j1"
    assert "experiment" in wrapper.attributes[sc.TAGS]
    done = posted["/api/runner/complete"]
    assert done["status"] == "ok" and done["output"] == "replayed ATLAS"
    assert done["trace_id"] == format(wrapper.context.trace_id, "032x")
