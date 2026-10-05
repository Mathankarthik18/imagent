"""Report spans that are still running.

OpenTelemetry exports a span only when it ends, so a long agent run is invisible
until it finishes. This processor notices spans that have been open longer than
``delay_s`` and exports a lightweight "started" snapshot of each (no payloads,
``harness.pending=true``). The server keeps those in a separate table and treats a
span as running until its finished version arrives. Fast spans never produce one.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

from opentelemetry.context import Context
from opentelemetry.sdk.trace import ReadableSpan, Span, SpanProcessor
from opentelemetry.sdk.trace.export import SpanExporter
from opentelemetry.trace import Status, StatusCode

from . import semconv as sc

logger = logging.getLogger("harness_moni")

_DROP = {sc.INPUT, sc.OUTPUT, sc.TOOLS, sc.METADATA}
PENDING = "harness.pending"


class PendingSpanProcessor(SpanProcessor):
    def __init__(self, exporter: SpanExporter, delay_s: float = 1.5, interval_s: float = 1.0):
        self._exporter = exporter
        self._delay = delay_s
        self._interval = interval_s
        self._open: dict[int, tuple[Span, float]] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="harness-pending", daemon=True)
        self._thread.start()

    def on_start(self, span: Span, parent_context: Context | None = None) -> None:
        if span.context is None or not span.context.trace_flags.sampled:
            return
        with self._lock:
            self._open[span.context.span_id] = (span, time.monotonic())

    def on_end(self, span: ReadableSpan) -> None:
        if span.context is not None:
            with self._lock:
                self._open.pop(span.context.span_id, None)

    def _snapshot(self, span: Span) -> ReadableSpan:
        attrs: dict[str, Any] = {k: v for k, v in (span.attributes or {}).items() if k not in _DROP}
        attrs[PENDING] = True
        return ReadableSpan(
            name=span.name, context=span.context, parent=span.parent, resource=span.resource,
            attributes=attrs, kind=span.kind, status=Status(StatusCode.UNSET),
            start_time=span.start_time, end_time=span.start_time,
            instrumentation_scope=span.instrumentation_scope,
        )

    def flush_pending(self) -> int:
        """Export snapshots for every span open longer than the delay (once each)."""
        cutoff = time.monotonic() - self._delay
        with self._lock:
            due = [(sid, span) for sid, (span, started) in self._open.items() if started <= cutoff]
            for sid, _ in due:
                # Keep tracking so on_end can drop it, but never report twice.
                self._open[sid] = (self._open[sid][0], float("inf"))
        if not due:
            return 0
        try:
            self._exporter.export([self._snapshot(span) for _, span in due])
        except Exception:  # telemetry must never break the app
            logger.debug("pending span export failed", exc_info=True)
        return len(due)

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            self.flush_pending()

    def shutdown(self) -> None:
        self._stop.set()
        self._exporter.shutdown()

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return True
