"""Imagent server: OTLP/HTTP ingest, read API, and the built UI."""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import hmac
import logging
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceResponse

from . import blueprints, compare, db, experiments, judge, live, price_sync, projects, queries, stitch
from . import pricing
from .config import settings
from .ingest import decode_request, split_rows

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("imagent_server")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.ensure_schema()
    tasks = []
    if settings.stitch_enabled:
        tasks.append(asyncio.create_task(stitch.run_forever()))
    if settings.price_sync:
        tasks.append(asyncio.create_task(price_sync.run_forever()))
    else:
        await db.query("SELECT 1")
    tasks.append(asyncio.create_task(judge.worker()))  # judges projects that have a key (theirs or the server's)
    yield
    for t in tasks:
        t.cancel()
    await db.close()


app = FastAPI(title="Imagent", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_methods=["*"], allow_headers=["*"])


def _presented_key(request: Request) -> str:
    key = request.headers.get("x-imagent-key", "") or request.headers.get("x-harness-key", "")
    auth = request.headers.get("authorization", "")
    if not key and auth.lower().startswith("bearer "):
        key = auth[7:]
    return key


def _require(expected: str):
    def check(request: Request) -> None:
        if expected and not hmac.compare_digest(_presented_key(request), expected):
            raise HTTPException(status_code=401, detail="invalid or missing imagent key")
    return check


require_ingest = _require(settings.ingest_key)
require_read = _require(settings.read_key)


async def ingest_project(request: Request) -> str | None:
    """Which project an SDK call writes to. A project key (imk_…) pins it; the server-wide
    ingest key — or no key on an open server — falls back to the app's service name."""
    key = _presented_key(request)
    if key.startswith(projects.KEY_PREFIX):
        pid = await projects.project_for_key(key)
        if pid is None:
            raise HTTPException(status_code=401, detail="unknown or rotated project key")
        return pid
    if settings.ingest_key and not hmac.compare_digest(key, settings.ingest_key):
        raise HTTPException(status_code=401, detail="invalid or missing imagent key")
    return None


IngestProject = Annotated[str | None, Depends(ingest_project)]


# ── ingest ───────────────────────────────────────────────────────────────────
@app.post("/v1/traces")
async def ingest_traces(request: Request, project: IngestProject) -> Response:
    body = await request.body()
    content_type = request.headers.get("content-type", "application/x-protobuf")
    try:
        req = decode_request(body, content_type, request.headers.get("content-encoding", ""))
        rows, running = split_rows(req, project)
    except Exception as exc:
        logger.warning("rejected OTLP payload: %s", exc)
        raise HTTPException(status_code=400, detail=f"invalid OTLP payload: {exc}") from exc
    await db.insert_spans(rows)
    await db.insert_running(running)
    if "json" in content_type:
        return Response(content="{}", media_type="application/json")
    return Response(content=ExportTraceServiceResponse().SerializeToString(), media_type="application/x-protobuf")


# ── read API ─────────────────────────────────────────────────────────────────
def _parse_time(value: str | None, default: dt.datetime) -> dt.datetime:
    if not value:
        return default
    try:
        t = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"bad timestamp: {value}") from exc
    return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)


def filters(
    start: str | None = None,
    end: str | None = None,
    project: str | None = None,
    environment: str | None = None,
    q: str | None = None,
    status: str | None = None,
    model: str | None = None,
    agent: str | None = None,
    thread_id: str | None = None,
    user_id: str | None = None,
    tag: str | None = None,
    name: str | None = None,
    origin: str | None = None,
) -> queries.Filters:
    now = dt.datetime.now(dt.timezone.utc)
    end_t = _parse_time(end, now)
    start_t = _parse_time(start, end_t - dt.timedelta(hours=24))
    if start_t >= end_t:
        raise HTTPException(status_code=422, detail="start must be before end")
    return queries.Filters(start=start_t, end=end_t, project=project or None, environment=environment or None,
                           q=q or None, status=status or None, model=model or None, agent=agent or None,
                           thread_id=thread_id or None, user_id=user_id or None, tag=tag or None,
                           name=name or None, origin=origin or None)


F = Annotated[queries.Filters, Depends(filters)]
read = [Depends(require_read)]


@app.get("/api/health")
async def health() -> dict:
    await db.query("SELECT 1")
    return {"ok": True}


@app.get("/api/projects", dependencies=read)
async def api_projects() -> dict:
    """Projects (with 24h activity) and project names in the data that no project owns yet."""
    return await projects.list_projects()


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field("", max_length=1000)
    adopt: str | None = Field(None, max_length=200, description="Existing data name to take over as this project's id")


