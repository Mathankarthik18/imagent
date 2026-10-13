"""LlamaIndex agents (``FunctionAgent``, ``ReActAgent``, ``AgentWorkflow``): traces, blueprint
and experiments.

* Traces — ``agent.run()`` becomes an agent span (its workflow tasks inherit the context, so
  everything nests under it); tool calls go through ``_call_tool``; model calls come from
  LlamaIndex's instrumentation events (the OpenAI/Anthropic SDK hooks stay quiet for them).
* Experiments — tools answer from the recording; each agent's LLM is swapped on a copy of
  the agent, never on the app's own object.
* Blueprint — agents, system prompts, LLMs, tools; a multi-agent workflow's agents are sub-agents.
"""

from __future__ import annotations

import logging
import threading
from typing import Any

from opentelemetry import context as otel_context
from opentelemetry import trace

from .. import replay
from .. import semconv as sc
from ..runtime import set_content
from ._spans import LLMCall, current_agent, provider_spans_off, step

logger = logging.getLogger("imagent")
_installed = False


def _agent_name(agent: Any) -> str:
    return str(getattr(agent, "name", None) or type(agent).__name__)


def _llm_model(llm: Any) -> str:
    return str(getattr(llm, "model", None) or getattr(llm, "model_name", None) or type(llm).__name__)


# ── model calls (instrumentation events) ──────────────────────────────────────
class _LLMEvents:
    def __init__(self) -> None:
        self._calls: dict[str, tuple[LLMCall, Any]] = {}
        self._lock = threading.Lock()

    def handle(self, event: Any) -> None:
        name = type(event).__name__
        try:
            if name == "LLMChatStartEvent":
                md = event.model_dict or {}
                model = str(md.get("model") or md.get("model_name") or md.get("class_name") or "llm")
                msgs = [{"role": str(getattr(m.role, "value", m.role)), "content": m.content} for m in event.messages]
                call = LLMCall(model, model=model, system=str(md.get("class_name", "llamaindex")).lower(), inputs=msgs, params=md)
                quiet = provider_spans_off.set(True)  # the provider SDK underneath stays quiet
                with self._lock:
                    self._calls[event.span_id] = (call, quiet)
            elif name in ("LLMChatInProgressEvent",):
                with self._lock:
                    entry = self._calls.get(event.span_id)
                if entry:
                    entry[0].token()
            elif name == "LLMChatEndEvent":
                with self._lock:
                    entry = self._calls.pop(event.span_id, None)
                if entry is None:
                    return
                call, quiet = entry
                try:
                    provider_spans_off.reset(quiet)
                except Exception:  # noqa: BLE001 — ended in another context
                    pass
                resp = event.response
                if resp is None:
                    call.finish(None)
                    return
                raw = getattr(resp, "raw", None)
                usage = getattr(raw, "usage", None) if raw is not None and not isinstance(raw, dict) else (raw or {}).get("usage")
                get = (lambda k: getattr(usage, k, None)) if usage is not None and not isinstance(usage, dict) else (lambda k: (usage or {}).get(k))
                msg = resp.message
                out: dict[str, Any] = {"role": "assistant", "content": msg.content or ""}
                if msg.additional_kwargs.get("tool_calls"):
                    out["tool_calls"] = [t.model_dump() if hasattr(t, "model_dump") else t for t in msg.additional_kwargs["tool_calls"]]
                call.finish(out, input_tokens=get("prompt_tokens") or get("input_tokens"),
                            output_tokens=get("completion_tokens") or get("output_tokens"),
                            response_model=getattr(raw, "model", None) if raw is not None and not isinstance(raw, dict) else None)
        except Exception as exc:  # noqa: BLE001 — never break the app
            logger.debug("imagent: llamaindex event %s: %s", name, exc)


# ── tools ──────────────────────────────────────────────────────────────────────
def _wrap_call_tool(orig: Any) -> Any:
    async def _call_tool(self, ctx, tool, tool_input):
        from llama_index.core.tools import ToolOutput

        name = tool.metadata.get_name()
        with step(name, "tool", inputs=tool_input) as span:
            hit, result, mode = replay.intercept_tool(name, tool_input)
            if hit:
                if span is not None:
                    span.set_attribute(sc.TAGS, [f"replay:mode:{mode}"])
                    set_content(span, sc.OUTPUT, result)
                return ToolOutput(content=result, tool_name=name, raw_input=tool_input, raw_output=result)
            out = await orig(self, ctx, tool, tool_input)
            if span is not None:
                set_content(span, sc.OUTPUT, str(getattr(out, "content", out)))
                if getattr(out, "is_error", False):
                    span.set_status(trace.Status(trace.StatusCode.ERROR, str(out.content)[:500]))
            return out
    return _call_tool


