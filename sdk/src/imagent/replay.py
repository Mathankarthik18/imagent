"""Replay mode: while an experiment job runs, tool calls are answered from the source
run's recorded outputs instead of executing.

``install()`` wraps ``BaseTool.ainvoke`` / ``invoke`` once. Outside a replay nothing
changes. Inside one (a contextvar set by the runner) each tool call is resolved as:

* **passthrough** tools (agent plumbing such as deepagents' ``task``) run normally, so
  sub-agents execute with the experiment's model;
* a call matching a recorded call (same tool, same arguments) returns the recorded
  output — consumed in order, so repeated calls replay in sequence;
* otherwise, in ``recorded`` mode the call returns a "not recorded" notice and is flagged;
  in ``live_reads`` mode tools declared read-only run for real and everything else is
  stubbed. Write tools never execute during a replay.

Every intercepted call is still reported through LangChain's callbacks, so it appears
in the trace with a ``replay:mode:<recorded|not_recorded|live|stubbed>`` tag.
"""

from __future__ import annotations

import json
import logging
import threading
from collections import defaultdict, deque
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger("imagent")

NOT_RECORDED = ("[imagent replay] This call was not made in the original run, so there is no recorded "
                "output for it. Treat the tool as unavailable.")
STUBBED = "[imagent replay] Write tool not executed during replay (stubbed)."


def canonical_args(args: Any) -> str:
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except ValueError:
            return args
    try:
        return json.dumps(args, sort_keys=True, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return str(args)


@dataclass
class ReplayState:
    model: str = ""                             # every LLM call (unless the agent has its own)
    models: dict[str, str] = field(default_factory=dict)   # agent name → model
    root_agent: str = ""                        # the agent being replayed — owner of unlabelled LLM calls
    swapped: dict[tuple[int, str], Any] = field(default_factory=dict)
    tool_mode: str = "recorded"                 # recorded | live_reads
    passthrough: set[str] = field(default_factory=set)
    read_tools: set[str] = field(default_factory=set)
    recorded: dict[tuple[str, str], deque] = field(default_factory=lambda: defaultdict(deque))
    events: list[dict[str, Any]] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)

    @classmethod
    def from_job(cls, job: dict[str, Any], *, passthrough: set[str], read_tools: set[str]) -> ReplayState:
        variant = job.get("variant") or {}
        models = variant.get("models") if isinstance(variant.get("models"), dict) else {}
        st = cls(model=str(variant.get("model") or ""), models={k: str(v) for k, v in models.items() if v},
                 root_agent=str(job.get("agent") or ""),
                 tool_mode=job.get("tool_mode", "recorded"),
                 passthrough=set(passthrough), read_tools=set(read_tools))
        for f in job.get("fixtures") or []:
            st.recorded[(f["name"], canonical_args(f.get("args", "")))].append(f)
        return st

    def resolve(self, name: str, args: Any) -> tuple[str, dict[str, Any] | None]:
        """→ (mode, recorded fixture or None)."""
        if name in self.passthrough:
            return "passthrough", None
        if self.tool_mode == "live":  # full access: every tool runs for real (reads and writes)
            return "live", None
        with self.lock:
            q = self.recorded.get((name, canonical_args(args)))
            fixture = q.popleft() if q else None
        if fixture is not None:
            return "recorded", fixture
        if self.tool_mode == "live_reads":
            return ("live", None) if name in self.read_tools else ("stubbed", None)
        return "not_recorded", None


_state: ContextVar[ReplayState | None] = ContextVar("imagent_replay", default=None)


def current() -> ReplayState | None:
    return _state.get()


def model_override(default: str | None = None) -> str | None:
    """The experiment's model when called inside a replay, else ``default``.
    Wire this into your app's model factory (e.g. ``get_model``)."""
    st = _state.get()
    return st.model if st is not None and st.model else default


