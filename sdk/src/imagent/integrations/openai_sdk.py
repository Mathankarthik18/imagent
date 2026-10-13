"""OpenAI Python SDK: trace every ``chat.completions.create`` and ``responses.create`` call
(sync, async, streaming), and swap the model in experiments.

Works for any OpenAI-compatible endpoint the client points at (OpenRouter, Azure, vLLM …).
Calls already recorded by a higher-level integration (LangChain's ChatOpenAI) are skipped.
"""

from __future__ import annotations

import functools
import logging
from typing import Any

from .. import replay
from ._spans import LLMCall, current_agent, provider_spans_off

logger = logging.getLogger("imagent")
_installed = False


def _system(base_url: str) -> str:
    for host, name in (("openrouter.ai", "openrouter"), ("azure", "azure_openai"), ("groq", "groq"),
                       ("together", "together"), ("deepseek", "deepseek"), ("mistral", "mistral")):
        if host in base_url:
            return name
    return "openai"


def _base_url(resource: Any) -> str:
    try:
        return str(resource._client.base_url)  # noqa: SLF001
    except Exception:  # noqa: BLE001
        return ""


def _prepare(resource: Any, kw: dict[str, Any]) -> tuple[str, str]:
    base = _base_url(resource)
    # Under a framework integration (LangChain, CrewAI, LlamaIndex, Agents SDK) the framework
    # already picked the experiment's model — don't override it again here.
    swapped = None if provider_spans_off.get() else replay.swap_model(current_agent.get(), str(kw.get("model") or ""), base_url=base)
    if swapped:
        kw["model"] = swapped
    return base, str(kw.get("model") or "")


def _dump(obj: Any) -> Any:
    return obj.model_dump(exclude_none=True) if hasattr(obj, "model_dump") else obj


def _extra(usage: Any, key: str) -> Any:
    v = getattr(usage, key, None)
    if v is None and getattr(usage, "model_extra", None):
        v = usage.model_extra.get(key)
    return v


# ── chat.completions ──────────────────────────────────────────────────────────
def _chat_start(resource: Any, kw: dict[str, Any]) -> LLMCall:
    base, model = _prepare(resource, kw)
    return LLMCall(model, model=model, system=_system(base), inputs=kw.get("messages"), tools=kw.get("tools"), params=kw)


def _chat_finish(call: LLMCall, resp: Any) -> None:
    choice = (getattr(resp, "choices", None) or [None])[0]
    msg = getattr(choice, "message", None)
    usage = getattr(resp, "usage", None)
    details = getattr(usage, "prompt_tokens_details", None)
    call.finish(_dump(msg) if msg is not None else None,
                input_tokens=getattr(usage, "prompt_tokens", None), output_tokens=getattr(usage, "completion_tokens", None),
                cache_read=getattr(details, "cached_tokens", None) if details else None,
                cost=_extra(usage, "cost") if usage else None,
                response_model=getattr(resp, "model", None), finish_reason=getattr(choice, "finish_reason", None))


class _ChatStream:
    """Wraps a chat-completion stream: passes chunks through, records the whole answer at the end."""

    def __init__(self, stream: Any, call: LLMCall) -> None:
        self._stream, self._call = stream, call
        self._text: list[str] = []
        self._tools: dict[int, dict[str, Any]] = {}
        self._usage = self._model = self._finish = None
        self._done = False

    def _take(self, chunk: Any) -> None:
        self._model = getattr(chunk, "model", None) or self._model
        if getattr(chunk, "usage", None):
            self._usage = chunk.usage
        for ch in getattr(chunk, "choices", None) or []:
            d = getattr(ch, "delta", None)
            if d is not None and getattr(d, "content", None):
                self._call.token()
                self._text.append(d.content)
            for tc in (getattr(d, "tool_calls", None) or []) if d is not None else []:
                t = self._tools.setdefault(tc.index, {"id": None, "name": "", "arguments": ""})
                t["id"] = tc.id or t["id"]
                if tc.function is not None:
                    t["name"] += tc.function.name or ""
                    t["arguments"] += tc.function.arguments or ""
            if getattr(ch, "finish_reason", None):
                self._finish = ch.finish_reason

    def _end(self, error: BaseException | None = None) -> None:
        if self._done:
            return
        self._done = True
        if error is not None:
            self._call.fail(error)
            return
        u = self._usage
        details = getattr(u, "prompt_tokens_details", None)
        out = {"role": "assistant", "content": "".join(self._text)}
        if self._tools:
            out["tool_calls"] = [{"id": t["id"], "type": "function", "function": {"name": t["name"], "arguments": t["arguments"]}}
                                 for _, t in sorted(self._tools.items())]
        self._call.finish(out, input_tokens=getattr(u, "prompt_tokens", None), output_tokens=getattr(u, "completion_tokens", None),
                          cache_read=getattr(details, "cached_tokens", None) if details else None,
                          cost=_extra(u, "cost") if u else None, response_model=self._model, finish_reason=self._finish)

    def __iter__(self):
        try:
            for chunk in self._stream:
                self._take(chunk)
                yield chunk
        except BaseException as exc:
            self._end(exc)
            raise
        self._end()

    async def __aiter__(self):
        try:
            async for chunk in self._stream:
                self._take(chunk)
                yield chunk
        except BaseException as exc:
            self._end(exc)
            raise
        self._end()

    def __enter__(self):
        self._stream.__enter__()
        return self

    def __exit__(self, *exc: Any):
        self._end()
        return self._stream.__exit__(*exc)

    async def __aenter__(self):
        await self._stream.__aenter__()
        return self

    async def __aexit__(self, *exc: Any):
        self._end()
        return await self._stream.__aexit__(*exc)

    def close(self) -> None:
        self._end()
        self._stream.close()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._stream, name)


