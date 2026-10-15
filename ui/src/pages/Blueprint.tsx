import { useMutation, useQuery } from "@tanstack/react-query";
import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { HANDLE, Tile } from "../components/FlowView";
import { Icon } from "../components/icons";
import { ModelPicker, useModelOptions } from "../components/ModelPicker";
import { Empty, ErrorBox, PageHeader, Segmented, Spinner, controlCls } from "../components/ui";
import { api, apiPost, type Runner, type Blueprint as BP, type BlueprintSummary, type BpAgent, type BpAgentStats, type BpTool } from "../lib/api";
import { fmtCost, fmtDuration, fmtNum, timeAgo } from "../lib/format";
import { pp } from "../lib/project";
import { useAppState } from "../lib/state";

const short = (m: string) => m.split("/").pop() ?? m;
const CARD_W = 260;
const CARD_H = 96;
const GAP = 18;
const PAD = 18;
const HEAD = 40;
const COLS = 4;
const STACK_GAP = 44;

const EMPTY: BpAgentStats = { runs: 0, errors: 0, p50: null, p95: null, last_run: null, cost: 0, llm_calls: 0, tokens: 0, models: [], tools: {} };

type Days = "1" | "7" | "30";

/** The app as its agent framework describes it, with live numbers from traces. */
export function Blueprint() {
  const [params, setParams] = useSearchParams();
  const { project } = useAppState();
  const list = useQuery({ queryKey: ["blueprints", project], queryFn: () => api<BlueprintSummary[]>("/api/blueprints", { project }) });
  const pick = params.get("app");
  const summary = (list.data ?? []).find((b) => `${b.project}/${b.name}` === pick) ?? list.data?.[0];
  const [days, setDays] = useState<Days>("7");
  const bp = useQuery({
    enabled: !!summary, queryKey: ["blueprint", summary?.project, summary?.name, days],
    queryFn: () => api<BP>(`/api/blueprints/${summary!.project}/${summary!.name}`, { days }),
  });

  if (list.isError) return <ErrorBox error={list.error} />;
  if (list.isPending) return <Spinner />;
  if (!summary) return <NoBlueprint />;

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 108px)" }}>
      <PageHeader title={<span className="inline-flex items-center gap-2">{summary.name}</span>}
        meta={<>{summary.agents} agents · {summary.tools} tools · published {timeAgo(summary.updated_at)}</>}>
        {(list.data ?? []).length > 1 && (
          <select className={`ghost ${controlCls}`} value={`${summary.project}/${summary.name}`}
            onChange={(e) => setParams((p) => { p.set("app", e.target.value); p.delete("agent"); return p; })}>
            {list.data!.map((b) => <option key={`${b.project}/${b.name}`} value={`${b.project}/${b.name}`}>{b.name}</option>)}
          </select>
        )}
        <Segmented value={days} onChange={setDays} options={[{ id: "1", label: "24h" }, { id: "7", label: "7d" }, { id: "30", label: "30d" }]} />
      </PageHeader>
      <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-3">
        <span className="rounded-md bg-subtle px-1.5 py-0.5 font-medium text-ink-2">{summary.framework}</span>
        {Object.entries(summary.versions).map(([k, v]) => <span key={k} className="num">{k} {v}</span>).reduce<React.ReactNode[]>((a, x, i) => (i ? [...a, "·", x] : [x]), [])}
        <span className="ml-auto">Read from the framework at app startup · stats from this project's production traces</span>
      </div>
      {bp.isError ? <ErrorBox error={bp.error} /> : !bp.data ? <Spinner /> : <BlueprintView data={bp.data} />}
    </div>
  );
}

function NoBlueprint() {
  return (
    <>
      <PageHeader title="Blueprint" />
      <Empty title="No blueprint yet"
        hint={<>Publish your app's structure once at startup (with this project's key) and imagent draws it here — every agent, sub-agent, model, prompt, tool and middleware, with live stats.
          <pre className="mx-auto mt-3 w-fit rounded-md bg-subtle px-3 py-2 text-left font-mono text-[12px] text-ink">{"agent = create_deep_agent(...)\nimagent.publish_blueprint(agent)"}</pre></>} />
    </>
  );
}

