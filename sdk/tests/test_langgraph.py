import json

from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.tools import tool
from langgraph.graph import START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition

import harness_moni as hm
from harness_moni import semconv as sc


class FakeToolModel(GenericFakeChatModel):
    def bind_tools(self, tools, **kwargs):
        return self


@hm.observe("fetch_noon_db", kind="retriever")
def fetch_noon_db(vessel: str) -> dict:
    return {"vessel": vessel, "speed": 12.4}


@tool
def vessel_speed(vessel: str) -> str:
    """Latest reported speed for a vessel."""
    return json.dumps(fetch_noon_db(vessel))


def build_graph():
    model = FakeToolModel(messages=iter([
        AIMessage(content="", tool_calls=[{"id": "call_1", "name": "vessel_speed", "args": {"vessel": "ATLAS"}}],
                  usage_metadata={"input_tokens": 120, "output_tokens": 15, "total_tokens": 135,
                                  "input_token_details": {"cache_read": 100}},
                  response_metadata={"model_name": "anthropic/claude-sonnet-5.5",
                                     "token_usage": {"cost": 0.00042}}),
        AIMessage(content="ATLAS is doing 12.4 kn.",
                  usage_metadata={"input_tokens": 160, "output_tokens": 9, "total_tokens": 169}),
    ]))

    def call_model(state: MessagesState):
        return {"messages": [model.invoke(state["messages"])]}

    g = StateGraph(MessagesState)
    g.add_node("model", call_model)
    g.add_node("tools", ToolNode([vessel_speed]))
    g.add_edge(START, "model")
    g.add_conditional_edges("model", tools_condition)
    g.add_edge("tools", "model")
    return g.compile(name="speed_agent")


def test_langgraph_agent_span_tree(spans):
    graph = build_graph()
    with hm.harness_context(user_id="u-1"):
        result = graph.invoke({"messages": [HumanMessage("How fast is ATLAS?")]},
                              config={"configurable": {"thread_id": "email-42"}})
    assert result["messages"][-1].content == "ATLAS is doing 12.4 kn."

    all_spans = spans.all()
    names = [s.name for s in all_spans]
    # plumbing runnables are filtered out
    assert not any(n.startswith(("ChannelWrite", "Branch<", "RunnableSequence")) for n in names), names

    roots = [s for s in all_spans if s.attributes.get(sc.ROOT)]
    assert len(roots) == 1
    root = roots[0]
    assert root.name == "speed_agent"
    assert root.attributes[sc.SPAN_KIND] == "agent"
    assert {s.context.trace_id for s in all_spans} == {root.context.trace_id}

    for s in all_spans:
        assert s.attributes.get(sc.THREAD_ID) == "email-42", s.name
        assert s.attributes.get(sc.USER_ID) == "u-1", s.name
        assert s.attributes.get(sc.GEN_AI_AGENT_NAME) == "speed_agent", s.name

    nodes = [s for s in all_spans if s.attributes.get(sc.SPAN_KIND) == "node"]
    assert sorted(n.name for n in nodes) == ["model", "model", "tools"]
    for n in nodes:
        assert n.parent.span_id == root.context.span_id

    llms = [s for s in all_spans if s.attributes.get(sc.SPAN_KIND) == "llm"]
    assert len(llms) == 2
    first = min(llms, key=lambda s: s.start_time)
    assert first.attributes[sc.GEN_AI_USAGE_INPUT_TOKENS] == 120
    assert first.attributes[sc.GEN_AI_USAGE_OUTPUT_TOKENS] == 15
    assert first.attributes[sc.GEN_AI_USAGE_CACHE_READ] == 100
    assert first.attributes[sc.COST_USD] == 0.00042
    assert first.attributes[sc.GEN_AI_RESPONSE_MODEL] == "anthropic/claude-sonnet-5.5"
    llm_in = json.loads(first.attributes[sc.INPUT])
    assert llm_in == [{"role": "user", "content": "How fast is ATLAS?"}]
    llm_out = json.loads(first.attributes[sc.OUTPUT])
    assert llm_out["tool_calls"][0]["name"] == "vessel_speed"

    tool_span = spans.by_name("vessel_speed")
    assert tool_span.attributes[sc.SPAN_KIND] == "tool"
    assert tool_span.attributes[sc.GEN_AI_TOOL_CALL_ID] == "call_1"
    assert json.loads(tool_span.attributes[sc.INPUT]) == {"vessel": "ATLAS"}

    # @observe inside a LangChain tool nests under the tool span
    inner = spans.by_name("fetch_noon_db")
    assert inner.parent.span_id == tool_span.context.span_id
    assert inner.attributes[sc.ROOT] is False


async def test_langgraph_async_nests_under_observe(spans):
    graph = build_graph()

    @hm.observe("handle_email", kind="agent")
    async def handle_email():
        return await graph.ainvoke({"messages": [HumanMessage("speed?")]},
                                   config={"configurable": {"thread_id": "t-async"}})

    await handle_email()
    outer = spans.by_name("handle_email")
    agent = spans.by_name("speed_agent")
    assert agent.parent.span_id == outer.context.span_id
    assert agent.attributes[sc.ROOT] is False
    assert outer.attributes[sc.ROOT] is True
    assert len({s.context.trace_id for s in spans.all()}) == 1
    # async path: the sync tool runs in an executor, yet @observe still nests under the tool
    assert spans.by_name("fetch_noon_db").parent.span_id == spans.by_name("vessel_speed").context.span_id
    assert not any(s.name == "tools_condition" for s in spans.all())


