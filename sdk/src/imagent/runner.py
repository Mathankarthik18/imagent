"""Experiment runner: lets the imagent server replay your app's agents.

In the app (inside its event loop, e.g. FastAPI lifespan):

    imagent.register_agent("email_orchestrator", replay_email, source_root="bosun_orchestrator")
    asyncio.create_task(imagent.runner.run_forever())

The runner polls the server for jobs (outbound HTTP only), runs the registered
function with tool calls replayed from the recorded source run, and reports the
resulting trace. Agent functions receive a ``ReplayJob`` and return the final output.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import os
import socket
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from . import replay
from . import semconv as sc
from ._context import context
from .runtime import apply_context, get_config, get_tracer, record_error, set_content

logger = logging.getLogger("imagent")

DEFAULT_PASSTHROUGH = ("task",)  # sub-agent delegation: run it so sub-agents use the new model too


@dataclass
class ReplayJob:
    job_id: str
    experiment_id: str
    agent: str
    variant: dict[str, Any]
    model: str                  # variant model ("" = the app's current default)
    thread_id: str              # use this as the agent's thread/conversation id
    tool_mode: str
    source: dict[str, Any]      # trace_id, name, input (raw JSON), metadata (raw JSON), thread_id, user_id, project
    raw: dict[str, Any] = field(repr=False, default_factory=dict)

    @property
    def input(self) -> Any:
        try:
            return json.loads(self.source.get("input") or "null")
        except ValueError:
            return self.source.get("input")

    @property
    def metadata(self) -> dict[str, Any]:
        try:
            v = json.loads(self.source.get("metadata") or "{}")
            return v if isinstance(v, dict) else {}
        except ValueError:
            return {}

    @property
    def messages(self) -> list[dict[str, Any]]:
        """Conversation to replay: the source run's first model call minus system prompts
        (covers chat follow-ups whose history lived in a checkpointer), else the input's messages."""
        history = self.raw.get("history") or []
        if history:
            return [m for m in history if isinstance(m, dict) and m.get("role") != "system"]
        v = self.input
        if isinstance(v, dict) and isinstance(v.get("messages"), list):
            return v["messages"]
        return []


@dataclass
class _Agent:
    name: str
    fn: Callable[[ReplayJob], Awaitable[Any] | Any]
    source_root: str
    description: str
    read_tools: set[str]
    passthrough: set[str]
    models: list[str]


_agents: dict[str, _Agent] = {}


def register_agent(name: str, fn: Callable[[ReplayJob], Awaitable[Any] | Any], *, source_root: str,
                   description: str = "", read_tools: tuple[str, ...] | list[str] = (),
                   passthrough_tools: tuple[str, ...] | list[str] = DEFAULT_PASSTHROUGH,
                   models: list[str] | None = None) -> None:
    """Make an agent replayable. ``source_root`` is the root span name of runs it can
    replay; ``read_tools`` may run live in ``live_reads`` mode (everything else is stubbed);
    ``models`` are suggestions shown in the UI."""
    replay.install()
    _agents[name] = _Agent(name, fn, source_root, description, set(read_tools), set(passthrough_tools), models or [])


def _post(path: str, body: dict[str, Any]) -> tuple[int, Any]:
    import requests  # dependency of the OTLP/HTTP exporter

    cfg = get_config()
    endpoint = (cfg.endpoint if cfg else os.getenv("IMAGENT_ENDPOINT", "http://localhost:8300")).rstrip("/")
    headers = {"x-imagent-key": cfg.api_key} if cfg and cfg.api_key else {}
    r = requests.post(f"{endpoint}{path}", json=body, headers=headers, timeout=30)
    if r.status_code == 204:
        return 204, None
    r.raise_for_status()
    return r.status_code, r.json()