function allAgents(a: BpAgent, parent?: string): { agent: BpAgent; parent?: string }[] {
  return [{ agent: a, parent }, ...a.subagents.flatMap((s) => allAgents(s, a.name))];
}

function BlueprintView({ data }: { data: BP }) {
  const root = data.blueprint.root;
  const [params, setParams] = useSearchParams();
  const index = useMemo(() => new Map(allAgents(root).map((x) => [x.agent.name, x])), [root]);
  const selected = index.get(params.get("agent") ?? "")?.agent ?? root;
  const select = (name: string) => setParams((p) => { p.set("agent", name); return p; }, { replace: true });
  const stat = (n: string) => data.stats[n] ?? EMPTY;
  // "What if this agent used another model?" — picked right on the canvas, run from the bar below it.
  const [changes, setChanges] = useState<Record<string, string>>({});
  const [picking, setPicking] = useState<{ agent: string; x: number; y: number } | null>(null);
  const pick = useCallback((agent: string, rect: DOMRect) => setPicking({ agent, x: rect.left, y: rect.bottom + 6 }), []);
  const current = (n: string) => stat(n).models[0]?.model || index.get(n)?.agent.model?.name || "";

  return (
    <div className="flex min-h-0 flex-1 gap-3 max-lg:flex-col">
      <div className="relative min-h-[420px] min-w-0 flex-1 overflow-hidden rounded-lg border border-line bg-panel">
        <Canvas root={root} stats={data.stats} days={data.days} selected={selected.name} onSelect={select} changes={changes} onPickModel={pick} />
        {Object.keys(changes).length === 0 && (
          <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-line bg-bg/90 px-3 py-1 text-[12px] text-ink-3 shadow-sm backdrop-blur">
            Click an agent's model to try another one
          </div>
        )}
        <TryBar project={data.project} rootName={root.name} changes={changes} current={current}
          onRemove={(a) => setChanges((c) => { const n = { ...c }; delete n[a]; return n; })} onClear={() => setChanges({})} />
        {picking && (
          <ModelPopover x={picking.x} y={picking.y} agent={picking.agent} current={current(picking.agent)} project={data.project}
            value={changes[picking.agent] ?? ""} onClose={() => setPicking(null)}
            onChoose={(m) => { setChanges((c) => { const n = { ...c }; if (m) n[picking.agent] = m; else delete n[picking.agent]; return n; }); setPicking(null); }} />
        )}
      </div>
      <aside className="flex w-[440px] shrink-0 flex-col overflow-hidden rounded-lg border border-line bg-bg max-lg:w-full">
        <AgentPanel key={selected.name} agent={selected} isRoot={selected === root} stats={stat(selected.name)} days={data.days}
          subStats={(n) => stat(n)} onSelect={select} parent={index.get(selected.name)?.parent} onTry={pick} />
      </aside>
    </div>
  );
}

// ── try another model ─────────────────────────────────────────────────────────

/** Pick a different model for one agent, anchored under the chip that was clicked. */
function ModelPopover({ x, y, agent, current, project, value, onClose, onChoose }: {
  x: number; y: number; agent: string; current: string; project: string; value: string;
  onClose: () => void; onChoose: (model: string) => void;
}) {
  const [model, setModel] = useState(value);
  const options = useModelOptions(project, current ? [current] : []);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!box.current?.contains(e.target as globalThis.Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [onClose]);
  const left = Math.max(12, Math.min(x, window.innerWidth - 460));
  const top = Math.min(y, window.innerHeight - 380);
  const ok = model.trim() && model.trim() !== current;
  return (
    <div ref={box} onKeyDown={(e) => {
      // Enter with the list closed applies; with it open, the picker takes the highlighted model first.
      if (e.key === "Enter" && ok && (e.target as HTMLElement).getAttribute("aria-expanded") === "false") onChoose(model.trim());
    }} className="fixed z-50 w-[440px] rounded-lg border border-line bg-bg p-3 shadow-[0_12px_32px_-8px_rgb(0_0_0/0.3)]" style={{ left, top }}>
      <div className="text-[13px] font-medium text-ink">Try another model for <span className="font-mono">{agent}</span></div>
      <div className="mb-2.5 mt-0.5 text-[12px] text-ink-3">Runs today on <span className="font-mono">{current || "unknown"}</span></div>
      <ModelPicker value={model} onChange={setModel} options={options} autoFocus />
      <div className="mt-3 flex items-center gap-2">
        {value && <button onClick={() => onChoose("")} className="text-[12.5px] text-ink-3 hover:text-ink">Keep current</button>}
        <button onClick={onClose} className="ml-auto h-7 rounded-md px-2.5 text-[12.5px] text-ink-2 hover:bg-hover">Cancel</button>
        <button disabled={!ok} onClick={() => onChoose(model.trim())}
          className="h-7 rounded-md bg-ink px-3 text-[12.5px] font-medium text-bg disabled:opacity-40">Use this model</button>
      </div>
    </div>
  );
}

