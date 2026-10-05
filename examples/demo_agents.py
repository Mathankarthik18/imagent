"""Generate realistic demo traces without spending on LLM calls.

Runs Bosun-shaped LangGraph agents backed by fake chat models, exported over
real OTLP/HTTP to a harness server:

    cd sdk && .venv/bin/python ../examples/demo_agents.py --runs 40 --endpoint http://localhost:8300
"""

from __future__ import annotations

import argparse
import asyncio
import json
import random
import time
import uuid

from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.tools import tool
from langgraph.graph import START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition

import harness_moni as hm

VESSELS = ["ATLAS VOYAGER", "NORDIC PEARL", "CAPE HARMONY", "SEA BREEZE", "OCEAN LIBERTY"]
MODELS = ["anthropic/claude-sonnet-5.5", "anthropic/claude-haiku-4.5", "anthropic/claude-opus-5.5"]


class FakeToolModel(GenericFakeChatModel):
    def bind_tools(self, tools, **kwargs):
        return self


@hm.observe("mongo.find_vessel", kind="retriever")
def find_vessel(name: str) -> dict:
    time.sleep(random.uniform(0.005, 0.03))
    return {"name": name, "imo": str(9_000_000 + abs(hash(name)) % 999_999), "type": "Bulk Carrier"}


@tool
def lookup_vessel(name: str) -> str:
    """Look up a vessel in the fleet knowledge base."""
    return json.dumps(find_vessel(name))


@tool
def latest_noon_report(vessel: str) -> str:
    """Fetch the latest 24h noon report for a vessel."""
    time.sleep(random.uniform(0.01, 0.06))
    if random.random() < 0.08:
        raise TimeoutError("noon_reports query exceeded 5s")
    return json.dumps({"vessel": vessel, "speed_kn": round(random.uniform(10, 14), 1),
                       "me_fo_mt": round(random.uniform(18, 32), 1)})


@tool
def create_task(title: str, vessel: str) -> str:
    """Create an operations task for the team."""
    time.sleep(random.uniform(0.005, 0.02))
    return json.dumps({"task_id": f"T-{random.randint(1000, 9999)}", "title": title, "vessel": vessel})


def usage(model: str, inp: int, out: int, cached: int) -> dict:
    return {
        "usage_metadata": {"input_tokens": inp, "output_tokens": out, "total_tokens": inp + out,
                           "input_token_details": {"cache_read": cached}},
        "response_metadata": {"model_name": model, "finish_reason": "stop"},
    }


def router_graph(vessel: str, model: str):
    sys_tokens = random.randint(3000, 9000)
    script = [
        AIMessage(content="", tool_calls=[{"id": f"call_{uuid.uuid4().hex[:8]}", "name": "lookup_vessel", "args": {"name": vessel}}],
                  **usage(model, sys_tokens + 400, 40, sys_tokens if random.random() < 0.8 else 0)),
        AIMessage(content="", tool_calls=[{"id": f"call_{uuid.uuid4().hex[:8]}", "name": "latest_noon_report", "args": {"vessel": vessel}}],
                  **usage(model, sys_tokens + 700, 35, sys_tokens)),
        AIMessage(content="", tool_calls=[{"id": f"call_{uuid.uuid4().hex[:8]}", "name": "create_task",
                                           "args": {"title": f"Review ME consumption for {vessel}", "vessel": vessel}}],
                  **usage(model, sys_tokens + 1100, 60, sys_tokens)),
        AIMessage(content=f"Created a task to review main-engine consumption on {vessel}; speed is within CP terms.",
                  **usage(model, sys_tokens + 1400, 55, sys_tokens)),
    ]
    llm = FakeToolModel(messages=iter(script))

    def call_model(state: MessagesState):
        time.sleep(random.uniform(0.05, 0.35))
        return {"messages": [llm.invoke(state["messages"])]}

    g = StateGraph(MessagesState)
    g.add_node("model", call_model)
    g.add_node("tools", ToolNode([lookup_vessel, latest_noon_report, create_task], handle_tool_errors=True))
    g.add_edge(START, "model")
    g.add_conditional_edges("model", tools_condition)
    g.add_edge("tools", "model")
    return g.compile(name="email_router")


def classifier(model: str):
    label = random.choice(["noon_report", "voyage_instruction", "bunker_enquiry", "general"])
    return FakeToolModel(messages=iter([AIMessage(content=json.dumps({"email_type": label}),
                                                  **usage(model, random.randint(800, 2500), 12, 0))]))


@hm.observe("process_email", kind="agent")
async def process_email(vessel: str, model: str) -> str:
    subject = f"{vessel} - Noon report {random.randint(1, 28)}/10"
    cls = await classifier("anthropic/claude-haiku-4.5").ainvoke(
        [SystemMessage("Classify the email."), HumanMessage(subject)], config={"run_name": "classify_email"})
    if random.random() < 0.05:
        raise ValueError("classifier returned unknown email_type")
    graph = router_graph(vessel, model)
    result = await graph.ainvoke({"messages": [SystemMessage("You are Bosun, a ship-operations assistant."),
                                               HumanMessage(f"Subject: {subject}\n\nPlease review today's report.")]})
    return f"{cls.content} → {result['messages'][-1].content}"


async def main(runs: int) -> None:
    threads = [f"gmail-thread-{uuid.uuid4().hex[:10]}" for _ in range(max(runs // 3, 1))]
    for _ in range(runs):
        vessel = random.choice(VESSELS)
        with hm.harness_context(thread_id=random.choice(threads), user_id=random.choice(["ops@marlo", "tech@marlo"]),
                                tags=["email", "demo"], metadata={"vessel": vessel}):
            try:
                await process_email(vessel, random.choice(MODELS))
            except Exception as exc:  # errors are part of the demo
                print("run failed:", exc)
    hm.flush()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=30)
    ap.add_argument("--endpoint", default="http://localhost:8300")
    ap.add_argument("--api-key", default=None)
    args = ap.parse_args()
    hm.init(service="bosun-demo", endpoint=args.endpoint, api_key=args.api_key, environment="dev")
    asyncio.run(main(args.runs))
    print("done")
