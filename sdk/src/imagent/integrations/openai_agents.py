"""OpenAI Agents SDK (``agents``): traces, blueprint and experiments.

* Traces — a tracing processor turns the SDK's own spans (agent, response/generation,
  function tool, handoff, guardrail) into imagent spans, nested the same way. The OpenAI
  SDK integration stays quiet for those model calls, so nothing is recorded twice.
* Experiments — function tools answer from the recording (``_invoke_function_tool_with_metadata``)
  and each agent's model can be swapped (``get_model``).
* Blueprint — ``describe(agent)``: agents, instructions, models, tools, handoffs (as sub-agents).
"""

from __future__ import annotations

import json
import logging
import sys
import threading
from typing import Any

from opentelemetry import context as otel_context
from opentelemetry import trace

from .. import replay
from .. import semconv as sc
from ..runtime import apply_context, get_tracer, record_error, set_content
from ._spans import _parent, current_agent, provider_spans_off

logger = logging.getLogger("imagent")
_installed = False


def _dump(obj: Any) -> Any:
    return obj.model_dump(exclude_none=True) if hasattr(obj, "model_dump") else obj


class _Processor:
    """Agents SDK TracingProcessor → imagent spans."""

    def __init__(self) -> None:
        self._spans: dict[str, Any] = {}       # agents span/trace id → (otel span, token, agent name, extras)
        self._lock = threading.Lock()

    # The SDK calls these synchronously where the work happens, so attaching the OTel context
    # here makes anything inside (an @observe'd helper, a raw SDK call) nest under the right span.
    def _open(self, key: str, parent_key: str | None, name: str, kind: str, attrs: dict[str, Any],
              agent: str | None = None, extras: dict[str, Any] | None = None) -> None:
        tracer = get_tracer()
        if tracer is None:
            return
        with self._lock:
            parent = self._spans.get(parent_key or "")
        if parent is not None:
            ctx, is_root, outer = trace.set_span_in_context(parent["span"]), False, None
            agent = agent or parent["agent"]
        else:
            ctx, is_root, outer = _parent()
        attrs = {sc.SPAN_KIND: kind, sc.ROOT: is_root, **attrs}
        span = tracer.start_span(name, context=ctx, attributes=attrs)
        apply_context(span, parent=outer, agent_name=agent)
        token = otel_context.attach(trace.set_span_in_context(span))
        agent_token = current_agent.set(agent) if agent else None
        with self._lock:
            self._spans[key] = {"span": span, "token": token, "agent": agent, "agent_token": agent_token, **(extras or {})}

    def _close(self, key: str, error: Any = None) -> dict[str, Any] | None:
        with self._lock:
            entry = self._spans.pop(key, None)
        if entry is None:
            return None
        if error is not None:
            entry["span"].set_status(trace.Status(trace.StatusCode.ERROR, str(getattr(error, "message", error))[:500]))
        for var, tok in ((otel_context, entry["token"]), (current_agent, entry.get("agent_token"))):
            if tok is None:
                continue
            try:
                var.detach(tok) if var is otel_context else var.reset(tok)
            except Exception:  # noqa: BLE001 — ended from another task/context: nothing to restore
                pass
        if entry.get("quiet") is not None:
            try:
                provider_spans_off.reset(entry["quiet"])
            except Exception:  # noqa: BLE001
                provider_spans_off.set(False)
        entry["span"].end()
        return entry

    # ── trace (one Runner.run) ──
    def on_trace_start(self, t: Any) -> None:
        self._open(t.trace_id, None, t.name or "agent workflow", "agent", {sc.GEN_AI_OPERATION: "invoke_agent"},
                   extras={"default_name": (t.name or "") in ("", "Agent workflow")})

    def on_trace_end(self, t: Any) -> None:
        self._close(t.trace_id)

    # ── spans ──
    def on_span_start(self, s: Any) -> None:
        d = s.span_data
        parent = s.parent_id or s.trace_id
        kind = getattr(d, "type", "")
        if kind == "agent":
            with self._lock:
                root = self._spans.get(s.trace_id)
            if root is not None and root.get("default_name") and not root.get("named"):
                root["span"].update_name(d.name)  # name the run after its first agent
                root["named"] = True
            self._open(s.span_id, parent, d.name, "agent", {sc.GEN_AI_OPERATION: "invoke_agent"}, agent=d.name)
        elif kind in ("response", "generation"):
            quiet = provider_spans_off.set(True)  # the OpenAI SDK integration underneath stays quiet
            self._open(s.span_id, parent, "model", "llm", {sc.GEN_AI_OPERATION: "chat"}, extras={"quiet": quiet})
        elif kind == "function":
            self._open(s.span_id, parent, d.name, "tool", {sc.GEN_AI_OPERATION: "execute_tool", sc.GEN_AI_TOOL_NAME: d.name})
        elif kind == "handoff":
            self._open(s.span_id, parent, f"handoff → {d.to_agent or '?'}", "span", {})
        elif kind in ("guardrail", "custom", "mcp_tools"):
            self._open(s.span_id, parent, getattr(d, "name", kind) or kind, "span", {})

    def on_span_end(self, s: Any) -> None:
        d = s.span_data
        with self._lock:
            entry = self._spans.get(s.span_id)
        if entry is None:
            return
        span = entry["span"]
        kind = getattr(d, "type", "")
        try:
            if kind == "response":
                self._response(span, d)
            elif kind == "generation":
                self._generation(span, d)
            elif kind == "function":
                set_content(span, sc.INPUT, d.input)
                set_content(span, sc.OUTPUT, d.output)
            elif kind == "agent":
                set_content(span, sc.METADATA, {"tools": d.tools, "handoffs": d.handoffs})
        except Exception as exc:  # noqa: BLE001
            logger.debug("imagent: agents span %s: %s", kind, exc)
        self._close(s.span_id, s.error)

    def _response(self, span: Any, d: Any) -> None:
        r = d.response
        if d.input is not None:
            set_content(span, sc.INPUT, d.input)
        if r is None:
            return
        span.update_name(getattr(r, "model", "") or "model")
        usage = getattr(r, "usage", None)
        details = getattr(usage, "input_tokens_details", None)
        for k, v in ((sc.GEN_AI_REQUEST_MODEL, getattr(r, "model", None)), (sc.GEN_AI_RESPONSE_MODEL, getattr(r, "model", None)),
                     (sc.GEN_AI_USAGE_INPUT_TOKENS, getattr(usage, "input_tokens", None)),
                     (sc.GEN_AI_USAGE_OUTPUT_TOKENS, getattr(usage, "output_tokens", None)),
                     (sc.GEN_AI_USAGE_CACHE_READ, getattr(details, "cached_tokens", None) if details else None)):
            if v is not None:
                span.set_attribute(k, v)
        out = [_dump(o) for o in (getattr(r, "output", None) or [])]
        text = getattr(r, "output_text", None)
        calls = [o for o in out if isinstance(o, dict) and o.get("type") == "function_call"]
        set_content(span, sc.OUTPUT, {"role": "assistant", "content": text or "", **({"tool_calls": calls} if calls else {})})

    def _generation(self, span: Any, d: Any) -> None:
        if d.model:
            span.update_name(str(d.model))
            span.set_attribute(sc.GEN_AI_REQUEST_MODEL, str(d.model))
        u = d.usage or {}
        for k, key in ((sc.GEN_AI_USAGE_INPUT_TOKENS, "input_tokens"), (sc.GEN_AI_USAGE_OUTPUT_TOKENS, "output_tokens")):
            if isinstance(u.get(key), int):
                span.set_attribute(k, u[key])
        set_content(span, sc.INPUT, d.input)
        set_content(span, sc.OUTPUT, d.output)

    def shutdown(self) -> None:
        pass

    def force_flush(self) -> None:
        pass


