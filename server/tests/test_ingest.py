import json

import pytest

import imagent
from imagent_server import pricing
from imagent_server.db import COLUMNS
from imagent_server.ingest import decode_request, span_rows

from .conftest import otlp_bytes


def row_dicts(spans):
    req = decode_request(otlp_bytes(spans), "application/x-protobuf")
    return [dict(zip(COLUMNS, r)) for r in span_rows(req)]


@pytest.mark.parametrize("model,expected", [
    ("openrouter/anthropic/claude-sonnet-4.5", "claude-sonnet-4-5"),
    ("anthropic/claude-opus-5.5", "claude-opus-5-5"),
    ("claude-3-5-haiku-20241022", "claude-3-5-haiku"),
])
def test_normalise_model(model, expected):
    assert pricing.normalise_model(model) == expected


def test_compute_cost_longest_prefix_and_cache():
    # Sonnet 5.5: $2 in / $10 out / $0.20 cache read. Must not match "claude-sonnet-5".
    cost = pricing.compute_cost("anthropic/claude-sonnet-5.5", 1_000_000, 100_000, 800_000, 0)
    assert cost == pytest.approx((200_000 * 2 + 800_000 * 0.2 + 100_000 * 10) / 1_000_000)
    assert pricing.compute_cost("some/unknown-model", 10, 10, 0, 0) is None


def test_sdk_spans_map_to_rows(sdk_spans):
    @imagent.observe("lookup", kind="tool")
    def lookup(imo):
        return {"imo": imo}

    @imagent.observe("router", kind="agent")
    def router():
        return lookup("9")

    with imagent.context(thread_id="thr-1", tags=["email"]):
        router()
    rows = {r["name"]: r for r in row_dicts(sdk_spans())}

    root, child = rows["router"], rows["lookup"]
    assert root["project"] == "bosun-test" and root["environment"] == "test"
    assert root["is_root"] == 1 and child["is_root"] == 0
    assert child["parent_span_id"] == root["span_id"] and child["trace_id"] == root["trace_id"]
    assert child["kind"] == "tool" and child["thread_id"] == "thr-1" and child["tags"] == ["email"]
    assert child["agent_name"] == "router"
    assert json.loads(child["output"]) == {"imo": "9"}
    assert "imagent.input" not in child["attributes"]
    assert child["attributes"]["gen_ai.tool.name"] == "lookup"


def test_llm_cost_provider_vs_computed():
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    exp = InMemorySpanExporter()
    tp = TracerProvider()
    tp.add_span_processor(SimpleSpanProcessor(exp))
    tracer = tp.get_tracer("other-lib")  # a non-imagent GenAI emitter
    with tracer.start_as_current_span("chat claude", attributes={
        "gen_ai.operation.name": "chat", "gen_ai.request.model": "claude-haiku-4-5",
        "gen_ai.usage.input_tokens": 1000, "gen_ai.usage.output_tokens": 200}):
        pass
    with tracer.start_as_current_span("chat or", attributes={
        "gen_ai.operation.name": "chat", "gen_ai.request.model": "x/y",
        "gen_ai.usage.input_tokens": 5, "gen_ai.usage.output_tokens": 5, "imagent.cost_usd": 0.5}):
        pass
    rows = {r["name"]: r for r in row_dicts(exp.get_finished_spans())}
    computed = rows["chat claude"]
    assert computed["kind"] == "llm" and computed["is_root"] == 1
    assert computed["cost_source"] == "computed"
    assert computed["cost_usd"] == pytest.approx((1000 * 1 + 200 * 5) / 1_000_000)
    assert rows["chat or"]["cost_source"] == "provider" and rows["chat or"]["cost_usd"] == 0.5


def test_otlp_json_hex_ids():
    payload = {"resourceSpans": [{"resource": {"attributes": [
        {"key": "service.name", "value": {"stringValue": "js-app"}}]},
        "scopeSpans": [{"spans": [{
            "traceId": "5b8efff798038103d269b633813fc60c", "spanId": "eee19b7ec3c1b174",
            "name": "agent", "startTimeUnixNano": "1700000000000000000", "endTimeUnixNano": "1700000001000000000",
            "attributes": [{"key": "imagent.span_kind", "value": {"stringValue": "agent"}}]}]}]}]}
    req = decode_request(json.dumps(payload).encode(), "application/json")
    row = dict(zip(COLUMNS, span_rows(req)[0]))
    assert row["trace_id"] == "5b8efff798038103d269b633813fc60c"
    assert row["span_id"] == "eee19b7ec3c1b174"
    assert row["duration_ms"] == 1000.0 and row["project"] == "js-app"


@pytest.mark.parametrize("model,expected", [
    ("us.anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4-5"),     # Bedrock
    ("claude-sonnet-4-5@20250929", "claude-sonnet-4-5"),                      # Vertex
    ("z-ai/glm-5.3-flashz-ai/glm-5.3-flash", "glm-5-3-flash"),                # doubled by streaming
])
def test_normalise_provider_ids(model, expected):
    assert pricing.normalise_model(model) == expected


def test_catalog_parse_and_exact_match_beats_prefix():
    from imagent_server.price_sync import parse_catalog

    rows = parse_catalog({"data": [
        {"id": "z-ai/glm-5.3-flash", "pricing": {"prompt": "0.00000015", "completion": "0.0000005", "input_cache_read": "0.00000003"}},
        {"id": "z-ai/glm-5.3-flashx", "pricing": {"prompt": "0.00000037", "completion": "0.00000125"}},
        {"id": "z-ai/glm-5.3-flash:batch", "pricing": {"prompt": "0.00000006", "completion": "0.0000002"}},
        {"id": "openrouter/free-model", "pricing": {"prompt": "0", "completion": "0"}},
        {"id": "openai/gpt-4o-mini", "pricing": {"prompt": "0.00000015", "completion": "0.0000006"}},
    ]})
    by = {r[0]: r for r in rows}
    assert set(by) == {"glm-5-3-flash", "glm-5-3-flashx", "gpt-4o-mini"}   # variants and free models skipped
    assert by["glm-5-3-flash"][2:5] == [0.15, 0.5, 0.03]
    try:
        pricing.set_catalog({r[0]: pricing.Price(r[2], r[3], r[4], r[5]) for r in rows})
        assert pricing.lookup("z-ai/glm-5.3-flash").input == 0.15              # not flashx
        assert pricing.lookup("openai/gpt-4o-mini-2024-07-18").output == 0.6   # date stripped
        assert pricing.lookup("claude-opus-5.5").input == 4.0                  # built-in still wins
        assert pricing.compute_cost("z-ai/glm-5.3-flash", 1_000_000, 0, 1_000_000, 0) == pytest.approx(0.03)
    finally:
        pricing.set_catalog({})


def test_legacy_harness_prefix_still_understood():
    """Apps still on the pre-rename SDK send harness.* attributes."""
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    exp = InMemorySpanExporter()
    tp = TracerProvider()
    tp.add_span_processor(SimpleSpanProcessor(exp))
    with tp.get_tracer("harness_moni").start_as_current_span("old_agent", attributes={
            "harness.span_kind": "agent", "harness.root": True, "harness.thread_id": "t-old", "harness.input": "hi"}):
        pass
    row = row_dicts(exp.get_finished_spans())[0]
    assert row["kind"] == "agent" and row["is_root"] == 1 and row["thread_id"] == "t-old" and row["input"] == "hi"