class ProjectPatch(BaseModel):
    name: str | None = Field(None, max_length=120)
    description: str | None = Field(None, max_length=1000)
    archived: bool | None = None
    rubric: str | None = Field(None, max_length=4000)
    judge_key: str | None = Field(None, max_length=400)
    judge_model: str | None = Field(None, max_length=200)
    judge_base_url: str | None = Field(None, max_length=400)


@app.post("/api/projects", dependencies=read)
async def api_create_project(body: ProjectIn) -> dict:
    """New project; the response carries its API key — the only time it is shown."""
    try:
        return await projects.create(body.name, body.description, project_id=body.adopt)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/api/projects/{project_id}", dependencies=read)
async def api_project(project_id: str) -> dict:
    p = await projects.get(project_id)
    if not p:
        raise HTTPException(status_code=404, detail="project not found")
    return projects.public(p)


@app.patch("/api/projects/{project_id}", dependencies=read)
async def api_update_project(project_id: str, body: ProjectPatch) -> dict:
    p = await projects.update(project_id, name=body.name, description=body.description, archived=body.archived,
                              rubric=body.rubric, judge_key=body.judge_key, judge_model=body.judge_model,
                              judge_base_url=body.judge_base_url)
    if not p:
        raise HTTPException(status_code=404, detail="project not found")
    return p


@app.post("/api/projects/{project_id}/rotate-key", dependencies=read)
async def api_rotate_project_key(project_id: str) -> dict:
    p = await projects.rotate_key(project_id)
    if not p:
        raise HTTPException(status_code=404, detail="project not found")
    return p


@app.get("/api/running", dependencies=read)
async def api_running(project: str | None = None) -> dict:
    """Runs in progress right now, with their current step and progress so far."""
    return await live.running_runs(project or None)


@app.get("/api/latest", dependencies=read)
async def api_latest(project: str | None = None) -> dict:
    """When the newest span arrived — lets the UI tell "no data in this window" from "server down"."""
    return await queries.latest(project or None)


@app.get("/api/facets", dependencies=read)
async def api_facets(f: F) -> dict:
    return await queries.facets(f)


@app.get("/api/traces", dependencies=read)
async def api_traces(f: F, limit: int = Query(50, ge=1, le=500), offset: int = Query(0, ge=0),
                     order: str = Query("desc", pattern="^(asc|desc)$")) -> dict:
    return await queries.list_traces(f, limit, offset, order)


@app.get("/api/traces/by-thread", dependencies=read)
async def api_traces_by_thread(f: F, sort: str = "recent", limit: int = Query(50, ge=1, le=500),
                               offset: int = Query(0, ge=0)) -> dict:
    return await queries.thread_groups(f, sort=sort, include_unthreaded=True, limit=limit, offset=offset)


@app.get("/api/traces/{trace_id}", dependencies=read)
async def api_trace(trace_id: str) -> dict:
    trace_id = trace_id.lower()
    spans = await queries.get_trace(trace_id)
    running = [live.as_span(r) for r in await live.open_spans(trace_ids=[trace_id])]
    if not spans and not running:
        raise HTTPException(status_code=404, detail="trace not found")
    return {"trace_id": trace_id, "spans": spans + running, "running": len(running) > 0}


@app.get("/api/threads", dependencies=read)
async def api_threads(f: F, sort: str = "recent", limit: int = Query(50, ge=1, le=500),
                      offset: int = Query(0, ge=0)) -> dict:
    return await queries.thread_groups(f, sort=sort, limit=limit, offset=offset)


@app.get("/api/threads/{thread_id}", dependencies=read)
async def api_thread(thread_id: str, f: F, limit: int = Query(200, ge=1, le=1000)) -> dict:
    f.thread_id = thread_id
    f.start = min(f.start, f.end - dt.timedelta(days=settings.retention_days))  # whole retained history
    return await queries.list_traces(f, limit, 0, "asc", preview_chars=20_000)


@app.get("/api/threads/{thread_id}/spans", dependencies=read)
async def api_thread_spans(thread_id: str, f: F) -> dict:
    f.start = min(f.start, f.end - dt.timedelta(days=settings.retention_days))
    result = await queries.thread_spans(thread_id, f)
    trace_ids = list({s["trace_id"] for s in result["spans"]})
    running = {r["span_id"]: r for r in await live.open_spans(project=f.project, thread_id=thread_id)}
    running.update({r["span_id"]: r for r in await live.open_spans(project=f.project, trace_ids=trace_ids)})
    result["spans"] += [live.as_span(r) for r in running.values()]
    result["running"] = bool(running)
    return result