# ── experiments: tools from the recording, per-agent model ─────────────────────
def _patch_everywhere(module_prefix: str, name: str, orig: Any, new: Any) -> None:
    """Replace a function in its module and in every module that imported it by name."""
    for mod_name, mod in list(sys.modules.items()):
        if mod_name.startswith(module_prefix) and getattr(mod, name, None) is orig:
            setattr(mod, name, new)


def _install_replay() -> None:
    import agents.tool as tool_mod
    from agents.run_internal import turn_preparation

    orig_invoke = tool_mod._invoke_function_tool_with_metadata  # noqa: SLF001

    async def invoke(*, function_tool: Any, context: Any, arguments: str):
        try:
            args = json.loads(arguments) if arguments else {}
        except ValueError:
            args = arguments
        hit, result, _mode = replay.intercept_tool(function_tool.name, args)
        if hit:
            return tool_mod._FunctionToolInvocationResult(result)  # noqa: SLF001
        return await orig_invoke(function_tool=function_tool, context=context, arguments=arguments)

    _patch_everywhere("agents", "_invoke_function_tool_with_metadata", orig_invoke, invoke)

    orig_get_model = turn_preparation.get_model

    def get_model(agent: Any, run_config: Any) -> Any:
        current = agent.model if isinstance(agent.model, str) else getattr(agent.model, "model", "") or ""
        swapped = replay.swap_model(agent.name, str(current or ""))
        if swapped:
            return run_config.model_provider.get_model(swapped)
        return orig_get_model(agent, run_config)

    _patch_everywhere("agents", "get_model", orig_get_model, get_model)


