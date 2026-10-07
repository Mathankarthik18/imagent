"""Compare two agent runs (traces): tool-call sequence, arguments, final output, cost/latency.

Used by the side-by-side compare view and to score experiment runs against their
baseline (the original recorded run).
"""

from __future__ import annotations

import datetime as dt
import difflib
import json
from typing import Any

# deepagents bookkeeping tools — planning noise, not behaviour worth diffing.
IGNORED_TOOLS = {"write_todos", "ls", "read_file", "write_file", "edit_file", "glob", "grep"}


def _ts(v: Any) -> float:
    if isinstance(v, dt.datetime):
        return (v if v.tzinfo else v.replace(tzinfo=dt.timezone.utc)).timestamp()
    try:
        return dt.datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def _parse(raw: str) -> Any:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return raw


def canonical_args(raw: str) -> str:
    """Stable string for a tool's input so equal arguments compare equal."""
    v = _parse(raw)
    if isinstance(v, dict) and set(v) >= {"name", "args"} and isinstance(v.get("args"), dict):
        v = v["args"]  # ToolCall envelope
    try:
        return json.dumps(v, sort_keys=True, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return str(v)


def _content_text(c: Any) -> str:
    if c is None:
        return ""
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "\n".join(str(b.get("text", "")) for b in c if isinstance(b, dict) and b.get("text"))
    return json.dumps(c, ensure_ascii=False, default=str)


def readable(raw: str, roles: tuple[str, ...] = ("assistant", "ai")) -> str:
    """Human text of a payload: last message from `roles`, a message's content, or the raw value."""
    v = _parse(raw)
    msgs = None
    if isinstance(v, dict) and isinstance(v.get("messages"), list):
        msgs = v["messages"]
    elif isinstance(v, list) and v and all(isinstance(m, dict) and "content" in m for m in v):
        msgs = v
    if msgs:
        for m in reversed(msgs):
            if isinstance(m, dict) and m.get("role") in roles and _content_text(m.get("content")).strip():
                return _content_text(m.get("content"))
        return _content_text(msgs[-1].get("content") if isinstance(msgs[-1], dict) else msgs[-1])
    if isinstance(v, dict) and "content" in v:
        return _content_text(v["content"])
    if isinstance(v, str):
        return v
    return "" if v is None else json.dumps(v, ensure_ascii=False, default=str)


def root_span(spans: list[dict[str, Any]]) -> dict[str, Any] | None:
    ids = {s["span_id"] for s in spans}
    roots = [s for s in spans if s.get("parent_span_id") not in ids]
    return min(roots, key=lambda s: _ts(s["start_time"])) if roots else None


def agent_span(spans: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The run's real agent: the root, unless the root is an experiment wrapper."""
    root = root_span(spans)
    if root and root.get("name", "").startswith("replay:"):
        kids = [s for s in spans if s.get("parent_span_id") == root["span_id"]]
        if kids:
            return min(kids, key=lambda s: _ts(s["start_time"]))
    return root


def tool_calls(spans: list[dict[str, Any]]) -> list[dict[str, Any]]:
    calls = []
    for s in sorted(spans, key=lambda s: _ts(s["start_time"])):
        if s.get("kind") != "tool" or s.get("name") in IGNORED_TOOLS:
            continue
        tags = s.get("tags") or []
        replay = next((t.split(":", 2)[2] for t in tags if isinstance(t, str) and t.startswith("replay:mode:")), "")
        calls.append({
            "span_id": s["span_id"], "trace_id": s["trace_id"], "name": s["name"],
            "args": canonical_args(s.get("input", "")),
            "output": readable(s.get("output", ""), roles=("tool",))[:600],
            "status": s.get("status", "ok"), "duration_ms": s.get("duration_ms", 0), "replay": replay,
        })
    return calls


def _align(a: list[str], b: list[str]) -> list[tuple[int | None, int | None]]:
    """LCS alignment of two name sequences → pairs of indexes (None = gap)."""
    n, m = len(a), len(b)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            dp[i][j] = dp[i + 1][j + 1] + 1 if a[i] == b[j] else max(dp[i + 1][j], dp[i][j + 1])
    out: list[tuple[int | None, int | None]] = []
    i = j = 0
    while i < n and j < m:
        if a[i] == b[j]:
            out.append((i, j)); i += 1; j += 1
        elif dp[i + 1][j] >= dp[i][j + 1]:
            out.append((i, None)); i += 1
        else:
            out.append((None, j)); j += 1
    out += [(k, None) for k in range(i, n)] + [(None, k) for k in range(j, m)]
    return out


def metrics(spans: list[dict[str, Any]]) -> dict[str, Any]:
    if not spans:
        return {}
    starts = [_ts(s["start_time"]) for s in spans]
    ends = [_ts(s["end_time"]) for s in spans]
    llm = [s for s in spans if s.get("kind") == "llm"]
    return {
        "duration_ms": round((max(ends) - min(starts)) * 1000, 1),
        "llm_calls": len(llm),
        "tool_calls": len([s for s in spans if s.get("kind") == "tool" and s.get("name") not in IGNORED_TOOLS]),
        "input_tokens": sum(s.get("input_tokens", 0) for s in llm),
        "output_tokens": sum(s.get("output_tokens", 0) for s in llm),
        "cost_usd": round(sum(s.get("cost_usd", 0.0) for s in llm), 6),
        "models": sorted({s.get("model") for s in llm if s.get("model")}),
        "errors": len([s for s in spans if s.get("status") == "error"]),
    }


def compare(a_spans: list[dict[str, Any]], b_spans: list[dict[str, Any]]) -> dict[str, Any]:
    """A = baseline, B = candidate."""
    a_calls, b_calls = tool_calls(a_spans), tool_calls(b_spans)
    rows = []
    same = args_differ = 0
    for i, j in _align([c["name"] for c in a_calls], [c["name"] for c in b_calls]):
        a = a_calls[i] if i is not None else None
        b = b_calls[j] if j is not None else None
        if a and b:
            status = "same" if a["args"] == b["args"] else "args_differ"
            same += status == "same"
            args_differ += status == "args_differ"
        else:
            status = "only_a" if a else "only_b"
        rows.append({"status": status, "a": a, "b": b})

    a_root, b_root = agent_span(a_spans), agent_span(b_spans)
    a_out = readable((a_root or {}).get("output", "")) if a_root else ""
    b_out = readable((b_root or {}).get("output", "")) if b_root else ""
    # The experiment wrapper's own output is the agent's return value — prefer it when the agent span has none.
    if not b_out and b_spans:
        r = root_span(b_spans)
        b_out = readable((r or {}).get("output", ""))
    similarity = difflib.SequenceMatcher(None, a_out[:6000], b_out[:6000]).ratio() if (a_out or b_out) else 1.0

    total = max(len(a_calls), len(b_calls))
    tool_match = (same + args_differ) / total if total else 1.0
    missing = [r["a"]["name"] for r in rows if r["status"] == "only_a"]
    extra = [r["b"]["name"] for r in rows if r["status"] == "only_b"]
    ma, mb = metrics(a_spans), metrics(b_spans)
    if mb.get("errors"):
        verdict = "failed"
    elif tool_match == 1 and not args_differ and similarity >= 0.6:
        verdict = "match"
    elif tool_match >= 0.75 and not missing:
        verdict = "partial"
    else:
        verdict = "diverged"
    return {
        "verdict": verdict,
        "tool_match": round(tool_match, 3),
        "args_match": round(same / total, 3) if total else 1.0,
        "output_similarity": round(similarity, 3),
        "missing_tools": missing,
        "extra_tools": extra,
        "rows": rows,
        "outputs": {"a": a_out, "b": b_out},
        "metrics": {"a": ma, "b": mb},
        "names": {"a": (a_root or {}).get("name", ""), "b": (b_root or {}).get("name", "")},
    }
