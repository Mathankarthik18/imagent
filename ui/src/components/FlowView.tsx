import { Background, Controls, Handle, MiniMap, Position, ReactFlow, useNodesState, type Edge, type Node, type NodeProps, type ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Span } from "../lib/api";

/** Fields the canvas needs — full spans and the thread endpoint's lite spans both fit. */
export type FlowSpan = Pick<Span, "span_id" | "parent_span_id" | "trace_id" | "name" | "kind" | "status" | "start_time" |
  "duration_ms" | "model" | "input_tokens" | "output_tokens" | "cost_usd">;
import { fmtCost, fmtDuration, fmtNum, parseTime } from "../lib/format";
import { elapsed, useNow } from "../lib/live";
import { useAppState } from "../lib/state";
import { Icon, KindIcon } from "./icons";
import type { Player } from "./Replay";

/** One box on the canvas: an LLM call, a tool call, or a nested agent. */
export interface Step {
  span: FlowSpan;
  kind: "llm" | "tool" | "agent" | "retriever" | "span";
  /** Scope you can open (a sub-agent run by this tool, or a nested agent). */
  subScope?: FlowSpan;
  subCounts?: { llm: number; tools: number };
}

const NODE_W = 232;
const NODE_H = 58;
const COL_GAP = 70;
const ROW_GAP = 22;

export function ts(s: FlowSpan) {
  return parseTime(s.start_time).getTime();
}

/** Spans that start a flow of their own: the run root, agents, and sub-agent graphs a tool runs. */
export function isScope(s: FlowSpan, byId: Map<string, FlowSpan>) {
  if (s.kind === "agent") return true;
  const parent = byId.get(s.parent_span_id);
  return s.kind === "chain" && parent?.kind === "tool";
}

export function childrenOf(spans: FlowSpan[]) {
  const m = new Map<string, FlowSpan[]>();
  for (const s of spans) {
    const list = m.get(s.parent_span_id) ?? [];
    list.push(s);
    m.set(s.parent_span_id, list);
  }
  for (const list of m.values()) list.sort((a, b) => ts(a) - ts(b));
  return m;
}

/** Steps directly inside a scope, skipping LangGraph plumbing (model/tools nodes, middleware). */
export function stepsOf(scope: FlowSpan, byId: Map<string, FlowSpan>, kids: Map<string, FlowSpan[]>): Step[] {
  const out: Step[] = [];
  const firstScopeBelow = (s: FlowSpan): FlowSpan | undefined => {
    for (const c of kids.get(s.span_id) ?? []) {
      if (isScope(c, byId)) return c;
      const deeper = firstScopeBelow(c);
      if (deeper) return deeper;
    }
    return undefined;
  };
  const walk = (s: FlowSpan) => {
    for (const c of kids.get(s.span_id) ?? []) {
      if (c.kind === "llm" || c.kind === "retriever") out.push({ span: c, kind: c.kind });
      else if (c.kind === "tool") {
        const sub = firstScopeBelow(c);
        out.push({ span: c, kind: "tool", subScope: sub, subCounts: sub ? counts(sub, byId, kids) : undefined });
      } else if (isScope(c, byId)) {
        out.push({ span: c, kind: "agent", subScope: c, subCounts: counts(c, byId, kids) });
      } else walk(c); // node / chain / span plumbing → look inside
    }
  };
  walk(scope);
  return out.sort((a, b) => ts(a.span) - ts(b.span));
}

export function counts(scope: FlowSpan, byId: Map<string, FlowSpan>, kids: Map<string, FlowSpan[]>) {
  const steps = stepsOf(scope, byId, kids);
  return { llm: steps.filter((s) => s.kind === "llm").length, tools: steps.filter((s) => s.kind === "tool").length };
}

