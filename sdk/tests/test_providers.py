"""OpenAI / Anthropic SDK integrations, against mocked HTTP — no network, no cost."""

import asyncio
import json

import httpx
import pytest

import imagent
from imagent import replay

openai = pytest.importorskip("openai")
anthropic = pytest.importorskip("anthropic")


def _openai(handler, *, base_url="https://api.openai.com/v1", is_async=False):
    if is_async:
        return openai.AsyncOpenAI(api_key="k", base_url=base_url, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    return openai.OpenAI(api_key="k", base_url=base_url, http_client=httpx.Client(transport=httpx.MockTransport(handler)))


def _anthropic(handler, is_async=False):
    try:  # newer Anthropic SDKs ship on httpx2
        import httpx2 as hx
    except ImportError:
        hx = httpx

    def h(request):
        r = handler(request)
        return hx.Response(r.status_code, content=r.content, headers=dict(r.headers))
    if is_async:
        return anthropic.AsyncAnthropic(api_key="k", http_client=hx.AsyncClient(transport=hx.MockTransport(h)))
    return anthropic.Anthropic(api_key="k", http_client=hx.Client(transport=hx.MockTransport(h)))


def _chat_reply(request):
    body = json.loads(request.content)
    return httpx.Response(200, json={
        "id": "c1", "object": "chat.completion", "created": 1, "model": body["model"],
        "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": f"hi from {body['model']}"}}],
        "usage": {"prompt_tokens": 12, "completion_tokens": 4, "total_tokens": 16, "prompt_tokens_details": {"cached_tokens": 2},
                  "cost": 0.0003}})


def test_openai_chat_call_is_traced(spans):
    client = _openai(_chat_reply, base_url="https://openrouter.ai/api/v1")
    r = client.chat.completions.create(model="z-ai/glm-5.2", messages=[{"role": "user", "content": "hello"}], temperature=0.2)
    assert r.choices[0].message.content == "hi from z-ai/glm-5.2"
    s = spans.by_name("z-ai/glm-5.2")
    a = s.attributes
    assert a["imagent.span_kind"] == "llm" and a["gen_ai.system"] == "openrouter"
    assert a["gen_ai.usage.input_tokens"] == 12 and a["gen_ai.usage.output_tokens"] == 4 and a["gen_ai.usage.cache_read_input_tokens"] == 2
    assert a["imagent.cost_usd"] == 0.0003 and a["gen_ai.request.temperature"] == 0.2
    assert "hello" in a["imagent.input"] and "hi from z-ai/glm-5.2" in a["imagent.output"]


def test_openai_stream_is_traced_when_consumed(spans):
    def sse(request):
        chunks = [{"id": "c", "object": "chat.completion.chunk", "created": 1, "model": "gpt-x",
                   "choices": [{"index": 0, "delta": {"content": t}, "finish_reason": None}]} for t in ("Hel", "lo")]
        chunks.append({"id": "c", "object": "chat.completion.chunk", "created": 1, "model": "gpt-x",
                       "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                       "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7}})
        body = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"
        return httpx.Response(200, text=body, headers={"content-type": "text/event-stream"})

    stream = _openai(sse).chat.completions.create(model="gpt-x", messages=[{"role": "user", "content": "hi"}], stream=True)
    assert "".join(c.choices[0].delta.content or "" for c in stream if c.choices) == "Hello"
    s = spans.by_name("gpt-x")
    assert "Hello" in s.attributes["imagent.output"] and s.attributes["gen_ai.usage.output_tokens"] == 2
    assert "imagent.ttft_ms" in s.attributes


def test_openai_async_and_errors(spans):
    async def go():
        c = _openai(_chat_reply, is_async=True)
        await c.chat.completions.create(model="m-async", messages=[{"role": "user", "content": "x"}])
        bad = _openai(lambda r: httpx.Response(400, json={"error": {"message": "nope"}}), is_async=True)
        with pytest.raises(openai.BadRequestError):
            await bad.with_options(max_retries=0).chat.completions.create(model="m-bad", messages=[{"role": "user", "content": "x"}])
    asyncio.run(go())
    assert spans.by_name("m-async").attributes["gen_ai.usage.input_tokens"] == 12
    assert spans.by_name("m-bad").status.status_code.name == "ERROR"


