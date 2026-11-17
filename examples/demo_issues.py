"""Demo runs with the failures the issue engine finds — fake models, no LLM cost, no real data.

A small fleet assistant (LangGraph, fake chat models) answering ops questions. Most runs are fine;
some go wrong the way real agents do: answering after a tool said "not found", a tool dumping
150k characters into the context, a search loop, an answer cut off at the token limit, an email
sent without the approval step, asking for details it was given, the wrong tool, a secret in the
answer, and tool timeouts.

    cd sdk && .venv/bin/python ../examples/demo_issues.py --api-key imk_…

Then in the project's Settings › Issue engine tick send_email under "Tools that need approval",
set an AI model key, and press Issues › Scan now.
"""

from __future__ import annotations

import argparse
import json
import random
import time
import uuid

from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.tools import tool
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition
from langgraph.types import Command, interrupt

import imagent

MODEL = "anthropic/claude-sonnet-5.5"
SYSTEM = ("You are Fleet Assistant for a dry-bulk operator. Answer from tool results only — never estimate a "
          "vessel's speed, position or consumption. Always give the vessel name with its IMO. Sending email "
          "needs the user's approval. Use latest_noon_report for speed and consumption questions.")
FLEET = {"ATLAS VOYAGER": "9612345", "NORDIC PEARL": "9587766", "CAPE HARMONY": "9701234", "OCEAN LIBERTY": "9455120"}


class FakeToolModel(GenericFakeChatModel):
    def bind_tools(self, tools, **kwargs):
        return self


@tool
def lookup_vessel(name: str) -> str:
    """Look up a vessel in the fleet register."""
    time.sleep(0.01)
    imo = FLEET.get(name.upper())
    return json.dumps({"name": name.upper(), "imo": imo, "type": "Bulk Carrier"} if imo else {"error": "vessel not found"})


@tool
def latest_noon_report(vessel: str) -> str:
    """Fetch the latest 24h noon report for a vessel: speed, consumption, position."""
    time.sleep(0.02)
    if vessel.endswith("!timeout"):
        raise TimeoutError("noon_reports query exceeded 5s")
    return json.dumps({"vessel": vessel, "speed_kn": 12.1, "me_fo_mt": 23.4, "lat": 1.21, "lon": 103.8})


@tool
def fleet_positions() -> str:
    """Positions and status of every vessel in the fleet."""
    rows = [{"vessel": f"MV FLEET {i:03d}", "imo": str(9_400_000 + i), "lat": round(random.uniform(-40, 50), 3),
             "lon": round(random.uniform(-170, 170), 3), "status": "laden", "notes": "x" * 380} for i in range(320)]
    return json.dumps(rows)


@tool
def search_emails(query: str) -> str:
    """Search the operations mailbox."""
    time.sleep(0.01)
    return "[]"


@tool
def create_task(title: str, vessel: str) -> str:
    """Create an operations task for the team."""
    return json.dumps({"task_id": f"T-{random.randint(1000, 9999)}", "title": title, "vessel": vessel})


@tool
def send_email(to: str, subject: str, body: str) -> str:
    """Send an email to a counterparty. Needs the user's approval first."""
    return json.dumps({"sent": True, "to": to, "message_id": uuid.uuid4().hex[:12]})


TOOLS = [lookup_vessel, latest_noon_report, fleet_positions, search_emails, create_task, send_email]


def _u(inp: int, out: int, finish: str = "stop") -> dict:
    return {"usage_metadata": {"input_tokens": inp, "output_tokens": out, "total_tokens": inp + out},
            "response_metadata": {"model_name": MODEL, "finish_reason": finish}}


def call(name: str, args: dict, inp: int = 4200) -> AIMessage:
    return AIMessage(content="", tool_calls=[{"id": f"call_{uuid.uuid4().hex[:8]}", "name": name, "args": args}],
                     **_u(inp, 40, "tool_calls"))


def say(text: str, inp: int = 4800, out: int = 90, finish: str = "stop") -> AIMessage:
    return AIMessage(content=text, **_u(inp, out, finish))


def agent(script: list[AIMessage]):
    llm = FakeToolModel(messages=iter(script))

    def model(state: MessagesState):
        time.sleep(random.uniform(0.03, 0.12))
        return {"messages": [llm.invoke(state["messages"])]}

    g = StateGraph(MessagesState)
    g.add_node("model", model)
    g.add_node("tools", ToolNode(TOOLS, handle_tool_errors=True))
    g.add_edge(START, "model")
    g.add_conditional_edges("model", tools_condition)
    g.add_edge("tools", "model")
    return g.compile(name="fleet_assistant")


def ask(script: list[AIMessage], question: str, user: str) -> None:
    thread = f"chat-{uuid.uuid4().hex[:10]}"
    agent(script).invoke({"messages": [SystemMessage(SYSTEM), HumanMessage(question)]},
                         config={"metadata": {"thread_id": thread, "user_id": user}})


# ── scenarios ───────────────────────────────────────────────────────────────

def good(v: str, imo: str):
    return [call("lookup_vessel", {"name": v}), call("latest_noon_report", {"vessel": v}),
            say(f"{v} (IMO {imo}) is doing 12.1 kn on 23.4 mt/day ME fuel oil, per today's noon report.")], \
        f"What speed is {v} doing today?"