@app.get("/api/threads/{thread_id}/summary", dependencies=read)
async def api_thread_summary(thread_id: str, f: F) -> dict:
    f.start = min(f.start, f.end - dt.timedelta(days=settings.retention_days))
    result = await queries.thread_summary(thread_id, f)
    if result["summary"] is None:
        raise HTTPException(status_code=404, detail="thread not found")
    return result


@app.post("/api/stitch", dependencies=read)
async def api_stitch(days: int = Query(2, ge=1, le=90)) -> dict:
    """Merge broken-off runs now (also runs every 30 s in the background)."""
    return {"merged": await stitch.stitch_once(dt.timedelta(days=days))}


@app.post("/api/prices/sync", dependencies=read)
async def api_price_sync() -> dict:
    """Refresh the model price catalog now and re-price unpriced spans."""
    n = await price_sync.refresh()
    return {"models": n, "repriced": await price_sync.reprice(settings.retention_days)}


@app.get("/api/prices", dependencies=read)
async def api_prices() -> dict:
    return {"catalog_models": pricing.catalog_size(), "source": settings.price_source}


# ── compare & experiments ────────────────────────────────────────────────────
@app.get("/api/compare", dependencies=read)
async def api_compare(a: str, b: str) -> dict:
    """Side-by-side diff of two runs (A = baseline, B = candidate)."""
    a_spans, b_spans = await queries.get_trace(a.lower()), await queries.get_trace(b.lower())
    if not a_spans or not b_spans:
        raise HTTPException(status_code=404, detail="trace not found")
    return {"a": a.lower(), "b": b.lower(), **compare.compare(a_spans, b_spans)}


class ExperimentIn(BaseModel):
    name: str = ""
    agent: str
    project: str = ""
    source_trace_ids: list[str] = Field(min_length=1, max_length=200)
    variants: list[dict] = Field(min_length=1, max_length=10)
    repeats: int = Field(1, ge=1, le=10)
    tool_mode: str = Field("recorded", pattern="^(recorded|live_reads|live)$")  # live: every tool runs for real


@app.get("/api/experiments", dependencies=read)
async def api_experiments(project: str | None = None) -> list[dict]:
    return await experiments.list_experiments(project=project or None)


@app.post("/api/experiments", dependencies=read)
async def api_create_experiment(body: ExperimentIn) -> dict:
    for v in body.variants:
        if not str(v.get("name", "")).strip():
            raise HTTPException(status_code=422, detail="every variant needs a name")
    if not body.project:
        raise HTTPException(status_code=422, detail="experiments belong to a project")
    # No runner connected yet is fine: jobs wait in the queue until the app connects.
    name = body.name or f"{body.agent}: " + " vs ".join(v["name"] for v in body.variants)
    return await experiments.create(name=name, agent=body.agent, project=body.project,
                                    source_trace_ids=[t.lower() for t in body.source_trace_ids],
                                    variants=body.variants, repeats=body.repeats, tool_mode=body.tool_mode)


@app.get("/api/experiments/sources", dependencies=read)
async def api_experiment_sources(root_name: str, project: str | None = None, limit: int = Query(20, ge=1, le=100)) -> list[dict]:
    return await experiments.recent_sources(project or None, root_name, limit)


@app.get("/api/experiments/{exp_id}", dependencies=read)
async def api_experiment(exp_id: str) -> dict:
    d = await experiments.detail(exp_id)
    if d is None:
        raise HTTPException(status_code=404, detail="experiment not found")
    return d


@app.post("/api/experiments/{exp_id}/cancel", dependencies=read)
async def api_cancel_experiment(exp_id: str) -> dict:
    return {"cancelled": await experiments.cancel(exp_id)}


@app.get("/api/judge", dependencies=read)
async def api_judge(project: str | None = None) -> dict:
    """Whether the AI judge is set up for a project (its own key, or the server's), and with which model."""
    return judge.status(await projects.get(project) if project else None)


class JudgeTestIn(BaseModel):
    key: str = Field("", max_length=400)       # empty: test the saved key
    model: str = Field("", max_length=200)
    base_url: str = Field("", max_length=400)


@app.post("/api/projects/{project_id}/judge/test", dependencies=read)
async def api_test_judge(project_id: str, body: JudgeTestIn) -> dict:
    """Try a key/model before (or after) saving it."""
    p = await projects.get(project_id)
    if not p:
        raise HTTPException(status_code=404, detail="project not found")
    cfg = judge.config_for({**p, **({"judge_key": body.key} if body.key else {}),
                            **({"judge_model": body.model} if body.model else {}),
                            **({"judge_base_url": body.base_url} if body.base_url else {})})
    if cfg is None:
        return {"ok": False, "error": "No API key — enter one first."}
    return await judge.test(cfg)


