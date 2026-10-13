"""Experiments with no wiring: set ``IMAGENT_EXPERIMENTS=true`` and call ``imagent.init()``.

* Every agent the app runs is captured on its first run (the blueprint hook sees it).
* A runner starts by itself and polls imagent for experiment jobs.
* A job re-runs the captured agent on the recorded input, with:
  - tools answered from the recorded run (``replay``) — nothing real executes;
  - the model swapped at call time, per agent (``replay`` patches the chat model);
  - an in-memory checkpointer/store, never the app's database.

Agents that need app context to run (a user, an org, a dry-run flag) register one
function instead, which wins over the automatic replay::

    @imagent.experiment("bosun_orchestrator")
    async def replay(run):
        agent = build_agent()
        return await agent.ainvoke({"messages": run.messages}, config={"configurable": {...}})

Jobs run on the app's own event loop once the app has run an agent (so clients bound to
that loop keep working); until then the runner reports "waiting for the first run".
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
from typing import Any, Awaitable, Callable

logger = logging.getLogger("imagent")

_graphs: dict[str, Any] = {}             # root agents seen running: name → compiled graph
_app_loop: asyncio.AbstractEventLoop | None = None
_sync_app = False                         # an agent ran outside any event loop
_started = False
_lock = threading.Lock()


def enabled() -> bool:
    from .runtime import _env

    return (_env("EXPERIMENTS", "false") or "").strip().lower() in {"1", "true", "yes", "on"}


def capture(graph: Any, name: str) -> None:
    """Called by the blueprint hook on an agent's first top-level run."""
    global _app_loop, _sync_app
    with _lock:
        _graphs[name] = graph  # the latest build — apps that rebuild per request replay the current agent
        try:
            loop = asyncio.get_running_loop()
            if _app_loop is None:
                _app_loop = loop
        except RuntimeError:
            _sync_app = True
    from . import runner

    if name not in runner._agents:
        runner.register_agent(name, _auto_replay, source_root=name, description="Captured automatically")
        runner._agents[name].auto = True  # type: ignore[attr-defined]


def ready() -> bool:
    """Jobs need the app's event loop: found at ``init()`` (servers import the app inside it)
    or on the first agent run; a sync app's first run marks it ready too."""
    return _app_loop is not None or _sync_app


def experiment(name: str, *, read_tools: tuple[str, ...] | list[str] = (),
               passthrough_tools: tuple[str, ...] | list[str] | None = None) -> Callable:
    """Register how to replay ``name`` when it needs app context. The function gets the
    run (``imagent.ReplayJob``: messages, input, metadata …) and returns the output."""
    from . import runner

    def deco(fn: Callable[[Any], Awaitable[Any] | Any]) -> Callable:
        kw = {} if passthrough_tools is None else {"passthrough_tools": passthrough_tools}
        runner.register_agent(name, fn, source_root=name, read_tools=read_tools, **kw)
        return fn
    return deco


def _text(content: Any) -> str:
    if isinstance(content, list):
        return "\n".join(str(b.get("text", "")) for b in content if isinstance(b, dict) and b.get("text"))
    return "" if content is None else str(content)


