"""Global SDK state: config, a dedicated TracerProvider, and the span helpers
shared by the decorator and the LangChain integration.

Harness keeps its own TracerProvider instead of the global one so that only
LLM/agent spans reach the harness backend (not every Mongo query an app's
existing OTel setup records). Parent context still propagates, so a harness
span created inside a FastAPI request shares that request's trace_id.
"""

from __future__ import annotations

import atexit
import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExporter
from opentelemetry.sdk.trace.sampling import ALWAYS_ON, TraceIdRatioBased
from opentelemetry.trace import Span, Tracer

from . import semconv as sc
from .context import current_context
from .redact import Redactor, default_redactor
from .serialize import dumps

logger = logging.getLogger("harness_moni")


def _env_bool(name: str, default: bool) -> bool:
    v = os.getenv(name)
    return default if v is None else v.strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class HarnessConfig:
    service: str = "default"
    endpoint: str = "http://localhost:8300"
    api_key: str | None = None
    environment: str | None = None
    enabled: bool = True
    capture_content: bool = True
    max_content_chars: int = 32_000
    redact: Redactor | None = default_redactor
    sample_rate: float = 1.0
    auto_instrument_langchain: bool = True
    # Extra OTLP/HTTP trace endpoints (e.g. a SigNoz collector) that also get harness spans.
    extra_otlp_endpoints: list[str] = field(default_factory=list)
    # Exporters added verbatim — mostly for tests (InMemorySpanExporter).
    exporters: list[SpanExporter] = field(default_factory=list)
    # Report spans still running after this many seconds (0 disables live progress).
    pending_delay_s: float = 1.5
    pending_exporter: SpanExporter | None = None
    resource_attributes: Mapping[str, Any] = field(default_factory=dict)


class _State:
    def __init__(self, config: HarnessConfig, provider: TracerProvider):
        self.config = config
        self.provider = provider
        self.tracer: Tracer = provider.get_tracer(sc.TRACER_NAME, "0.1.0")


_state: _State | None = None


def init(
    service: str | None = None,
    *,
    endpoint: str | None = None,
    api_key: str | None = None,
    environment: str | None = None,
    enabled: bool | None = None,
    capture_content: bool | None = None,
    max_content_chars: int | None = None,
    redact: Redactor | None | bool = True,
    sample_rate: float | None = None,
    auto_instrument_langchain: bool = True,
    extra_otlp_endpoints: list[str] | None = None,
    exporters: list[SpanExporter] | None = None,
    resource_attributes: Mapping[str, Any] | None = None,
    pending_delay_s: float | None = None,
    pending_exporter: SpanExporter | None = None,
) -> HarnessConfig:
    """Initialise tracing. Every argument falls back to a ``HARNESS_*`` env var.

    ``redact``: True → default redactor (secrets + card numbers), False/None →
    off, or pass your own ``Callable[[str], str]``.
    """
    global _state
    if _state is not None:
        logger.debug("harness_moni already initialised")
        return _state.config

    cfg = HarnessConfig(
        service=service or os.getenv("HARNESS_SERVICE") or os.getenv("OTEL_SERVICE_NAME") or "default",
        endpoint=(endpoint or os.getenv("HARNESS_ENDPOINT") or "http://localhost:8300").rstrip("/"),
        api_key=api_key or os.getenv("HARNESS_API_KEY") or None,
        environment=environment or os.getenv("HARNESS_ENVIRONMENT") or None,
        enabled=enabled if enabled is not None else _env_bool("HARNESS_ENABLED", True),
        capture_content=capture_content if capture_content is not None else _env_bool("HARNESS_CAPTURE_CONTENT", True),
        max_content_chars=max_content_chars or int(os.getenv("HARNESS_MAX_CONTENT_CHARS", "32000")),
        redact=default_redactor if redact is True else (redact or None),
        sample_rate=sample_rate if sample_rate is not None else float(os.getenv("HARNESS_SAMPLE_RATE", "1.0")),
        auto_instrument_langchain=auto_instrument_langchain,
        extra_otlp_endpoints=extra_otlp_endpoints
        or [e for e in os.getenv("HARNESS_EXTRA_OTLP_ENDPOINTS", "").split(",") if e.strip()],
        exporters=exporters or [],
        resource_attributes=resource_attributes or {},
        pending_delay_s=pending_delay_s if pending_delay_s is not None else float(os.getenv("HARNESS_PENDING_DELAY", "1.5")),
        pending_exporter=pending_exporter,
    )
    if not cfg.enabled:
        logger.info("harness_moni disabled (HARNESS_ENABLED=false)")
        return cfg

    attrs: dict[str, Any] = {"service.name": cfg.service, **cfg.resource_attributes}
    if cfg.environment:
        attrs[sc.ENVIRONMENT] = cfg.environment
    # Ratio sampling on trace_id keeps every span of a trace together.
    sampler = ALWAYS_ON if cfg.sample_rate >= 1 else TraceIdRatioBased(cfg.sample_rate)
    provider = TracerProvider(resource=Resource.create(attrs), sampler=sampler)

    exporters_: list[SpanExporter] = list(cfg.exporters)
    if not cfg.exporters:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

        headers = {"x-harness-key": cfg.api_key} if cfg.api_key else None
        exporters_.append(OTLPSpanExporter(endpoint=f"{cfg.endpoint}/v1/traces", headers=headers))
        for extra in cfg.extra_otlp_endpoints:
            extra = extra.strip().rstrip("/")
            exporters_.append(OTLPSpanExporter(endpoint=extra if extra.endswith("/v1/traces") else f"{extra}/v1/traces"))
    for exp in exporters_:
        provider.add_span_processor(BatchSpanProcessor(exp))

    # Live progress: "started" snapshots of long-running spans go to the harness server only.
    pending_exp = cfg.pending_exporter
    if pending_exp is None and not cfg.exporters and cfg.pending_delay_s > 0:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

        headers = {"x-harness-key": cfg.api_key} if cfg.api_key else None
        pending_exp = OTLPSpanExporter(endpoint=f"{cfg.endpoint}/v1/traces", headers=headers, timeout=5)
    if pending_exp is not None and cfg.pending_delay_s > 0:
        from .pending import PendingSpanProcessor

        provider.add_span_processor(PendingSpanProcessor(pending_exp, delay_s=cfg.pending_delay_s))

    _state = _State(cfg, provider)
    atexit.register(shutdown)

    if cfg.auto_instrument_langchain:
        try:
            from .integrations.langchain import install

            install()
        except ImportError:
            logger.debug("langchain-core not installed; skipping auto-instrumentation")
    logger.info("harness_moni tracing → %s (service=%s)", cfg.endpoint, cfg.service)
    return cfg