def answered_after_not_found():
    v = random.choice(["SEA BREEZ", "NORDIC PERL", "CAPE HARMONEY"])
    return [call("lookup_vessel", {"name": v}),
            say(f"{v} is averaging 12.4 kn with about 24.1 mt/day main-engine consumption, in line with her CP.")], \
        f"How is {v} performing this week?"


def fleet_dump():
    return [call("fleet_positions", {}), say("Two vessels are within 200 nm of Singapore: MV FLEET 014 and MV FLEET 233.",
                                             inp=152_000, out=60)], "Which vessels are near Singapore right now?"


def search_loop():
    q = ["CAPE HARMONY charter party", "Cape Harmony CP", "charter party CAPE HARMONY", "CAPE HARMONY C/P"]
    return [call("search_emails", {"query": q[i % 4]}) for i in range(14)] + [
        say("I couldn't find the charter party email for CAPE HARMONY.")], "Find the charter party email for CAPE HARMONY"


def cut_off():
    text = ("# October performance — fleet\n\n| Vessel | IMO | Avg speed | ME FO/day | vs CP |\n|---|---|---|---|---|\n"
            "| ATLAS VOYAGER | 9612345 | 12.3 kn | 23.8 mt | +0.4 mt |\n| NORDIC PEARL | 9587766 | 11.9 kn | 2")
    return [call("latest_noon_report", {"vessel": "ATLAS VOYAGER"}), call("latest_noon_report", {"vessel": "NORDIC PEARL"}),
            say(text, out=8192, finish="length")], "Write the October performance report for the whole fleet"


def send_without_approval():
    return [call("send_email", {"to": "chartering@cargill-demo.com", "subject": "ATLAS VOYAGER ETA",
                                "body": "ETA Singapore 22 Oct 0600 LT."}),
            say("Done — I've emailed Cargill the updated ETA for ATLAS VOYAGER.")], \
        "Let Cargill know ATLAS VOYAGER's new ETA is 22 Oct 0600"


def asks_what_it_was_told():
    return [say("Sure — which vessel is this for, and what should the task say?")], \
        "Create a task to book hull cleaning for NORDIC PEARL at the next port call"


def wrong_tool():
    return [call("search_emails", {"query": "OCEAN LIBERTY noon report"}),
            say("OCEAN LIBERTY's latest noon report shows 11.8 kn and 22 mt/day.")], \
        "What's the latest noon report for OCEAN LIBERTY?"


def secret_in_answer():
    return [say("Connect the noon portal with this key: sk-demo-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c — paste it into Settings › API.")], \
        "How do I connect the noon portal?"


def timeout():
    return [call("latest_noon_report", {"vessel": "CAPE HARMONY!timeout"}),
            say("The noon report service timed out, so I can't give CAPE HARMONY's speed right now — try again shortly.")], \
        "Speed of CAPE HARMONY?"


def approved_send(user: str) -> None:
    """A send that goes through the approval step (the run pauses; the person approves; it resumes)."""
    def approve(state: MessagesState):
        decision = interrupt({"action": "send_email", "to": "ops@nordic-demo.com", "subject": "NORDIC PEARL bunkers"})
        return {"messages": [say(f"Approval: {decision['decisions'][0]['type']}")]}

    def send(state: MessagesState):
        send_email.invoke({"to": "ops@nordic-demo.com", "subject": "NORDIC PEARL bunkers", "body": "Please confirm 450 mt VLSFO."})
        return {"messages": [say("Sent the bunker confirmation request to Nordic ops.")]}

    g = StateGraph(MessagesState)
    g.add_node("approve", approve)
    g.add_node("send", send)
    g.add_edge(START, "approve")
    g.add_edge("approve", "send")
    graph = g.compile(checkpointer=InMemorySaver(), name="fleet_assistant")
    cfg = {"configurable": {"thread_id": f"chat-{uuid.uuid4().hex[:10]}"}, "metadata": {"user_id": user}}
    graph.invoke({"messages": [SystemMessage(SYSTEM), HumanMessage("Ask Nordic ops to confirm the bunker stem")]}, config=cfg)
    graph.invoke(Command(resume={"decisions": [{"type": "approve"}]}), config=cfg)


def main(rounds: int) -> None:
    users = ["ops@demo", "chartering@demo", "tech@demo"]
    plan = ([answered_after_not_found] * 4 + [fleet_dump] * 3 + [search_loop] * 2 + [cut_off] * 3 +
            [send_without_approval] * 2 + [asks_what_it_was_told] * 2 + [wrong_tool] * 2 + [secret_in_answer] +
            [timeout] * 3)
    for _ in range(rounds):
        for v, imo in FLEET.items():
            ask(*good(v, imo), random.choice(users))
        approved_send(random.choice(users))
        for scenario in random.sample(plan, len(plan)):
            ask(*scenario(), random.choice(users))
    imagent.flush()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, default=2)
    ap.add_argument("--endpoint", default="http://localhost:8300")
    ap.add_argument("--api-key", default=None)
    args = ap.parse_args()
    imagent.init(service="fleet-demo", endpoint=args.endpoint, api_key=args.api_key, environment="demo")
    main(args.rounds)
    print("done")
