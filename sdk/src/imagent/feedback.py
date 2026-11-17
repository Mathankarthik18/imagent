"""Feedback on runs: a user's 👍/👎, a reviewer's score, or a flag for the issue engine.

    imagent.feedback(thread_id=thread_id, score=0, comment="wrong vessel")   # the thread's latest run
    imagent.feedback(trace_id=trace_id, score=1)

Negative feedback sends a run to the front of the issue engine's queue. Sent in the
background; never raises into the app.
"""

from __future__ import annotations

import datetime as dt
import logging
import threading
from typing import Any

from opentelemetry import trace

logger = logging.getLogger(__name__)


def current_trace_id() -> str | None:
    """The trace id of the run this code is inside, to store for feedback later."""
    ctx = trace.get_current_span().get_span_context()
    return format(ctx.trace_id, "032x") if ctx.is_valid else None


def feedback(*, trace_id: str | None = None, thread_id: str | None = None, score: float | None = None,
             comment: str = "", key: str = "user", source: str = "app", user_id: str | None = None,
             at: dt.datetime | None = None) -> None:
    """Record feedback on a run (``trace_id``) or on the latest run of a thread before ``at``.

    ``score``: 0..1 (👎 = 0, 👍 = 1) or None for a comment only. ``key`` names the kind
    ("user", "reviewer", "flag" …)."""
    from .runtime import get_config

    cfg = get_config()
    if cfg is None or not (trace_id or thread_id):
        return
    body: dict[str, Any] = {
        "trace_id": trace_id or "", "thread_id": thread_id or "", "score": score, "comment": comment[:4000],
        "key": key, "source": source, "user_id": user_id or "",
        "at": (at or dt.datetime.now(dt.timezone.utc)).isoformat(), "project": cfg.service,
    }

    def post() -> None:
        try:
            import requests

            headers = {"x-imagent-key": cfg.api_key} if cfg.api_key else {}
            requests.post(f"{cfg.endpoint}/api/feedback", headers=headers, timeout=15, json=body).raise_for_status()
        except Exception as exc:  # noqa: BLE001 — feedback must never break the app
            logger.warning("imagent feedback not sent: %s", exc)

    threading.Thread(target=post, name="imagent-feedback", daemon=True).start()