/** Columns left→right; tool calls fired by the same LangGraph step run in parallel → one column. */
function columns(steps: Step[]): Step[][] {
  const cols: Step[][] = [];
  for (const st of steps) {
    const prev = cols[cols.length - 1];
    if (prev && st.kind === "tool" && prev[0].kind === "tool" && prev[0].span.parent_span_id === st.span.parent_span_id) prev.push(st);
    else cols.push([st]);
  }
  return cols;
}

/** Visual role of a node: the run's main agent, a sub-agent, or a step inside an agent. */
type Role = "main" | "sub" | "llm" | "tool" | "other";

export type FlowDir = "TB" | "LR";
/** Replay playback: where a step is at the current playback time. */
type Phase = "pending" | "running" | "done";

type StepNodeData = { step: Step; role: Role; selected: boolean; running: boolean; now: number; onOpen?: () => void; isRoot?: boolean; expandLabel?: string; dir: FlowDir; phase?: Phase };

/** Icon tile per role — the only colour on a card; the card itself stays neutral. */
const TILE: Record<Role, { tile: string; kind: string; label: string }> = {
  main: { tile: "bg-[#2a78d6] text-white dark:bg-[#3987e5]", kind: "agent", label: "Main agent" },
  sub: { tile: "bg-[#4a3aa7]/12 text-[#4a3aa7] dark:bg-[#9085e9]/20 dark:text-[#c3bcf5]", kind: "agent", label: "Sub-agent" },
  llm: { tile: "bg-[#1baf7a]/12 text-[#12855c] dark:bg-[#1baf7a]/20 dark:text-[#4fd1a0]", kind: "llm", label: "LLM call" },
  tool: { tile: "bg-[#eb6834]/12 text-[#c24f1f] dark:bg-[#eb6834]/20 dark:text-[#f59366]", kind: "tool", label: "Tool" },
  other: { tile: "bg-subtle text-ink-3", kind: "span", label: "Step" },
};

function Tile({ role, size = 32 }: { role: Role; size?: number }) {
  const t = TILE[role];
  return (
    <span className={`flex shrink-0 items-center justify-center rounded-lg ${t.tile}`} style={{ width: size, height: size }}>
      <KindIcon kind={t.kind} size={Math.round(size * 0.47)} className="!text-current" />
    </span>
  );
}

export function FlowLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-bg/90 px-2 py-1 text-[11px] text-ink-3 backdrop-blur">
      {(["main", "sub", "llm", "tool"] as Role[]).map((r) => (
        <span key={r} className="inline-flex items-center gap-1.5"><Tile role={r} size={16} /> {TILE[r].label}</span>
      ))}
    </div>
  );
}

/** Edges attach to invisible handles so cards keep a clean outline. */
const HANDLE = "!size-1.5 !min-h-0 !min-w-0 !border-0 !bg-transparent";