def test_anthropic_call_counts_cached_tokens(spans):
    def reply(request):
        body = json.loads(request.content)
        return httpx.Response(200, json={
            "id": "m1", "type": "message", "role": "assistant", "model": body["model"], "stop_reason": "end_turn",
            "content": [{"type": "text", "text": "bonjour"}],
            "usage": {"input_tokens": 10, "output_tokens": 3, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 0}})

    _anthropic(reply).messages.create(model="claude-haiku-5-5", max_tokens=50, system="be brief",
                                      messages=[{"role": "user", "content": "hi"}])
    a = spans.by_name("claude-haiku-5-5").attributes
    assert a["gen_ai.system"] == "anthropic" and a["gen_ai.usage.input_tokens"] == 110 and a["gen_ai.usage.cache_read_input_tokens"] == 100
    assert "be brief" in a["imagent.input"] and "bonjour" in a["imagent.output"]


def test_anthropic_stream(spans):
    def sse(request):
        events = [
            ("message_start", {"type": "message_start", "message": {"id": "m", "type": "message", "role": "assistant", "model": "claude-x",
                               "content": [], "stop_reason": None, "usage": {"input_tokens": 7, "output_tokens": 1}}}),
            ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
            ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hi "}}),
            ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "there"}}),
            ("content_block_stop", {"type": "content_block_stop", "index": 0}),
            ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 5}}),
            ("message_stop", {"type": "message_stop"}),
        ]
        body = "".join(f"event: {e}\ndata: {json.dumps(d)}\n\n" for e, d in events)
        return httpx.Response(200, text=body, headers={"content-type": "text/event-stream"})

    stream = _anthropic(sse).messages.create(model="claude-x", max_tokens=20, messages=[{"role": "user", "content": "hi"}], stream=True)
    for _ in stream:
        pass
    a = spans.by_name("claude-x").attributes
    assert "Hi there" in a["imagent.output"] and a["gen_ai.usage.output_tokens"] == 5 and a["gen_ai.usage.input_tokens"] == 7


def test_experiment_swaps_the_provider_model_and_replays_observed_tools(spans):
    seen = []

    def reply(request):
        seen.append(json.loads(request.content)["model"])
        return _chat_reply(request)

    client = _openai(reply, base_url="https://openrouter.ai/api/v1")
    calls = []

    @imagent.observe("lookup_vessel", kind="tool")
    def lookup_vessel(name: str) -> dict:
        calls.append(name)
        return {"imo": "LIVE"}

    st = replay.ReplayState.from_job(
        {"agent": "support", "variant": {"model": "openrouter/anthropic/claude-haiku-5.5"},
         "fixtures": [{"name": "lookup_vessel", "args": json.dumps({"name": "BOA"}), "output": json.dumps({"imo": "9623764"})}]},
        passthrough=set(), read_tools=set())
    with replay.activate(st):
        client.chat.completions.create(model="z-ai/glm-5.2", messages=[{"role": "user", "content": "x"}])
        assert lookup_vessel("BOA") == {"imo": "9623764"}          # recorded answer, structured again
        assert "unavailable" in lookup_vessel("LYNX")              # not in the recording
    assert seen == ["anthropic/claude-haiku-5.5"] and calls == []  # model swapped (router prefix dropped), tool never ran
    client.chat.completions.create(model="z-ai/glm-5.2", messages=[{"role": "user", "content": "x"}])
    assert seen[-1] == "z-ai/glm-5.2" and lookup_vessel("X") == {"imo": "LIVE"}   # outside a replay: untouched


def test_langchain_chat_model_call_is_not_recorded_twice(spans):
    langchain_openai = pytest.importorskip("langchain_openai")
    llm = langchain_openai.ChatOpenAI(model="gpt-x", api_key="k", http_client=httpx.Client(transport=httpx.MockTransport(_chat_reply)))
    llm.invoke("hello")
    assert len([s for s in spans.all() if s.attributes.get("imagent.span_kind") == "llm"]) == 1