async def test_llm_called_inside_observe_inherits_agent(spans):
    model = GenericFakeChatModel(messages=iter([AIMessage("noon_report")]))

    @hm.observe("process_email", kind="agent")
    async def process():
        return await model.ainvoke("classify", config={"run_name": "classify_email"})

    with hm.harness_context(thread_id="t-9"):
        await process()
    llm = spans.by_name("classify_email")
    assert llm.attributes[sc.GEN_AI_AGENT_NAME] == "process_email"
    assert llm.attributes[sc.THREAD_ID] == "t-9"
    assert llm.attributes[sc.ROOT] is False


def test_tool_error_marks_span(spans):
    @tool
    def flaky(x: str) -> str:
        """Always fails."""
        raise RuntimeError("upstream 503")

    try:
        flaky.invoke({"x": "a"})
    except RuntimeError:
        pass
    s = spans.by_name("flaky")
    assert s.status.status_code.name == "ERROR"
    assert s.attributes[sc.ROOT] is True


def test_orphan_runs_relink_by_checkpoint_namespace(spans):
    """Production (deepagents + astream_events) delivered LLM/tool callbacks whose
    parent_run_id pointed at runs the handler never saw. They must still nest."""
    import uuid

    from harness_moni.integrations.langchain import get_callback_handler

    h = get_callback_handler()
    agent, node, llm, tool_run, late = (uuid.uuid4() for _ in range(5))
    md_graph = {"thread_id": "t-ns"}
    md_node = {"thread_id": "t-ns", "langgraph_node": "model", "langgraph_checkpoint_ns": "model:abc"}

    h.on_chain_start({"id": ["langgraph", "CompiledStateGraph"]}, {}, run_id=agent, metadata=md_graph, name="orchestrator")
    h.on_chain_start(None, {}, run_id=node, parent_run_id=agent, metadata=md_node, name="model")
    # unknown parent id, same namespace → relinked under the node
    h.on_chat_model_start({}, [[]], run_id=llm, parent_run_id=uuid.uuid4(), metadata=md_node)
    h.on_llm_end(type("R", (), {"generations": []})(), run_id=llm)
    # missing parent id but clearly inside a graph task → relinked too
    h.on_tool_start({"name": "ping"}, "x", run_id=tool_run, metadata={**md_node, "langgraph_checkpoint_ns": "model:abc|sub:1"})
    h.on_tool_end("pong", run_id=tool_run)
    h.on_chain_end({}, run_id=node)
    # parent already ended → still found via the recent-runs cache
    h.on_tool_start({"name": "late"}, "x", run_id=late, parent_run_id=node, metadata=md_graph)
    h.on_tool_end("ok", run_id=late)
    h.on_chain_end({}, run_id=agent)

    by = {s.name: s for s in spans.all()}
    root = by["orchestrator"]
    assert len({s.context.trace_id for s in spans.all()}) == 1
    model_span = by["model"]
    llm_span = next(s for s in spans.all() if s.attributes.get(sc.SPAN_KIND) == "llm")
    assert llm_span.parent.span_id == model_span.context.span_id
    assert llm_span.attributes["harness.lc.relinked"] == "checkpoint_ns"
    assert by["ping"].parent.span_id == model_span.context.span_id
    assert by["late"].parent.span_id == model_span.context.span_id
    assert model_span.parent.span_id == root.context.span_id
    assert all(s.attributes.get("harness.lc.run_id") for s in spans.all())


def test_streamed_call_metadata_is_not_doubled(spans):
    """Streaming merges chunks and concatenates string metadata; the span must not."""
    from langchain_core.messages import AIMessageChunk
    from langchain_core.outputs import ChatGeneration, LLMResult

    from harness_moni.integrations.langchain import _unrepeat, get_callback_handler

    assert _unrepeat("z-ai/glm-5.3-flashz-ai/glm-5.3-flash") == "z-ai/glm-5.3-flash"
    assert _unrepeat("stopstop") == "stop"
    assert _unrepeat("gpt-4o") == "gpt-4o"

    import uuid
    h = get_callback_handler()
    run = uuid.uuid4()
    h.on_chat_model_start({}, [[]], run_id=run, invocation_params={"model": "z-ai/glm-5.3-flash"})
    merged = (AIMessageChunk(content="a", response_metadata={"model_name": "z-ai/glm-5.3-flash"})
              + AIMessageChunk(content="b", response_metadata={"model_name": "z-ai/glm-5.3-flash", "finish_reason": "stop"},
                               usage_metadata={"input_tokens": 9, "output_tokens": 2, "total_tokens": 11}))
    h.on_llm_end(LLMResult(generations=[[ChatGeneration(message=merged)]]), run_id=run)
    s = next(x for x in spans.all() if x.attributes.get(sc.SPAN_KIND) == "llm")
    assert s.attributes[sc.GEN_AI_RESPONSE_MODEL] == "z-ai/glm-5.3-flash"
    assert list(s.attributes[sc.GEN_AI_RESPONSE_FINISH_REASONS]) == ["stop"]
    assert s.attributes[sc.GEN_AI_USAGE_INPUT_TOKENS] == 9