const RUN_COUNTS = [5, 10, 25, 50];

/** "1 change: agent → model · Test on [last 10] runs · Run" — replays the latest runs that used the changed agents. */
function TryBar({ project, rootName, changes, current, onRemove, onClear }: {
  project: string; rootName: string; changes: Record<string, string>; current: (agent: string) => string;
  onRemove: (agent: string) => void; onClear: () => void;
}) {
  const navigate = useNavigate();
  const [limit, setLimit] = useState(10);
  const agents = Object.keys(changes).sort();
  const runs = useQuery({
    queryKey: ["candidates", project, rootName, agents.join(","), limit], enabled: agents.length > 0,
    queryFn: () => api<{ trace_ids: string[]; total: number; days: number }>("/api/experiments/candidates",
      { project, root_name: rootName, agents: agents.join(","), limit }),
  });
  // Experiments run under the app's registered agent name; fall back to the blueprint root.
  const runners = useQuery({ queryKey: ["runners", project], queryFn: () => api<Runner[]>("/api/runners", { project }), enabled: agents.length > 0 });
  const agentName = runners.data?.flatMap((r) => r.agents).find((a) => a.source_root === rootName)?.name ?? rootName;
  const ids = runs.data?.trace_ids ?? [];
  const start = useMutation({
    mutationFn: () => apiPost<{ id: string }>("/api/experiments", {
      agent: agentName, project, source_trace_ids: ids, repeats: 1, tool_mode: "recorded",
      variants: [{ name: agents.map((a) => `${a} → ${short(changes[a])}`).join(", "), model: "", models: changes }],
    }),
    onSuccess: (r) => navigate(pp(`/experiments/${r.id}`)),
  });
  if (!agents.length) return null;
  return (
    <div className="absolute inset-x-3 bottom-3 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-bg/95 px-3 py-2 text-[12.5px] shadow-[0_8px_24px_-8px_rgb(0_0_0/0.25)] backdrop-blur">
      <span className="whitespace-nowrap font-medium text-ink">{agents.length} {agents.length === 1 ? "change" : "changes"}</span>
      {agents.map((a) => (
        <span key={a} className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md bg-accent-soft px-1.5 py-0.5 font-mono text-[11.5px] text-ink">
          <span className="truncate">{a}</span><span className="text-ink-3">:</span>
          <span className="truncate text-ink-3 line-through">{short(current(a)) || "?"}</span><span>→</span>
          <span className="truncate font-medium">{short(changes[a])}</span>
          <button onClick={() => onRemove(a)} title="Remove" className="ml-0.5 text-ink-3 hover:text-ink"><Icon.close size={11} /></button>
        </span>
      ))}
      <div className="ml-auto flex flex-wrap items-center justify-end gap-x-2 gap-y-1.5 whitespace-nowrap">
        <span className="inline-flex items-center gap-1.5 text-ink-3">Test on
          <select className={controlCls} value={limit} onChange={(e) => setLimit(Number(e.target.value))} aria-label="How many runs">
            {RUN_COUNTS.map((n) => <option key={n} value={n}>last {n}</option>)}
          </select>
          runs</span>
        <span className="num text-[12px] text-ink-3">
          {runs.isPending ? "…" : runs.isError ? "couldn't load runs" : ids.length === 0 ? `no runs used ${agents.length === 1 ? "this agent" : "these agents"} in ${runs.data!.days}d`
            : ids.length < limit ? `only ${ids.length} found` : `of ${fmtNum(runs.data!.total)} in ${runs.data!.days}d`}
        </span>
        <button onClick={onClear} className="h-7 rounded-md px-2 text-ink-3 hover:bg-hover hover:text-ink">Clear</button>
        <button onClick={() => navigate(pp(`/experiments/new?root=${encodeURIComponent(rootName)}&sources=${ids.join(",")}`))}
          className="h-7 rounded-md px-2 text-ink-3 hover:bg-hover hover:text-ink" title="Pick runs, repeats and tool access yourself">Advanced…</button>
        <button disabled={!ids.length || start.isPending} onClick={() => start.mutate()}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-ink px-3 font-medium text-bg disabled:opacity-40">
          <Icon.play size={11} /> {start.isPending ? "Starting…" : `Run on ${ids.length || ""} ${ids.length === 1 ? "run" : "runs"}`}
        </button>
      </div>
      {start.isError && <div className="w-full text-[12px] text-critical">{(start.error as Error).message}</div>}
    </div>
  );
}

