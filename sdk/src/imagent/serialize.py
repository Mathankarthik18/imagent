"""Turn arbitrary Python / LangChain objects into JSON for span payloads."""

from __future__ import annotations

import dataclasses
import datetime as _dt
import enum
import json
import uuid
from typing import Any

_ROLE_MAP = {"human": "user", "ai": "assistant", "AIMessageChunk": "assistant", "system": "system",
             "tool": "tool", "function": "function", "chat": "user"}
_MAX_DEPTH = 10


def _is_message(obj: Any) -> bool:
    return hasattr(obj, "content") and hasattr(obj, "type") and type(obj).__name__.endswith(("Message", "MessageChunk"))


def message_to_dict(m: Any) -> dict[str, Any]:
    role = getattr(m, "role", None) or _ROLE_MAP.get(getattr(m, "type", ""), getattr(m, "type", "unknown"))
    d: dict[str, Any] = {"role": role, "content": to_jsonable(m.content)}
    name = getattr(m, "name", None)
    if name:
        d["name"] = name
    tool_calls = getattr(m, "tool_calls", None)
    if tool_calls:
        d["tool_calls"] = [
            {"id": tc.get("id"), "name": tc.get("name"), "args": to_jsonable(tc.get("args"))}
            for tc in tool_calls
        ]
    tool_call_id = getattr(m, "tool_call_id", None)
    if tool_call_id:
        d["tool_call_id"] = tool_call_id
    status = getattr(m, "status", None)
    if status and status != "success":
        d["status"] = status
    return d


def to_jsonable(obj: Any, _depth: int = 0) -> Any:
    if _depth > _MAX_DEPTH:
        return f"<max depth: {type(obj).__name__}>"
    if obj is None or isinstance(obj, (bool, int, float, str)):
        return obj
    if isinstance(obj, bytes):
        return f"<{len(obj)} bytes>"
    if isinstance(obj, (_dt.datetime, _dt.date, _dt.time)):
        return obj.isoformat()
    if isinstance(obj, uuid.UUID):
        return str(obj)
    if isinstance(obj, enum.Enum):
        return to_jsonable(obj.value, _depth + 1)
    if isinstance(obj, dict):
        return {str(k): to_jsonable(v, _depth + 1) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set, frozenset)):
        return [to_jsonable(v, _depth + 1) for v in obj]
    if _is_message(obj):
        return message_to_dict(obj)
    if hasattr(obj, "page_content") and hasattr(obj, "metadata"):  # langchain Document
        return {"page_content": obj.page_content, "metadata": to_jsonable(obj.metadata, _depth + 1)}
    if type(obj).__name__ == "Command" and hasattr(obj, "update"):  # langgraph Command
        return {"command": {"goto": to_jsonable(getattr(obj, "goto", None), _depth + 1),
                            "update": to_jsonable(obj.update, _depth + 1)}}
    model_dump = getattr(obj, "model_dump", None)
    if callable(model_dump):
        try:
            return to_jsonable(model_dump(), _depth + 1)
        except Exception:
            pass
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return to_jsonable(dataclasses.asdict(obj), _depth + 1)
    r = repr(obj)
    return r if len(r) <= 2000 else r[:2000] + "…"


def dumps(obj: Any) -> str:
    if isinstance(obj, str):
        return obj
    return json.dumps(to_jsonable(obj), ensure_ascii=False, default=str)
