"""Request-scoped trace context (thread/user/session/agent/tags/metadata).

Values set here are stamped onto every harness span started inside the block,
including LangChain runs, so you can later ask "show me every trace for email
thread X" without threading IDs through your code.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

_ctx: ContextVar[dict[str, Any]] = ContextVar("harness_moni_context", default={})


def current_context() -> dict[str, Any]:
    return _ctx.get()


@contextmanager
def harness_context(
    *,
    thread_id: str | None = None,
    user_id: str | None = None,
    session_id: str | None = None,
    agent_name: str | None = None,
    tags: Sequence[str] | None = None,
    metadata: Mapping[str, Any] | None = None,
) -> Iterator[None]:
    """Nestable; inner values override outer ones, tags and metadata merge."""
    cur = _ctx.get()
    new = dict(cur)
    for k, v in (("thread_id", thread_id), ("user_id", user_id), ("session_id", session_id), ("agent_name", agent_name)):
        if v is not None:
            new[k] = v
    if tags:
        new["tags"] = list(dict.fromkeys([*(cur.get("tags") or []), *tags]))
    if metadata:
        new["metadata"] = {**(cur.get("metadata") or {}), **metadata}
    token = _ctx.set(new)
    try:
        yield
    finally:
        _ctx.reset(token)