# ── responses ─────────────────────────────────────────────────────────────────
def _responses_start(resource: Any, kw: dict[str, Any]) -> LLMCall:
    base, model = _prepare(resource, kw)
    inputs = kw.get("input")
    if kw.get("instructions"):
        inputs = {"instructions": kw["instructions"], "input": inputs}
    return LLMCall(model, model=model, system=_system(base), inputs=inputs, tools=kw.get("tools"), params=kw)


def _responses_finish(call: LLMCall, resp: Any) -> None:
    usage = getattr(resp, "usage", None)
    details = getattr(usage, "input_tokens_details", None)
    out: Any = getattr(resp, "output_text", None)
    calls = [_dump(o) for o in (getattr(resp, "output", None) or []) if getattr(o, "type", "") == "function_call"]
    if calls:
        out = {"role": "assistant", "content": out or "", "tool_calls": calls}
    call.finish(out, input_tokens=getattr(usage, "input_tokens", None), output_tokens=getattr(usage, "output_tokens", None),
                cache_read=getattr(details, "cached_tokens", None) if details else None,
                cost=_extra(usage, "cost") if usage else None, response_model=getattr(resp, "model", None),
                finish_reason=getattr(resp, "status", None))


class _ResponsesStream(_ChatStream):
    """Responses API stream: the final ``response.completed`` event carries the whole response."""

    def _take(self, event: Any) -> None:
        kind = getattr(event, "type", "")
        if kind == "response.output_text.delta":
            self._call.token()
        elif kind in ("response.completed", "response.incomplete", "response.failed"):
            self._final = getattr(event, "response", None)

    def _end(self, error: BaseException | None = None) -> None:
        if self._done:
            return
        self._done = True
        if error is not None:
            self._call.fail(error)
        elif getattr(self, "_final", None) is not None:
            _responses_finish(self._call, self._final)
        else:
            self._call.finish(None)


# ── install ───────────────────────────────────────────────────────────────────
def _wrap(orig: Any, start: Any, finish: Any, stream_cls: type, is_async: bool) -> Any:
    if is_async:
        @functools.wraps(orig)
        async def acreate(self, *args: Any, **kw: Any):
            call = start(self, kw)
            try:
                resp = await orig(self, *args, **kw)
            except BaseException as exc:
                call.fail(exc)
                raise
            if kw.get("stream"):
                return stream_cls(resp, call)
            finish(call, resp)
            return resp
        return acreate

    @functools.wraps(orig)
    def create(self, *args: Any, **kw: Any):
        call = start(self, kw)
        try:
            resp = orig(self, *args, **kw)
        except BaseException as exc:
            call.fail(exc)
            raise
        if kw.get("stream"):
            return stream_cls(resp, call)
        finish(call, resp)
        return resp
    return create


def install() -> bool:
    global _installed
    if _installed:
        return True
    try:
        from openai.resources.chat.completions import AsyncCompletions, Completions
    except ImportError:
        return False
    Completions.create = _wrap(Completions.create, _chat_start, _chat_finish, _ChatStream, False)  # type: ignore[method-assign]
    AsyncCompletions.create = _wrap(AsyncCompletions.create, _chat_start, _chat_finish, _ChatStream, True)  # type: ignore[method-assign]
    try:
        from openai.resources.responses import AsyncResponses, Responses

        Responses.create = _wrap(Responses.create, _responses_start, _responses_finish, _ResponsesStream, False)  # type: ignore[method-assign]
        AsyncResponses.create = _wrap(AsyncResponses.create, _responses_start, _responses_finish, _ResponsesStream, True)  # type: ignore[method-assign]
    except ImportError:
        pass
    _installed = True
    logger.debug("imagent: OpenAI SDK instrumented")
    return True
