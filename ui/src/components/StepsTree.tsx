import { useEffect, useMemo, useRef, useState } from "react";
import { fmtDuration } from "../lib/format";
import { childrenOf, isScope, stepsOf, ts, type FlowSpan, type Step } from "./FlowView";
import { Icon, KindIcon } from "./icons";
import type { Player } from "./Replay";

interface Row {
  key: string;
  span: FlowSpan;
  label: string;
  kind: string;
  depth: number;
  agent?: { name: string; sub: boolean };  // agent / sub-agent rows
  hasKids: boolean;
}

/** The run as a tree of steps: main agent → LLM/tool calls → sub-agents (collapsible) → their steps.
 *  Normal mode: click selects a step. Replay: shows ✓ ● ○ progress and click jumps there. */
export function StepsTree({ spans, selectedId, onSelect, player, onOrder, onOpenTrace, onExpand, title = "Steps" }: {
  spans: FlowSpan[];
  /** Show the full tree in the main panel instead of the canvas. */
  onExpand?: () => void;
  /** Thread view: open a run on its own page. */
  onOpenTrace?: (traceId: string) => void;
  selectedId?: string;
  onSelect?: (span: FlowSpan) => void;
  player?: Player;
  onOrder?: (ids: string[]) => void;
  title?: string;
}) {
  const byId = useMemo(() => new Map(spans.map((s) => [s.span_id, s])), [spans]);
  const kids = useMemo(() => childrenOf(spans), [spans]);
  const runs = useMemo(() => {
    const roots = spans.filter((s) => !byId.has(s.parent_span_id)).sort((a, b) => ts(a) - ts(b));
    return roots.map((r) => (r.name.startsWith("replay:") ? (kids.get(r.span_id) ?? []).find((c) => isScope(c, byId)) ?? r : r));
  }, [spans, byId, kids]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [framework, setFramework] = useState(() => {
    try {
      return localStorage.getItem("imagent.steps.framework") === "1";
    } catch {
      return false;
    }
  });
  const toggleFramework = (v: boolean) => {
    setFramework(v);
    try {
      localStorage.setItem("imagent.steps.framework", v ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  };

  const rows = useMemo(() => {
    const out: Row[] = [];
    const addScope = (scope: FlowSpan, depth: number) => {
      for (const st of stepsOf(scope, byId, kids)) addStep(st, depth);
    };
    const addStep = (st: Step, depth: number) => {
      const sub = st.subScope && st.subScope.span_id !== st.span.span_id ? st.subScope : undefined;
      const isSub = !!sub || st.kind === "agent";
      out.push({
        key: st.span.span_id, span: st.span, kind: isSub ? "agent" : st.kind, depth, hasKids: isSub,
        label: st.kind === "llm" ? st.span.model || st.span.name : sub ? sub.name : st.span.name,
        agent: isSub ? { name: sub ? sub.name : st.span.name, sub: true } : undefined,
      });
      if (isSub && !collapsed.has(st.span.span_id)) addScope(sub ?? st.span, depth + 1);
    };
    // Framework steps on: every recorded span (LangGraph nodes, middleware hooks, routing), as nested.
    const addRaw = (sp: FlowSpan, depth: number) => {
      const children = kids.get(sp.span_id) ?? [];
      const agentish = isScope(sp, byId);
      out.push({
        key: sp.span_id, span: sp, kind: agentish ? "agent" : sp.kind, depth, hasKids: children.length > 0,
        label: sp.kind === "llm" ? sp.model || sp.name : sp.name,
        agent: agentish ? { name: sp.name, sub: depth > 0 } : undefined,
      });
      if (!collapsed.has(sp.span_id)) for (const c of children) addRaw(c, depth + 1);
    };
    for (const r of runs) {
      if (framework) {
        addRaw(r, 0);
        continue;
      }
      out.push({ key: r.span_id, span: r, label: r.name, kind: "agent", depth: 0, hasKids: true, agent: { name: r.name, sub: false } });
      if (!collapsed.has(r.span_id)) addScope(r, 1);
    }
    return out;
  }, [runs, byId, kids, collapsed, framework]);

  useEffect(() => { onOrder?.(rows.map((r) => r.key)); }, [rows, onOrder]);

  const replay = !!player?.on;
  const activeId = replay ? player?.current?.span.span_id : selectedId;
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!activeId || (replay && !player?.follow)) return;
    list.current?.querySelector(`[data-step="${activeId}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);  // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id: string) => setCollapsed((c) => {
    const n = new Set(c);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  const steps = rows.filter((r) => r.kind === "llm" || r.kind === "tool");
  const done = replay ? steps.filter((r) => player!.phaseOf(r.span) === "done").length : 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 px-4 pb-1.5 pt-2.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">
        <span>{title}</span>
        <span className="num normal-case tracking-normal">
          {replay ? `${done} / ${steps.length} done` : `${steps.filter((r) => r.kind === "llm").length} LLM · ${steps.filter((r) => r.kind === "tool").length} tools`}
        </span>
        <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5 font-normal normal-case tracking-normal hover:text-ink"
          title="Also show LangGraph nodes, middleware hooks and routing — the plumbing between steps">
          <input type="checkbox" className="accent-[var(--accent)]" checked={framework} onChange={(e) => toggleFramework(e.target.checked)} />
          Framework steps
        </label>
        {onExpand && (
          <button onClick={onExpand} title="Open the full tree in the main panel"
            className="inline-flex items-center gap-1 rounded px-1 py-0.5 font-normal normal-case tracking-normal text-ink-3 hover:bg-subtle hover:text-ink">
            ⤢ Expand
          </button>
        )}
      </div>
      <div ref={list} className="min-h-0 flex-1 overflow-auto pb-2" role="tree">
        {rows.map((r) => {
          const phase = replay ? player!.phaseOf(r.span) : undefined;
          const active = r.key === activeId;
          const failed = r.span.status === "error";
          const tone = r.agent ? (r.agent.sub ? "text-[#4a3aa7] dark:text-[#b8b0f2]" : "text-[#2a78d6] dark:text-[#6da7ec]") : "";
          return (
            <div key={r.key} data-step={r.key} role="treeitem" aria-selected={active}
              onClick={() => (replay ? player!.seek(ts(r.span) - player!.t0 + 1) : onSelect?.(r.span))}
              className={`group flex h-7 cursor-pointer items-center gap-1.5 pr-3 text-[12.5px] ${active ? "bg-accent-soft shadow-[inset_2px_0_0_var(--accent)]" : "hover:bg-hover"}`}
              style={{ paddingLeft: 10 + r.depth * 16 }}>
              {r.hasKids ? (
                <button onClick={(e) => { e.stopPropagation(); toggle(r.key); }} aria-label={collapsed.has(r.key) ? "Expand" : "Collapse"}
                  className="flex size-4 shrink-0 items-center justify-center text-ink-3 hover:text-ink">
                  <Icon.chevronRight size={12} className={`transition-transform ${collapsed.has(r.key) ? "" : "rotate-90"}`} />
                </button>
              ) : <span className="size-4 shrink-0" />}
              {replay && (r.kind === "llm" || r.kind === "tool") && (
                <span className={`w-3 shrink-0 text-center text-[11px] ${phase === "done" ? "text-good" : phase === "running" ? "text-accent" : "text-ink-3/50"}`}>
                  {phase === "done" ? "✓" : phase === "running" ? "●" : "○"}
                </span>
              )}
              <KindIcon kind={r.kind} size={13} />
              {r.agent && (
                <span className={`shrink-0 text-[9.5px] font-semibold uppercase tracking-[0.05em] ${tone}`}>{r.agent.sub ? "Sub-agent" : "Agent"}</span>
              )}
              <span className={`truncate ${r.agent ? "font-medium" : ""} ${phase === "pending" ? "text-ink-3" : failed ? "text-critical" : "text-ink"}`}>{r.label}</span>
              {failed && <Icon.x size={12} className="shrink-0 text-critical" />}
              {onOpenTrace && r.depth === 0 && (
                <button onClick={(e) => { e.stopPropagation(); onOpenTrace(r.span.trace_id); }} title="Open this run"
                  className="shrink-0 text-ink-3 opacity-0 hover:text-ink group-hover:opacity-100"><Icon.external size={12} /></button>
              )}
              <span className="num ml-auto shrink-0 pl-2 text-[11px] text-ink-3">
                {phase === "running" && player ? <span className="text-accent">{fmtDuration(Math.max(0, player.vnow - ts(r.span)))}</span> : fmtDuration(r.span.duration_ms)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
