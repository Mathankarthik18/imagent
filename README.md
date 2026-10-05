# Imagent — self-hosted agent observability

LangSmith-style tracing for LLM agents with no trace limits and no per-seat
pricing, built on OpenTelemetry so nothing is locked in.

```
 your app ── imagent SDK ──OTLP/HTTP──►  imagent server  ──►  ClickHouse
 (LangChain / LangGraph auto-traced,          (FastAPI: /v1/traces ingest,
  @observe for your own code)                  /api/* queries, serves UI)
        │
        └── optional: same spans to SigNoz/Jaeger (IMAGENT_EXTRA_OTLP_ENDPOINTS)
```

| Dir | What |
|---|---|
| `sdk/` | Python library `imagent`: `init()`, `@observe`, `context()`, LangChain/LangGraph callback, redaction |
| `server/` | FastAPI OTLP receiver → ClickHouse, cost computation, read API, hosts the built UI |
| `ui/` | React + Vite + Tailwind: Overview, Traces (by thread / all runs), trace & thread views, live progress |
| `examples/demo_agents.py` | Bosun-shaped LangGraph agents with fake models — realistic traces at zero LLM cost |

## Run it

```bash
docker compose up -d            # ClickHouse + imagent on http://localhost:8300
```

Both services restart automatically (`restart: unless-stopped`) whenever Docker
is running — enable Docker Desktop's "start at login" so Imagent is up after a
reboot. After changing server or UI code: `docker compose up -d --build imagent`.

Local dev (hot reload):

```bash
docker compose up -d clickhouse
cd server && uv venv -p 3.12 .venv && uv pip install -p .venv/bin/python -e '.[dev]'
CLICKHOUSE_USER=imagent CLICKHOUSE_PASSWORD=imagent .venv/bin/uvicorn imagent_server.main:app --port 8300 --reload
cd ui && npm install && npm run dev          # http://localhost:5180 (proxies /api to :8300)
```

Demo data:

```bash
cd sdk && uv venv -p 3.12 .venv && uv pip install -p .venv/bin/python -e '.[dev]'
.venv/bin/python ../examples/demo_agents.py --runs 60
```

Tests: `cd sdk && .venv/bin/pytest` · `cd server && .venv/bin/pytest` (API test needs ClickHouse up) · `cd ui && npm run typecheck`

## Instrument an app

```python
import imagent
imagent.init(service="bosun", endpoint="http://localhost:8300")   # LangChain/LangGraph now traced

with imagent.context(thread_id=gmail_thread_id, user_id=user.id, tags=["email"]):
    await graph.ainvoke(...)
```

Bosun already has an opt-in hook in `app/main.py`; to turn it on:

```bash
cd ~/bosun_project/bosun && uv pip install -p venv/bin/python -e ~/imagent/sdk
# .env
IMAGENT_ENABLED=true
IMAGENT_ENDPOINT=http://localhost:8300
```

LangSmith keeps working in parallel; turn `LANGSMITH_TRACING` off once you're happy.

## What gets captured

Per span: kind (agent / node / llm / tool / retriever), parent links, timings,
model, provider, input / output / cache-read / cache-write tokens, cost
(provider-reported, e.g. OpenRouter `usage.cost`; otherwise from
`server/imagent_server/pricing.py`), time to first token, full prompts /
completions / tool arguments and results (redacted and truncated), errors with
stack traces, thread / user / session / agent / tags / metadata.

Attributes follow the OTel GenAI conventions (`gen_ai.*`), so the server also
accepts spans from OpenLLMetry, OpenInference and vendor SDKs, and SigNoz can
read imagent spans.

## Cost

1. **Provider-reported** — OpenRouter returns the billed cost per call (`cost_source=provider`).
2. **Computed** — otherwise tokens × price (`cost_source=computed`). Prices come from
   `IMAGENT_PRICING_FILE` overrides, then built-in Anthropic list prices, then a catalog
   synced daily from OpenRouter's public model list (~360 models across providers; no key,
   no trace data sent). Bedrock / Vertex / dated model ids are normalised onto it.
3. Calls still unpriced show as `unknown` and are re-priced automatically once a price
   appears. `POST /api/prices/sync` refreshes now; `IMAGENT_PRICE_SYNC=false` disables.

Streaming note: LangChain drops OpenRouter's cost on streamed calls and concatenates
the model name across chunks; the SDK undoes the name, and the catalog prices the call.

## Live progress

The SDK reports any span still open after 1.5 s (`IMAGENT_PENDING_DELAY`) as a
payload-free "started" record; the server keeps these in `running_spans` until the
finished span arrives. The UI shows a "Running now" strip, live rows and growing bars;
a run with no new span for 5 minutes is flagged stalled.

## Merging broken-off runs

Some runtimes (deepagents + `astream_events` in Bosun) report LLM/tool calls with
a parent run the tracer never saw, so each call would land as its own trace.
Two layers fix this:

- **SDK:** a missing or unknown parent is resolved through LangGraph's checkpoint
  namespace (`imagent.lc.relinked`), and recently finished runs stay resolvable.
- **Server stitcher:** every 30 s, any remaining orphan (a root span that carries
  `langgraph_node` metadata) is re-parented under the span that was running at
  that moment, preferring the same node name inside the same agent. Its whole
  trace is rewritten into the parent trace and marked `imagent.stitched=time`.
  Run it on demand with `POST /api/stitch?days=7`; disable with `IMAGENT_STITCH=false`.

## Security

- `IMAGENT_INGEST_KEY`: required on `/v1/traces` when set (SDK: `IMAGENT_API_KEY`).
- `IMAGENT_READ_KEY`: required on `/api/*` when set (UI asks once, keeps it in localStorage).
- Set both before exposing the server beyond localhost. Traces contain email
  bodies and prompts.

## Roadmap: beyond LangSmith

**Phase 2: debugging power**
- Playground replay: re-run any LLM span with an edited prompt or model, then diff the outputs.
- Datasets: save a trace or span to a dataset in one click, then use it for regression runs in CI.
- Prompt registry with versions; every LLM span links to the prompt version it used (could replace LangSmith Hub).
- Tail sampling at the server: keep 100% of errors and slow traces, sample the rest.
- Annotations and feedback: 👍/👎 from Bosun's UI attached to the trace (`imagent.feedback(trace_id, score)`).

**Phase 3: AI on top of traces (cheap, since it's your own model budget)**
- Failure clustering: a small model (Haiku) labels error and low-score traces, then groups them ("router created duplicate task", "noon parse rejected") with counts and trends.
- Online evaluators: rule checks plus an LLM judge on a sample. Bosun examples: "decided with full thread context?", "outbound send without confirmation?", "task created for wrong vessel?".
- Anomaly alerts: cost or token spikes, tool-call loops (the same tool called N times in a trace), latency regressions, silent queues. Alerts go to Slack or Signal.
- Cache-efficiency advisor: flag prompts whose cache hit rate dropped, and diff consecutive system prompts to find the invalidator.
- "Ask your traces": natural language → ClickHouse SQL over the spans table.
- Agent decision audit: for each orchestrator decision, show the facts it saw, the directives applied, and the outcome.

**Scale and ops**
- A Kafka or Redis buffer in front of ClickHouse if ingest bursts outgrow `async_insert`.
- Materialized views for per-hour rollups, so 30–90 day dashboards stay instant.
- A JS/TS SDK (the same OTLP schema), so the React app's own LLM calls are traced too.
