import { useEffect, useMemo, useState } from "react";
import { fmtCost, fmtDuration, fmtNum, fmtTime, parseTime } from "../lib/format";
import { elapsed, useNow } from "../lib/live";
import { Icon, KindIcon } from "./icons";

/** The span fields the tree needs — full spans and the thread endpoint's lite spans both fit. */
export interface TreeSpan {
  trace_id: string;
  span_id: string;
  parent_span_id: string;
  name: string;
  kind: string;
  status: string;
  start_time: string;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

interface TraceInfo {
  trace_id: string;
  index: number;
  name: string;
  kind: string;
  spans: number;
  tokens: number;
  cost: number;
  errors: number;
  running: boolean;
  firstSpanId: string;
}

interface Node {
  id: string;
  span?: TreeSpan;
  trace?: TraceInfo;
  children: Node[];
  depth: number;
  start: number;
  end: number;
  /** Time window the bar is drawn against (the trace for spans, the thread for trace rows). */
  w0: number;
  w1: number;
}

// Bars stay neutral; only model and tool time get colour, so the expensive parts pop.
const BAR_COLOR: Record<string, string> = {
  llm: "bg-[#1baf7a]/80", tool: "bg-[#eb6834]/75", retriever: "bg-[#e87ba4]/75", embedding: "bg-[#e87ba4]/75",
  agent: "bg-ink-3/45", node: "bg-ink-3/35", chain: "bg-ink-3/35", span: "bg-ink-3/35", trace: "bg-ink-3/45",
};

function spanEnd(s: TreeSpan, start: number, now: number) {
  return s.status === "running" ? Math.max(now, start) : start + Math.max(s.duration_ms, 0);
}

function spanTree(spans: TreeSpan[], now: number): Node[] {
  const nodes = new Map<string, Node>();
  for (const s of spans) {
    const start = parseTime(s.start_time).getTime();
    nodes.set(s.span_id, { id: s.span_id, span: s, children: [], depth: 0, start, end: spanEnd(s, start, now), w0: 0, w1: 0 });
  }
  const roots: Node[] = [];
  for (const n of nodes.values()) {
    const parent = n.span!.parent_span_id ? nodes.get(n.span!.parent_span_id) : undefined;
    if (parent) parent.children.push(n);
    else roots.push(n);
  }
  return roots;
}

function finalize(list: Node[], depth: number, w0: number, w1: number) {
  list.sort((a, b) => a.start - b.start);
  for (const n of list) {
    n.depth = depth;
    if (!n.trace) {
      n.w0 = w0;
      n.w1 = w1;
    }
    finalize(n.children, depth + 1, n.trace ? n.start : w0, n.trace ? n.end : w1);
  }
}

function build(spans: TreeSpan[], groupByTrace: boolean, now: number): Node[] {
  if (spans.length === 0) return [];
  if (!groupByTrace) {
    const roots = spanTree(spans, now);
    const all = spans.map((s) => parseTime(s.start_time).getTime());
    const t0 = Math.min(...all);
    const t1 = Math.max(...spans.map((s, i) => spanEnd(s, all[i], now)));
    finalize(roots, 0, t0, t1);
    return roots;
  }
  const byTrace = new Map<string, TreeSpan[]>();
  for (const s of spans) {
    const list = byTrace.get(s.trace_id) ?? [];
    list.push(s);
    byTrace.set(s.trace_id, list);
  }
  const traceNodes: Node[] = [];
  for (const [traceId, list] of byTrace) {
    const roots = spanTree(list, now);
    const starts = list.map((s) => parseTime(s.start_time).getTime());
    const start = Math.min(...starts);
    const end = Math.max(...list.map((s, i) => spanEnd(s, starts[i], now)));
    const first = [...roots].sort((a, b) => a.start - b.start)[0];
    traceNodes.push({
      id: `trace:${traceId}`,
      trace: {
        trace_id: traceId, index: 0, name: first?.span?.name ?? traceId, kind: first?.span?.kind ?? "span",
        spans: list.length, tokens: list.reduce((a, s) => a + s.input_tokens + s.output_tokens, 0),
        cost: list.reduce((a, s) => a + s.cost_usd, 0), errors: list.filter((s) => s.status === "error").length,
        running: list.some((s) => s.status === "running"),
        firstSpanId: first?.id ?? "",
      },
      children: roots, depth: 0, start, end, w0: 0, w1: 0,
    });
  }
  traceNodes.sort((a, b) => a.start - b.start);
  traceNodes.forEach((n, i) => (n.trace!.index = i + 1));
  const t0 = traceNodes[0].start;
  const t1 = Math.max(...traceNodes.map((n) => n.end));
  for (const n of traceNodes) {
    n.w0 = t0;
    n.w1 = t1;
  }
  finalize(traceNodes, 0, t0, t1);
  return traceNodes;
}

// Agent-framework bookkeeping steps (deepagents / LangChain middleware hooks): real
// spans, but instant and empty — hidden by default so the work stands out.
const FRAMEWORK_STEP = /Middleware\.(before|after)_(agent|model)$|^(tools_condition|should_continue)$/;

function isFramework(n: Node) {
  return !!n.span && n.children.length === 0 && FRAMEWORK_STEP.test(n.span.name) && n.span.status !== "error";
}

function flatten(roots: Node[], collapsed: Set<string>, hideFramework: boolean): Node[] {
  const out: Node[] = [];
  const walk = (list: Node[]) => {
    for (const n of list) {
      if (hideFramework && isFramework(n)) continue;
      out.push(n);
      if (!collapsed.has(n.id)) walk(n.children);
    }
  };
  walk(roots);
  return out;
}

/** Per-span diff marks for side-by-side comparison. */
export type SpanMark = "missing" | "extra" | "args" | "not_recorded";

const MARK_STYLE: Record<SpanMark, { row: string; chip: string; label: string }> = {
  missing: { row: "bg-critical/[0.07]", chip: "bg-critical/12 text-critical", label: "missing in other run" },
  extra: { row: "bg-accent-soft/60", chip: "bg-accent/12 text-accent", label: "extra" },
  args: { row: "bg-[#eda100]/[0.09]", chip: "bg-[#eda100]/15 text-[#a06d00] dark:text-[#e0a526]", label: "different args" },
  not_recorded: { row: "bg-critical/[0.07]", chip: "bg-critical/12 text-critical", label: "not recorded" },
};

export function SpanTree({ spans, groupByTrace = false, selectedId, onSelect, onOpenTrace, onOrder, className = "", marks }: {
  spans: TreeSpan[];
  marks?: Map<string, SpanMark>;
  groupByTrace?: boolean;
  selectedId?: string;
  onSelect: (span: TreeSpan) => void;
  onOpenTrace?: (traceId: string) => void;
  /** Visible span ids in display order — lets the caller step with [ and ]. */
  onOrder?: (spanIds: string[]) => void;
  className?: string;
}) {
  const anyRunning = spans.some((s) => s.status === "running");
  const now = useNow(anyRunning);
  const roots = useMemo(() => build(spans, groupByTrace, now), [spans, groupByTrace, now]);
  // Long threads start with only the latest run expanded.
  const [collapsed, setCollapsed] = useState<Set<string>>(() =>
    groupByTrace && roots.length > 3 ? new Set(roots.slice(0, -1).map((n) => n.id)) : new Set());
  const [hideFramework, setHideFrameworkState] = useState(() => {
    try {
      return localStorage.getItem("imagent.steps.framework") !== "1";
    } catch {
      return true;
    }
  });
  const setHideFramework = (hide: boolean) => {
    setHideFrameworkState(hide);
    try {
      localStorage.setItem("imagent.steps.framework", hide ? "0" : "1");
    } catch {
      /* storage unavailable */
    }
  };
  const rows = useMemo(() => flatten(roots, collapsed, hideFramework), [roots, collapsed, hideFramework]);
  const frameworkCount = useMemo(() => {
    let n = 0;
    const walk = (list: Node[]) => list.forEach((x) => { if (isFramework(x)) n += 1; walk(x.children); });
    walk(roots);
    return n;
  }, [roots]);

  useEffect(() => {
    onOrder?.(rows.filter((n) => n.span).map((n) => n.span!.span_id));
  }, [rows, onOrder]);
  useEffect(() => {
    if (selectedId) document.querySelector(`[data-span-id="${selectedId}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const toggle = (id: string) => setCollapsed((c) => {
    const n = new Set(c);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-line px-3 text-[12px] text-ink-3">
        <span className="num">{groupByTrace && roots.length > 1 ? `${roots.length} runs · ` : ""}{spans.length} spans</span>
        <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5 hover:text-ink" title="LangChain/deepagents middleware hooks that do no work">
          <input type="checkbox" className="accent-[var(--accent)]" checked={!hideFramework} onChange={(e) => setHideFramework(!e.target.checked)} />
          Framework steps{frameworkCount > 0 ? ` (${frameworkCount})` : ""}
        </label>
        {groupByTrace && roots.length > 1 && (
          <>
            <button className="hover:text-ink" onClick={() => setCollapsed(new Set())}>Expand all</button>
            <button className="hover:text-ink" onClick={() => setCollapsed(new Set(roots.map((n) => n.id)))}>Collapse all</button>
          </>
        )}
      </div>
      <div className={`min-h-0 flex-1 overflow-auto py-1 ${className}`}>
        {rows.map((n) => {
          const total = Math.max(n.w1 - n.w0, 1);
          const left = ((n.start - n.w0) / total) * 100;
          const width = Math.max(((n.end - n.start) / total) * 100, 0.5);
          const hasKids = n.children.length > 0;
          const isOpen = !collapsed.has(n.id);

          if (n.trace) {
            const t = n.trace;
            return (
              <div key={n.id} onClick={() => toggle(n.id)} onDoubleClick={() => onOpenTrace?.(t.trace_id)}
                className="group grid h-9 cursor-pointer grid-cols-[minmax(0,1fr)_minmax(110px,26%)] items-center gap-4 border-t border-line/70 px-3 first:border-t-0 hover:bg-hover">
                <div className="flex min-w-0 items-center gap-2">
                  <Icon.chevronRight size={13} className={`shrink-0 text-ink-3 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                  <span className="num w-5 shrink-0 text-right text-[11.5px] text-ink-3">{t.index}</span>
                  <KindIcon kind={t.kind} size={13} />
                  <span className="min-w-[5rem] shrink-0 truncate font-medium" style={{ maxWidth: "60%" }}>{t.name}</span>
                  {t.running && <span className="shrink-0 text-[11.5px] text-accent">running</span>}
                  {t.errors > 0 && <span className="shrink-0 text-[11.5px] text-critical">{t.errors} failed</span>}
                  <span className="num ml-auto min-w-0 truncate pl-3 text-[11.5px] text-ink-3">
                    {fmtTime(new Date(n.start).toISOString())} · {fmtNum(t.tokens)} tok · {fmtCost(t.cost)}
                  </span>
                  {onOpenTrace && (
                    <button className="shrink-0 text-ink-3 opacity-0 hover:text-ink group-hover:opacity-100" title="Open run"
                      onClick={(e) => { e.stopPropagation(); onOpenTrace(t.trace_id); }}>
                      <Icon.external size={13} />
                    </button>
                  )}
                </div>
                <Bar left={left} width={width} color={t.errors ? "bg-critical/80" : BAR_COLOR.trace} running={t.running}
                  label={t.running ? elapsed(new Date(n.start).toISOString(), now) : fmtDuration(n.end - n.start)} title={`Run ${t.index} · ${fmtDuration(n.end - n.start)} (scale: whole thread)`} />
              </div>
            );
          }

          const s = n.span!;
          const isSel = s.span_id === selectedId;
          const failed = s.status === "error";
          const running = s.status === "running";
          const mark = marks?.get(s.span_id);
          return (
            <div key={n.id} data-span-id={s.span_id} onClick={() => onSelect(s)}
              className={`grid h-7 cursor-pointer grid-cols-[minmax(0,1fr)_minmax(110px,26%)] items-center gap-4 px-3 ${isSel ? "bg-accent-soft shadow-[inset_2px_0_0_var(--accent)]" : `${mark ? MARK_STYLE[mark].row : ""} hover:bg-hover`}`}>
              <div className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: n.depth * 16 }}>
                {hasKids ? (
                  <button className="flex size-4 shrink-0 items-center justify-center text-ink-3 hover:text-ink" aria-label={isOpen ? "Collapse" : "Expand"}
                    onClick={(e) => { e.stopPropagation(); toggle(n.id); }}>
                    <Icon.chevronRight size={12} className={`transition-transform ${isOpen ? "rotate-90" : ""}`} />
                  </button>
                ) : <span className="size-4 shrink-0" />}
                <KindIcon kind={s.kind} size={13} />
                <span className={`truncate ${failed ? "text-critical" : s.kind === "node" || s.kind === "chain" ? "text-ink-2" : "text-ink"}`}>{s.name}</span>
                {running && <span className="shrink-0 text-[11.5px] text-accent">running</span>}
                {mark && <span className={`shrink-0 rounded px-1 text-[10.5px] font-medium ${MARK_STYLE[mark].chip}`}>{MARK_STYLE[mark].label}</span>}
                {s.kind === "llm" && s.input_tokens + s.output_tokens > 0 && (
                  <span className="num shrink-0 text-[11.5px] text-ink-3">{fmtNum(s.input_tokens + s.output_tokens)}</span>
                )}
              </div>
              <Bar left={left} width={width} color={failed ? "bg-critical/80" : running ? "bg-accent/70" : BAR_COLOR[s.kind] ?? BAR_COLOR.span}
                running={running} label={running ? elapsed(s.start_time, now) : fmtDuration(s.duration_ms)} title={`${fmtDuration(s.duration_ms)} · starts +${fmtDuration(n.start - n.w0)}`} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Bar({ left, width, color, label, title, running = false }: {
  left: number; width: number; color: string; label: string; title: string; running?: boolean;
}) {
  const l = Math.min(left, 99.5);
  const w = Math.min(width, 100 - l);
  return (
    <div className="flex items-center gap-2" title={running ? `${title} · still running` : title}>
      <div className="relative h-3.5 flex-1">
        <div className={`absolute inset-y-[3px] rounded-[2px] ${color} ${running ? "animate-pulse rounded-r-none" : ""}`} style={{ left: `${l}%`, width: `${w}%` }} />
        {running && <div className="absolute inset-y-[1px] w-[2px] rounded bg-accent" style={{ left: `calc(${Math.min(l + w, 100)}% - 1px)` }} />}
      </div>
      <span className={`num w-12 shrink-0 text-right text-[11px] ${running ? "text-accent" : "text-ink-3"}`}>{label}</span>
    </div>
  );
}
