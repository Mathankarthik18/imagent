"""Blueprint: the structure of an AI application, read from the agent framework itself.

Automatic: after ``imagent.init()``, the first run of each LangGraph agent publishes its
blueprint (``install_auto``). To publish without running it: ``imagent.publish_blueprint(agent)``.

imagent then shows the app as a canvas: main agent → sub-agents (nested), each with its
model, system prompt, tools, middleware and LangGraph nodes — including parts that have
never run yet — with live stats from traces layered on top.

Nothing here runs the agent; it only reads the compiled graph. Introspection is
best-effort (framework internals are not a public API): anything it can't read is
left out rather than raising.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from typing import Any

logger = logging.getLogger("imagent")

SCHEMA_VERSION = 1
MAX_PROMPT_CHARS = 60_000
MAX_DESC_CHARS = 2_000
MAX_DEPTH = 6
# Tools deepagents adds to every agent (filesystem + planning + delegation).
DEEPAGENTS_BUILTIN_TOOLS = {"ls", "read_file", "write_file", "edit_file", "delete", "glob", "grep", "execute",
                            "write_todos", "task"}


def _cells(fn: Any) -> dict[str, Any]:
    """Closure variables of a function, by name."""
    code, closure = getattr(fn, "__code__", None), getattr(fn, "__closure__", None)
    if code is None or not closure:
        return {}
    out = {}
    for name, cell in zip(code.co_freevars, closure):
        try:
            out[name] = cell.cell_contents
        except ValueError:
            pass
    return out


def _walk_closures(root: Any, max_depth: int = 5):
    """Every object reachable through nested closures (and functools.partial / bound methods)."""
    seen: set[int] = set()
    stack = [(root, 0)]
    while stack:
        obj, depth = stack.pop()
        if id(obj) in seen or depth > max_depth:
            continue
        seen.add(id(obj))
        yield obj
        targets: list[Any] = []
        for attr in ("func", "afunc", "coroutine", "__func__", "__self__"):
            try:
                v = getattr(obj, attr, None)
            except Exception:  # noqa: BLE001
                v = None
            if v is not None and v is not obj:
                targets.append(v)
        targets.extend(_cells(obj).values())
        if isinstance(obj, (list, tuple)) and depth < max_depth:
            targets.extend(obj[:200])
        for t in targets:
            if t is not None and not isinstance(t, (str, bytes, int, float, bool)):
                stack.append((t, depth + 1))


def _trim(s: Any, n: int) -> str:
    s = "" if s is None else str(s)
    return s if len(s) <= n else s[:n] + f"\n… ({len(s) - n:,} more characters)"


def _text(msg: Any) -> str:
    content = getattr(msg, "content", msg)
    if isinstance(content, list):
        return "\n".join(str(b.get("text", "")) if isinstance(b, dict) else str(b) for b in content)
    return "" if content is None else str(content)


def describe_model(model: Any) -> dict[str, Any] | None:
    if model is None:
        return None
    if isinstance(model, str):
        return {"name": model, "class": "", "provider": model.split(":", 1)[0] if ":" in model else ""}
    name = (getattr(model, "model_name", None) or getattr(model, "model", None) or getattr(model, "model_id", None)
            or getattr(model, "deployment_name", None) or "")
    cls = type(model).__name__
    provider = ""
    try:
        provider = model._llm_type  # noqa: SLF001 — LangChain's own provider id
    except Exception:  # noqa: BLE001
        pass
    params = {}
    for k in ("temperature", "max_tokens", "max_completion_tokens", "streaming", "disable_streaming", "timeout", "max_retries"):
        v = getattr(model, k, None)
        if v is not None and isinstance(v, (int, float, str, bool)):
            params[k] = v
    base_url = getattr(model, "openai_api_base", None) or getattr(model, "base_url", None)
    if base_url:
        params["base_url"] = str(base_url)
    return {"name": str(name), "class": cls, "provider": str(provider), "params": params}


def describe_tool(tool: Any) -> dict[str, Any]:
    name = str(getattr(tool, "name", "") or getattr(tool, "__name__", ""))
    args: list[str] = []
    try:
        args = list((getattr(tool, "args", None) or {}).keys())
    except Exception:  # noqa: BLE001
        pass
    return {"name": name, "description": _trim(getattr(tool, "description", ""), MAX_DESC_CHARS), "args": args,
            "builtin": name in DEEPAGENTS_BUILTIN_TOOLS}


def _middleware_name(m: Any) -> str:
    return str(getattr(m, "name", None) or type(m).__name__)


def describe_agent(agent: Any, name: str | None = None, *, description: str = "", _depth: int = 0) -> dict[str, Any]:
    """Describe one compiled agent graph (recursing into sub-agents)."""
    out: dict[str, Any] = {"name": name or getattr(agent, "name", None) or "agent", "description": description,
                           "model": None, "system_prompt": "", "tools": [], "middleware": [], "subagents": [],
                           "graph": {"nodes": [], "edges": []}}
    nodes = getattr(agent, "nodes", {}) or {}

    # LangGraph structure: nodes + edges (middleware hooks show up as "Name.hook" nodes).
    try:
        g = agent.get_graph()
        for nid in g.nodes:
            typ = ("start" if nid == "__start__" else "end" if nid == "__end__" else "model" if nid == "model"
                   else "tools" if nid == "tools" else "middleware" if "." in nid else "node")
            out["graph"]["nodes"].append({"id": nid, "type": typ})
        out["graph"]["edges"] = [{"source": e.source, "target": e.target, "conditional": bool(e.conditional)} for e in g.edges]
    except Exception as exc:  # noqa: BLE001
        logger.debug("blueprint: graph of %s unreadable: %s", out["name"], exc)

    # Model, system prompt and middleware chain live in the model node's closure (langchain create_agent).
    model_node = nodes.get("model")
    bound = getattr(model_node, "bound", None)
    if bound is not None:
        cells: dict[str, Any] = {}
        for attr in ("func", "afunc"):
            cells.update(_cells(getattr(bound, attr, None)))
        out["model"] = describe_model(cells.get("model"))
        sm = cells.get("system_message") or cells.get("system_prompt")
        if sm is not None:
            out["system_prompt"] = _trim(_text(sm), MAX_PROMPT_CHARS)
        try:
            from langchain.agents.middleware import AgentMiddleware  # type: ignore[import-not-found]
        except Exception:  # noqa: BLE001
            AgentMiddleware = None  # type: ignore[assignment]
        mw: dict[str, dict[str, Any]] = {}
        if AgentMiddleware is not None:
            # wrap_model_call / wrap_tool_call middleware never become graph nodes — they sit
            # inside the composed handlers of the model and tool nodes.
            roots = [bound, getattr(nodes.get("tools"), "bound", None)]
            for obj in (o for r in roots if r is not None for o in _walk_closures(r, max_depth=10)):
                if isinstance(obj, AgentMiddleware):
                    mw.setdefault(_middleware_name(obj), {"name": _middleware_name(obj), "class": type(obj).__name__,
                                                          "module": type(obj).__module__, "hooks": []})
        for n in out["graph"]["nodes"]:  # hooks that became graph nodes
            if n["type"] == "middleware":
                mname, hook = n["id"].split(".", 1)
                mw.setdefault(mname, {"name": mname, "class": mname, "module": "", "hooks": []})["hooks"].append(hook)
        out["middleware"] = list(mw.values())

    # Tools; deepagents' `task` tool carries the compiled sub-agent graphs.
    tool_node = getattr(nodes.get("tools"), "bound", None)
    tools_by_name = getattr(tool_node, "tools_by_name", {}) or {}
    out["tools"] = [describe_tool(t) for t in tools_by_name.values()]
    task = tools_by_name.get("task")
    if task is not None and _depth < MAX_DEPTH:
        graphs, specs = {}, {}
        for obj in _walk_closures(task, max_depth=6):
            if isinstance(obj, dict) and obj:
                vals = list(obj.values())
                if all(hasattr(v, "get_graph") for v in vals):
                    graphs.update(obj)
                elif all(isinstance(v, dict) and "description" in v for v in vals):
                    specs.update(obj)
                elif {"name", "description"} <= set(obj) and isinstance(obj.get("name"), str):
                    specs[obj["name"]] = obj
        for sub_name, sub_graph in graphs.items():
            spec = specs.get(sub_name) or {}
            sub = describe_agent(sub_graph, sub_name, description=_trim(spec.get("description", ""), MAX_DESC_CHARS),
                                 _depth=_depth + 1)
            if not sub["system_prompt"] and spec.get("system_prompt"):
                sub["system_prompt"] = _trim(spec["system_prompt"], MAX_PROMPT_CHARS)
            if sub["model"] is None and spec.get("model") is not None:
                sub["model"] = describe_model(spec["model"])
            out["subagents"].append(sub)
    return out


def _framework(desc: dict[str, Any]) -> str:
    def any_deep(d: dict[str, Any]) -> bool:
        return any(m.get("module", "").startswith("deepagents") for m in d["middleware"]) or any(
            t["name"] == "task" for t in d["tools"]) or any(any_deep(s) for s in d["subagents"])
    return "deepagents" if any_deep(desc) else "langgraph" if desc["graph"]["nodes"] else "unknown"


def _versions() -> dict[str, str]:
    from importlib import metadata

    out = {}
    for pkg in ("deepagents", "langgraph", "langchain", "langchain-core", "openai-agents", "crewai", "llama-index-core",
                "openai", "anthropic"):
        try:
            out[pkg] = metadata.version(pkg)
        except metadata.PackageNotFoundError:
            pass
    return out


def framework_of(agent: Any) -> str:
    """Which framework built this agent object."""
    mod = type(agent).__module__
    for prefix, name in (("agents", "openai-agents"), ("crewai", "crewai"), ("llama_index", "llamaindex"),
                         ("langgraph", "langgraph"), ("deepagents", "deepagents"), ("langchain", "langchain")):
        if mod == prefix or mod.startswith(prefix + "."):
            return name
    return "unknown"


def describe(agent: Any, name: str | None = None) -> dict[str, Any]:
    """The full blueprint of an agent application (JSON-serialisable), whatever framework built it."""
    fw = framework_of(agent)
    if fw == "openai-agents":
        from .integrations.openai_agents import describe_agent as describe_oa

        root = describe_oa(agent)
    elif fw == "crewai":
        from .integrations.crewai import describe_crew

        root = describe_crew(agent, name)
    elif fw == "llamaindex":
        from .integrations.llamaindex import describe_agent as describe_li

        root = describe_li(agent, name)
    else:
        root = describe_agent(agent, name)
        fw = _framework(root)
    if name:
        root["name"] = name
    return {"schema": SCHEMA_VERSION, "framework": fw, "versions": _versions(), "root": root}


def publish(agent: Any, name: str | None = None, *, background: bool = True) -> dict[str, Any] | None:
    """Describe ``agent`` and send it to imagent (no-op if imagent isn't initialised).

    Runs in a background thread by default so app startup never waits on it."""
    from .runtime import get_config

    cfg = get_config()
    if cfg is None:
        logger.debug("blueprint not published — imagent.init() was not called")
        return None

    def send() -> dict[str, Any] | None:
        try:
            bp = describe(agent, name)
            body = json.dumps(bp, default=str, ensure_ascii=False, sort_keys=True)
            import requests  # dependency of the OTLP/HTTP exporter

            headers = {"x-imagent-key": cfg.api_key} if cfg.api_key else {}
            r = requests.post(f"{cfg.endpoint}/api/blueprints", headers=headers, timeout=30, json={
                "project": cfg.service, "name": bp["root"]["name"], "blueprint": bp,
                "hash": hashlib.sha256(body.encode()).hexdigest()[:16]})
            r.raise_for_status()
            logger.info("imagent blueprint published: %s (%d sub-agents)", bp["root"]["name"], len(bp["root"]["subagents"]))
            return bp
        except Exception as exc:  # noqa: BLE001 — never break the host app
            logger.warning("imagent blueprint not published: %s", exc)
            return None

    if background:
        threading.Thread(target=send, name="imagent-blueprint", daemon=True).start()
        return None
    return send()


# ── automatic capture ─────────────────────────────────────────────────────────
import contextvars

_inside_run: contextvars.ContextVar[bool] = contextvars.ContextVar("imagent_inside_graph", default=False)
_sub_names: set[str] = set()       # sub-agents of published apps (never published as apps of their own)
_merged: dict[str, dict[str, Any]] = {}   # app name → its structure, combined over every build in this process
_sent: dict[str, str] = {}         # app name → fingerprint last sent
_last_check: dict[str, float] = {}
_lock = threading.Lock()
_installed = False
_publish = True
REFRESH_SECONDS = 10.0             # re-read an app's structure at most this often


def _nested() -> bool:
    """True inside a running LangChain/LangGraph run — LangGraph hands its config to nested
    runs through this context variable, in whatever thread the node runs."""
    try:
        from langchain_core.runnables.config import var_child_runnable_config
    except ImportError:
        return False
    return var_child_runnable_config.get() is not None


def _names(a: dict[str, Any]) -> list[str]:
    return [a["name"], *(n for s in a.get("subagents") or [] for n in _names(s))]


def _merge(old: dict[str, Any] | None, new: dict[str, Any]) -> dict[str, Any]:
    """Combine two builds of the same app: the newest build wins for prompts, models and
    descriptions; sub-agents, tools and middleware seen in either are kept (an app can build
    different agents per request — the blueprint shows all of them)."""
    if old is None:
        return new

    def union(a: list[dict[str, Any]], b: list[dict[str, Any]], merge: bool = False) -> list[dict[str, Any]]:
        by = {x.get("name"): x for x in a}
        out = []
        for x in b:
            out.append(_merge(by[x["name"]], x) if merge and x.get("name") in by else x)
        seen = {x.get("name") for x in b}
        out.extend(x for x in a if x.get("name") not in seen)
        return out

    return {**new, "tools": union(old.get("tools") or [], new.get("tools") or []),
            "middleware": union(old.get("middleware") or [], new.get("middleware") or []),
            "subagents": union(old.get("subagents") or [], new.get("subagents") or [], merge=True)}


def _fingerprint(a: dict[str, Any]) -> str:
    """The app's shape — agents, models, tools, middleware, graph — without prompt text, which
    can carry per-request details (ids, directives) and would otherwise republish constantly."""
    def shape(x: dict[str, Any]) -> Any:
        return {"name": x["name"], "model": (x.get("model") or {}).get("name"),
                "tools": sorted(t["name"] for t in x.get("tools") or []),
                "middleware": sorted(m["name"] for m in x.get("middleware") or []),
                "nodes": sorted(n["id"] for n in (x.get("graph") or {}).get("nodes") or []),
                "subagents": sorted((shape(s) for s in x.get("subagents") or []), key=lambda y: y["name"])}
    return hashlib.sha256(json.dumps(shape(a), sort_keys=True, default=str).encode()).hexdigest()[:16]


def _refresh(graph: Any, name: str) -> None:
    """Describe the app, fold it into what this process has built, and send it if its shape changed."""
    try:
        bp = describe(graph, name)
    except Exception as exc:  # noqa: BLE001 — never break the host app
        logger.debug("imagent blueprint skipped for %s: %s", name, exc)
        return
    with _lock:
        merged = _merge(_merged.get(name), bp["root"])
        _merged[name] = merged
        _sub_names.update(n for n in _names(merged) if n != name)
        fp = _fingerprint(merged)
        if _sent.get(name) == fp:
            return
        _sent[name] = fp
    _send({**bp, "root": merged})


def publish_built(graph: Any, name: str) -> None:
    """Publish an agent the SDK built itself (at startup) — same as its first run would."""
    with _lock:
        _last_check[name] = time.monotonic()
    _refresh(graph, name)


def _auto(graph: Any) -> None:
    """Each top-level run keeps the app's blueprint current (unless it runs inside another agent)."""
    if _inside_run.get() or _nested():
        return
    name = str(getattr(graph, "name", None) or "agent")
    from . import experiments

    if experiments._started:
        experiments.capture(graph, name)
    seen_agent(graph, name)


def seen_agent(graph: Any, name: str) -> None:
    """A top-level agent was built or is about to run (any framework). The first time, its
    blueprint is sent right away (so its sub-agents are known before they run); after that it's
    re-read in the background at most every REFRESH_SECONDS and re-sent only when it changed —
    an agent, tool or model added or removed shows up without a restart."""
    if not _publish:
        return
    with _lock:
        if name in _sub_names and name not in _merged:
            return  # a sub-agent of an app we already publish
        now = time.monotonic()
        if now - _last_check.get(name, float("-inf")) < REFRESH_SECONDS:
            return
        _last_check[name] = now
        first = name not in _merged
    if first:
        _refresh(graph, name)
    else:
        threading.Thread(target=_refresh, args=(graph, name), name="imagent-blueprint", daemon=True).start()


def _send(bp: dict[str, Any]) -> None:
    from .runtime import get_config

    cfg = get_config()
    if cfg is None:
        return

    def post() -> None:
        try:
            import requests

            body = json.dumps(bp, default=str, ensure_ascii=False, sort_keys=True)
            headers = {"x-imagent-key": cfg.api_key} if cfg.api_key else {}
            requests.post(f"{cfg.endpoint}/api/blueprints", headers=headers, timeout=30, json={
                "project": cfg.service, "name": bp["root"]["name"], "blueprint": bp,
                "hash": hashlib.sha256(body.encode()).hexdigest()[:16]}).raise_for_status()
            logger.info("imagent blueprint published: %s", bp["root"]["name"])
        except Exception as exc:  # noqa: BLE001
            logger.warning("imagent blueprint not published: %s", exc)

    threading.Thread(target=post, name="imagent-blueprint", daemon=True).start()


def _tag(graph: Any, a: tuple, kw: dict) -> tuple[tuple, dict]:
    """Top-level runs of an ``@imagent.agent`` build carry its build id in their metadata."""
    if not getattr(graph, "_imagent_build", None) or _nested():
        return a, kw
    from . import experiments

    if len(a) >= 2:  # (input, config, ...)
        return (a[0], experiments.note_run(graph, a[1]), *a[2:]), kw
    return a, {**kw, "config": experiments.note_run(graph, kw.get("config"))}


def install_auto(publish: bool = True) -> None:
    """Wrap LangGraph's run methods so every agent's first run publishes its blueprint
    (``publish``) and becomes replayable when experiments are on."""
    global _installed, _publish
    _publish = publish
    if _installed:
        return
    try:
        from langgraph.pregel import Pregel
    except ImportError:
        return
    import functools

    def wrap_call(orig):
        @functools.wraps(orig)
        def run(self, *a, **kw):
            _auto(self)
            a, kw = _tag(self, a, kw)
            token = _inside_run.set(True)
            try:
                return orig(self, *a, **kw)
            finally:
                _inside_run.reset(token)
        return run

    def wrap_acall(orig):
        @functools.wraps(orig)
        async def run(self, *a, **kw):
            _auto(self)
            a, kw = _tag(self, a, kw)
            token = _inside_run.set(True)
            try:
                return await orig(self, *a, **kw)
            finally:
                _inside_run.reset(token)
        return run

    def wrap_gen(orig):
        @functools.wraps(orig)
        def run(self, *a, **kw):
            _auto(self)
            a, kw = _tag(self, a, kw)
            return orig(self, *a, **kw)
        return run

    Pregel.invoke = wrap_call(Pregel.invoke)
    Pregel.ainvoke = wrap_acall(Pregel.ainvoke)
    Pregel.stream = wrap_gen(Pregel.stream)
    Pregel.astream = wrap_gen(Pregel.astream)
    _installed = True
