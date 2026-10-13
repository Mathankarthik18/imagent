"""Anthropic Python SDK: trace every ``messages.create`` call (sync, async, streaming) and
swap the model in experiments. Calls already recorded by LangChain's ChatAnthropic are skipped.
"""

from __future__ import annotations

import logging
from typing import Any

from .. import replay
from ._spans import LLMCall, current_agent, provider_spans_off
from .openai_sdk import _ChatStream, _dump, _wrap

logger = logging.getLogger("imagent")
_installed = False


def _start(resource: Any, kw: dict[str, Any]) -> LLMCall:
    try:
        base = str(resource._client.base_url)  # noqa: SLF001
    except Exception:  # noqa: BLE001
        base = ""
    swapped = None if provider_spans_off.get() else replay.swap_model(current_agent.get(), str(kw.get("model") or ""), base_url=base)
    if swapped:
        kw["model"] = swapped
    model = str(kw.get("model") or "")
    inputs: Any = kw.get("messages")
    if kw.get("system"):
        inputs = [{"role": "system", "content": kw["system"]}, *(inputs or [])]
    return LLMCall(model, model=model, system="anthropic", inputs=inputs, tools=kw.get("tools"), params=kw)


def _tokens(usage: Any) -> dict[str, Any]:
    """Anthropic reports cached prompt tokens separately; imagent's input count includes them."""
    if usage is None:
        return {}
    read = getattr(usage, "cache_read_input_tokens", None) or 0
    write = getattr(usage, "cache_creation_input_tokens", None) or 0
    inp = getattr(usage, "input_tokens", None)
    return {"input_tokens": (inp or 0) + read + write if inp is not None else None,
            "output_tokens": getattr(usage, "output_tokens", None),
            "cache_read": read or None, "cache_write": write or None}


def _finish(call: LLMCall, msg: Any) -> None:
    blocks = [_dump(b) for b in (getattr(msg, "content", None) or [])]
    text = "".join(b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text")
    uses = [b for b in blocks if isinstance(b, dict) and b.get("type") == "tool_use"]
    out: Any = {"role": "assistant", "content": text, "tool_calls": uses} if uses else {"role": "assistant", "content": text}
    call.finish(out, **_tokens(getattr(msg, "usage", None)), response_model=getattr(msg, "model", None),
                finish_reason=getattr(msg, "stop_reason", None))


class _MessageStream(_ChatStream):
    """``create(stream=True)`` events: message_start → content deltas → message_delta (usage, stop)."""

    def _take(self, event: Any) -> None:
        kind = getattr(event, "type", "")
        if kind == "message_start":
            m = event.message
            self._model, self._usage = getattr(m, "model", None), getattr(m, "usage", None)
        elif kind == "content_block_start" and getattr(event.content_block, "type", "") == "tool_use":
            b = event.content_block
            self._tools[event.index] = {"id": b.id, "name": b.name, "arguments": ""}
        elif kind == "content_block_delta":
            d = event.delta
            if getattr(d, "type", "") == "text_delta":
                self._call.token()
                self._text.append(d.text)
            elif getattr(d, "type", "") == "input_json_delta" and event.index in self._tools:
                self._tools[event.index]["arguments"] += d.partial_json
        elif kind == "message_delta":
            self._finish = getattr(event.delta, "stop_reason", None) or self._finish
            self._out_tokens = getattr(getattr(event, "usage", None), "output_tokens", None)

    def _end(self, error: BaseException | None = None) -> None:
        if self._done:
            return
        self._done = True
        if error is not None:
            self._call.fail(error)
            return
        out: dict[str, Any] = {"role": "assistant", "content": "".join(self._text)}
        if self._tools:
            out["tool_calls"] = [{"type": "tool_use", "id": t["id"], "name": t["name"], "input": t["arguments"]}
                                 for _, t in sorted(self._tools.items())]
        tok = _tokens(self._usage)
        tok["output_tokens"] = getattr(self, "_out_tokens", None) or tok.get("output_tokens")
        self._call.finish(out, **tok, response_model=self._model, finish_reason=self._finish)


def install() -> bool:
    global _installed
    if _installed:
        return True
    try:
        from anthropic.resources.messages import AsyncMessages, Messages
    except ImportError:
        return False
    Messages.create = _wrap(Messages.create, _start, _finish, _MessageStream, False)  # type: ignore[method-assign]
    AsyncMessages.create = _wrap(AsyncMessages.create, _start, _finish, _MessageStream, True)  # type: ignore[method-assign]
    _installed = True
    logger.debug("imagent: Anthropic SDK instrumented")
    return True
