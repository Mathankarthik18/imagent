"""CrewAI: traces, blueprint and experiments.

* Traces — ``Crew.kickoff`` is the run (agent span), each ``Agent.execute_task`` an agent
  span (named after the agent's role), tools a tool span, and every model call goes through
  CrewAI's ``get_llm_response`` → an llm span (the provider SDK underneath stays quiet).
  CrewAI's own event bus runs on a thread pool, so the call points themselves are wrapped.
* Experiments — tools answer from the recording; each agent's LLM can be swapped (a copy of
  the LLM is called; the crew's objects are untouched).
* Blueprint — the crew, its agents (role, goal, backstory, LLM, tools) and its tasks.
"""

from __future__ import annotations

import asyncio
import functools
import json
import logging
import sys
from contextvars import ContextVar
from typing import Any

from .. import replay
from .. import semconv as sc
from ._spans import LLMCall, current_agent, output, provider_spans_off, step

logger = logging.getLogger("imagent")
_installed = False
_in_tool: ContextVar[bool] = ContextVar("imagent_crewai_in_tool", default=False)


def _role(agent: Any) -> str:
    return str(getattr(agent, "role", None) or getattr(agent, "name", None) or "agent").strip()


def _model(llm: Any) -> str:
    return str(getattr(llm, "model", None) or type(llm).__name__)


def _usage(llm: Any) -> dict[str, int]:
    u = getattr(llm, "_token_usage", None) or {}
    return {k: int(u.get(k, 0) or 0) for k in ("prompt_tokens", "completion_tokens", "cached_prompt_tokens")}


# ── model calls ────────────────────────────────────────────────────────────────
def _llm_call(llm: Any, messages: Any, kwargs: dict[str, Any]) -> tuple[Any, LLMCall, Any, dict[str, int]]:
    agent = kwargs.get("from_agent")
    name = _role(agent) if agent is not None else current_agent.get()
    swapped = replay.swap_model(name, _model(llm), base_url=str(getattr(llm, "base_url", "") or ""))
    provider = str(getattr(llm, "provider", "") or "")
    if swapped and provider and swapped.startswith(provider + "/") and "/" not in _model(llm):
        swapped = swapped[len(provider) + 1:]  # "openai/gpt-4o-mini" → "gpt-4o-mini", as CrewAI stores it
    if swapped and hasattr(llm, "model_copy"):
        llm = llm.model_copy(update={"model": swapped})
    call = LLMCall(_model(llm), model=_model(llm), system=str(getattr(llm, "provider", "") or "crewai"),
                   inputs=messages, tools=kwargs.get("tools"), params={"temperature": getattr(llm, "temperature", None)})
    quiet = provider_spans_off.set(True)
    return llm, call, quiet, _usage(llm)


def _llm_done(llm: Any, call: LLMCall, quiet: Any, before: dict[str, int], answer: Any = None,
              error: BaseException | None = None) -> None:
    provider_spans_off.reset(quiet)
    if error is not None:
        call.fail(error)
        return
    after = _usage(llm)
    call.finish(answer if isinstance(answer, (str, dict, list)) else str(answer),
                input_tokens=(after["prompt_tokens"] - before["prompt_tokens"]) or None,
                output_tokens=(after["completion_tokens"] - before["completion_tokens"]) or None,
                cache_read=(after["cached_prompt_tokens"] - before["cached_prompt_tokens"]) or None,
                response_model=_model(llm))


def _wrap_llm_response(orig: Any) -> Any:
    @functools.wraps(orig)
    def get_llm_response(llm, messages, *args, **kwargs):
        llm, call, quiet, before = _llm_call(llm, messages, kwargs)
        try:
            answer = orig(llm, messages, *args, **kwargs)
        except BaseException as exc:
            _llm_done(llm, call, quiet, before, error=exc)
            raise
        _llm_done(llm, call, quiet, before, answer)
        return answer
    return get_llm_response