function StepNode({ data }: NodeProps<Node<StepNodeData>>) {
  const { step, role, selected, running, now, onOpen, isRoot } = data;
  const s = step.span;
  const failed = s.status === "error";
  const agentish = role === "main" || role === "sub";
  // A sub-agent reached through a tool is named after the agent it runs, not the tool.
  const title = step.kind === "llm" ? (s.model || s.name) : role === "sub" && step.subScope && step.kind === "tool" ? step.subScope.name : s.name;
  const border = failed ? "border-critical/70" : running || selected ? "border-accent" : role === "main" ? "border-[#2a78d6]/50" : "border-line-strong";
  return (
    <div className={`flex items-center gap-2.5 rounded-xl border bg-bg px-2.5 shadow-[0_1px_2px_rgb(0_0_0/0.06)] transition-[opacity,filter,box-shadow] duration-300 ${border} ${selected ? "shadow-[0_0_0_3px_var(--accent-soft)]" : ""} ${running ? "animate-pulse shadow-[0_0_0_4px_var(--accent-soft)]" : ""} ${data.phase === "pending" ? "opacity-30 grayscale" : ""}`}
      style={{ width: NODE_W, height: NODE_H }}
      title={role === "sub" && step.kind === "tool" ? `Sub-agent ${title}, started by the ${s.name} tool` : title}>
      {!isRoot && <Handle type="target" position={data.dir === "TB" ? Position.Top : Position.Left} className={HANDLE} />}
      <Handle type="source" position={data.dir === "TB" ? Position.Bottom : Position.Right} className={HANDLE} />
      <Tile role={role} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12.5px] font-medium text-ink">{title}</span>
          {failed && <Icon.x size={13} className="shrink-0 text-critical" />}
        </div>
        <div className="num mt-0.5 flex items-center gap-1 truncate text-[11px] text-ink-3">
          {running ? <span className="text-accent">running {elapsed(s.start_time, now)}</span> : (
            <span className="truncate">
              {agentish && <>{TILE[role].label} · </>}
              {fmtDuration(s.duration_ms)}
              {step.kind === "llm" && s.input_tokens + s.output_tokens > 0 && <> · {fmtNum(s.input_tokens + s.output_tokens)} tok</>}
              {step.kind === "llm" && s.cost_usd > 0 && <> · {fmtCost(s.cost_usd)}</>}
            </span>
          )}
        </div>
      </div>
      {step.subScope && onOpen && (
        <button onClick={(e) => { e.stopPropagation(); onOpen(); }}
          title={`${data.expandLabel ?? "Open"} · ${step.subCounts?.llm ?? 0} LLM, ${step.subCounts?.tools ?? 0} tools`}
          className="nodrag flex size-6 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-subtle hover:text-ink">
          <Icon.chevronRight size={14} />
        </button>
      )}
    </div>
  );
}

type GroupNodeData = StepNodeData & { onToggle: () => void; width: number; height: number };

const GROUP_PAD = 16;
const GROUP_HEAD = 48;

/** An expanded sub-agent: a framed area with its LLM/tool steps laid out inside. */
function GroupNode({ data }: NodeProps<Node<GroupNodeData>>) {
  const { step, selected, running, now, onToggle, width, height } = data;
  const s = step.span;
  const name = step.subScope?.name ?? s.name;
  const failed = s.status === "error";
  const c = step.subCounts;
  return (
    <div className={`relative rounded-2xl border bg-[#4a3aa7]/[0.03] transition-opacity duration-300 dark:bg-[#9085e9]/[0.05] ${failed ? "border-critical/70" : running || selected ? "border-accent" : "border-[#4a3aa7]/25 dark:border-[#9085e9]/30"} ${selected ? "shadow-[0_0_0_3px_var(--accent-soft)]" : ""} ${data.phase === "pending" ? "opacity-30" : ""}`}
      style={{ width, height }}>
      <Handle type="target" position={data.dir === "TB" ? Position.Top : Position.Left} className={HANDLE} />
      <Handle type="source" position={data.dir === "TB" ? Position.Bottom : Position.Right} className={HANDLE} />
      <div className="flex items-center gap-2.5 border-b border-[#4a3aa7]/15 px-3 dark:border-[#9085e9]/20" style={{ height: GROUP_HEAD }}
        title={step.kind === "tool" ? `Sub-agent ${name}, started by the ${s.name} tool` : name}>
        <Tile role="sub" size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12.5px] font-medium text-ink">{name}</span>
            {failed && <Icon.x size={13} className="shrink-0 text-critical" />}
          </div>
          <div className="num truncate text-[11px] text-ink-3">
            Sub-agent{c && <> · {c.llm} LLM · {c.tools} tools</>}{step.kind === "tool" && <> · via {s.name}</>}
          </div>
        </div>
        <span className="num shrink-0 text-[11.5px] text-ink-3">
          {running ? <span className="text-accent">{elapsed(s.start_time, now)}</span> : fmtDuration(s.duration_ms)}
        </span>
        <button onClick={(e) => { e.stopPropagation(); onToggle(); }} title="Collapse to one node"
          className="nodrag flex size-6 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-subtle hover:text-ink">
          <Icon.chevronDown size={14} />
        </button>
      </div>
    </div>
  );
}

