"""OpenAI Agents SDK integration against a mocked Responses API."""

import asyncio
import json

import httpx
import pytest

import imagent
from imagent import blueprint, replay

agents = pytest.importorskip("agents")
openai = pytest.importorskip("openai")


def _msg(text, model):
    return {"type": "message", "id": "m1", "status": "completed", "role": "assistant",
            "content": [{"type": "output_text", "text": text, "annotations": []}]}


def _response(model, output, i=12, o=5):
    return {"id": "r1", "object": "response", "created_at": 1, "model": model, "status": "completed", "output": output,
            "parallel_tool_calls": True, "tool_choice": "auto", "tools": [],
            "usage": {"input_tokens": i, "output_tokens": o, "total_tokens": i + o,
                      "input_tokens_details": {"cached_tokens": 0}, "output_tokens_details": {"reasoning_tokens": 0}}}


@pytest.fixture
def oa(spans):
    """Agents SDK on a mocked OpenAI client; first call asks for a tool, second answers."""
    from imagent.integrations import openai_agents

    openai_agents.install()
    agents.set_trace_processors([p for p in agents.tracing.get_trace_provider()._multi_processor._processors
                                 if type(p).__name__ == "_Processor"][:1] or [openai_agents._Processor()])
    seen = []

    def handler(request):
        body = json.loads(request.content)
        seen.append(body["model"])
        has_tool_result = any(isinstance(m, dict) and m.get("type") == "function_call_output" for m in body.get("input", []))
        if has_tool_result:
            return httpx.Response(200, json=_response(body["model"], [_msg("BOA's IMO is 9623764.", body["model"])]))
        return httpx.Response(200, json=_response(body["model"], [{
            "type": "function_call", "id": "fc1", "call_id": "call1", "name": "lookup_vessel",
            "arguments": json.dumps({"name": "BOA"}), "status": "completed"}]))

    client = openai.AsyncOpenAI(api_key="k", http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    agents.set_default_openai_client(client, use_for_tracing=False)
    agents.set_default_openai_api("responses")
    ran = []

    @agents.function_tool
    def lookup_vessel(name: str) -> str:
        """Find a vessel's IMO."""
        ran.append(name)
        return "IMO 9623764"

    helper = agents.Agent(name="noon_helper", instructions="Answer noon-report questions.", model="gpt-small")
    triage = agents.Agent(name="fleet_assistant", instructions="Help with the fleet.", model="gpt-big",
                          tools=[lookup_vessel], handoffs=[helper])
    return {"agent": triage, "seen": seen, "ran": ran, "spans": spans}


def test_run_is_traced_as_agent_tool_and_model_spans(oa):
    result = asyncio.run(agents.Runner.run(oa["agent"], "IMO of BOA?"))
    assert result.final_output == "BOA's IMO is 9623764."
    all_ = oa["spans"].all()
    kinds = {(s.attributes.get("imagent.span_kind"), s.name) for s in all_}
    assert ("agent", "fleet_assistant") in kinds and ("tool", "lookup_vessel") in kinds
    llm = [s for s in all_ if s.attributes.get("imagent.span_kind") == "llm"]
    assert len(llm) == 2                                       # once per model call — not again by the OpenAI SDK hook
    assert llm[0].attributes["gen_ai.usage.input_tokens"] == 12 and llm[0].name == "gpt-big"
    root = [s for s in all_ if s.parent is None]
    assert len(root) == 1 and root[0].name == "fleet_assistant"  # one trace, named after its agent
    tool = next(s for s in all_ if s.name == "lookup_vessel")
    assert tool.parent is not None and "9623764" in tool.attributes["imagent.output"]


def test_blueprint_describes_agents_tools_and_handoffs():
    from imagent.integrations.openai_agents import describe_agent

    helper = agents.Agent(name="noon_helper", instructions="Noon.", model="gpt-small", handoff_description="Noon reports")

    @agents.function_tool
    def lookup_vessel(name: str) -> str:
        """Find a vessel's IMO."""
        return ""

    bp = blueprint.describe(agents.Agent(name="fleet", instructions="Fleet.", model="gpt-big", tools=[lookup_vessel], handoffs=[helper]))
    root = bp["root"]
    assert bp["framework"] == "openai-agents" and root["model"]["name"] == "gpt-big" and root["system_prompt"] == "Fleet."
    assert root["tools"][0]["name"] == "lookup_vessel" and root["tools"][0]["args"] == ["name"]
    assert root["subagents"][0]["name"] == "noon_helper" and root["subagents"][0]["description"] == "Noon reports"


def test_experiment_replays_tools_and_swaps_each_agents_model(oa):
    st = replay.ReplayState.from_job(
        {"agent": "fleet_assistant", "variant": {"models": {"fleet_assistant": "gpt-cheap"}},
         "fixtures": [{"name": "lookup_vessel", "args": json.dumps({"name": "BOA"}), "output": "IMO 9623764 (recorded)"}]},
        passthrough=set(), read_tools=set())

    async def go():
        with replay.activate(st):
            return await agents.Runner.run(oa["agent"], "IMO of BOA?")
    asyncio.run(go())
    assert oa["seen"] == ["gpt-cheap", "gpt-cheap"]   # this agent's model swapped on both calls
    assert oa["ran"] == []                            # the tool answered from the recording
    tool = oa["spans"].by_name("lookup_vessel")
    assert "(recorded)" in tool.attributes["imagent.output"]
