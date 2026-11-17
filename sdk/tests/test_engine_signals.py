"""Signals the issue engine reads: long content keeps its end, approvals are recorded."""
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import START, MessagesState, StateGraph
from langgraph.types import Command, interrupt

from imagent import runtime, semconv as sc


def test_long_content_keeps_start_and_end(spans):
    cfg = runtime.get_config()
    old = cfg.max_content_chars
    cfg.max_content_chars = 100
    try:
        s = runtime.encode_content("S" * 50 + "m" * 1000 + "E" * 50)
    finally:
        cfg.max_content_chars = old
    assert s.startswith("S" * 40) and s.endswith("E" * 50) and "truncated" in s


def test_interrupt_and_resume_are_recorded(spans):
    def ask(state: MessagesState):
        decision = interrupt({"action": "send_email", "to": "ops@example.com"})
        return {"messages": [AIMessage(f"decision: {decision['type']}")]}

    g = StateGraph(MessagesState)
    g.add_node("ask", ask)
    g.add_edge(START, "ask")
    graph = g.compile(checkpointer=InMemorySaver(), name="approver")
    cfg = {"configurable": {"thread_id": "hitl-1"}}
    graph.invoke({"messages": [HumanMessage("send it")]}, config=cfg)
    paused = [s for s in spans.all() if s.attributes.get(sc.INTERRUPT)]
    assert paused and "send_email" in paused[0].attributes[sc.INTERRUPT]
    assert all(s.status.status_code.name != "ERROR" for s in spans.all())

    graph.invoke(Command(resume={"type": "approve"}), config=cfg)
    resumed = [s for s in spans.all() if s.attributes.get(sc.RESUME)]
    assert resumed and "approve" in resumed[0].attributes[sc.RESUME]