def _wrap_allm_response(orig: Any) -> Any:
    @functools.wraps(orig)
    async def aget_llm_response(llm, messages, *args, **kwargs):
        llm, call, quiet, before = _llm_call(llm, messages, kwargs)
        try:
            answer = await orig(llm, messages, *args, **kwargs)
        except BaseException as exc:
            _llm_done(llm, call, quiet, before, error=exc)
            raise
        _llm_done(llm, call, quiet, before, answer)
        return answer
    return aget_llm_response


# ── tools ──────────────────────────────────────────────────────────────────────
def _tool_args(args: tuple, kwargs: dict) -> Any:
    raw = kwargs.get("input", args[0] if args else kwargs)
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except ValueError:
            return raw
    return raw


def _wrap_tool(orig: Any, is_async: bool) -> Any:
    def begin(self, args, kwargs):
        name = str(getattr(self, "name", "tool"))
        a = _tool_args(args, kwargs)
        return name, a

    if is_async:
        @functools.wraps(orig)
        async def ainvoke(self, *args, **kwargs):
            if _in_tool.get():
                return await orig(self, *args, **kwargs)
            name, a = begin(self, args, kwargs)
            token = _in_tool.set(True)
            try:
                with step(name, "tool", inputs=a) as span:
                    hit, result, mode = replay.intercept_tool(name, a)
                    if hit:
                        if span is not None:
                            span.set_attribute(sc.TAGS, [f"replay:mode:{mode}"])
                        output(span, result)
                        return result
                    res = await orig(self, *args, **kwargs)
                    output(span, res)
                    return res
            finally:
                _in_tool.reset(token)
        return ainvoke

    @functools.wraps(orig)
    def invoke(self, *args, **kwargs):
        if _in_tool.get():
            return orig(self, *args, **kwargs)
        name, a = begin(self, args, kwargs)
        token = _in_tool.set(True)
        try:
            with step(name, "tool", inputs=a) as span:
                hit, result, mode = replay.intercept_tool(name, a)
                if hit:
                    if span is not None:
                        span.set_attribute(sc.TAGS, [f"replay:mode:{mode}"])
                    output(span, result)
                    return result
                res = orig(self, *args, **kwargs)
                output(span, res)
                return res
        finally:
            _in_tool.reset(token)
    return invoke


# ── agents, tasks, the crew ────────────────────────────────────────────────────
def _wrap_execute_task(orig: Any) -> Any:
    @functools.wraps(orig)
    def execute_task(self, task, *args, **kwargs):
        role = _role(self)
        with step(role, "agent", agent=role, inputs={"task": getattr(task, "description", ""),
                                                      "expected_output": getattr(task, "expected_output", "")}) as span:
            res = orig(self, task, *args, **kwargs)
            output(span, res)
            return res
    return execute_task


def _crew_name(crew: Any) -> str:
    return str(getattr(crew, "name", None) or "crew")


def _wrap_kickoff(orig: Any) -> Any:
    @functools.wraps(orig)
    def kickoff(self, *args, **kwargs):
        from .. import blueprint, experiments

        name = _crew_name(self)
        if not blueprint._nested():  # noqa: SLF001
            blueprint.seen_agent(self, name)
            if experiments._started:  # noqa: SLF001
                experiments.capture(self, name)
        inputs = kwargs.get("inputs", args[0] if args else None)
        with step(name, "agent", agent=name, inputs={"inputs": inputs or {}}) as span:
            res = orig(self, *args, **kwargs)
            output(span, str(getattr(res, "raw", res)))
            return res
    return kickoff


# ── blueprint ──────────────────────────────────────────────────────────────────
def _tools(tools: Any) -> list[dict[str, Any]]:
    from ..blueprint import MAX_DESC_CHARS, _trim

    out = []
    for t in tools or []:
        schema = getattr(t, "args_schema", None)
        out.append({"name": str(getattr(t, "name", t)), "description": _trim(getattr(t, "description", ""), MAX_DESC_CHARS),
                    "args": list(getattr(schema, "model_fields", {}) or {}) if schema is not None else [], "builtin": False})
    return out


