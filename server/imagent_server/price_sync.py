"""Daily model-price sync from OpenRouter's public catalog (no key, no trace data sent).

Prices land in the ``model_prices`` table so they survive restarts and work offline,
are loaded into the in-memory price book, and any LLM spans that were stored
"unpriced" (or with a doubled streamed model name) are re-priced.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import urllib.request
from typing import Any

from . import pricing
from .config import settings
from .db import DB, SPANS, get_client, query

logger = logging.getLogger(__name__)

PRICES = f"{DB}.model_prices"
REFRESH_EVERY = dt.timedelta(hours=24)
CHECK_INTERVAL_SECONDS = 6 * 3600

DDL = f"""
CREATE TABLE IF NOT EXISTS {PRICES} (
    model       String,
    source_id   String,
    input       Float64,
    output      Float64,
    cache_read  Nullable(Float64),
    cache_write Nullable(Float64),
    updated_at  DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY model
"""


def _per_million(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return round(f * 1_000_000, 6) if f >= 0 else None


def parse_catalog(payload: dict[str, Any]) -> list[list[Any]]:
    rows: dict[str, list[Any]] = {}
    for m in payload.get("data", []):
        source_id = str(m.get("id") or "")
        if not source_id or ":" in source_id:        # skip :batch / :free / :beta variants
            continue
        p = m.get("pricing") or {}
        inp, out = _per_million(p.get("prompt")), _per_million(p.get("completion"))
        if inp is None or out is None or (inp == 0 and out == 0):
            continue
        key = pricing.normalise_model(source_id)
        rows.setdefault(key, [key, source_id, inp, out, _per_million(p.get("input_cache_read")),
                              _per_million(p.get("input_cache_write"))])
    return list(rows.values())


def _fetch() -> dict[str, Any]:
    req = urllib.request.Request(settings.price_source, headers={"User-Agent": "imagent/0.1"})
    with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310 — fixed https URL from config
        return json.loads(r.read())


async def load_into_book() -> int:
    rows = await query(f"SELECT model, input, output, cache_read, cache_write FROM {PRICES} FINAL")
    pricing.set_catalog({r["model"]: pricing.Price(r["input"], r["output"], r["cache_read"], r["cache_write"]) for r in rows})
    return len(rows)


async def refresh() -> int:
    payload = await asyncio.to_thread(_fetch)
    rows = parse_catalog(payload)
    if not rows:
        raise RuntimeError("price catalog returned no usable models")
    client = await get_client()
    await client.insert(PRICES, rows, column_names=["model", "source_id", "input", "output", "cache_read", "cache_write"])
    n = await load_into_book()
    logger.info("synced %d model prices from %s", n, settings.price_source)
    return n


async def reprice(days: int = 30, include_computed: bool = False) -> int:
    """Fix LLM spans stored unpriced or with a doubled (streamed) model name.
    One mutation per affected (model, cost_source); returns how many were updated."""
    pairs = await query(f"""
        SELECT DISTINCT model, cost_source FROM {SPANS}
        WHERE kind = 'llm' AND model != '' AND start_time >= now64(6) - toIntervalDay({{days:UInt32}})
    """, {"days": days})
    client = await get_client()
    updated = 0
    for r in pairs:
        model, source = r["model"], r["cost_source"]
        clean = pricing.unrepeat(model)
        price = pricing.lookup(clean)
        fix_name = clean != model
        fix_cost = price is not None and (source in ("unknown", "") or (include_computed and source == "computed"))
        if not (fix_name or fix_cost):
            continue
        set_parts = ["model = {clean:String}"]
        params: dict[str, Any] = {"model": model, "clean": clean, "source": source, "days": days}
        if fix_cost:
            cr = price.cache_read if price.cache_read is not None else price.input * 0.1
            cw = price.cache_write if price.cache_write is not None else price.input * 1.25
            params.update(pi=price.input, po=price.output, pcr=cr, pcw=cw)
            set_parts += [
                "cost_usd = (greatest(toInt64(input_tokens) - cache_read_tokens - cache_write_tokens, 0) * {pi:Float64}"
                " + cache_read_tokens * {pcr:Float64} + cache_write_tokens * {pcw:Float64} + output_tokens * {po:Float64}) / 1000000",
                "cost_source = 'computed'",
            ]
        await client.command(
            f"ALTER TABLE {SPANS} UPDATE {', '.join(set_parts)} "
            "WHERE kind = 'llm' AND model = {model:String} AND cost_source = {source:String} "
            "AND start_time >= now64(6) - toIntervalDay({days:UInt32})",
            parameters=params, settings={"mutations_sync": 1})
        updated += 1
    if updated:
        logger.info("re-priced/renamed LLM spans for %d model group(s)", updated)
    return updated


async def run_forever() -> None:
    try:
        client = await get_client()
        await client.command(DDL)
        await load_into_book()
    except Exception:
        logger.exception("could not load stored model prices")
    while True:
        try:
            latest = await query(f"SELECT max(updated_at) AS t FROM {PRICES}")
            last = latest[0]["t"] if latest else None
            stale = last is None or last.year < 2000 or (
                dt.datetime.now(dt.timezone.utc) - (last if last.tzinfo else last.replace(tzinfo=dt.timezone.utc)) > REFRESH_EVERY)
            if stale:
                await refresh()
            await reprice(settings.retention_days)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("model price sync failed; using stored/built-in prices", exc_info=True)
        await asyncio.sleep(CHECK_INTERVAL_SECONDS)
