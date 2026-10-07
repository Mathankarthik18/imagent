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
    model: str = ""
    tool_mode: str = "recorded"                 # recorded | live_reads
    passthrough: set[str] = field(default_factory=set)
    read_tools: set[str] = field(default_factory=set)
    recorded: dict[tuple[str, str], deque] = field(default_factory=lambda: defaultdict(deque))
    events: list[dict[str, Any]] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)

    @classmethod
    def from_job(cls, job: dict[str, Any], *, passthrough: set[str], read_tools: set[str]) -> ReplayState:
        st = cls(model=str((job.get("variant") or {}).get("model") or ""), tool_mode=job.get("tool_mode", "recorded"),
                 passthrough=set(passthrough), read_tools=set(read_tools))
        for f in job.get("fixtures") or []:
            st.recorded[(f["name"], canonical_args(f.get("args", "")))].append(f)
        return st

    def resolve(self, name: str, args: Any) -> tuple[str, dict[str, Any] | None]:
        """→ (mode, recorded fixture or None)."""
        if name in self.passthrough:
            return "passthrough", None
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
        _installed = True
        logger.info("imagent replay hooks installed")


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
