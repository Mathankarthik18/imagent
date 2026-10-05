"""OTLP/HTTP trace payload (protobuf or JSON) → ClickHouse rows.

Understands harness SDK spans fully and any OTel GenAI-convention span
(OpenLLMetry, OpenInference, vendor SDKs) on a best-effort basis.
"""

from __future__ import annotations

import base64
import datetime as dt
import gzip
import json
import zlib
from typing import Any

from google.protobuf import json_format
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
from opentelemetry.proto.common.v1.common_pb2 import AnyValue

from . import pricing

_UTC = dt.timezone.utc

# Attributes lifted into dedicated columns (not duplicated into the attributes map).
_LIFTED = {
    "harness.span_kind", "harness.root", "harness.input", "harness.output", "harness.metadata", "harness.tags",
    "harness.thread_id", "harness.user_id", "harness.session_id", "harness.cost_usd", "harness.ttft_ms",
    "gen_ai.agent.name", "gen_ai.request.model", "gen_ai.response.model", "gen_ai.system",
    "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens", "gen_ai.usage.prompt_tokens",
    "gen_ai.usage.completion_tokens", "gen_ai.usage.cache_read_input_tokens",
    "gen_ai.usage.cache_creation_input_tokens", "gen_ai.prompt", "gen_ai.completion",
    "input.value", "output.value", "session.id", "user.id",
}
_OPERATION_KIND = {"chat": "llm", "text_completion": "llm", "generate_content": "llm", "embeddings": "embedding",
                   "execute_tool": "tool", "invoke_agent": "agent", "create_agent": "agent"}
_OPENINFERENCE_KIND = {"LLM": "llm", "TOOL": "tool", "AGENT": "agent", "CHAIN": "chain",
                       "RETRIEVER": "retriever", "EMBEDDING": "embedding"}


def _hex_to_b64(value: str) -> str:
    try:
        return base64.b64encode(bytes.fromhex(value)).decode()
    except ValueError:
        return value  # already base64


def decode_request(body: bytes, content_type: str, content_encoding: str = "") -> ExportTraceServiceRequest:
    enc = content_encoding.lower()
    if enc == "gzip":
        body = gzip.decompress(body)
    elif enc == "deflate":
        body = zlib.decompress(body)
    req = ExportTraceServiceRequest()
    if "json" in content_type.lower():
        # OTLP/JSON encodes ids as hex; protobuf's JSON mapping expects base64.
        data = json.loads(body)
        for rs in data.get("resourceSpans", []):
            for ss in rs.get("scopeSpans", []):
                for span in ss.get("spans", []):
                    for key in ("traceId", "spanId", "parentSpanId"):
                        if span.get(key):
                            span[key] = _hex_to_b64(span[key])
                    for link in span.get("links", []):
                        for key in ("traceId", "spanId"):
                            if link.get(key):
                                link[key] = _hex_to_b64(link[key])
        json_format.ParseDict(data, req, ignore_unknown_fields=True)
    else:
        req.ParseFromString(body)
    return req


def _any(v: AnyValue) -> Any:
    which = v.WhichOneof("value")
    if which == "string_value":
        return v.string_value
    if which == "bool_value":
        return v.bool_value
    if which == "int_value":
        return v.int_value
    if which == "double_value":
        return v.double_value
    if which == "array_value":
        return [_any(x) for x in v.array_value.values]
    if which == "kvlist_value":
        return {kv.key: _any(kv.value) for kv in v.kvlist_value.values}
    if which == "bytes_value":
        return base64.b64encode(v.bytes_value).decode()
    return None


def _attrs(kvs) -> dict[str, Any]:
    return {kv.key: _any(kv.value) for kv in kvs}


def _int(v: Any) -> int:
    try:
        return max(int(v), 0)
    except (TypeError, ValueError):
        return 0


