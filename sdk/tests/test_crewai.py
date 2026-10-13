"""CrewAI integration against a local fake OpenAI server."""

import asyncio
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

os.environ.setdefault("CREWAI_DISABLE_TELEMETRY", "true")
os.environ.setdefault("CREWAI_TRACING_ENABLED", "false")
os.environ.setdefault("OTEL_SDK_DISABLED", "false")
crewai = pytest.importorskip("crewai")

from imagent import blueprint, replay  # noqa: E402


class _FakeOpenAI(BaseHTTPRequestHandler):
    models: list = []

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        self.models.append(body["model"])
        msgs = body.get("messages", [])
        done = any(m.get("role") == "tool" for m in msgs) or any("9623764" in str(m.get("content")) for m in msgs[1:])
        if done or not body.get("tools"):
            msg = {"role": "assistant", "content": "Thought: I now know the final answer\nFinal Answer: BOA's IMO is 9623764."}
        else:
            msg = {"role": "assistant", "content": None, "tool_calls": [
                {"id": "call1", "type": "function", "function": {"name": "lookup_vessel", "arguments": json.dumps({"name": "BOA"})}}]}
        out = json.dumps({"id": "c", "object": "chat.completion", "created": 1, "model": body["model"],
                          "choices": [{"index": 0, "finish_reason": "stop", "message": msg}],
                          "usage": {"prompt_tokens": 30, "completion_tokens": 7, "total_tokens": 37}}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


@pytest.fixture
def crew(spans):
    from crewai import LLM, Agent, Crew, Task
    from crewai.tools import tool

    from imagent.integrations import crewai as cw

    cw.install()
    _FakeOpenAI.models = []
    server = HTTPServer(("127.0.0.1", 0), _FakeOpenAI)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}/v1"
    ran = []

    @tool("lookup_vessel")
    def lookup_vessel(name: str) -> str:
        """Find a vessel's IMO number by name."""
        ran.append(name)
        return "IMO 9623764"

    analyst = Agent(role="fleet analyst", goal="Answer vessel questions", backstory="Knows the fleet.",
                    llm=LLM(model="openai/gpt-4o", base_url=base, api_key="k"), tools=[lookup_vessel], verbose=False)
    task = Task(description="What is the IMO of {vessel}?", expected_output="The IMO number", agent=analyst)
    c = Crew(name="fleet_crew", agents=[analyst], tasks=[task], verbose=False)
    yield {"crew": c, "ran": ran, "spans": spans, "models": _FakeOpenAI.models}
    server.shutdown()


def test_kickoff_is_traced_crew_agent_tool_and_model(crew):
    res = crew["crew"].kickoff(inputs={"vessel": "BOA"})
    assert "9623764" in str(res.raw)
    all_ = crew["spans"].all()
    by = {(s.attributes.get("imagent.span_kind"), s.name) for s in all_}
    assert ("agent", "fleet_crew") in by and ("agent", "fleet analyst") in by and ("tool", "lookup_vessel") in by
    llm = [s for s in all_ if s.attributes.get("imagent.span_kind") == "llm"]
    assert llm and all(s.attributes.get("gen_ai.usage.input_tokens") for s in llm)
    assert len(llm) == len(crew["models"])                         # each model call recorded once
    roots = [s for s in all_ if s.parent is None]
    assert [r.name for r in roots] == ["fleet_crew"]


def test_blueprint_lists_agents_and_tasks():
    from crewai import LLM, Agent, Crew, Task

    a = Agent(role="fleet analyst", goal="Answer", backstory="b", llm=LLM(model="openai/gpt-4o", api_key="k"))
    bp = blueprint.describe(Crew(name="fleet_crew", agents=[a], tasks=[Task(description="Find IMO", expected_output="x", agent=a)]))
    r = bp["root"]
    assert bp["framework"] == "crewai" and r["name"] == "fleet_crew"
    assert r["subagents"][0]["name"] == "fleet analyst" and "gpt-4o" in r["subagents"][0]["model"]["name"]
    assert r["graph"]["nodes"][0]["id"].startswith("task 1")


def test_experiment_replays_tools_and_swaps_the_agents_llm(crew):
    from imagent.integrations.crewai import run
    from imagent.runner import ReplayJob

    st = replay.ReplayState.from_job(
        {"agent": "fleet_crew", "variant": {"models": {"fleet analyst": "openai/gpt-4o-mini"}},
         "fixtures": [{"name": "lookup_vessel", "args": json.dumps({"name": "BOA"}), "output": "IMO 9623764 (recorded)"}]},
        passthrough=set(), read_tools=set())
    job = ReplayJob(job_id="j", experiment_id="e", agent="fleet_crew", variant={}, model="", thread_id="t", tool_mode="recorded",
                    source={"input": json.dumps({"inputs": {"vessel": "BOA"}})})

    async def go():
        with replay.activate(st):
            return await run(crew["crew"], job)
    assert "9623764" in asyncio.run(go())
    assert crew["models"] and all(m == "gpt-4o-mini" for m in crew["models"])   # this agent's model swapped
    assert crew["ran"] == []                                                    # tool answered from the recording