// ── canvas ────────────────────────────────────────────────────────────────────

type CardData = { agent: BpAgent; stats: BpAgentStats; isRoot: boolean; selected: boolean; days: number; onSelect: () => void;
  change?: string; onPickModel: (rect: DOMRect) => void };
type FrameData = { label: string; used: number; total: number; width: number; height: number };

interface Box { w: number; h: number }

function Canvas({ root, stats, days, selected, onSelect, changes, onPickModel }: {
  root: BpAgent; stats: Record<string, BpAgentStats>; days: number; selected: string; onSelect: (n: string) => void;
  changes: Record<string, string>; onPickModel: (agent: string, rect: DOMRect) => void;
}) {
  const { theme } = useAppState();
  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const st = (n: string) => stats[n] ?? EMPTY;
    // Used sub-agents first (busiest first), then the rest by name.
    const order = (subs: BpAgent[]) => [...subs].sort((a, b) => (st(b.name).runs - st(a.name).runs) || a.name.localeCompare(b.name));

    const measure = (a: BpAgent): Box => {
      if (!a.subagents.length) return { w: CARD_W, h: CARD_H };
      const kids = order(a.subagents).map(measure);
      const rows: Box[][] = [];
      kids.forEach((k, i) => (i % COLS ? rows[rows.length - 1].push(k) : rows.push([k])));
      const fw = Math.max(...rows.map((r) => r.reduce((s, k) => s + k.w, 0) + GAP * (r.length - 1))) + 2 * PAD;
      const fh = HEAD + rows.reduce((s, r) => s + Math.max(...r.map((k) => k.h)), 0) + GAP * (rows.length - 1) + PAD;
      return { w: Math.max(CARD_W, fw), h: CARD_H + STACK_GAP + fh };
    };

    const place = (a: BpAgent, x: number, y: number, parentId: string | undefined, isRoot: boolean) => {
      const box = measure(a);
      const cardId = `a:${a.name}`;
      nodes.push({
        id: cardId, type: "agent", position: { x: x + (box.w - CARD_W) / 2, y }, parentId, extent: parentId ? "parent" : undefined,
        data: { agent: a, stats: st(a.name), isRoot, selected: a.name === selected, days, onSelect: () => onSelect(a.name),
                change: changes[a.name], onPickModel: (rect: DOMRect) => onPickModel(a.name, rect) } satisfies CardData,
        draggable: true,
      });
      if (!a.subagents.length) return;
      const kids = order(a.subagents);
      const frameId = `f:${a.name}`;
      const fw = box.w, fh = box.h - CARD_H - STACK_GAP;
      const used = kids.filter((k) => st(k.name).runs > 0).length;
      nodes.push({
        id: frameId, type: "frame", position: { x, y: y + CARD_H + STACK_GAP }, parentId, extent: parentId ? "parent" : undefined,
        width: fw, height: fh, draggable: true, selectable: false,
        data: { label: "Sub-agents", used, total: kids.length, width: fw, height: fh } satisfies FrameData,
      });
      edges.push({ id: `e:${a.name}`, source: cardId, target: frameId, type: "smoothstep",
        style: { stroke: "var(--border-strong)", strokeWidth: 1.5 } });
      let cy = HEAD;
      for (let i = 0; i < kids.length; i += COLS) {
        const row = kids.slice(i, i + COLS).map((k) => ({ k, b: measure(k) }));
        const rw = row.reduce((s, r) => s + r.b.w, 0) + GAP * (row.length - 1);
        let cx = (fw - rw) / 2;
        for (const r of row) {
          place(r.k, cx, cy, frameId, false);
          cx += r.b.w + GAP;
        }
        cy += Math.max(...row.map((r) => r.b.h)) + GAP;
      }
    };
    place(root, 0, 0, undefined, true);
    return { nodes, edges };
  }, [root, stats, days, selected, onSelect, changes, onPickModel]);

  return (
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} colorMode={theme} fitView fitViewOptions={{ padding: 0.08, maxZoom: 1 }}
      minZoom={0.15} proOptions={{ hideAttribution: true }} nodesConnectable={false}>
      <Background gap={20} size={1} color="var(--border)" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