def _float(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _str(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    return json.dumps(v, ensure_ascii=False, default=str)


def _ts(ns: int) -> dt.datetime:
    return dt.datetime.fromtimestamp(ns / 1e9, tz=_UTC)


def _kind(a: dict[str, Any]) -> str:
    if a.get("harness.span_kind"):
        return str(a["harness.span_kind"])
    oi = a.get("openinference.span.kind")
    if oi in _OPENINFERENCE_KIND:
        return _OPENINFERENCE_KIND[oi]
    op = a.get("gen_ai.operation.name")
    if op in _OPERATION_KIND:
        return _OPERATION_KIND[op]
    if a.get("gen_ai.request.model") or a.get("gen_ai.system"):
        return "llm"
    return "span"


def span_rows(req: ExportTraceServiceRequest) -> list[list]:
    return split_rows(req)[0]


def split_rows(req: ExportTraceServiceRequest) -> tuple[list[list], list[list]]:
    """(finished span rows, running-span rows). Running rows are SDK "started"
    snapshots (``harness.pending``) and go to the running_spans table."""
    rows: list[list] = []
    running: list[list] = []
    for rs in req.resource_spans:
        res = _attrs(rs.resource.attributes)
        project = str(res.get("service.name") or "default")
        environment = str(res.get("deployment.environment") or res.get("deployment.environment.name") or "")
        for ss in rs.scope_spans:
            for sp in ss.spans:
                a = _attrs(sp.attributes)
                kind = _kind(a)
                if a.get("harness.pending"):
                    parent = sp.parent_span_id.hex()
                    running.append([
                        project, sp.trace_id.hex(), sp.span_id.hex(), parent,
                        1 if (a.get("harness.root") if "harness.root" in a else not parent) else 0,
                        sp.name, kind, _ts(sp.start_time_unix_nano),
                        str(a.get("harness.thread_id") or ""), str(a.get("harness.user_id") or ""),
                        str(a.get("gen_ai.agent.name") or ""),
                        str(a.get("gen_ai.response.model") or a.get("gen_ai.request.model") or ""),
                    ])
                    continue
                start_ns, end_ns = sp.start_time_unix_nano, sp.end_time_unix_nano or sp.start_time_unix_nano
                parent = sp.parent_span_id.hex()
                is_root = bool(a.get("harness.root")) if "harness.root" in a else not parent

                model = pricing.unrepeat(str(a.get("gen_ai.response.model") or a.get("gen_ai.request.model") or ""))
                inp = _int(a.get("gen_ai.usage.input_tokens", a.get("gen_ai.usage.prompt_tokens")))
                out = _int(a.get("gen_ai.usage.output_tokens", a.get("gen_ai.usage.completion_tokens")))
                cache_r = _int(a.get("gen_ai.usage.cache_read_input_tokens"))
                cache_w = _int(a.get("gen_ai.usage.cache_creation_input_tokens"))
                cost = _float(a.get("harness.cost_usd"))
                cost_source = "provider" if cost is not None else ""
                if cost is None and kind == "llm" and (inp or out):
                    cost = pricing.compute_cost(model, inp, out, cache_r, cache_w)
                    cost_source = "computed" if cost is not None else "unknown"

                status_code = sp.status.code  # 0 unset, 1 ok, 2 error
                events = [{"name": e.name, "time": _ts(e.time_unix_nano).isoformat(),
                           "attributes": _attrs(e.attributes)} for e in sp.events]
                tags = a.get("harness.tags") or []
                rows.append([
                    project,
                    environment,
                    sp.trace_id.hex(),
                    sp.span_id.hex(),
                    parent,
                    1 if is_root else 0,
                    sp.name,
                    kind,
                    "error" if status_code == 2 else "ok",
                    sp.status.message,
                    _ts(start_ns),
                    _ts(end_ns),
                    max(end_ns - start_ns, 0) / 1e6,
                    str(a.get("harness.thread_id") or a.get("session.id") or ""),
                    str(a.get("harness.user_id") or a.get("user.id") or ""),
                    str(a.get("harness.session_id") or ""),
                    str(a.get("gen_ai.agent.name") or ""),
                    model,
                    str(a.get("gen_ai.system") or ""),
                    inp,
                    out,
                    cache_r,
                    cache_w,
                    cost or 0.0,
                    cost_source,
                    _float(a.get("harness.ttft_ms")),
                    _str(a.get("harness.input") or a.get("input.value") or a.get("gen_ai.prompt")),
                    _str(a.get("harness.output") or a.get("output.value") or a.get("gen_ai.completion")),
                    [str(t) for t in tags] if isinstance(tags, list) else [str(tags)],
                    _str(a.get("harness.metadata")),
                    {k: _str(v) for k, v in a.items() if k not in _LIFTED},
                    json.dumps(events, default=str) if events else "",
                ])
    return rows, running