def conversation(messages: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Recorded messages → user/assistant text turns (earlier tool plumbing can't be re-run)."""
    out = []
    for m in messages:
        role = {"human": "user", "ai": "assistant"}.get(m.get("role", ""), m.get("role", ""))
        if role in ("user", "assistant") and _text(m.get("content")).strip():
            out.append({"role": role, "content": _text(m.get("content"))})
    return out


async def _auto_replay(job: Any) -> str:
    """Re-run the captured agent on the recorded conversation, with in-memory persistence."""
    graph = _graphs.get(job.agent)
    if graph is None:
        raise RuntimeError(f"agent '{job.agent}' hasn't run in this process yet")
    return await _replay_graph(graph, job, {})


def start() -> None:
    """Start the runner in a background thread (idempotent)."""
    global _started
    with _lock:
        if _started:
            return
        _started = True
    from . import replay

    replay.install()
    global _app_loop
    try:  # servers (uvicorn) import the app inside their running loop — jobs can use it right away
        _app_loop = _app_loop or asyncio.get_running_loop()
    except RuntimeError:
        pass
    threading.Thread(target=lambda: asyncio.run(_poll()), name="imagent-experiments", daemon=True).start()
    logger.info("imagent experiments on")


async def _poll(poll_interval: float = 2.0) -> None:
    import socket
    import uuid

    from . import runner

    runner_id = f"{socket.gethostname()}-{os.getpid()}-{uuid.uuid4().hex[:6]}"
    backoff = poll_interval
    while True:
        try:
            job = await runner.claim_once(runner_id, ready=ready())
            backoff = poll_interval
            if job:
                loop = _app_loop
                if loop is not None and loop.is_running():
                    # On the app's loop: its HTTP clients / DB handles belong to that loop.
                    await asyncio.wrap_future(asyncio.run_coroutine_threadsafe(runner._run_job(job), loop))
                else:
                    await runner._run_job(job)
                continue
        except Exception as exc:  # noqa: BLE001 — the runner must never die
            logger.debug("imagent experiments poll failed: %s", exc)
            backoff = min(backoff * 2, 60.0)
        await asyncio.sleep(backoff)


# ── @imagent.agent: decorate the function that builds the agent ───────────────
import dataclasses
import functools
import itertools
from collections import OrderedDict

_builds: OrderedDict[str, dict[str, Any]] = OrderedDict()   # build id → how the agent was built + run config
_latest: dict[str, str] = {}                                 # agent name → newest build id
_latest_config: dict[str, dict[str, Any]] = {}               # agent name → newest run's config (live connections)
_ids = itertools.count(1)
MAX_BUILDS = 500
# Run config keys that belong to one run, never reused by a replay.
_PER_RUN_KEYS = {"thread_id", "checkpoint_id", "checkpoint_ns", "run_id"}


def agent(name: str, *, replay_overrides: dict[str, dict[str, Any]] | None = None,
          read_tools: tuple[str, ...] | list[str] = ()) -> Callable:
    """Decorate the function that builds your agent (the one calling ``create_deep_agent`` /
    ``create_agent``). Nothing changes for normal runs. In an experiment imagent rebuilds the
    agent with the arguments the recorded run was built with, reuses that run's config, and
    makes it safe: in-memory checkpointer/store, tools from the recording, the experiment's model.

    ``replay_overrides`` patches fields of objects in the run config that would otherwise act
    on live systems, e.g. ``{"bosun_context": {"db": None, "dry_run": True}}``."""
    from . import runner

    overrides = replay_overrides or {}

    def deco(build: Callable) -> Callable:
        @functools.wraps(build)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            graph = build(*args, **kwargs)
            bid = f"{os.getpid()}-{next(_ids)}"
            try:
                graph._imagent_build = bid  # read by the run hook to tag the run's metadata
            except Exception:  # noqa: BLE001
                return graph
            with _lock:
                _builds[bid] = {"agent": name, "build": build, "args": args, "kwargs": kwargs, "configurable": None,
                                "portable": portable_args(build, args, kwargs)}
                _latest[name] = bid
                while len(_builds) > MAX_BUILDS:
                    _builds.popitem(last=False)
            return graph

        async def replay(job: Any) -> str:
            live = job.tool_mode == "live"
            bid = job.metadata.get("imagent_build")
            with _lock:
                b = _builds.get(bid)
            if b is not None:  # built in this process: exact arguments + the run's config
                graph = build(*b["args"], **b["kwargs"])
                return await _replay_graph(graph, job, safe_configurable(b["configurable"] or {}, overrides, live=live))
            if live:
                # The run predates this process: borrow live connections from the agent's latest run here,
                # with the original run's identity (user, org, role, thread …) from its metadata.
                with _lock:
                    template = _latest_config.get(name)
                if template is None:
                    raise RuntimeError(f"live tools need a live connection: let the app run '{name}' once since it "
                                       "started, then run this experiment again")
                configurable = rebuild_context(template, job.metadata)
                portable = job.metadata.get("imagent_build_args")
                graph = build(**portable) if isinstance(portable, dict) else build(**default_args(build))
                return await _replay_graph(graph, job, safe_configurable(configurable, overrides, live=True))
            portable = job.metadata.get("imagent_build_args")
            if isinstance(portable, dict):  # built before a restart: the simple arguments from the run's metadata
                return await _replay_graph(build(**portable), job, {})
            with _lock:
                b = _builds.get(_latest.get(name, ""))
            if b is None:  # nothing recorded: the build's defaults, required arguments emptied
                return await _replay_graph(build(**default_args(build)), job, {})
            graph = build(*b["args"], **b["kwargs"])
            return await _replay_graph(graph, job, safe_configurable(b["configurable"] or {}, overrides))

        runner.register_agent(name, replay, source_root=name, read_tools=read_tools)
        _startup_builds.append((name, wrapper))
        _run_startup_builds()  # no-op until imagent.init() has run
        return wrapper
    return deco


# Decorated builders are built once right after the app starts, so the blueprint appears
# without waiting for the agent's first run.
_startup_builds: list[tuple[str, Callable]] = []
STARTUP_DELAY_SECONDS = 2.0


def _run_startup_builds() -> None:
    from .runtime import _env, get_config

    cfg = get_config()
    if cfg is None or not cfg.auto_blueprint or (_env("AUTO_BLUEPRINT", "true") or "").lower() in {"0", "false", "no"}:
        return
    with _lock:
        pending, _startup_builds[:] = list(_startup_builds), []
    for name, build in pending:
        def go(name: str = name, build: Callable = build) -> None:
            try:
                from . import blueprint

                blueprint.publish_built(build(**default_args(build)), name)
            except Exception as exc:  # noqa: BLE001 — never break the app's startup
                logger.warning("imagent: couldn't build %s at startup for its blueprint: %s", name, exc)
        try:  # on the app's loop when there is one (builders may touch loop-bound clients)
            (_app_loop or asyncio.get_running_loop()).call_later(STARTUP_DELAY_SECONDS, go)
        except RuntimeError:
            threading.Timer(STARTUP_DELAY_SECONDS, go).start()


def note_run(graph: Any, config: Any) -> Any:
    """Called for a top-level run of a decorated agent's graph: remember the run config and
    tag the run with its build id, so a replay rebuilds exactly this agent."""
    bid = getattr(graph, "_imagent_build", None)
    if not bid:
        return config
    config = dict(config or {})
    with _lock:
        b = _builds.get(bid)
        if b is not None and b["configurable"] is None:
            b["configurable"] = dict(config.get("configurable") or {})
        if b is not None and config.get("configurable"):
            _latest_config[b["agent"]] = dict(config["configurable"])
    extra = {"imagent_build": bid}
    if b is not None and b.get("portable") is not None:
        extra["imagent_build_args"] = b["portable"]
    config["metadata"] = {**(config.get("metadata") or {}), **extra}
    return config


def _portable(v: Any) -> tuple[bool, Any]:
    import enum

    if v is None or isinstance(v, (bool, int, float, str)):
        return True, v.value if isinstance(v, enum.Enum) and isinstance(v.value, (str, int)) else v
    if isinstance(v, (list, tuple)):
        items = [_portable(x) for x in v]
        return (True, [x for _, x in items]) if all(ok for ok, _ in items) else (False, [])
    if isinstance(v, dict):
        items = {k: _portable(x) for k, x in v.items()}
        return (True, {k: x for k, (_, x) in items.items()}) if all(ok for ok, _ in items.values()) and all(isinstance(k, str) for k in v) else (False, {})
    return False, None


def default_args(build: Callable) -> dict[str, Any]:
    """Stand-ins for required arguments: [] for list-like ones, else None."""
    import inspect

    out = {}
    for k, p in inspect.signature(build).parameters.items():
        if p.default is inspect.Parameter.empty and p.kind not in (p.VAR_POSITIONAL, p.VAR_KEYWORD):
            out[k] = [] if "list" in str(p.annotation).lower() or "seq" in str(p.annotation).lower() else None
    return out


def portable_args(build: Callable, args: tuple, kwargs: dict) -> dict[str, Any] | None:
    """The build's arguments as JSON (strings, numbers, flags, enums). Objects that can't be
    stored are left out (their default applies) — or emptied when the argument is required."""
    import inspect

    try:
        bound = inspect.signature(build).bind_partial(*args, **kwargs)
    except (TypeError, ValueError):
        return None
    params = inspect.signature(build).parameters
    out: dict[str, Any] = {}
    for k, v in bound.arguments.items():
        ok, val = _portable(v)
        if ok:
            out[k] = val
        elif params[k].default is inspect.Parameter.empty:  # required: pass an empty stand-in
            out[k] = val
    return out


def rebuild_context(template: dict[str, Any], metadata: dict[str, Any]) -> dict[str, Any]:
    """Another run's config with the recorded run's identity: every context object (dataclass /
    pydantic) gets its fields that the run's metadata names (user_id, org_id, role, thread_id …)
    set from that metadata; connections and clients stay as they are."""
    out: dict[str, Any] = {}
    for k, v in template.items():
        fields: list[str] = []
        if dataclasses.is_dataclass(v) and not isinstance(v, type):
            fields = [f.name for f in dataclasses.fields(v)]
        elif hasattr(v, "model_fields"):
            fields = list(type(v).model_fields)
        update = {f: metadata[f] for f in fields if f in metadata and isinstance(metadata[f], (str, int, float, bool))}
        out[k] = _patched(v, update) if update else v
    return out


def _patched(value: Any, fields: dict[str, Any]) -> Any:
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return dataclasses.replace(value, **fields)
    if hasattr(value, "model_copy"):
        return value.model_copy(update=fields)
    if isinstance(value, dict):
        return {**value, **fields}
    for k, v in fields.items():  # plain object: copy, then set
        import copy

        value = copy.copy(value)
        setattr(value, k, v)
    return value


def safe_configurable(configurable: dict[str, Any], overrides: dict[str, dict[str, Any]],
                      live: bool = False) -> dict[str, Any]:
    """The recorded run's config made safe to replay: per-run ids dropped, stores and
    checkpointers swapped for in-memory ones, ``overrides`` applied.

    ``live`` (full-access experiments): the real context and stores are kept so tools act on
    live systems; only the conversation checkpointer is dropped (replays never add turns
    to real threads)."""
    from langgraph.checkpoint.base import BaseCheckpointSaver
    from langgraph.store.base import BaseStore
    from langgraph.store.memory import InMemoryStore

    out: dict[str, Any] = {}
    for k, v in configurable.items():
        if k in _PER_RUN_KEYS or k.startswith("__"):
            continue
        if isinstance(v, BaseCheckpointSaver):
            continue
        if live:
            out[k] = v
            continue
        if isinstance(v, BaseStore):
            v = InMemoryStore()
        if k in overrides:
            v = _patched(v, overrides[k])
        out[k] = v
    return out


async def _replay_graph(graph: Any, job: Any, configurable: dict[str, Any]) -> str:
    """Run the agent on the recorded conversation — dispatched on the framework that built it."""
    from .blueprint import framework_of

    fw = framework_of(graph)
    if fw == "openai-agents":
        from .integrations.openai_agents import run

        return await run(graph, _needs_user(conversation(job.messages)))
    if fw == "crewai":
        from .integrations.crewai import run as run_crew

        return await run_crew(graph, job)
    if fw == "llamaindex":
        from .integrations.llamaindex import run as run_li

        return await run_li(graph, _needs_user(conversation(job.messages)))
    return await _replay_langgraph(graph, job, configurable)


def _needs_user(msgs: list[dict[str, str]]) -> list[dict[str, str]]:
    if not msgs or msgs[-1]["role"] != "user":
        raise ValueError("the recorded run has no user message to replay")
    return msgs


async def _replay_langgraph(graph: Any, job: Any, configurable: dict[str, Any]) -> str:
    from langgraph.checkpoint.memory import InMemorySaver
    from langgraph.store.memory import InMemoryStore

    g = graph.copy(update={"checkpointer": InMemorySaver(), "store": InMemoryStore()})
    msgs = conversation(job.messages)
    if not msgs or msgs[-1]["role"] != "user":
        raise ValueError("the recorded run has no user message to replay")
    result = await g.ainvoke({"messages": msgs}, config={
        "configurable": {**configurable, "thread_id": job.thread_id}, "recursion_limit": 1000})
    for m in reversed(result.get("messages", []) if isinstance(result, dict) else []):
        if getattr(m, "type", "") == "ai" and _text(m.content).strip():
            return _text(m.content)
    return ""