# ── runs ───────────────────────────────────────────────────────────────────────
def _wrap_run(orig: Any) -> Any:
    def run(self, *args, **kwargs):
        from .. import blueprint, experiments
        from ..runtime import apply_context, get_tracer, record_error
        from ._spans import _parent

        name = _agent_name(self)
        nested = blueprint._nested()  # noqa: SLF001
        if not nested:
            blueprint.seen_agent(self, name)
            if experiments._started:  # noqa: SLF001
                experiments.capture(self, name)
        tracer = get_tracer()
        if tracer is None:
            return orig(self, *args, **kwargs)
        ctx, is_root, parent = _parent()
        span = tracer.start_span(name, context=ctx, attributes={sc.SPAN_KIND: "agent", sc.ROOT: is_root,
                                                                sc.GEN_AI_OPERATION: "invoke_agent"})
        apply_context(span, parent=parent, agent_name=name)
        set_content(span, sc.INPUT, {"user_msg": str(kwargs.get("user_msg") or (args[0] if args else ""))})
        # Current only while the workflow's tasks are created: they copy this context, so every
        # step, tool and model call of the run nests under the agent span.
        token = otel_context.attach(trace.set_span_in_context(span))
        agent_token = current_agent.set(name)
        try:
            handler = orig(self, *args, **kwargs)
        except BaseException as exc:
            record_error(span, exc)
            span.end()
            raise
        finally:
            current_agent.reset(agent_token)
            otel_context.detach(token)

        def done(fut: Any) -> None:
            try:
                res = fut.result()
                set_content(span, sc.OUTPUT, str(getattr(getattr(res, "response", None), "content", None) or res))
            except BaseException as exc:  # noqa: BLE001
                record_error(span, exc)
            span.end()
        try:
            handler.add_done_callback(done)
        except Exception:  # noqa: BLE001
            span.end()
        return handler
    return run


# ── blueprint ──────────────────────────────────────────────────────────────────
def _tools(agent: Any) -> list[dict[str, Any]]:
    from ..blueprint import MAX_DESC_CHARS, _trim

    out = []
    for t in getattr(agent, "tools", None) or []:
        md = getattr(t, "metadata", None)
        schema = getattr(md, "fn_schema", None)
        args = list(getattr(schema, "model_fields", {}) or {}) if schema is not None else []
        out.append({"name": md.get_name() if md else str(t), "description": _trim(getattr(md, "description", ""), MAX_DESC_CHARS),
                    "args": args, "builtin": False})
    return out


def describe_agent(agent: Any, name: str | None = None) -> dict[str, Any]:
    from ..blueprint import MAX_PROMPT_CHARS, _trim

    subs = [describe_agent(a) for a in (getattr(agent, "agents", None) or {}).values()] if hasattr(agent, "agents") else []
    llm = getattr(agent, "llm", None)
    return {"name": name or _agent_name(agent), "description": str(getattr(agent, "description", "") or ""),
            "model": {"name": _llm_model(llm), "class": type(llm).__name__, "provider": "llamaindex", "params": {}} if llm else None,
            "system_prompt": _trim(getattr(agent, "system_prompt", "") or "", MAX_PROMPT_CHARS), "tools": _tools(agent),
            "middleware": [], "subagents": subs, "graph": {"nodes": [], "edges": []}}


# ── experiments: run a copy with swapped LLMs ──────────────────────────────────
def _with_models(agent: Any) -> Any:
    """A copy of ``agent`` whose LLMs follow the experiment's model picks (the app's object is untouched)."""
    def swap(a: Any) -> Any:
        llm = getattr(a, "llm", None)
        new = replay.swap_model(_agent_name(a), _llm_model(llm)) if llm is not None else None
        if new and hasattr(llm, "model_copy"):
            return a.model_copy(update={"llm": llm.model_copy(update={"model": new})})
        return a
    if hasattr(agent, "agents") and isinstance(getattr(agent, "agents", None), dict):
        copy = agent.model_copy() if hasattr(agent, "model_copy") else agent
        copy.agents = {k: swap(v) for k, v in agent.agents.items()}
        return copy
    return swap(agent)


async def run(agent: Any, messages: list[dict[str, str]]) -> str:
    from llama_index.core.llms import ChatMessage

    history = [ChatMessage(role=m["role"], content=m["content"]) for m in messages[:-1]]
    handler = _with_models(agent).run(user_msg=messages[-1]["content"], chat_history=history or None)
    res = await handler
    return str(getattr(getattr(res, "response", None), "content", None) or res)


def install() -> bool:
    global _installed
    if _installed:
        return True
    try:
        from llama_index.core.agent.workflow.base_agent import BaseWorkflowAgent
        from llama_index.core.instrumentation import get_dispatcher
        from llama_index.core.instrumentation.event_handlers import BaseEventHandler
    except ImportError:
        return False
    events = _LLMEvents()

    class _Handler(BaseEventHandler):
        @classmethod
        def class_name(cls) -> str:
            return "ImagentEventHandler"

        def handle(self, event: Any, **kwargs: Any) -> None:
            events.handle(event)

    get_dispatcher().add_event_handler(_Handler())
    BaseWorkflowAgent._call_tool = _wrap_call_tool(BaseWorkflowAgent._call_tool)  # type: ignore[method-assign]
    BaseWorkflowAgent.run = _wrap_run(BaseWorkflowAgent.run)  # type: ignore[method-assign]
    try:
        from llama_index.core.agent.workflow.multi_agent_workflow import AgentWorkflow

        AgentWorkflow._call_tool = _wrap_call_tool(AgentWorkflow._call_tool)  # type: ignore[method-assign]
        AgentWorkflow.run = _wrap_run(AgentWorkflow.run)  # type: ignore[method-assign]
    except ImportError:
        pass
    _installed = True
    return True