# ── blueprint ──────────────────────────────────────────────────────────────────
def _settings(ms: Any) -> dict[str, Any]:
    """ModelSettings (a dataclass) → its simple, set values."""
    import dataclasses

    if ms is None:
        return {}
    raw = dataclasses.asdict(ms) if dataclasses.is_dataclass(ms) else _dump(ms)
    return {k: v for k, v in (raw or {}).items() if isinstance(v, (int, float, str, bool))}


def describe_agent(agent: Any, _seen: set[int] | None = None) -> dict[str, Any]:
    from ..blueprint import MAX_DESC_CHARS, MAX_PROMPT_CHARS, _trim

    seen = _seen if _seen is not None else set()
    seen.add(id(agent))
    instructions = agent.instructions if isinstance(agent.instructions, str) else (
        "(dynamic instructions)" if agent.instructions else "")
    model = agent.model if isinstance(agent.model, str) else getattr(agent.model, "model", "") or ""
    tools = []
    for t in agent.tools or []:
        schema = getattr(t, "params_json_schema", None) or {}
        tools.append({"name": str(getattr(t, "name", "")), "description": _trim(getattr(t, "description", ""), MAX_DESC_CHARS),
                      "args": list((schema.get("properties") or {}).keys()), "builtin": False})
    subs = []
    for h in agent.handoffs or []:
        target = getattr(h, "agent", None) or (h if hasattr(h, "instructions") else None)
        if target is not None and id(target) not in seen:
            sub = describe_agent(target, seen)
            sub["description"] = sub["description"] or str(getattr(h, "tool_description", "") or "")
            subs.append(sub)
    middleware = [{"name": f"guardrail: {getattr(g, 'name', None) or getattr(getattr(g, 'guardrail_function', None), '__name__', 'guardrail')}",
                   "class": type(g).__name__, "module": "agents", "hooks": [kind]}
                  for kind, gs in (("input", agent.input_guardrails or []), ("output", agent.output_guardrails or [])) for g in gs]
    return {"name": agent.name, "description": str(getattr(agent, "handoff_description", "") or ""),
            "model": {"name": str(model or "default"), "class": "Agent", "provider": "openai-agents",
                      "params": _settings(getattr(agent, "model_settings", None))},
            "system_prompt": _trim(instructions, MAX_PROMPT_CHARS), "tools": tools, "middleware": middleware,
            "subagents": subs, "graph": {"nodes": [], "edges": []}}


async def run(agent: Any, messages: list[dict[str, str]]) -> str:
    from agents import Runner

    result = await Runner.run(agent, messages)
    out = result.final_output
    return out if isinstance(out, str) else json.dumps(_dump(out), default=str)


def _install_capture() -> None:
    """First run of each top-level agent → blueprint; and it becomes replayable."""
    from agents import Runner

    from .. import blueprint, experiments

    orig_run = Runner.run.__func__ if hasattr(Runner.run, "__func__") else Runner.run

    async def run_(cls, starting_agent, *args, **kwargs):
        if not blueprint._nested():  # noqa: SLF001
            blueprint.seen_agent(starting_agent, starting_agent.name)
            if experiments._started:  # noqa: SLF001
                experiments.capture(starting_agent, starting_agent.name)
        return await orig_run(cls, starting_agent, *args, **kwargs)

    Runner.run = classmethod(run_)  # type: ignore[method-assign]


def install() -> bool:
    global _installed
    if _installed:
        return True
    try:
        from agents import add_trace_processor
    except ImportError:
        return False
    add_trace_processor(_Processor())
    try:
        _install_replay()
    except Exception as exc:  # noqa: BLE001 — SDK internals moved: traces still work
        logger.warning("imagent: OpenAI Agents experiments unavailable (%s)", exc)
    try:
        _install_capture()
    except Exception as exc:  # noqa: BLE001
        logger.debug("imagent: OpenAI Agents capture unavailable (%s)", exc)
    _installed = True
    return True