def describe_crew(crew: Any, name: str | None = None) -> dict[str, Any]:
    from ..blueprint import MAX_PROMPT_CHARS, _trim

    agents = []
    for a in getattr(crew, "agents", None) or []:
        llm = getattr(a, "llm", None)
        agents.append({
            "name": _role(a), "description": str(getattr(a, "goal", "") or ""),
            "model": {"name": _model(llm), "class": type(llm).__name__, "provider": "crewai", "params": {}} if llm else None,
            "system_prompt": _trim(f"Role: {_role(a)}\nGoal: {getattr(a, 'goal', '')}\nBackstory: {getattr(a, 'backstory', '')}",
                                   MAX_PROMPT_CHARS),
            "tools": _tools(getattr(a, "tools", None)), "middleware": [], "subagents": [], "graph": {"nodes": [], "edges": []}})
    tasks = list(getattr(crew, "tasks", None) or [])
    nodes = [{"id": f"task {i + 1}: {str(getattr(t, 'name', None) or getattr(t, 'description', ''))[:60]}", "type": "node"}
             for i, t in enumerate(tasks)]
    edges = [{"source": a["id"], "target": b["id"], "conditional": False} for a, b in zip(nodes, nodes[1:])]
    process = str(getattr(getattr(crew, "process", None), "value", getattr(crew, "process", "")) or "")
    return {"name": name or _crew_name(crew), "description": f"CrewAI crew · {process} process · {len(tasks)} tasks",
            "model": None, "system_prompt": "\n\n".join(f"Task {i + 1}: {getattr(t, 'description', '')}" for i, t in enumerate(tasks)),
            "tools": [], "middleware": [], "subagents": agents, "graph": {"nodes": nodes, "edges": edges}}


async def run(crew: Any, job: Any) -> str:
    """Kick the crew off again with the recorded inputs (its LLMs and tools follow the experiment)."""
    rec = job.input if isinstance(job.input, dict) else {}
    inputs = rec.get("inputs") if isinstance(rec.get("inputs"), dict) else {}
    target = crew.copy() if hasattr(crew, "copy") else crew
    res = await asyncio.to_thread(target.kickoff, inputs=inputs)  # to_thread keeps the experiment's context
    return str(getattr(res, "raw", res))


def _patch_everywhere(prefix: str, name: str, orig: Any, new: Any) -> None:
    for mod_name, mod in list(sys.modules.items()):
        if mod_name.startswith(prefix) and getattr(mod, name, None) is orig:
            setattr(mod, name, new)


def install() -> bool:
    global _installed
    if _installed:
        return True
    try:
        from crewai import Agent, Crew
        from crewai.tools import BaseTool
        from crewai.tools.structured_tool import CrewStructuredTool
        from crewai.utilities import agent_utils
    except ImportError:
        return False
    _patch_everywhere("crewai", "get_llm_response", agent_utils.get_llm_response, _wrap_llm_response(agent_utils.get_llm_response))
    _patch_everywhere("crewai", "aget_llm_response", agent_utils.aget_llm_response, _wrap_allm_response(agent_utils.aget_llm_response))
    CrewStructuredTool.invoke = _wrap_tool(CrewStructuredTool.invoke, False)  # type: ignore[method-assign]
    CrewStructuredTool.ainvoke = _wrap_tool(CrewStructuredTool.ainvoke, True)  # type: ignore[method-assign]
    BaseTool.run = _wrap_tool(BaseTool.run, False)  # type: ignore[method-assign]
    try:  # @tool functions become Tool, which overrides run() (native function calling calls tool.run)
        from crewai.tools.base_tool import Tool

        Tool.run = _wrap_tool(Tool.run, False)  # type: ignore[method-assign]
    except ImportError:
        pass
    Agent.execute_task = _wrap_execute_task(Agent.execute_task)  # type: ignore[method-assign]
    Crew.kickoff = _wrap_kickoff(Crew.kickoff)  # type: ignore[method-assign]
    _installed = True
    return True