def flush(timeout_millis: int = 10_000) -> bool:
    return _state.provider.force_flush(timeout_millis) if _state else True


def shutdown() -> None:
    global _state
    if _state is None:
        return
    try:
        _state.provider.shutdown()
    finally:
        _state = None


def get_config() -> HarnessConfig | None:
    return _state.config if _state else None


def get_tracer() -> Tracer | None:
    return _state.tracer if _state else None


def is_harness_span(span: Span | None) -> bool:
    scope = getattr(span, "instrumentation_scope", None)
    return scope is not None and scope.name == sc.TRACER_NAME


def encode_content(obj: Any) -> str | None:
    """Serialize → redact → truncate. Returns None when content capture is off."""
    cfg = get_config()
    if cfg is None or not cfg.capture_content or obj is None:
        return None
    try:
        s = dumps(obj)
    except Exception as exc:  # never let serialization break the app
        s = f"<unserializable {type(obj).__name__}: {exc}>"
    if cfg.redact:
        try:
            s = cfg.redact(s)
        except Exception:
            logger.exception("harness redactor failed; dropping content")
            return "<redaction failed>"
    if len(s) > cfg.max_content_chars:
        s = s[: cfg.max_content_chars] + f"…[truncated {len(s) - cfg.max_content_chars} chars]"
    return s


def set_content(span: Span, key: str, obj: Any) -> None:
    s = encode_content(obj)
    if s is not None:
        span.set_attribute(key, s)


_INHERITED = {"thread_id": sc.THREAD_ID, "user_id": sc.USER_ID, "session_id": sc.SESSION_ID,
              "agent_name": sc.GEN_AI_AGENT_NAME}


def apply_context(span: Span, *, parent: Span | None = None, **explicit: Any) -> None:
    """Stamp thread/user/session/agent/tags/metadata. Precedence: explicit
    values > ``harness_context`` > the parent harness span's values."""
    ctx = dict(current_context())
    parent_attrs = getattr(parent, "attributes", None) if is_harness_span(parent) else None
    if parent_attrs:
        for key, attr in _INHERITED.items():
            if not ctx.get(key) and parent_attrs.get(attr):
                ctx[key] = parent_attrs[attr]
    thread_id = explicit.get("thread_id") or ctx.get("thread_id")
    user_id = explicit.get("user_id") or ctx.get("user_id")
    session_id = explicit.get("session_id") or ctx.get("session_id")
    agent_name = explicit.get("agent_name") or ctx.get("agent_name")
    if thread_id:
        span.set_attribute(sc.THREAD_ID, str(thread_id))
    if user_id:
        span.set_attribute(sc.USER_ID, str(user_id))
    if session_id:
        span.set_attribute(sc.SESSION_ID, str(session_id))
    if agent_name:
        span.set_attribute(sc.GEN_AI_AGENT_NAME, str(agent_name))
    tags = list(dict.fromkeys([*(ctx.get("tags") or []), *(explicit.get("tags") or [])]))
    if tags:
        span.set_attribute(sc.TAGS, [str(t) for t in tags])
    metadata = {**(ctx.get("metadata") or {}), **(explicit.get("metadata") or {})}
    if metadata:
        span.set_attribute(sc.METADATA, dumps(metadata))


def record_error(span: Span, error: BaseException) -> None:
    from opentelemetry.trace import Status, StatusCode

    span.record_exception(error)
    span.set_status(Status(StatusCode.ERROR, f"{type(error).__name__}: {error}"[:1000]))