// Not "group": React Flow styles that built-in type with its own border/padding (the double box).
const nodeTypes = { step: StepNode, subagent: GroupNode };

/** n8n-style canvas: steps left→right; open sub-agents with ▸, back via the breadcrumb.
 *  With several runs (a thread) the top level is the runs themselves, in order. */
export function FlowView({ spans, selectedId, onSelect, player }: {
  spans: FlowSpan[]; selectedId?: string; onSelect: (span: FlowSpan) => void;
  /** Replay player (see Replay.tsx): drives which steps are pending / running / done. */
  player?: Player;
}) {
  const { theme } = useAppState();
  const byId = useMemo(() => new Map(spans.map((s) => [s.span_id, s])), [spans]);
  const kids = useMemo(() => childrenOf(spans), [spans]);
  // Each run's entry point; an experiment wrapper ("replay:x") opens on its agent directly.
  const runs = useMemo(() => {
    const roots = spans.filter((s) => !byId.has(s.parent_span_id)).sort((a, b) => ts(a) - ts(b));
    return roots.map((r) => (r.name.startsWith("replay:") ? (kids.get(r.span_id) ?? []).find((c) => isScope(c, byId)) ?? r : r));
  }, [spans, byId, kids]);
  const multi = runs.length > 1;
  const [path, setPath] = useState<string[]>([]);
  const scopeId = path[path.length - 1] ?? (multi ? undefined : runs[0]?.span_id);
  const scope = scopeId ? byId.get(scopeId) : undefined;
  const anyRunning = spans.some((s) => s.status === "running");
  const now = useNow(anyRunning);
  const runIds = useMemo(() => new Set(runs.map((r) => r.span_id)), [runs]);
  const roleOf = (step: Step, header: boolean): Role => {
    if (step.kind === "agent") return runIds.has(step.span.span_id) && (header || !scope) ? "main" : "sub";
    if (step.kind === "tool" && step.subScope) return "sub";
    if (step.kind === "llm") return "llm";
    if (step.kind === "tool") return "tool";
    return "other";
  };

  // Top-to-bottom fits the tall panel; left-to-right is one click away.
  const [dir, setDirState] = useState<FlowDir>(() => {
    try {
      return localStorage.getItem("imagent.flow.dir") === "LR" ? "LR" : "TB";
    } catch {
      return "TB";
    }
  });
  const setDir = (d: FlowDir) => {
    setDirState(d);
    try {
      localStorage.setItem("imagent.flow.dir", d);
    } catch {
      /* storage unavailable */
    }
  };

  // Sub-agents are expanded inline by default; this holds the ones the user collapsed.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setCollapsed((c) => {
    const n = new Set(c);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  const { nodes, edges, bounds } = useMemo(() => {
    const nodes: Node<StepNodeData>[] = [];
    const edges: Edge[] = [];
    const edgeStyle = (target: FlowSpan) => {
      const live = target.status === "running";
      return { type: "smoothstep" as const, animated: live,
        style: { stroke: target.status === "error" ? "var(--critical)" : live ? "var(--accent)" : "var(--border-strong)", strokeWidth: 1.5 } };
    };
    type Item = { step: Step; id: string; w: number; h: number; group?: { cols: Item[][]; innerW: number; innerH: number } };
    const TB = dir === "TB";
    const MAIN_GAP = TB ? 42 : COL_GAP;   // between consecutive steps
    const CROSS_GAP = TB ? 26 : ROW_GAP;  // between parallel steps
    const main = (i: { w: number; h: number }) => (TB ? i.h : i.w);
    const cross = (i: { w: number; h: number }) => (TB ? i.w : i.h);

    /** Size a scope's ranks (recursively expanding sub-agents). Returns real width/height. */
    const measure = (cols: Step[][], depth: number): { items: Item[][]; w: number; h: number } => {
      const items = cols.map((col) => col.map((step): Item => {
        const sub = step.subScope;
        const expandable = !!sub && step.span.span_id !== sub.span_id && depth < 6;
        const gid = `g:${step.span.span_id}`;
        if (expandable && !collapsed.has(gid)) {
          const inner = measure(columns(stepsOf(sub!, byId, kids)), depth + 1);
          if (inner.items.length) {
            return { step, id: gid, w: Math.max(inner.w + 2 * GROUP_PAD, 300), h: inner.h + GROUP_HEAD + 2 * GROUP_PAD,
                     group: { cols: inner.items, innerW: inner.w, innerH: inner.h } };
          }
        }
        return { step, id: step.span.span_id, w: NODE_W, h: NODE_H };
      }));
      const rankMain = items.map((c) => Math.max(...c.map(main)));
      const rankCross = items.map((c) => c.reduce((a, i) => a + cross(i), 0) + CROSS_GAP * (c.length - 1));
      const totalMain = rankMain.reduce((a, x) => a + x, 0) + MAIN_GAP * Math.max(items.length - 1, 0);
      const totalCross = Math.max(0, ...rankCross);
      return { items, w: TB ? totalCross : totalMain, h: TB ? totalMain : totalCross };
    };

    /** Place measured ranks inside a frame of size (w,h) at offset and emit nodes/edges. */
    const place = (items: Item[][], w: number, h: number, parentId: string | undefined, offX: number, offY: number, isHeaderLevel: boolean) => {
      let m = 0;
      const crossSize = TB ? w : h;
      items.forEach((col, ci) => {
        const rMain = Math.max(...col.map(main));
        const rCross = col.reduce((a, i) => a + cross(i), 0) + CROSS_GAP * (col.length - 1);
        let c = (crossSize - rCross) / 2;
        for (const it of col) {
          const mOff = (rMain - main(it)) / 2;
          const px = offX + (TB ? c : m + mOff);
          const py = offY + (TB ? m + mOff : c);
          const header = isHeaderLevel && ci === 0;
          const common = { selected: it.step.span.span_id === selectedId, running: it.step.span.status === "running", now, dir };
          if (it.group) {
            nodes.push({
              id: it.id, type: "subagent", position: { x: px, y: py }, parentId, width: it.w, height: it.h, draggable: true,
              data: { step: it.step, role: "sub", ...common, onToggle: () => toggle(it.id), width: it.w, height: it.h } as GroupNodeData,
            } as Node<StepNodeData>);
            place(it.group.cols, it.w - 2 * GROUP_PAD, it.group.innerH, it.id, GROUP_PAD, GROUP_HEAD + GROUP_PAD, false);
          } else {
            const gid = `g:${it.step.span.span_id}`;
            const canExpand = it.step.subScope && it.step.subScope.span_id !== it.step.span.span_id;
            nodes.push({
              id: it.id, type: "step", position: { x: px, y: py }, parentId, extent: parentId ? "parent" : undefined, draggable: true,
              data: {
                step: it.step, role: roleOf(it.step, header), ...common, isRoot: header,
                onOpen: canExpand ? () => toggle(gid) : it.step.subScope && it.step.subScope.span_id !== scopeId && !scope
                  ? () => setPath((p) => [...p, it.step.subScope!.span_id]) : undefined,
                expandLabel: canExpand ? "expand" : undefined,
              },
            });
          }
          c += cross(it) + CROSS_GAP;
        }
        if (ci > 0) {
          for (const prev of items[ci - 1]) for (const cur of col) {
            edges.push({ id: `${prev.id}->${cur.id}`, source: prev.id, target: cur.id, ...edgeStyle(cur.step.span) });
          }
        }
        m += rMain + MAIN_GAP;
      });
    };

    let cols: Step[][];
    if (scope) cols = [[{ span: scope, kind: "agent" }], ...columns(stepsOf(scope, byId, kids))];
    else cols = runs.map((r) => [{ span: r, kind: "agent" as const, subScope: r, subCounts: counts(r, byId, kids) }]);
    // Thread level shows runs compactly; inside a run every sub-agent is expanded.
    const m = scope ? measure(cols, 0) : measure(cols.map((c) => c.map((st) => ({ ...st, subScope: undefined }))), 99);
    if (!scope) m.items.forEach((c, ci) => c.forEach((it, ri) => { it.step = cols[ci][ri]; }));  // runs stay compact
    place(m.items, m.w, m.h, undefined, 0, 0, true);
    return { nodes, edges, bounds: { w: m.w, h: m.h } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, scopeId, runs, byId, kids, selectedId, now, collapsed, dir]);

  // ── Replay playback (clock owned by the parent's player) ──
  const replayOn = !!player?.on;
  const vnow = player?.vnow ?? 0;
  const shownNodes = useMemo(() => (replayOn && player ? nodes.map((n) => {
    const phase = player.phaseOf(n.data.step.span);
    return { ...n, data: { ...n.data, phase, running: phase === "running", now: vnow } };
  }) : nodes), [replayOn, nodes, vnow]);  // eslint-disable-line react-hooks/exhaustive-deps
  const shownEdges = useMemo(() => (replayOn ? edges.map((e) => {
    const target = shownNodes.find((n) => n.id === e.target);
    const phase = target?.data.phase;
    return { ...e, animated: phase === "running",
      style: { ...e.style, stroke: phase === "running" ? "var(--accent)" : e.style?.stroke, opacity: phase === "pending" ? 0.15 : 1,
               strokeWidth: phase === "running" ? 2 : 1.5 } };
  }) : edges), [replayOn, edges, shownNodes]);
  const rfRef = useRef<ReactFlowInstance<Node<StepNodeData>, Edge> | null>(null);
  // Camera follows the step that's playing (when it's on this canvas).
  const currentId = replayOn ? player?.current?.span.span_id : undefined;
  useEffect(() => {
    const rf = rfRef.current;
    if (!replayOn || !player?.follow || !rf || !currentId) return;
    const n = rf.getInternalNode(currentId);
    if (!n) return;
    const pos = n.internals.positionAbsolute;
    rf.setCenter(pos.x + NODE_W / 2, pos.y + NODE_H / 2, { zoom: rf.getZoom(), duration: 450 });
  }, [currentId, replayOn, player?.follow]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Draggable nodes: user-moved positions are remembered per view (and survive live updates).
  const viewKey = `${scopeId ?? "__runs"}:${dir}`;
  const moved = useRef(new Map<string, { x: number; y: number }>());
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node<StepNodeData>>([]);
  useEffect(() => {
    // Keep React Flow's measured sizes: a node object without them is hidden until
    // re-measured, which made nodes and edges vanish while playback re-renders each frame.
    setRfNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return shownNodes.map((n) => {
        const p = moved.current.get(`${viewKey}:${n.id}`);
        const old = prevById.get(n.id);
        return { ...n, ...(p ? { position: p } : {}), ...(old?.measured ? { measured: old.measured } : {}) };
      });
    });
  }, [shownNodes, viewKey, setRfNodes]);
  const hasMoved = [...moved.current.keys()].some((k) => k.startsWith(`${viewKey}:`));
  const [, force] = useState(0);
  const resetLayout = () => {
    for (const k of [...moved.current.keys()]) if (k.startsWith(`${viewKey}:`)) moved.current.delete(k);
    setRfNodes(nodes);
    force((x) => x + 1);
  };

  // Open at a readable size from the left (like n8n) instead of shrinking long runs to fit.
  const box = useRef<HTMLDivElement>(null);
  const onInit = (rf: ReactFlowInstance<Node<StepNodeData>, Edge>) => {
    rfRef.current = rf;
    const el = box.current;
    if (!el || nodes.length === 0) return;
    if (dir === "TB") {
      const zoom = Math.max(0.55, Math.min(1, (el.clientWidth - 60) / bounds.w));
      rf.setViewport({ x: el.clientWidth / 2 - (bounds.w / 2) * zoom, y: 56, zoom });
    } else {
      const zoom = Math.max(0.55, Math.min(1, (el.clientWidth - 80) / bounds.w, (el.clientHeight - 140) / bounds.h));
      rf.setViewport({ x: 40, y: el.clientHeight / 2 - (bounds.h / 2) * zoom, zoom });
    }
  };

  if (runs.length === 0) return null;
  const trail = path.map((id) => byId.get(id)).filter(Boolean) as FlowSpan[];
  const crumbs: { key: string; label: string; depth: number }[] = multi
    ? [{ key: "thread", label: `Thread · ${runs.length} runs`, depth: 0 }, ...trail.map((c, i) => ({ key: c.span_id, label: c.name, depth: i + 1 }))]
    : [{ key: runs[0].span_id, label: runs[0].name, depth: 0 }, ...trail.map((c, i) => ({ key: c.span_id, label: c.name, depth: i + 1 }))];

  return (
    <div ref={box} className="relative h-full w-full">
      <div className="absolute left-3 top-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-1 rounded-md border border-line bg-bg/90 px-2 py-1 text-[12px] backdrop-blur">
        {crumbs.map((c, i) => (
          <span key={c.key} className="inline-flex items-center gap-1">
            {i > 0 && <Icon.chevronRight size={11} className="text-ink-3" />}
            <button onClick={() => setPath(path.slice(0, c.depth))} disabled={i === crumbs.length - 1}
              className={i === crumbs.length - 1 ? "font-medium text-ink" : "text-ink-3 hover:text-ink"}>{c.label}</button>
          </span>
        ))}
      </div>
      <div className="absolute bottom-3 left-14 right-[13.5rem] z-10 flex flex-wrap items-end gap-2 max-sm:hidden">
        {hasMoved && (
          <button onClick={resetLayout} className="rounded-md border border-line bg-bg/90 px-2 py-1 text-[11.5px] text-ink-2 backdrop-blur hover:text-ink">
            Reset layout
          </button>
        )}
        <div className="inline-flex h-[26px] items-center rounded-md border border-line bg-bg/90 p-0.5 text-[11.5px] backdrop-blur" role="tablist" aria-label="Layout direction">
          {(["TB", "LR"] as const).map((d) => (
            <button key={d} onClick={() => setDir(d)} aria-selected={dir === d} title={d === "TB" ? "Top to bottom" : "Left to right"}
              className={`h-5 rounded px-1.5 ${dir === d ? "bg-subtle font-medium text-ink" : "text-ink-3 hover:text-ink"}`}>
              {d === "TB" ? "↓ Vertical" : "→ Horizontal"}
            </button>
          ))}
        </div>
        <FlowLegend />
      </div>
      <ReactFlow key={viewKey} nodes={rfNodes} edges={shownEdges} nodeTypes={nodeTypes} colorMode={theme} onNodesChange={onNodesChange}
        onNodeDragStop={(_, n) => { moved.current.set(`${viewKey}:${n.id}`, n.position); force((x) => x + 1); }}
        onInit={onInit} minZoom={0.15} maxZoom={1.6}
        nodesDraggable nodesConnectable={false} elementsSelectable={false} proOptions={{ hideAttribution: true }}
        onNodeClick={(_, n) => onSelect((n.data as StepNodeData).step.span)}
        onNodeDoubleClick={(_, n) => { if (!scope) { const st = (n.data as StepNodeData).step; if (st.subScope) setPath((p) => [...p, st.subScope!.span_id]); } }}>
        <Background gap={20} size={1} color="var(--border-strong)" />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap pannable zoomable position="bottom-right" nodeStrokeWidth={2}
          nodeColor={(n) => (n.type === "subagent" ? "color-mix(in srgb, #4a3aa7 18%, transparent)" : (n.data as StepNodeData).step.span.status === "error" ? "var(--critical)" : "var(--border-strong)")}
          maskColor="color-mix(in srgb, var(--bg) 70%, transparent)" style={{ background: "var(--panel)" }} />
      </ReactFlow>
    </div>
  );
}
