"""Harness server: OTLP/HTTP ingest, read API, and the built UI."""

from __future__ import annotations

import asyncio
import datetime as dt
import hmac
import logging
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceResponse

from . import db, live, price_sync, queries, stitch
from . import pricing
from .config import settings
from .ingest import decode_request, split_rows

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("harness_server")


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
    yield
    for t in tasks:
        t.cancel()
    await db.close()


app = FastAPI(title="Harness", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_methods=["*"], allow_headers=["*"])


def _presented_key(request: Request) -> str:
    key = request.headers.get("x-harness-key", "")
    auth = request.headers.get("authorization", "")
    if not key and auth.lower().startswith("bearer "):
        key = auth[7:]
    return key


def _require(expected: str):
    def check(request: Request) -> None:
        if expected and not hmac.compare_digest(_presented_key(request), expected):
            raise HTTPException(status_code=401, detail="invalid or missing harness key")
    return check


require_ingest = _require(settings.ingest_key)
require_read = _require(settings.read_key)


# ── ingest ───────────────────────────────────────────────────────────────────
@app.post("/v1/traces", dependencies=[Depends(require_ingest)])
async def ingest_traces(request: Request) -> Response:
    body = await request.body()
    content_type = request.headers.get("content-type", "application/x-protobuf")
    try:
        req = decode_request(body, content_type, request.headers.get("content-encoding", ""))
        rows, running = split_rows(req)
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
) -> queries.Filters:
    now = dt.datetime.now(dt.timezone.utc)
    end_t = _parse_time(end, now)
    start_t = _parse_time(start, end_t - dt.timedelta(hours=24))
    if start_t >= end_t:
        raise HTTPException(status_code=422, detail="start must be before end")
    return queries.Filters(start=start_t, end=end_t, project=project or None, environment=environment or None,
                           q=q or None, status=status or None, model=model or None, agent=agent or None,
                           thread_id=thread_id or None, user_id=user_id or None, tag=tag or None,
                           name=name or None)


F = Annotated[queries.Filters, Depends(filters)]
read = [Depends(require_read)]


@app.get("/api/health")
async def health() -> dict:
    await db.query("SELECT 1")
    return {"ok": True}


@app.get("/api/projects", dependencies=read)
async def api_projects() -> list[str]:
    return await queries.projects()


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


@app.get("/api/stats", dependencies=read)
async def api_stats(f: F) -> dict:
    return await queries.stats(f)


# ── UI (built SPA) ───────────────────────────────────────────────────────────
if (settings.ui_dir / "index.html").exists():
    app.mount("/assets", StaticFiles(directory=settings.ui_dir / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str) -> FileResponse:
        if path.startswith(("api/", "v1/")):
            raise HTTPException(status_code=404)
        candidate = (settings.ui_dir / path).resolve()
        if path and candidate.is_file() and settings.ui_dir.resolve() in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(settings.ui_dir / "index.html")