def _split(tool_input: Any) -> tuple[Any, str | None]:
    """ToolCall envelope → (args, tool_call_id)."""
    if isinstance(tool_input, dict) and tool_input.get("type") == "tool_call" and "args" in tool_input:
        return tool_input["args"], tool_input.get("id")
    return tool_input, None


def _result(content: str, name: str, tool_call_id: str | None, status: str = "success") -> Any:
    if tool_call_id is None:
        return content
    from langchain_core.messages import ToolMessage

    return ToolMessage(content=content, name=name, tool_call_id=tool_call_id, status=status)


_installed = False
_install_lock = threading.Lock()


def install() -> None:
    """Patch LangChain tools for replay (idempotent; no effect outside a replay)."""
    global _installed
    with _install_lock:
        if _installed:
            return
        from langchain_core.runnables.config import get_async_callback_manager_for_config, get_callback_manager_for_config
        from langchain_core.tools import BaseTool

        orig_ainvoke, orig_invoke = BaseTool.ainvoke, BaseTool.invoke

        def _record(st: ReplayState, name: str, mode: str, args: Any) -> None:
            st.events.append({"tool": name, "mode": mode, "args": canonical_args(args)})

        async def ainvoke(self, input, config=None, **kwargs):  # noqa: A002
            st = _state.get()
            if st is None:
                return await orig_ainvoke(self, input, config, **kwargs)
            args, call_id = _split(input)
            mode, fixture = st.resolve(self.name, args)
            if mode in ("passthrough", "live"):
                if mode == "live":
                    _record(st, self.name, mode, args)
                return await orig_ainvoke(self, input, config, **kwargs)
            _record(st, self.name, mode, args)
            cm = get_async_callback_manager_for_config(config or {})
            cm.add_tags([f"replay:mode:{mode}"], inherit=False)
            run = await cm.on_tool_start({"name": self.name, "description": self.description},
                                         canonical_args(args), name=self.name,
                                         inputs=args if isinstance(args, dict) else None, tool_call_id=call_id)
            content = fixture["output"] if fixture else (STUBBED if mode == "stubbed" else NOT_RECORDED)
            status = "error" if fixture and fixture.get("status") == "error" else "success"
            result = _result(content, self.name, call_id, status)
            await run.on_tool_end(result)
            return result

        def invoke(self, input, config=None, **kwargs):  # noqa: A002
            st = _state.get()
            if st is None:
                return orig_invoke(self, input, config, **kwargs)
            args, call_id = _split(input)
            mode, fixture = st.resolve(self.name, args)
            if mode in ("passthrough", "live"):
                if mode == "live":
                    _record(st, self.name, mode, args)
                return orig_invoke(self, input, config, **kwargs)
            _record(st, self.name, mode, args)
            cm = get_callback_manager_for_config(config or {})
            cm.add_tags([f"replay:mode:{mode}"], inherit=False)
            run = cm.on_tool_start({"name": self.name, "description": self.description}, canonical_args(args),
                                   name=self.name, inputs=args if isinstance(args, dict) else None, tool_call_id=call_id)
            content = fixture["output"] if fixture else (STUBBED if mode == "stubbed" else NOT_RECORDED)
            status = "error" if fixture and fixture.get("status") == "error" else "success"
            result = _result(content, self.name, call_id, status)
            run.on_tool_end(result)
            return result

        BaseTool.ainvoke = ainvoke  # type: ignore[method-assign]
        BaseTool.invoke = invoke  # type: ignore[method-assign]
        _install_model_swap()
        _installed = True
        logger.info("imagent replay hooks installed")


# ── model swap ────────────────────────────────────────────────────────────────
_NAME_FIELDS = ("model_name", "model", "model_id")


def model_name_of(model: Any) -> str:
    for f in _NAME_FIELDS:
        v = getattr(model, f, None)
        if isinstance(v, str) and v:
            return v
    return ""


