"""LangChain / LangGraph → OpenTelemetry spans.

One callback handler turns every chain, graph node, chat-model call, tool and
retriever run into a span with correct parent/child links. ``install()``
registers it globally through LangChain's configure hook, so no call site
needs ``callbacks=[...]``.
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from langchain_core.callbacks import BaseCallbackHandler
from opentelemetry import trace
from opentelemetry.trace import Span

from .. import semconv as sc
from ..runtime import apply_context, get_tracer, is_harness_span, record_error, set_content
from ..serialize import message_to_dict, to_jsonable

# LangGraph control-flow exceptions — not failures.
_CONTROL_FLOW_ERRORS = {"GraphInterrupt", "NodeInterrupt", "ParentCommand", "GraphBubbleUp", "Interrupt"}
# Plumbing runnables that add depth without information.
_SKIP_CHAIN_PREFIXES = ("ChannelWrite", "ChannelRead", "Branch<", "RunnableAssign", "RunnablePassthrough",
                        "_write", "_route", "RunnableSequence")
# LangGraph routing functions — they decide an edge, they don't do work.
_SKIP_CHAIN_NAMES = {"tools_condition", "should_continue", "route", "router_condition"}
_HIDDEN_TAG = "langsmith:hidden"
_METADATA_SKIP = {"langgraph_triggers", "langgraph_path", "langgraph_checkpoint_ns", "checkpoint_ns",
                  "__pregel_task_id", "__pregel_resuming"}


@dataclass
class _Run:
    span: Span
    kind: str
    agent_name: str | None
    thread_id: str | None
    started: float
    checkpoint_ns: str | None = None
    first_token_at: float | None = None


_RECENT_RUNS = 4096  # ended runs kept so late children can still find their parent


def _name_from(serialized: dict[str, Any] | None, kwargs: dict[str, Any], default: str) -> str:
    if kwargs.get("name"):
        return str(kwargs["name"])
    if serialized:
        if serialized.get("name"):
            return str(serialized["name"])
        ident = serialized.get("id")
        if isinstance(ident, list) and ident:
            return str(ident[-1])
    return default


def _is_graph(serialized: dict[str, Any] | None) -> bool:
    ident = (serialized or {}).get("id") or []
    return any(isinstance(p, str) and ("Pregel" in p or "StateGraph" in p) for p in ident)


def _clean_metadata(metadata: dict[str, Any] | None) -> dict[str, Any]:
    return {k: v for k, v in (metadata or {}).items() if k not in _METADATA_SKIP and not k.startswith("__")}


def _unrepeat(value: Any) -> Any:
    """Undo LangChain's chunk merge, which concatenates string metadata across
    streamed chunks ("z-ai/glmz-ai/glm", "stopstop")."""
    if not isinstance(value, str) or len(value) < 2:
        return value
    n = len(value)
    for size in range(1, n // 2 + 1):
        if n % size == 0 and value == value[:size] * (n // size):
            return value[:size]
    return value


def _usage(response: Any, message: Any) -> dict[str, Any]:
    """Normalise token usage across providers. ``input`` is the total prompt
    (cached included), matching LangChain's ``usage_metadata`` semantics."""
    out: dict[str, Any] = {}
    um = getattr(message, "usage_metadata", None) or {}
    if um:
        out["input"] = um.get("input_tokens")
        out["output"] = um.get("output_tokens")
        details = um.get("input_token_details") or {}
        out["cache_read"] = details.get("cache_read")
        out["cache_write"] = details.get("cache_creation")
    llm_output = getattr(response, "llm_output", None) or {}
    rm = getattr(message, "response_metadata", None) or {}
    raw = rm.get("token_usage") or rm.get("usage") or llm_output.get("token_usage") or llm_output.get("usage") or {}
    if not isinstance(raw, dict):
        raw = to_jsonable(raw) if raw else {}
        raw = raw if isinstance(raw, dict) else {}
    if out.get("input") is None:
        out["input"] = raw.get("prompt_tokens", raw.get("input_tokens"))
        out["output"] = raw.get("completion_tokens", raw.get("output_tokens"))
    if out.get("cache_read") is None:
        out["cache_read"] = (raw.get("prompt_tokens_details") or {}).get("cached_tokens") or raw.get("cache_read_input_tokens")
    cost = raw.get("cost")  # OpenRouter reports the real billed cost here
    if isinstance(cost, (int, float)):
        out["cost"] = float(cost)
    out["model"] = _unrepeat(rm.get("model_name") or rm.get("model") or llm_output.get("model_name"))
    finish = _unrepeat(rm.get("finish_reason") or rm.get("stop_reason"))
    if finish:
        out["finish_reason"] = str(finish)
    return out


