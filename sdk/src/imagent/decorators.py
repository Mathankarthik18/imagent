"""``@observe`` — trace any function (sync, async, generator, async generator)."""

from __future__ import annotations

import functools
import inspect
from collections.abc import Callable
from typing import Any, TypeVar, overload

from opentelemetry import context as otel_context
from opentelemetry import trace
from opentelemetry.trace import Span

from . import semconv as sc
from .runtime import apply_context, get_tracer, is_imagent_span, record_error, set_content

F = TypeVar("F", bound=Callable[..., Any])

_KIND_TO_OPERATION = {"llm": "chat", "tool": "execute_tool", "agent": "invoke_agent"}


def _parent() -> tuple[otel_context.Context | None, bool, Span | None]:
    """(context to start the span in, is_root, parent imagent span).

    Two candidates: the current OTel span (another @observe) and the LangChain
    run currently executing (e.g. the tool calling us). Whichever started
    later is the more deeply nested one.
    """
    current = trace.get_current_span()
    current = current if is_imagent_span(current) else None
    try:
        from .integrations.langchain import current_run_span
    except ImportError:
        current_run_span = None  # type: ignore[assignment]
    lc_span = current_run_span() if current_run_span is not None else None
    if lc_span is not None and (current is None or getattr(lc_span, "start_time", 0) > getattr(current, "start_time", 0)):
        return trace.set_span_in_context(lc_span), False, lc_span
    if current is not None:
        return None, False, current
    return None, True, None


def _bound_inputs(sig: inspect.Signature | None, args: tuple, kwargs: dict) -> Any:
    if sig is None:
        return {"args": args, "kwargs": kwargs}
    try:
        bound = sig.bind_partial(*args, **kwargs)
    except TypeError:
        return {"args": args, "kwargs": kwargs}
    data = dict(bound.arguments)
    for drop in ("self", "cls"):
        data.pop(drop, None)
    return data


@overload
def observe(func: F) -> F: ...
@overload
def observe(
    name: str | None = None,
    *,
    kind: str = "span",
    capture_input: bool = True,
    capture_output: bool = True,
    attributes: dict[str, Any] | None = None,
) -> Callable[[F], F]: ...


def observe(
    func_or_name: Any = None,
    *,
    kind: str = "span",
    capture_input: bool = True,
    capture_output: bool = True,
    attributes: dict[str, Any] | None = None,
) -> Any:
    """Trace a function call as a imagent span.

    ``kind``: agent | tool | llm | retriever | chain | span — drives how the UI
    renders it. Usable bare (``@observe``) or configured (``@observe("x", kind="tool")``).
    """

    def decorate(fn: F) -> F:
        span_name = func_or_name if isinstance(func_or_name, str) else fn.__qualname__
        try:
            sig: inspect.Signature | None = inspect.signature(fn)
        except (TypeError, ValueError):
            sig = None

        def start(args: tuple, kwargs: dict, current: bool = True):
            tracer = get_tracer()
            if tracer is None:
                return None
            ctx, is_root, parent = _parent()
            attrs: dict[str, Any] = {sc.SPAN_KIND: kind, sc.ROOT: is_root, **(attributes or {})}
            if kind in _KIND_TO_OPERATION:
                attrs[sc.GEN_AI_OPERATION] = _KIND_TO_OPERATION[kind]
            if kind == "tool":
                attrs[sc.GEN_AI_TOOL_NAME] = span_name
            if current:
                cm = tracer.start_as_current_span(span_name, context=ctx, attributes=attrs,
                                                  record_exception=False, set_status_on_exception=False)
                span = cm.__enter__()
            else:
                # Generators: a context token can't be detached from another
                # context after a yield, so the span is not made current.
                cm, span = None, tracer.start_span(span_name, context=ctx, attributes=attrs)
            apply_context(span, parent=parent, agent_name=span_name if kind == "agent" else None)
            if capture_input:
                set_content(span, sc.INPUT, _bound_inputs(sig, args, kwargs))
            return cm, span

        def finish(handle, result: Any = None, error: BaseException | None = None) -> None:
            if handle is None:
                return
            cm, span = handle
            if error is not None:
                record_error(span, error)
            elif capture_output:
                set_content(span, sc.OUTPUT, result)
            if cm is None:
                span.end()
            elif error is not None:
                cm.__exit__(type(error), error, error.__traceback__)
            else:
                cm.__exit__(None, None, None)

        if inspect.isasyncgenfunction(fn):
            @functools.wraps(fn)
            async def agen_wrapper(*args: Any, **kwargs: Any):
                h = start(args, kwargs, current=False)
                items: list[Any] = []
                try:
                    async for item in fn(*args, **kwargs):
                        if len(items) < 1000:
                            items.append(item)
                        yield item
                except BaseException as e:
                    finish(h, error=e)
                    raise
                finish(h, items)
            return agen_wrapper  # type: ignore[return-value]

        if inspect.isgeneratorfunction(fn):
            @functools.wraps(fn)
            def gen_wrapper(*args: Any, **kwargs: Any):
                h = start(args, kwargs, current=False)
                items: list[Any] = []
                try:
                    for item in fn(*args, **kwargs):
                        if len(items) < 1000:
                            items.append(item)
                        yield item
                except BaseException as e:
                    finish(h, error=e)
                    raise
                finish(h, items)
            return gen_wrapper  # type: ignore[return-value]

        if inspect.iscoroutinefunction(fn):
            @functools.wraps(fn)
            async def async_wrapper(*args: Any, **kwargs: Any):
                h = start(args, kwargs)
                try:
                    result = await fn(*args, **kwargs)
                except BaseException as e:
                    finish(h, error=e)
                    raise
                finish(h, result)
                return result
            return async_wrapper  # type: ignore[return-value]

        @functools.wraps(fn)
        def sync_wrapper(*args: Any, **kwargs: Any):
            h = start(args, kwargs)
            try:
                result = fn(*args, **kwargs)
            except BaseException as e:
                finish(h, error=e)
                raise
            finish(h, result)
            return result
        return sync_wrapper  # type: ignore[return-value]

    if callable(func_or_name):
        return decorate(func_or_name)
    return decorate
