"""ClickHouse client + schema."""

from __future__ import annotations

import logging

import clickhouse_connect
from clickhouse_connect.driver.asyncclient import AsyncClient

from .config import settings

logger = logging.getLogger(__name__)

DB = settings.clickhouse_database
SPANS = f"{DB}.spans"
RUNNING = f"{DB}.running_spans"
RUNNING_COLUMNS = ["project", "trace_id", "span_id", "parent_span_id", "is_root", "name", "kind",
                   "start_time", "thread_id", "user_id", "agent_name", "model", "origin", "service"]

# Column order used by the ingest insert.
COLUMNS = [
    "project", "environment", "trace_id", "span_id", "parent_span_id", "is_root", "name", "kind",
    "status", "status_message", "start_time", "end_time", "duration_ms",
    "thread_id", "user_id", "session_id", "agent_name",
    "model", "provider", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
    "cost_usd", "cost_source", "ttft_ms", "input", "output", "tags", "metadata", "attributes", "events",
    "origin", "service",
]

# Added after the first release — ALTERed onto existing tables at startup.
#   origin:  '' for production runs, 'experiment' for replays (they stay in their project)
#   service: the app's OTel service.name (several services can feed one project)
_MIGRATIONS = [
    f"ALTER TABLE {SPANS} ADD COLUMN IF NOT EXISTS origin LowCardinality(String) DEFAULT ''",
    f"ALTER TABLE {SPANS} ADD COLUMN IF NOT EXISTS service LowCardinality(String) DEFAULT ''",
    f"ALTER TABLE {RUNNING} ADD COLUMN IF NOT EXISTS origin LowCardinality(String) DEFAULT ''",
    f"ALTER TABLE {RUNNING} ADD COLUMN IF NOT EXISTS service LowCardinality(String) DEFAULT ''",
]

_SCHEMA = [
    f"CREATE DATABASE IF NOT EXISTS {DB}",
    f"""
    CREATE TABLE IF NOT EXISTS {SPANS} (
        project            LowCardinality(String),
        environment        LowCardinality(String),
        trace_id           String,
        span_id            String,
        parent_span_id     String,
        is_root            UInt8,
        name               String,
        kind               LowCardinality(String),
        status             LowCardinality(String),
        status_message     String,
        start_time         DateTime64(6, 'UTC'),
        end_time           DateTime64(6, 'UTC'),
        duration_ms        Float64,
        thread_id          String,
        user_id            String,
        session_id         String,
        agent_name         LowCardinality(String),
        model              LowCardinality(String),
        provider           LowCardinality(String),
        input_tokens       UInt32,
        output_tokens      UInt32,
        cache_read_tokens  UInt32,
        cache_write_tokens UInt32,
        cost_usd           Float64,
        cost_source        LowCardinality(String),
        ttft_ms            Nullable(Float64),
        input              String CODEC(ZSTD(3)),
        output             String CODEC(ZSTD(3)),
        tags               Array(String),
        metadata           String CODEC(ZSTD(3)),
        attributes         Map(String, String) CODEC(ZSTD(3)),
        events             String CODEC(ZSTD(3)),
        inserted_at        DateTime64(3, 'UTC') DEFAULT now64(3),
        INDEX idx_trace   trace_id  TYPE bloom_filter(0.01) GRANULARITY 1,
        INDEX idx_thread  thread_id TYPE bloom_filter(0.01) GRANULARITY 1,
        INDEX idx_user    user_id   TYPE bloom_filter(0.01) GRANULARITY 1,
        INDEX idx_name    name      TYPE tokenbf_v1(8192, 3, 0) GRANULARITY 4
    )
    ENGINE = ReplacingMergeTree(inserted_at)
    PARTITION BY toYYYYMM(start_time)
    ORDER BY (project, toStartOfHour(start_time), trace_id, span_id)
    TTL toDateTime(start_time) + INTERVAL {int(settings.retention_days)} DAY
    SETTINGS index_granularity = 8192
    """,
    # "Started" snapshots of spans still running (SDK PendingSpanProcessor). A span is
    # running while it is here and not yet in `spans`.
    f"""
    CREATE TABLE IF NOT EXISTS {RUNNING} (
        project        LowCardinality(String),
        trace_id       String,
        span_id        String,
        parent_span_id String,
        is_root        UInt8,
        name           String,
        kind           LowCardinality(String),
        start_time     DateTime64(6, 'UTC'),
        thread_id      String,
        user_id        String,
        agent_name     LowCardinality(String),
        model          LowCardinality(String),
        inserted_at    DateTime64(3, 'UTC') DEFAULT now64(3)
    )
    ENGINE = ReplacingMergeTree(inserted_at)
    ORDER BY (project, trace_id, span_id)
    TTL toDateTime(start_time) + INTERVAL 2 DAY
    """,
]