async def _run_job(job_raw: dict[str, Any]) -> None:
    agent = _agents.get(job_raw["agent"])
    job = ReplayJob(job_id=job_raw["job_id"], experiment_id=job_raw["experiment_id"], agent=job_raw["agent"],
                    variant=job_raw.get("variant") or {}, model=str((job_raw.get("variant") or {}).get("model") or ""),
                    thread_id=job_raw["thread_id"], tool_mode=job_raw.get("tool_mode", "recorded"),
                    source=job_raw.get("source") or {}, raw=job_raw)
    tracer = get_tracer()
    status, error, output, trace_id = "ok", "", None, ""
    state = replay.ReplayState.from_job(job_raw, passthrough=agent.passthrough if agent else set(),
                                        read_tools=agent.read_tools if agent else set())
    attrs = {sc.SPAN_KIND: "agent", sc.ROOT: True, "imagent.experiment.id": job.experiment_id,
             "imagent.experiment.job_id": job.job_id, "imagent.experiment.variant": job.variant.get("name", ""),
             "imagent.experiment.source_trace_id": job.source.get("trace_id", "")}
    if job.model:
        attrs[sc.GEN_AI_REQUEST_MODEL] = job.model
    with context(thread_id=job.thread_id, tags=["experiment", f"variant:{job.variant.get('name', '')}"],
                 metadata={"experiment_id": job.experiment_id, "source_trace_id": job.source.get("trace_id", "")}):
        span_cm = tracer.start_as_current_span(f"replay:{job.agent}", attributes=attrs) if tracer else None
        span = span_cm.__enter__() if span_cm else None
        try:
            if agent is None:
                raise RuntimeError(f"agent '{job.agent}' is not registered in this runner")
            if span is not None:
                apply_context(span)  # thread/tags/metadata → lands in the "<project>/experiments" project
                set_content(span, sc.INPUT, {"source_trace_id": job.source.get("trace_id"), "variant": job.variant,
                                              "tool_mode": job.tool_mode})
            with replay.activate(state):
                result = agent.fn(job)
                output = await result if inspect.isawaitable(result) else result
            if span is not None:
                set_content(span, sc.OUTPUT, output)
                span.set_attribute("imagent.replay.not_recorded", sum(e["mode"] == "not_recorded" for e in state.events))
                span.set_attribute("imagent.replay.stubbed", sum(e["mode"] == "stubbed" for e in state.events))
        except Exception as exc:  # report, never crash the host app
            status, error = "error", f"{type(exc).__name__}: {exc}"
            logger.exception("imagent replay job %s failed", job.job_id)
            if span is not None:
                record_error(span, exc)
        finally:
            if span is not None:
                trace_id = format(span.get_span_context().trace_id, "032x")
                span_cm.__exit__(None, None, None)
    from .runtime import flush

    await asyncio.to_thread(flush, 10_000)
    try:
        text = output if isinstance(output, str) else json.dumps(output, default=str, ensure_ascii=False)
    except (TypeError, ValueError):
        text = str(output)
    await asyncio.to_thread(_post, "/api/runner/complete", {
        "job_id": job.job_id, "trace_id": trace_id, "status": status, "error": error, "output": (text or "")[:20000]})


async def run_forever(poll_interval: float = 2.0) -> None:
    """Poll for experiment jobs and run them one at a time. Cancel the task to stop."""
    runner_id = f"{socket.gethostname()}-{os.getpid()}-{uuid.uuid4().hex[:6]}"
    logger.info("imagent experiment runner started (%d agent(s))", len(_agents))
    backoff = poll_interval
    while True:
        agents = [{"name": a.name, "source_root": a.source_root, "description": a.description,
                   "read_tools": sorted(a.read_tools), "models": a.models} for a in _agents.values()]
        try:
            code, job = await asyncio.to_thread(_post, "/api/runner/claim",
                                                {"runner_id": runner_id, "host": socket.gethostname(), "agents": agents})
            backoff = poll_interval
            if code == 200 and job:
                await _run_job(job)
                continue  # immediately look for the next job
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.debug("imagent runner poll failed: %s", exc)
            backoff = min(backoff * 2, 60.0)
        await asyncio.sleep(backoff)
