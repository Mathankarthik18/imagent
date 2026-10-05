import json

import pytest
from opentelemetry.trace import StatusCode

import imagent
from imagent import semconv as sc


def test_nested_sync_spans_share_trace_and_mark_root(spans):
    @imagent.observe(kind="tool")
    def lookup(imo: str) -> dict:
        return {"imo": imo, "name": "MV Test"}

    @imagent.observe("pipeline", kind="agent")
    def pipeline(x):
        return lookup(x)

    assert pipeline("9876543") == {"imo": "9876543", "name": "MV Test"}

    root, child = spans.by_name("pipeline"), spans.by_name("test_nested_sync_spans_share_trace_and_mark_root.<locals>.lookup")
    assert child.parent.span_id == root.context.span_id
    assert root.attributes[sc.ROOT] is True and child.attributes[sc.ROOT] is False
    assert child.attributes[sc.SPAN_KIND] == "tool"
    assert json.loads(child.attributes[sc.INPUT]) == {"imo": "9876543"}
    assert json.loads(child.attributes[sc.OUTPUT])["name"] == "MV Test"
    assert root.attributes[sc.GEN_AI_AGENT_NAME] == "pipeline"
    assert root.resource.attributes["service.name"] == "test"


async def test_async_error_is_recorded(spans):
    @imagent.observe
    async def boom():
        raise ValueError("bad noon report")

    with pytest.raises(ValueError):
        await boom()
    s = spans.all()[0]
    assert s.status.status_code == StatusCode.ERROR
    assert "bad noon report" in s.status.description
    assert any(e.name == "exception" for e in s.events)


def test_generator_collects_items(spans):
    @imagent.observe
    def gen():
        yield 1
        yield 2

    assert list(gen()) == [1, 2]
    assert json.loads(spans.all()[0].attributes[sc.OUTPUT]) == [1, 2]


def test_context_and_redaction(spans):
    @imagent.observe
    def call(prompt):
        return "ok"

    with imagent.context(thread_id="t-1", user_id="u-9", tags=["email"], metadata={"vessel": "ATLAS"}):
        with imagent.context(tags=["noon"]):
            call("key sk-abcdefghijklmnopqrstuvwx and card 4111 1111 1111 1111")

    s = spans.all()[0]
    assert s.attributes[sc.THREAD_ID] == "t-1"
    assert s.attributes[sc.USER_ID] == "u-9"
    assert list(s.attributes[sc.TAGS]) == ["email", "noon"]
    assert json.loads(s.attributes[sc.METADATA]) == {"vessel": "ATLAS"}
    raw = s.attributes[sc.INPUT]
    assert "sk-abc" not in raw and "4111" not in raw
    assert "[REDACTED_API_KEY]" in raw and "[REDACTED_CARD]" in raw


def test_truncation(spans):
    imagent.get_config().max_content_chars = 50

    @imagent.observe
    def big():
        return "x" * 500

    out = spans.all() or None
    big()
    out = spans.all()[0].attributes[sc.OUTPUT]
    assert out.startswith("x" * 50) and "truncated 450 chars" in out


def test_noop_when_not_initialised():
    from imagent import runtime

    runtime.shutdown()

    @imagent.observe
    def f(x):
        return x * 2

    assert f(21) == 42