_client: AsyncClient | None = None


async def get_client() -> AsyncClient:
    global _client
    if _client is None:
        _client = await clickhouse_connect.get_async_client(
            host=settings.clickhouse_host,
            port=settings.clickhouse_port,
            username=settings.clickhouse_user,
            password=settings.clickhouse_password,
            secure=settings.clickhouse_secure,
            settings={"async_insert": 1, "wait_for_async_insert": 1},
        )
    return _client


async def ensure_schema() -> None:
    from .blueprints import DDL as BLUEPRINT_DDL
    from .projects import DDL as PROJECT_DDL
    from .experiments import DDL as EXPERIMENT_DDL
    from .price_sync import DDL as PRICES_DDL
    from .diagnose import DDL as DIAGNOSE_DDL
    from .engine import DDL as ENGINE_DDL
    from .rules import DDL as RULES_DDL
    from .screener import DDL as SCREENER_DDL
    from .learning import DDL as LEARNING_DDL
    from .checks import DDL as CHECKS_DDL
    from .fix_chat import DDL as FIX_CHAT_DDL

    client = await get_client()
    for ddl in [*_SCHEMA, *_MIGRATIONS, PRICES_DDL, *EXPERIMENT_DDL, *BLUEPRINT_DDL, *PROJECT_DDL, *DIAGNOSE_DDL, *ENGINE_DDL, *RULES_DDL, *SCREENER_DDL, *LEARNING_DDL, *CHECKS_DDL, *FIX_CHAT_DDL]:
        await client.command(ddl)
    await _ensure_search_text()
    logger.info("ClickHouse schema ready (%s)", SPANS)


# What a text search reads: the words that are distinct in each step, a few KB at most, instead of
# every payload (a model call's input re-sends the whole conversation; agent state outputs repeat it).
# Root spans: the end of the request and of the output (the latest user message, the final answer);
# model calls: what the model wrote; tools and other steps: the start of input and output.
SEARCH_TEXT_EXPR = (
    "multiIf("
    "kind = 'llm', substring(output, 1, 4000), "
    "is_root = 1, concat(right(input, 3000), '\\n', right(output, 3000)), "
    "kind IN ('agent', 'chain', 'node'), '', "
    "concat(substring(input, 1, 2000), '\\n', substring(output, 1, 3000)))"
)


async def _ensure_search_text() -> None:
    """Add the search column (filled on insert from now on) and, the first time, backfill the runs
    already stored — a background mutation ClickHouse works through part by part."""
    rows = await query("SELECT count() AS n FROM system.columns WHERE database = {db:String} AND table = 'spans' "
                       "AND name = 'search_text'", {"db": DB})
    if rows and rows[0]["n"]:
        return
    client = await get_client()
    await client.command(f"ALTER TABLE {SPANS} ADD COLUMN IF NOT EXISTS search_text String "
                         f"MATERIALIZED {SEARCH_TEXT_EXPR} CODEC(ZSTD(3))")
    await client.command(f"ALTER TABLE {SPANS} MATERIALIZE COLUMN search_text", settings={"mutations_sync": 0})
    logger.info("search_text column added; backfilling stored runs in the background")


async def close() -> None:
    global _client
    if _client is not None:
        await _client.close()
        _client = None


async def insert_spans(rows: list[list]) -> None:
    if rows:
        client = await get_client()
        await client.insert(SPANS, rows, column_names=COLUMNS)


# Output aliases reuse column names (``min(start_time) AS start_time``); make
# expressions and WHERE clauses keep referring to the underlying columns.
_QUERY_SETTINGS = {"prefer_column_name_to_alias": 1}


async def insert_running(rows: list[list]) -> None:
    if rows:
        client = await get_client()
        await client.insert(RUNNING, rows, column_names=RUNNING_COLUMNS)


async def query(sql: str, params: dict | None = None, settings: dict | None = None) -> list[dict]:
    client = await get_client()
    result = await client.query(sql, parameters=params or {}, settings={**_QUERY_SETTINGS, **(settings or {})})
    return list(result.named_results())
