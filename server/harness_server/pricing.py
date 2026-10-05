"""Model prices (USD per 1M tokens), used when the provider didn't report a cost.

Provider-reported cost (OpenRouter's ``usage.cost``) always wins. Otherwise a model is
looked up, in order, in:

1. ``HARNESS_PRICING_FILE`` overrides (JSON: {"model": {"input": .., "output": .., ...}})
2. built-in Anthropic first-party list prices
3. the synced catalog (OpenRouter's public model list — hundreds of models across
   OpenAI, Google, Meta, Mistral, Z.ai, …), refreshed daily by ``price_sync``

Exact (normalised) names match first, then the longest prefix.
"""

from __future__ import annotations

import json
import logging
import re
import threading
from dataclasses import dataclass

from .config import settings

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Price:
    input: float
    output: float
    cache_read: float | None = None   # default 0.1 × input
    cache_write: float | None = None  # default 1.25 × input (5-minute cache write)


# Anthropic first-party list prices (cached 2026-09-25).
_BUILTIN: dict[str, Price] = {
    "claude-fable-5-1": Price(10.0, 50.0, cache_read=0.25),
    "claude-fable-5": Price(10.0, 50.0),
    "claude-opus-5-5": Price(4.0, 20.0, cache_read=0.20),
    "claude-opus-5": Price(5.0, 25.0),
    "claude-opus-4-8": Price(5.0, 25.0),
    "claude-opus-4-7": Price(5.0, 25.0),
    "claude-opus-4-6": Price(5.0, 25.0),
    "claude-opus-4-5": Price(5.0, 25.0),
    "claude-opus-4": Price(15.0, 75.0),          # Opus 4 / 4.1
    "claude-sonnet-5-5": Price(2.0, 10.0, cache_read=0.20),
    "claude-sonnet-5": Price(2.0, 10.0),
    "claude-sonnet-4": Price(3.0, 15.0),
    "claude-haiku-4-5": Price(1.0, 5.0),
    "claude-3-5-haiku": Price(0.8, 4.0),
}

_VENDOR_PREFIX = re.compile(r"^(?:(?:us|eu|apac|global|jp|au)\.)?(?:anthropic|meta|amazon|mistral|cohere|ai21|deepseek|openai|qwen)\.")


def unrepeat(value: str) -> str:
    """Undo string concatenation from merged streaming chunks ("abab" → "ab")."""
    n = len(value)
    for size in range(1, n // 2 + 1):
        if n % size == 0 and value == value[:size] * (n // size):
            return value[:size]
    return value


def normalise_model(model: str) -> str:
    """Map provider-specific ids onto one key:
    openrouter/anthropic/claude-sonnet-4.5, claude-sonnet-4-5-20250929,
    us.anthropic.claude-sonnet-4-5-20250929-v1:0 (Bedrock), claude-sonnet-4-5@20250929 (Vertex)
    → claude-sonnet-4-5."""
    m = unrepeat(model.strip()).lower()
    m = m.split("/")[-1]
    m = m.split(":")[0]
    m = m.split("@")[0]
    m = _VENDOR_PREFIX.sub("", m)
    m = re.sub(r"-v\d+$", "", m)
    m = re.sub(r"[._]", "-", m)
    m = re.sub(r"-\d{8}$", "", m)
    return m


class _Book:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.catalog: dict[str, Price] = {}
        self.overrides: dict[str, Price] = self._load_overrides()
        self._prefixes: list[tuple[str, Price]] = []
        self._rebuild()

    @staticmethod
    def _load_overrides() -> dict[str, Price]:
        if not settings.pricing_file:
            return {}
        try:
            with open(settings.pricing_file) as f:
                return {normalise_model(k): Price(**v) for k, v in json.load(f).items()}
        except Exception:
            logger.exception("failed to load pricing file %s", settings.pricing_file)
            return {}

    def _rebuild(self) -> None:
        merged = {**self.catalog, **_BUILTIN, **self.overrides}   # later wins
        self._merged = merged
        self._prefixes = sorted(merged.items(), key=lambda kv: len(kv[0]), reverse=True)

    def set_catalog(self, catalog: dict[str, Price]) -> None:
        with self.lock:
            self.catalog = catalog
            self._rebuild()

    def lookup(self, model: str) -> Price | None:
        if not model:
            return None
        norm = normalise_model(model)
        with self.lock:
            exact = self._merged.get(norm)
            if exact is not None:
                return exact
            for prefix, price in self._prefixes:
                if norm.startswith(prefix + "-"):
                    return price
        return None


_book = _Book()


def set_catalog(catalog: dict[str, Price]) -> None:
    _book.set_catalog(catalog)


def catalog_size() -> int:
    return len(_book.catalog)


def lookup(model: str) -> Price | None:
    return _book.lookup(model)


def compute_cost(model: str, input_tokens: int, output_tokens: int, cache_read: int, cache_write: int) -> float | None:
    """``input_tokens`` is the total prompt (cached included), per OTel/LangChain semantics."""
    price = lookup(model)
    if price is None:
        return None
    uncached = max(input_tokens - cache_read - cache_write, 0)
    cr = price.cache_read if price.cache_read is not None else price.input * 0.1
    cw = price.cache_write if price.cache_write is not None else price.input * 1.25
    return (uncached * price.input + cache_read * cr + cache_write * cw + output_tokens * price.output) / 1_000_000
