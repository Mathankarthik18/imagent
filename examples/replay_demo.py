"""Experiment runner demo — replays the demo agents' `process_email` runs.

    cd sdk && .venv/bin/python ../examples/demo_agents.py --runs 10   # record some source runs first
    cd sdk && .venv/bin/python ../examples/replay_demo.py              # then start the runner

Then open http://localhost:8300/experiments → New experiment. Variant model "smart"
behaves like the original; "cheap" forgets to create the task — the experiment
should flag that as a regression.
"""

from __future__ import annotations

import asyncio
import uuid

from demo_agents import FakeToolModel, create_task, latest_noon_report, lookup_vessel, usage
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langgraph.graph import START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition

import imagent


def scripted_model(model: str, vessel: str):
    """Stand-in for a real LLM: 'cheap' skips the task, anything else follows the original plan."""
    call = lambda name, args: AIMessage(content="", tool_calls=[{"id": f"call_{uuid.uuid4().hex[:8]}", "name": name, "args": args}],
                                        **usage(model, 3000, 30, 2500))
    steps = [call("lookup_vessel", {"name": vessel}), call("latest_noon_report", {"vessel": vessel})]
    if model != "cheap":
        steps.append(call("create_task", {"title": f"Review ME consumption for {vessel}", "vessel": vessel}))
        steps.append(AIMessage(content=f"Created a task to review main-engine consumption on {vessel}.", **usage(model, 3600, 40, 2500)))
    else:
        steps.append(AIMessage(content=f"{vessel} looks fine; no action needed.", **usage(model, 3300, 20, 2500)))
    return FakeToolModel(messages=iter(steps))


async def replay_email(job: imagent.ReplayJob) -> str:
    vessel = (job.input or {}).get("vessel", "UNKNOWN")
    model = scripted_model(job.model or "smart", vessel)

    def call_model(state: MessagesState):
        return {"messages": [model.invoke(state["messages"])]}

    g = StateGraph(MessagesState)
    g.add_node("model", call_model)
    g.add_node("tools", ToolNode([lookup_vessel, latest_noon_report, create_task]))
    g.add_edge(START, "model")
    g.add_conditional_edges("model", tools_condition)
    g.add_edge("tools", "model")
    agent = g.compile(name="email_router")
    result = await agent.ainvoke({"messages": [SystemMessage("You are Bosun."), HumanMessage(f"Noon report for {vessel}")]},
                                 config={"configurable": {"thread_id": job.thread_id}})
    return result["messages"][-1].content


async def main() -> None:
    imagent.init(service="bosun-demo", endpoint="http://localhost:8300", environment="dev")
    imagent.register_agent("demo_email", replay_email, source_root="process_email",
                           description="Demo email router", models=["smart", "cheap"])
    print("runner started — create an experiment at http://localhost:8300/experiments")
    await imagent.runner.run_forever()


if __name__ == "__main__":
    asyncio.run(main())