class HarnessCallbackHandler(BaseCallbackHandler):
    run_inline = True       # keep the caller's contextvars (OTel parent) in async runs
    raise_error = False

    def __init__(self) -> None:
        self._runs: dict[UUID, _Run] = {}
        self._recent: OrderedDict[UUID, _Run] = OrderedDict()
        self._skipped: dict[UUID, UUID | None] = {}
        # LangGraph checkpoint namespace ("model:<task>", "tools:<task>|model:<task>") → open run.
        self._by_ns: dict[str, list[UUID]] = {}
        self._lock = threading.Lock()

    # ── bookkeeping ──────────────────────────────────────────────────────────
    def _effective_parent(self, parent_run_id: UUID | None) -> _Run | None:
        with self._lock:
            pid = parent_run_id
            seen = 0
            while pid is not None and pid in self._skipped and seen < 1000:
                pid = self._skipped[pid]
                seen += 1
            if pid is None:
                return None
            return self._runs.get(pid) or self._recent.get(pid)

    def _parent_by_namespace(self, metadata: dict[str, Any]) -> _Run | None:
        """Fallback when LangChain's parent_run_id is missing or unknown (seen with
        deepagents + astream_events in production): every run inside a LangGraph
        task carries that task's checkpoint namespace, so the innermost open run
        registered under the same (or an enclosing) namespace is the parent."""
        ns = metadata.get("langgraph_checkpoint_ns") or metadata.get("checkpoint_ns")
        if not isinstance(ns, str) or not ns:
            return None
        with self._lock:
            parts = ns.split("|")
            while parts:
                for run_id in reversed(self._by_ns.get("|".join(parts), ())):
                    if run_id in self._runs:
                        return self._runs[run_id]
                parts.pop()
        return None

    def _resolve_parent(self, parent_run_id: UUID | None, metadata: dict[str, Any]) -> tuple[_Run | None, str | None]:
        parent = self._effective_parent(parent_run_id)
        if parent is not None:
            return parent, None
        in_graph = "langgraph_node" in metadata or "langgraph_checkpoint_ns" in metadata
        if parent_run_id is not None or in_graph:
            parent = self._parent_by_namespace(metadata)
            if parent is not None:
                return parent, "checkpoint_ns"
        return None, None

    def span_for_run(self, run_id: UUID | None) -> Span | None:
        run = self._effective_parent(run_id)
        return run.span if run else None

    def _skip(self, run_id: UUID, parent_run_id: UUID | None) -> None:
        with self._lock:
            self._skipped[run_id] = parent_run_id

    def _start(
        self,
        *,
        run_id: UUID,
        parent_run_id: UUID | None,
        name: str,
        kind: str,
        metadata: dict[str, Any] | None,
        tags: list[str] | None,
        attributes: dict[str, Any],
        inputs: Any,
    ) -> _Run | None:
        tracer = get_tracer()
        if tracer is None:
            return None
        metadata = metadata or {}
        parent, relinked = self._resolve_parent(parent_run_id, metadata)
        outer = None
        if parent is not None:
            ctx = trace.set_span_in_context(parent.span)
            is_root = False
        else:
            ctx = None  # current OTel context: an @observe span, a web request span, or nothing
            current = trace.get_current_span()
            is_root = not is_harness_span(current)
            outer = None if is_root else current
            if kind == "chain":
                kind = "agent"
        thread_id = metadata.get("thread_id") or metadata.get("session_id") or (parent.thread_id if parent else None)
        thread_id = str(thread_id) if thread_id else None
        agent_name = parent.agent_name if parent else None
        if kind == "agent":
            agent_name = name if agent_name is None or name not in {"LangGraph", "RunnableSequence"} else agent_name
        attrs = {sc.SPAN_KIND: kind, sc.ROOT: is_root, **{k: v for k, v in attributes.items() if v is not None}}
        if kind == "agent":
            attrs[sc.GEN_AI_OPERATION] = "invoke_agent"
        # LangChain run ids: lets the backend (and a human) audit/repair the tree.
        attrs["harness.lc.run_id"] = str(run_id)
        if parent_run_id is not None:
            attrs["harness.lc.parent_run_id"] = str(parent_run_id)
        if relinked:
            attrs["harness.lc.relinked"] = relinked
        elif parent is None and parent_run_id is not None:
            attrs["harness.lc.orphan"] = True
        span = tracer.start_span(name, context=ctx, attributes=attrs)
        visible_tags = [t for t in (tags or []) if not t.startswith(("seq:", "graph:", "langsmith:"))]
        apply_context(span, parent=outer, thread_id=thread_id, agent_name=agent_name, tags=visible_tags,
                      metadata=_clean_metadata(metadata) if is_root or kind in {"llm", "agent"} else None)
        if inputs is not None:
            set_content(span, sc.INPUT, inputs)
        ns = metadata.get("langgraph_checkpoint_ns")
        ns = ns if isinstance(ns, str) and ns and kind in {"agent", "node", "chain", "tool"} else None
        run = _Run(span=span, kind=kind, agent_name=agent_name, thread_id=thread_id, started=time.monotonic(),
                   checkpoint_ns=ns)
        with self._lock:
            self._runs[run_id] = run
            if ns:
                # Stack per namespace: a node registers after its graph, a tool after its node.
                self._by_ns.setdefault(ns, []).append(run_id)
        return run

    def _end(self, run_id: UUID, *, outputs: Any = None, error: BaseException | None = None,
             attributes: dict[str, Any] | None = None) -> None:
        with self._lock:
            run = self._runs.pop(run_id, None)
            self._skipped.pop(run_id, None)
            if run is not None:
                stack = self._by_ns.get(run.checkpoint_ns) if run.checkpoint_ns else None
                if stack is not None:
                    if run_id in stack:
                        stack.remove(run_id)
                    if not stack:
                        del self._by_ns[run.checkpoint_ns]
                self._recent[run_id] = run
                while len(self._recent) > _RECENT_RUNS:
                    self._recent.popitem(last=False)
        if run is None:
            return
        span = run.span
        for k, v in (attributes or {}).items():
            if v is not None:
                span.set_attribute(k, v)
        if error is not None:
            if type(error).__name__ in _CONTROL_FLOW_ERRORS:
                span.add_event("interrupt", {"type": type(error).__name__, "message": str(error)[:1000]})
            else:
                record_error(span, error)
        elif outputs is not None:
            set_content(span, sc.OUTPUT, outputs)
        span.end()

    # ── chains / graphs / nodes ──────────────────────────────────────────────
    def on_chain_start(self, serialized: dict[str, Any] | None, inputs: Any, *, run_id: UUID,
                       parent_run_id: UUID | None = None, tags: list[str] | None = None,
                       metadata: dict[str, Any] | None = None, **kwargs: Any) -> None:
        name = _name_from(serialized, kwargs, "chain")
        parent_kept, _ = self._resolve_parent(parent_run_id, metadata or {})
        hidden = _HIDDEN_TAG in (tags or [])
        if parent_kept is not None and (hidden or name.startswith(_SKIP_CHAIN_PREFIXES) or name in _SKIP_CHAIN_NAMES):
            self._skip(run_id, parent_run_id)
            return
        md = metadata or {}
        if _is_graph(serialized) or (parent_kept is not None and parent_kept.kind == "tool" and "langgraph_node" not in md):
            kind = "agent"
        elif md.get("langgraph_node") == name:
            kind = "node"
        else:
            kind = "chain"
        attrs: dict[str, Any] = {}
        if "langgraph_step" in md:
            attrs["langgraph.step"] = md["langgraph_step"]
        if "langgraph_node" in md:
            attrs["langgraph.node"] = str(md["langgraph_node"])
        self._start(run_id=run_id, parent_run_id=parent_run_id, name=name, kind=kind, metadata=metadata,
                    tags=tags, attributes=attrs, inputs=inputs)

    def on_chain_end(self, outputs: Any, *, run_id: UUID, **kwargs: Any) -> None:
        self._end(run_id, outputs=outputs)

    def on_chain_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        self._end(run_id, error=error)

    # ── LLMs ─────────────────────────────────────────────────────────────────
    def _llm_start(self, serialized: dict[str, Any] | None, inputs: Any, run_id: UUID,
                   parent_run_id: UUID | None, tags: list[str] | None, metadata: dict[str, Any] | None,
                   kwargs: dict[str, Any], operation: str) -> None:
        params = kwargs.get("invocation_params") or {}
        md = metadata or {}
        model = params.get("model") or params.get("model_name") or md.get("ls_model_name") or ""
        provider = md.get("ls_provider") or params.get("_type") or ""
        attrs: dict[str, Any] = {
            sc.GEN_AI_OPERATION: operation,
            sc.GEN_AI_REQUEST_MODEL: str(model) if model else None,
            sc.GEN_AI_SYSTEM: str(provider) if provider else None,
            sc.GEN_AI_REQUEST_TEMPERATURE: params.get("temperature") if isinstance(params.get("temperature"), (int, float)) else None,
            sc.GEN_AI_REQUEST_MAX_TOKENS: params.get("max_tokens") if isinstance(params.get("max_tokens"), int) else None,
        }
        if "langgraph_node" in md:
            attrs["langgraph.node"] = str(md["langgraph_node"])
        run = self._start(run_id=run_id, parent_run_id=parent_run_id,
                          name=str(model) if model else _name_from(serialized, kwargs, "llm"),
                          kind="llm", metadata=metadata, tags=tags, attributes=attrs, inputs=inputs)
        tools = params.get("tools") or params.get("functions")
        if run is not None and tools:
            set_content(run.span, sc.TOOLS, tools)

    def on_chat_model_start(self, serialized: dict[str, Any] | None, messages: list[list[Any]], *, run_id: UUID,
                            parent_run_id: UUID | None = None, tags: list[str] | None = None,
                            metadata: dict[str, Any] | None = None, **kwargs: Any) -> None:
        inputs = [message_to_dict(m) for m in messages[0]] if messages else []
        self._llm_start(serialized, inputs, run_id, parent_run_id, tags, metadata, kwargs, "chat")

    def on_llm_start(self, serialized: dict[str, Any] | None, prompts: list[str], *, run_id: UUID,
                     parent_run_id: UUID | None = None, tags: list[str] | None = None,
                     metadata: dict[str, Any] | None = None, **kwargs: Any) -> None:
        self._llm_start(serialized, prompts[0] if len(prompts) == 1 else prompts, run_id, parent_run_id,
                        tags, metadata, kwargs, "text_completion")

    def on_llm_new_token(self, token: str, *, run_id: UUID, **kwargs: Any) -> None:
        with self._lock:
            run = self._runs.get(run_id)
        if run is not None and run.first_token_at is None:
            run.first_token_at = time.monotonic()
            run.span.set_attribute(sc.TTFT_MS, round((run.first_token_at - run.started) * 1000, 1))

    def on_llm_end(self, response: Any, *, run_id: UUID, **kwargs: Any) -> None:
        gens = getattr(response, "generations", None) or []
        gen = gens[0][0] if gens and gens[0] else None
        message = getattr(gen, "message", None)
        if message is not None:
            output: Any = message_to_dict(message)
        elif gen is not None:
            output = getattr(gen, "text", None)
        else:
            output = None
        u = _usage(response, message)
        attrs = {
            sc.GEN_AI_USAGE_INPUT_TOKENS: u.get("input"),
            sc.GEN_AI_USAGE_OUTPUT_TOKENS: u.get("output"),
            sc.GEN_AI_USAGE_CACHE_READ: u.get("cache_read"),
            sc.GEN_AI_USAGE_CACHE_WRITE: u.get("cache_write"),
            sc.GEN_AI_RESPONSE_MODEL: u.get("model"),
            sc.COST_USD: u.get("cost"),
            sc.GEN_AI_RESPONSE_FINISH_REASONS: [u["finish_reason"]] if u.get("finish_reason") else None,
        }
        self._end(run_id, outputs=output, attributes=attrs)

    def on_llm_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        self._end(run_id, error=error)

    # ── tools ────────────────────────────────────────────────────────────────
    def on_tool_start(self, serialized: dict[str, Any] | None, input_str: str, *, run_id: UUID,
                      parent_run_id: UUID | None = None, tags: list[str] | None = None,
                      metadata: dict[str, Any] | None = None, inputs: dict[str, Any] | None = None,
                      **kwargs: Any) -> None:
        name = _name_from(serialized, kwargs, "tool")
        attrs = {sc.GEN_AI_OPERATION: "execute_tool", sc.GEN_AI_TOOL_NAME: name,
                 sc.GEN_AI_TOOL_CALL_ID: kwargs.get("tool_call_id")}
        self._start(run_id=run_id, parent_run_id=parent_run_id, name=name, kind="tool", metadata=metadata,
                    tags=tags, attributes=attrs, inputs=inputs if inputs is not None else input_str)

    def on_tool_end(self, output: Any, *, run_id: UUID, **kwargs: Any) -> None:
        status = getattr(output, "status", None)
        if status == "error":
            with self._lock:
                run = self._runs.get(run_id)
            if run is not None:
                from opentelemetry.trace import Status, StatusCode
                run.span.set_status(Status(StatusCode.ERROR, str(getattr(output, "content", ""))[:1000]))
        self._end(run_id, outputs=output)

    def on_tool_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        self._end(run_id, error=error)

    # ── retrievers ───────────────────────────────────────────────────────────
    def on_retriever_start(self, serialized: dict[str, Any] | None, query: str, *, run_id: UUID,
                           parent_run_id: UUID | None = None, tags: list[str] | None = None,
                           metadata: dict[str, Any] | None = None, **kwargs: Any) -> None:
        self._start(run_id=run_id, parent_run_id=parent_run_id, name=_name_from(serialized, kwargs, "retriever"),
                    kind="retriever", metadata=metadata, tags=tags, attributes={}, inputs=query)

    def on_retriever_end(self, documents: Any, *, run_id: UUID, **kwargs: Any) -> None:
        self._end(run_id, outputs=documents)

    def on_retriever_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        self._end(run_id, error=error)