def target_model(st: ReplayState, run_manager: Any) -> str:
    """The experiment's model for this LLM call: the calling agent's pick, else the run-wide one."""
    # create_agent / deepagents label each call with its agent; a plain graph's calls are the replayed agent's.
    agent = ((getattr(run_manager, "metadata", None) or {}).get("lc_agent_name") or "") if run_manager else ""
    return st.models.get(agent or st.root_agent) or st.model


def provider_model_id(model: Any, name: str) -> str:
    """Apps often write "openrouter/vendor/model" and strip the router prefix in their own
    model factory; a client already pointed at OpenRouter must get "vendor/model"."""
    base = str(getattr(model, "openai_api_base", None) or getattr(model, "base_url", None) or "")
    if name.startswith("openrouter/") and "openrouter.ai" in base:
        return name[len("openrouter/"):]
    return name


def swapped(st: ReplayState, model: Any, name: str) -> Any:
    """A copy of ``model`` asking for ``name`` (same provider, keys and settings)."""
    key = (id(model), name)
    if key not in st.swapped:
        fields = getattr(type(model), "model_fields", {})
        field_ = next((f for f in _NAME_FIELDS if f in fields), None)
        # A model we can't rename (custom class) is left alone — the app may pick it itself from job.model.
        st.swapped[key] = model.model_copy(update={field_: provider_model_id(model, name)}) if field_ else model
    return st.swapped[key]


def _install_model_swap() -> None:
    from langchain_core.language_models.chat_models import BaseChatModel

    orig_a, orig_s = BaseChatModel._agenerate_with_cache, BaseChatModel._generate_with_cache

    async def agen(self, messages, stop=None, run_manager=None, **kwargs):
        st = _state.get()
        name = target_model(st, run_manager) if st else ""
        if name and name != model_name_of(self):
            return await orig_a(swapped(st, self, name), messages, stop, run_manager, **kwargs)
        return await orig_a(self, messages, stop, run_manager, **kwargs)

    def gen(self, messages, stop=None, run_manager=None, **kwargs):
        st = _state.get()
        name = target_model(st, run_manager) if st else ""
        if name and name != model_name_of(self):
            return orig_s(swapped(st, self, name), messages, stop, run_manager, **kwargs)
        return orig_s(self, messages, stop, run_manager, **kwargs)

    BaseChatModel._agenerate_with_cache = agen  # type: ignore[method-assign]
    BaseChatModel._generate_with_cache = gen  # type: ignore[method-assign]


# ── hooks for non-LangChain integrations ──────────────────────────────────────
def intercept_tool(name: str, args: Any) -> tuple[bool, str, str]:
    """For a framework tool about to run: (intercepted, result, mode). When intercepted, return
    ``result`` instead of running the tool — a recorded output, or a not-recorded/stubbed notice."""
    st = _state.get()
    if st is None:
        return False, "", ""
    mode, fixture = st.resolve(name, args)
    if mode in ("passthrough", "live"):
        if mode == "live":
            st.events.append({"tool": name, "mode": mode, "args": canonical_args(args)})
        return False, "", mode
    st.events.append({"tool": name, "mode": mode, "args": canonical_args(args)})
    return True, (fixture["output"] if fixture else (STUBBED if mode == "stubbed" else NOT_RECORDED)), mode


def swap_model(agent: str, current: str, *, base_url: str = "") -> str | None:
    """The experiment's model for a call by ``agent`` (None: keep ``current``)."""
    st = _state.get()
    if st is None:
        return None
    name = st.models.get(agent or st.root_agent) or st.model
    if not name:
        return None
    if name.startswith("openrouter/") and "openrouter.ai" in base_url:
        name = name[len("openrouter/"):]
    return name if name != current else None


class activate:
    """``with activate(state): ...`` — tool calls inside are replayed."""

    def __init__(self, state: ReplayState):
        self.state = state
        self._token = None

    def __enter__(self) -> ReplayState:
        self._token = _state.set(self.state)
        return self.state

    def __exit__(self, *exc: Any) -> None:
        _state.reset(self._token)
