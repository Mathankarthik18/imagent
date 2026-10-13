"""LlamaIndex agent integration against a mocked OpenAI chat API."""

import asyncio
import json

import httpx
import pytest

from imagent import blueprint, replay

pytest.importorskip("llama_index.core")
li_openai = pytest.importorskip("llama_index.llms.openai")


def _reply(model, message, i=20, o=6):
    return {"id": "c", "object": "chat.completion", "created": 1, "model": model,
            "choices": [{"index": 0, "finish_reason": "tool_calls" if message.get("tool_calls") else "stop", "message": message}],
            "usage": {"prompt_tokens": i, "completion_tokens": o, "total_tokens": i + o}}


@pytest.fixture
def li(spans):
    from llama_index.core.agent.workflow import FunctionAgent
    from llama_index.core.tools import FunctionTool

    from imagent.integrations import llamaindex

    llamaindex.install()
    seen, ran = [], []

    def handler(request):
        body = json.loads(request.content)
        seen.append(body["model"])
        final = any(m.get("role") == "tool" for m in body["messages"])
        msg = {"role": "assistant", "content": "BOA's IMO is 9623764."} if final else {"role": "assistant", "content": None, "tool_calls": [
            {"id": "call1", "type": "function", "function": {"name": "lookup_vessel", "arguments": json.dumps({"name": "BOA"})}}]}
        if not body.get("stream"):
            return httpx.Response(200, json=_reply(body["model"], msg))
        # FunctionAgent streams: send the same message as SSE chunks
        delta = {"role": "assistant", "content": msg["content"]}
        if msg.get("tool_calls"):
            delta["tool_calls"] = [{"index": 0, **msg["tool_calls"][0]}]
        chunks = [{"id": "c", "object": "chat.completion.chunk", "created": 1, "model": body["model"],
                   "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                  {"id": "c", "object": "chat.completion.chunk", "created": 1, "model": body["model"],
                   "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls" if not final else "stop"}],
                   "usage": {"prompt_tokens": 20, "completion_tokens": 6, "total_tokens": 26}}]
        sse = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"
        return httpx.Response(200, text=sse, headers={"content-type": "text/event-stream"})

    llm = li_openai.OpenAI(model="gpt-4o", api_key="k", async_http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
                           http_client=httpx.Client(transport=httpx.MockTransport(handler)), max_retries=0)

    def lookup_vessel(name: str) -> str:
        """Find a vessel's IMO."""
        ran.append(name)
        return "IMO 9623764"

    agent = FunctionAgent(name="fleet_agent", description="Fleet questions", system_prompt="Help with the fleet.",
                          llm=llm, tools=[FunctionTool.from_defaults(lookup_vessel)])
    return {"agent": agent, "seen": seen, "ran": ran, "spans": spans}


def test_agent_run_is_traced_with_nested_tool_and_model_calls(li):
    async def go():
        return await li["agent"].run(user_msg="IMO of BOA?")
    res = asyncio.run(go())
    assert "9623764" in str(res)
    all_ = li["spans"].all()
    agent = next(s for s in all_ if s.name == "fleet_agent")
    assert agent.attributes["imagent.span_kind"] == "agent" and agent.parent is None
    tool = next(s for s in all_ if s.name == "lookup_vessel")
    llm = [s for s in all_ if s.attributes.get("imagent.span_kind") == "llm"]
    assert len(llm) == 2 and llm[0].attributes["gen_ai.usage.input_tokens"] == 20      # recorded once each
    assert {s.context.trace_id for s in all_} == {agent.context.trace_id}                # one trace
    assert tool.parent is not None and "9623764" in tool.attributes["imagent.output"]


def test_blueprint_reads_the_agent():
    from llama_index.core.agent.workflow import FunctionAgent
    from llama_index.core.tools import FunctionTool

    def lookup_vessel(name: str) -> str:
        """Find a vessel's IMO."""
        return ""
    bp = blueprint.describe(FunctionAgent(name="fleet_agent", system_prompt="Help.", llm=li_openai.OpenAI(model="gpt-4o", api_key="k"),
                                          tools=[FunctionTool.from_defaults(lookup_vessel)]))
    r = bp["root"]
    assert bp["framework"] == "llamaindex" and r["model"]["name"] == "gpt-4o" and r["system_prompt"] == "Help."
    assert r["tools"][0]["name"] == "lookup_vessel" and r["tools"][0]["args"] == ["name"]


def test_experiment_replays_tools_and_swaps_the_llm_on_a_copy(li):
    from imagent.integrations.llamaindex import run

    st = replay.ReplayState.from_job(
        {"agent": "fleet_agent", "variant": {"models": {"fleet_agent": "gpt-4o-mini"}},
         "fixtures": [{"name": "lookup_vessel", "args": json.dumps({"name": "BOA"}), "output": "IMO 9623764 (recorded)"}]},
        passthrough=set(), read_tools=set())

    async def go():
        with replay.activate(st):
            return await run(li["agent"], [{"role": "user", "content": "IMO of BOA?"}])
    out = asyncio.run(go())
    assert "9623764" in out
    assert li["seen"] == ["gpt-4o-mini", "gpt-4o-mini"] and li["ran"] == []
    assert li["agent"].llm.model == "gpt-4o"            # the app's own agent was not changed