_handler: HarnessCallbackHandler | None = None
_handler_var: ContextVar[HarnessCallbackHandler | None] | None = None


def get_callback_handler() -> HarnessCallbackHandler:
    """The process-wide handler — pass it as ``callbacks=[...]`` if you disabled auto-instrumentation."""
    global _handler
    if _handler is None:
        _handler = HarnessCallbackHandler()
    return _handler


def install() -> HarnessCallbackHandler:
    """Register the handler on every LangChain run in the process (idempotent)."""
    global _handler_var
    handler = get_callback_handler()
    if _handler_var is None:
        from langchain_core.tracers.context import register_configure_hook

        # A ContextVar whose *default* is the handler makes it visible in every
        # thread and task without anyone calling .set().
        _handler_var = ContextVar("harness_moni_langchain_handler", default=handler)
        register_configure_hook(_handler_var, inheritable=True)
    return handler


def current_run_span() -> Span | None:
    """Span of the LangChain run currently executing (e.g. inside a tool), so an
    ``@observe`` function called from a tool nests under that tool's span."""
    if _handler is None:
        return None
    try:
        from langchain_core.runnables.config import var_child_runnable_config
    except ImportError:
        return None
    cfg = var_child_runnable_config.get()
    if not cfg:
        return None
    parent_run_id = getattr(cfg.get("callbacks"), "parent_run_id", None)
    return _handler.span_for_run(parent_run_id) if parent_run_id else None
