export function parseTime(s: string): Date {
  // ClickHouse datetimes arrive as ISO strings; treat zone-less values as UTC.
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return "–";
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function fmtCost(usd: number | null | undefined): string {
  if (!usd) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString()}`;
}

export function fmtNum(n: number | null | undefined): string {
  if (n == null) return "–";
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return n.toLocaleString();
}

export function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "–";
  return `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`;
}

export function fmtTime(s: string): string {
  return parseTime(s).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

export function timeAgo(s: string): string {
  const diff = (Date.now() - parseTime(s).getTime()) / 1000;
  if (diff < 60) return `${Math.max(0, Math.round(diff))}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

export function shortId(id: string, n = 8): string {
  return id.length > n ? id.slice(0, n) : id;
}

/** Best-effort pretty text for a captured payload preview. */
export function previewText(raw: string): string {
  if (!raw) return "";
  try {
    const v = JSON.parse(raw);
    return summarize(v);
  } catch {
    return raw;
  }
}

function summarize(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const last = v[v.length - 1];
    return last && typeof last === "object" && "content" in last ? summarize((last as { content: unknown }).content) : JSON.stringify(v);
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.messages)) return summarize(o.messages);
    if ("content" in o) return summarize(o.content);
    return JSON.stringify(o);
  }
  return String(v);
}