class ReviewIn(BaseModel):
    better: str | None = Field(None, pattern="^(new|original|tie)$")  # None clears the review
    note: str = Field("", max_length=1000)


@app.post("/api/experiments/{exp_id}/rejudge", dependencies=read)
async def api_rejudge(exp_id: str) -> dict:
    """Judge an experiment's answers again (e.g. after changing the judge model or rules)."""
    return {"queued": await experiments.rejudge(exp_id)}


@app.post("/api/experiments/jobs/{job_id}/review", dependencies=read)
async def api_review_job(job_id: str, body: ReviewIn) -> dict:
    """A person's verdict on one replay — overrides the AI judge."""
    if not await experiments.save_review(job_id, body.better, body.note):
        raise HTTPException(status_code=404, detail="replay not found")
    return {"ok": True}


@app.get("/api/runners", dependencies=read)
async def api_runners(project: str | None = None) -> list[dict]:
    return experiments.runners(project or None)


class ClaimIn(BaseModel):
    runner_id: str
    host: str = ""
    agents: list[dict] = []
    project: str = ""  # the app's service name; a project key overrides it
    ready: bool = True  # False: the app hasn't run an agent yet, so it can't replay one
    live_agents: list[str] | None = None  # agents that can take live-tool jobs now (None: older SDK, no limit)


class CompleteIn(BaseModel):
    job_id: str
    trace_id: str = ""
    status: str = "ok"
    error: str = ""
    output: str = ""


class BlueprintIn(BaseModel):
    project: str = Field("", max_length=200)  # the app's service name; a project key overrides it
    name: str = Field(min_length=1, max_length=200)
    hash: str = Field(max_length=64)
    blueprint: dict


@app.post("/api/blueprints")
async def api_publish_blueprint(body: BlueprintIn, project: IngestProject) -> dict:
    """Called by the SDK at app startup (imagent.publish_blueprint)."""
    pid = project or body.project
    if not pid:
        raise HTTPException(status_code=422, detail="no project: send with a project key")
    return await blueprints.upsert(pid, body.name, body.blueprint, body.hash)


@app.get("/api/blueprints", dependencies=read)
async def api_blueprints(project: str | None = None) -> list[dict]:
    return await blueprints.list_blueprints(project or None)


@app.get("/api/blueprints/{project:path}/{name}", dependencies=read)
async def api_blueprint(project: str, name: str, days: int = Query(7, ge=1, le=90)) -> dict:
    bp = await blueprints.get(project, name, days)
    if bp is None:
        raise HTTPException(404, "blueprint not found")
    return bp


@app.post("/api/runner/claim")
async def api_runner_claim(body: ClaimIn, project: IngestProject) -> Response:
    """Runners (imagent SDK inside the app) poll here; 204 = nothing to do."""
    job = await experiments.claim(body.runner_id, body.agents, body.host, project or body.project, ready=body.ready,
                                  live_agents=body.live_agents)
    if job is None:
        return Response(status_code=204)
    return Response(content=json.dumps(job, default=str), media_type="application/json")


@app.post("/api/runner/complete")
async def api_runner_complete(body: CompleteIn, project: IngestProject) -> dict:
    await experiments.complete(body.job_id, trace_id=body.trace_id, status=body.status, error=body.error, output=body.output)
    return {"ok": True}


@app.get("/api/stats", dependencies=read)
async def api_stats(f: F) -> dict:
    return await queries.stats(f)


# ── UI (built SPA) ───────────────────────────────────────────────────────────
if (settings.ui_dir / "index.html").exists():
    class _ImmutableAssets(StaticFiles):
        async def get_response(self, path, scope):  # content-hashed file names → safe to cache forever
            resp = await super().get_response(path, scope)
            resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
            return resp

    app.mount("/assets", _ImmutableAssets(directory=settings.ui_dir / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str) -> FileResponse:
        if path.startswith(("api/", "v1/")):
            raise HTTPException(status_code=404)
        candidate = (settings.ui_dir / path).resolve()
        if path and candidate.is_file() and settings.ui_dir.resolve() in candidate.parents:
            return FileResponse(candidate)
        # The page must always be fresh so a rebuild shows up on a normal reload.
        return FileResponse(settings.ui_dir / "index.html", headers={"Cache-Control": "no-cache, must-revalidate"})