function AgentCard({ data }: NodeProps<Node<CardData>>) {
  const { agent: a, stats: s, isRoot, selected, days } = data;
  const idle = s.runs === 0 && s.llm_calls === 0;
  const own = a.tools.filter((t) => !t.builtin);
  const usedTools = own.filter((t) => s.tools[t.name]).length;
  const drift = a.model && s.models.length > 0 && !s.models.some((m) => short(m.model) === short(a.model!.name));
  const errs = s.errors + s.models.reduce((x, m) => x + m.errors, 0) + Object.values(s.tools).reduce((x, t) => x + t.errors, 0);
  return (
    <div onClick={data.onSelect}
      className={`flex cursor-pointer flex-col justify-between rounded-xl border bg-bg px-3 py-2.5 shadow-[0_1px_2px_rgb(0_0_0/0.06)] transition-[border-color,box-shadow,opacity] ${data.change ? "border-accent" : ""} ${selected ? "border-accent shadow-[0_0_0_3px_var(--accent-soft)]" : isRoot ? "border-[#cc4a1a]/50" : "border-line-strong hover:border-ink-3"} ${idle && !selected ? "opacity-55" : ""}`}
      style={{ width: CARD_W, height: CARD_H }}>
      {!isRoot && <Handle type="target" position={Position.Top} className={HANDLE} />}
      <Handle type="source" position={Position.Bottom} className={HANDLE} />
      <div className="flex items-center gap-2.5">
        <Tile role={isRoot ? "main" : "sub"} size={30} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-ink" title={a.name}>{a.name}</div>
          <button type="button" title="Try another model for this agent"
            onClick={(e) => { e.stopPropagation(); data.onPickModel((e.currentTarget as HTMLElement).getBoundingClientRect()); }}
            className={`nodrag mt-0.5 inline-flex max-w-full items-center gap-1 rounded px-1 font-mono text-[11px] ${data.change ? "bg-accent-soft text-ink" : "text-ink-3 hover:bg-subtle hover:text-ink"}`}>
            <span className={`truncate ${data.change ? "line-through opacity-60" : ""}`}>{s.models[0]?.model ? short(s.models[0].model) : a.model ? short(a.model.name) : "model unknown"}</span>
            {data.change ? <><span>→</span><span className="truncate font-medium">{short(data.change)}</span></> : <Icon.chevronDown size={10} className="shrink-0" />}
          </button>
        </div>
        {errs > 0 && <span className="num shrink-0 rounded bg-critical/10 px-1 text-[10.5px] font-medium text-critical" title="errors in window">{errs} err</span>}
      </div>
      <div className="num flex items-center gap-1.5 truncate text-[11px] text-ink-3">
        {idle ? <span>No runs in {days === 1 ? "24h" : `${days}d`}</span> : (
          <span className="truncate text-ink-2">
            {fmtNum(s.runs || s.llm_calls)} {s.runs ? "runs" : "LLM calls"}{s.p50 != null && <> · p50 {fmtDuration(s.p50)}</>}{s.cost > 0 && <> · {fmtCost(s.cost)}</>}
          </span>
        )}
        <span className="ml-auto shrink-0" title={`${usedTools} of ${own.length} tools called in window`}>
          {usedTools}/{own.length} tools
        </span>
      </div>
      {drift && (
        <div className="-mb-1 truncate text-[10.5px] text-[#b4620b] dark:text-[#f0a35c]" title="The configured model differs from what traces show">
          <Icon.warning size={11} className="mr-0.5 inline-block align-[-1px]" /> traces show {short(s.models[0].model)}
        </div>
      )}
    </div>
  );
}

