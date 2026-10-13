"""Framework-neutral span helpers for the provider and framework integrations.

Every integration records the same shapes the LangChain one does — ``llm`` spans with
model, tokens, cost and the prompt/answer; ``tool`` and ``agent`` spans — so traces,
the blueprint stats, compare and experiments work the same whatever the framework.
"""

from __future__ import annotations

import contextlib
import time
from contextvars import ContextVar
from typing import Any, Iterator

from opentelemetry import trace
from opentelemetry.trace import Span

from .. import semconv as sc
from ..runtime import apply_context, get_tracer, record_error, set_content

# Set while a higher-level integration (e.g. LangChain's chat model) is already recording
# this LLM call, so the provider SDK underneath doesn't record it a second time.
provider_spans_off: ContextVar[bool] = ContextVar("imagent_provider_spans_off", default=False)
# The agent a framework is running right now (OpenAI Agents SDK / CrewAI / LlamaIndex),
# for per-agent model swaps in experiments.
current_agent: ContextVar[str] = ContextVar("imagent_current_agent", default="")


def _parent() -> tuple[Any, bool, Span | None]:
    from ..decorators import _parent as parent

    return parent()


class LLMCall:
    """One model call: ``start`` → ``finish`` (or ``fail``)."""

    def __init__(self, name: str, *, model: str, system: str, inputs: Any, tools: Any = None,
                 params: dict[str, Any] | None = None) -> None:
        self.span: Span | None = None
        self.started = time.monotonic()
        self.first_token: float | None = None
        tracer = get_tracer()
        if tracer is None or provider_spans_off.get():
            return
        ctx, is_root, parent = _parent()
        p = params or {}
        attrs = {sc.SPAN_KIND: "llm", sc.ROOT: is_root, sc.GEN_AI_OPERATION: "chat", sc.GEN_AI_REQUEST_MODEL: model,
                 sc.GEN_AI_SYSTEM: system}
        if isinstance(p.get("temperature"), (int, float)):
            attrs[sc.GEN_AI_REQUEST_TEMPERATURE] = p["temperature"]
        mt = p.get("max_tokens") or p.get("max_output_tokens") or p.get("max_completion_tokens")
        if isinstance(mt, int):
            attrs[sc.GEN_AI_REQUEST_MAX_TOKENS] = mt
        self.span = tracer.start_span(name or model or "llm", context=ctx, attributes=attrs)
        apply_context(self.span, parent=parent, agent_name=current_agent.get() or None)
        set_content(self.span, sc.INPUT, inputs)
        if tools:
            set_content(self.span, sc.TOOLS, tools)

    def token(self) -> None:
        if self.first_token is None:
            self.first_token = time.monotonic()
            if self.span is not None:
                self.span.set_attribute(sc.TTFT_MS, round((self.first_token - self.started) * 1000, 1))

    def finish(self, output: Any, *, input_tokens: int | None = None, output_tokens: int | None = None,
               cache_read: int | None = None, cache_write: int | None = None, cost: float | None = None,
               response_model: str | None = None, finish_reason: str | None = None) -> None:
        if self.span is None:
            return
        for k, v in ((sc.GEN_AI_USAGE_INPUT_TOKENS, input_tokens), (sc.GEN_AI_USAGE_OUTPUT_TOKENS, output_tokens),
                     (sc.GEN_AI_USAGE_CACHE_READ, cache_read), (sc.GEN_AI_USAGE_CACHE_WRITE, cache_write),
                     (sc.COST_USD, cost), (sc.GEN_AI_RESPONSE_MODEL, response_model)):
            if v is not None:
                self.span.set_attribute(k, v)
        if finish_reason:
            self.span.set_attribute(sc.GEN_AI_RESPONSE_FINISH_REASONS, [str(finish_reason)])
        set_content(self.span, sc.OUTPUT, output)
        self.span.end()
        self.span = None

    def fail(self, error: BaseException) -> None:
        if self.span is not None:
            record_error(self.span, error)
            self.span.end()
            self.span = None


@contextlib.contextmanager
def step(name: str, kind: str, *, inputs: Any = None, attributes: dict[str, Any] | None = None,
         agent: str | None = None) -> Iterator[Span | None]:
    """An ``agent`` / ``tool`` / ``chain`` span that is current while it runs (children nest under it)."""
    tracer = get_tracer()
    if tracer is None:
        token = current_agent.set(agent) if agent else None
        try:
            yield None
        finally:
            if token is not None:
                current_agent.reset(token)
        return
    ctx, is_root, parent = _parent()
    attrs: dict[str, Any] = {sc.SPAN_KIND: kind, sc.ROOT: is_root, **(attributes or {})}
    if kind == "agent":
        attrs[sc.GEN_AI_OPERATION] = "invoke_agent"
    elif kind == "tool":
        attrs[sc.GEN_AI_OPERATION] = "execute_tool"
        attrs.setdefault(sc.GEN_AI_TOOL_NAME, name)
    token = current_agent.set(agent) if agent else None
    with tracer.start_as_current_span(name, context=ctx, attributes=attrs, record_exception=False,
                                      set_status_on_exception=False) as span:
        apply_context(span, parent=parent, agent_name=agent if kind == "agent" else None)
        if inputs is not None:
            set_content(span, sc.INPUT, inputs)
        try:
            yield span
        except BaseException as exc:
            record_error(span, exc)
            raise
        finally:
            if token is not None:
                current_agent.reset(token)


def output(span: Span | None, value: Any) -> None:
    if span is not None:
        set_content(span, sc.OUTPUT, value)


def is_recording() -> bool:
    return trace.get_current_span().is_recording()