function FrameNode({ data }: NodeProps<Node<FrameData>>) {
  return (
    <div className="rounded-2xl border border-[#4a3aa7]/20 bg-[#4a3aa7]/[0.025] dark:border-[#9085e9]/25 dark:bg-[#9085e9]/[0.04]"
      style={{ width: data.width, height: data.height }}>
      <Handle type="target" position={Position.Top} className={HANDLE} />
      <div className="flex items-center gap-2 px-4 text-[12px] text-ink-3" style={{ height: HEAD }}>
        <span className="font-medium text-ink-2">{data.label}</span>
        <span className="num">{data.total}</span>
        <span className="num ml-auto">{data.used} used in window</span>
      </div>
    </div>
  );
}

const nodeTypes = { agent: AgentCard, frame: FrameNode };

// ── detail panel ──────────────────────────────────────────────────────────────

type Tab = "overview" | "tools" | "prompt" | "framework";

function AgentPanel({ agent: a, isRoot, stats: s, days, subStats, onSelect, parent, onTry }: {
  agent: BpAgent; isRoot: boolean; stats: BpAgentStats; days: number; subStats: (n: string) => BpAgentStats;
  onSelect: (n: string) => void; parent?: string; onTry: (agent: string, rect: DOMRect) => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const own = a.tools.filter((t) => !t.builtin);
  return (
    <>
      <div className="border-b border-line px-4 pb-3 pt-3.5">
        {parent && (
          <button onClick={() => onSelect(parent)} className="mb-1.5 inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink">
            <Icon.chevronRight size={12} className="rotate-180" /> {parent}
          </button>
        )}
        <div className="flex items-center gap-2.5">
          <Tile role={isRoot ? "main" : "sub"} size={32} />
          <div className="min-w-0">
            <div className="truncate text-[14px] font-semibold">{a.name}</div>
            <div className="text-[12px] text-ink-3">{isRoot ? "Main agent" : "Sub-agent"} · {own.length} tools · {a.middleware.length} middleware{a.subagents.length ? ` · ${a.subagents.length} sub-agents` : ""}</div>
          </div>
        </div>
        {a.description && <p className="mt-2 line-clamp-4 text-[12.5px] text-ink-2" title={a.description}>{a.description}</p>}
        <button onClick={(e) => onTry(a.name, e.currentTarget.getBoundingClientRect())}
          className="mt-3 inline-flex h-7 items-center gap-1.5 rounded-md border border-line px-2.5 text-[12.5px] font-medium text-ink-2 hover:border-line-strong hover:text-ink">
          <Icon.experiments size={13} /> Try another model{isRoot ? "" : " for this agent"}
        </button>
        <div className="mt-3">
          <Segmented value={tab} onChange={setTab} options={[
            { id: "overview", label: "Overview" }, { id: "tools", label: `Tools ${own.length}` },
            { id: "prompt", label: "Prompt" }, { id: "framework", label: "Framework" }]} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {tab === "overview" && <Overview a={a} s={s} days={days} subStats={subStats} onSelect={onSelect} />}
        {tab === "tools" && <Tools tools={a.tools} s={s} />}
        {tab === "prompt" && <Prompt text={a.system_prompt} />}
        {tab === "framework" && <Framework a={a} />}
      </div>
    </>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 mt-4 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 first:mt-0">{children}</div>;
}

function Overview({ a, s, days, subStats, onSelect }: {
  a: BpAgent; s: BpAgentStats; days: number; subStats: (n: string) => BpAgentStats; onSelect: (n: string) => void;
}) {
  const totalCalls = s.models.reduce((x, m) => x + m.calls, 0);
  const figures: [string, string][] = [
    ["Runs", fmtNum(s.runs)], ["p50", fmtDuration(s.p50)], ["p95", fmtDuration(s.p95)],
    ["LLM calls", fmtNum(s.llm_calls)], ["Tokens", fmtNum(s.tokens)], ["Cost", fmtCost(s.cost)],
  ];
  return (
    <>
      <Label>Last {days === 1 ? "24 hours" : `${days} days`}</Label>
      <div className="grid grid-cols-3 overflow-hidden rounded-lg border border-line">
        {figures.map(([k, v], i) => (
          <div key={k} className={`px-3 py-2 ${i % 3 ? "border-l border-line" : ""} ${i >= 3 ? "border-t border-line" : ""}`}>
            <div className="text-[11px] text-ink-3">{k}</div>
            <div className="num text-[14px] font-semibold">{v}</div>
          </div>
        ))}
      </div>
      {s.last_run && <p className="mt-1.5 text-[12px] text-ink-3">Last run {timeAgo(s.last_run)}</p>}

      <Label>Model — configured</Label>
      {a.model ? (
        <div className="rounded-lg border border-line px-3 py-2">
          <div className="font-mono text-[12.5px] text-ink">{a.model.name}</div>
          <div className="mt-0.5 text-[11.5px] text-ink-3">{a.model.provider || a.model.class}{a.model.class && a.model.provider ? ` · ${a.model.class}` : ""}</div>
          {a.model.params && Object.keys(a.model.params).length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {Object.entries(a.model.params).map(([k, v]) => (
                <span key={k} className="num rounded bg-subtle px-1.5 py-0.5 text-[11px] text-ink-2">{k}: {String(v)}</span>
              ))}
            </div>
          )}
        </div>
      ) : <p className="text-[12.5px] text-ink-3">The framework didn't expose a model for this agent.</p>}

      <Label>Models — in traces</Label>
      {s.models.length === 0 ? <p className="text-[12.5px] text-ink-3">No LLM calls in this window.</p> : (
        <div className="space-y-1.5">
          {s.models.map((m) => (
            <div key={m.model}>
              <div className="flex items-baseline gap-2 text-[12.5px]">
                <span className="truncate font-mono">{short(m.model)}</span>
                <span className="num ml-auto shrink-0 text-ink-3">{fmtNum(m.calls)} calls · p50 {fmtDuration(m.p50)}{m.cost > 0 ? ` · ${fmtCost(m.cost)}` : ""}</span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-subtle">
                <div className="h-full rounded-full bg-[#1baf7a]" style={{ width: `${(m.calls / totalCalls) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {a.subagents.length > 0 && (
        <>
          <Label>Sub-agents {a.subagents.length}</Label>
          <div className="overflow-hidden rounded-lg border border-line">
            {[...a.subagents].sort((x, y) => subStats(y.name).runs - subStats(x.name).runs || x.name.localeCompare(y.name)).map((sub) => {
              const ss = subStats(sub.name);
              return (
                <button key={sub.name} onClick={() => onSelect(sub.name)}
                  className="flex w-full items-center gap-2 border-b border-line/70 px-3 py-1.5 text-left text-[12.5px] last:border-0 hover:bg-hover">
                  <Tile role="sub" size={18} />
                  <span className={`truncate ${ss.runs ? "text-ink" : "text-ink-3"}`}>{sub.name}</span>
                  <span className="num ml-auto shrink-0 text-ink-3">{ss.runs ? `${fmtNum(ss.runs)} runs` : "—"}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

function Tools({ tools, s }: { tools: BpTool[]; s: BpAgentStats }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const match = (t: BpTool) => !q || t.name.toLowerCase().includes(q.toLowerCase()) || t.description.toLowerCase().includes(q.toLowerCase());
  const own = tools.filter((t) => !t.builtin && match(t));
  const used = own.filter((t) => s.tools[t.name]).sort((a, b) => s.tools[b.name].calls - s.tools[a.name].calls);
  const unused = own.filter((t) => !s.tools[t.name]);
  const builtin = tools.filter((t) => t.builtin && match(t));
  const row = (t: BpTool) => {
    const ts = s.tools[t.name];
    const isOpen = open === t.name;
    return (
      <div key={t.name} className="border-b border-line/70 last:border-0">
        <button onClick={() => setOpen(isOpen ? null : t.name)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-hover">
          <Icon.chevronRight size={11} className={`shrink-0 text-ink-3 transition-transform ${isOpen ? "rotate-90" : ""}`} />
          <span className={`truncate font-mono text-[12px] ${ts ? "text-ink" : "text-ink-3"}`}>{t.name}</span>
          {ts ? (
            <span className="num ml-auto shrink-0 text-[11.5px] text-ink-3">
              {fmtNum(ts.calls)}× · {fmtDuration(ts.p50)}{ts.errors ? <span className="text-critical"> · {ts.errors} err</span> : null}
            </span>
          ) : null}
        </button>
        {isOpen && (
          <div className="px-3 pb-2.5 pl-8">
            {t.args.length > 0 && <div className="mb-1 flex flex-wrap gap-1">{t.args.map((x) => <span key={x} className="rounded bg-subtle px-1.5 py-0.5 font-mono text-[11px] text-ink-2">{x}</span>)}</div>}
            <p className="whitespace-pre-wrap text-[12px] text-ink-2">{t.description || "No description."}</p>
          </div>
        )}
      </div>
    );
  };
  const group = (title: string, list: BpTool[], hint?: string) => list.length > 0 && (
    <>
      <Label>{title} {list.length}{hint && <span className="ml-1 font-normal normal-case tracking-normal">· {hint}</span>}</Label>
      <div className="overflow-hidden rounded-lg border border-line">{list.map(row)}</div>
    </>
  );
  return (
    <>
      <input className={`${controlCls} mb-1 w-full`} placeholder="Filter tools" value={q} onChange={(e) => setQ(e.target.value)} />
      {group("Called", used)}
      {group("Never called in window", unused)}
      {group("Framework tools", builtin, "added by deepagents")}
      {!used.length && !unused.length && !builtin.length && <p className="mt-3 text-[12.5px] text-ink-3">No tools match.</p>}
    </>
  );
}

function Prompt({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  if (!text) return <p className="text-[12.5px] text-ink-3">The framework didn't expose a system prompt for this agent.</p>;
  return (
    <>
      <div className="mb-2 flex items-center text-[12px] text-ink-3">
        <span className="num">{fmtNum(text.length)} characters · ~{fmtNum(Math.round(text.length / 4))} tokens</span>
        <button className="ml-auto inline-flex items-center gap-1 hover:text-ink"
          onClick={() => { navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }}>
          {copied ? <Icon.check size={12} /> : <Icon.copy size={12} />} {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="whitespace-pre-wrap break-words rounded-lg border border-line bg-panel px-3 py-2.5 font-mono text-[11.5px] leading-[1.55] text-ink-2">{text}</pre>
    </>
  );
}

function Framework({ a }: { a: BpAgent }) {
  const steps = a.graph.nodes.filter((n) => n.type !== "start" && n.type !== "end");
  return (
    <>
      <Label>Middleware {a.middleware.length}</Label>
      {a.middleware.length === 0 ? <p className="text-[12.5px] text-ink-3">None found.</p> : (
        <div className="overflow-hidden rounded-lg border border-line">
          {a.middleware.map((m) => (
            <div key={m.name} className="border-b border-line/70 px-3 py-1.5 last:border-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-[12.5px] text-ink">{m.name}</span>
                {m.module && <span className="ml-auto truncate font-mono text-[10.5px] text-ink-3" title={m.module}>{m.module.split(".")[0]}</span>}
              </div>
              {m.hooks.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">{m.hooks.map((h) => <span key={h} className="rounded bg-subtle px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2">{h}</span>)}</div>
              )}
            </div>
          ))}
        </div>
      )}
      <Label>LangGraph nodes {steps.length}</Label>
      <div className="overflow-hidden rounded-lg border border-line">
        {a.graph.edges.map((e, i) => (
          <div key={i} className="flex items-center gap-1.5 border-b border-line/70 px-3 py-1 font-mono text-[11.5px] last:border-0">
            <span className="truncate text-ink-2">{e.source}</span>
            <span className="shrink-0 text-ink-3">{e.conditional ? "⇢" : "→"}</span>
            <span className="truncate text-ink-2">{e.target}</span>
          </div>
        ))}
      </div>
      <p className="mt-1.5 text-[11.5px] text-ink-3">⇢ conditional edge — the route is decided at run time.</p>
    </>
  );
}
