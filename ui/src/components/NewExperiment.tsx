import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, apiPost, type Blueprint, type BlueprintSummary, type BpAgent, type Runner } from "../lib/api";
import { pp } from "../lib/project";
import { useAppState } from "../lib/state";
import { Tile } from "./FlowView";
import { Icon } from "./icons";
import { ModelPicker, type ModelOption } from "./ModelPicker";
import { Time } from "./Time";
import { controlCls } from "./ui";

interface SourceRun { trace_id: string; project: string; start_time: string; thread_id: string; input_text: string; output_text: string }

/** A variant: one model for every agent, or a model for chosen agents (the rest unchanged). */
interface VariantDraft { name: string; mode: "all" | "per"; model: string; perAgent: Record<string, string> }
interface TreeRow { name: string; depth: number; model: string; runs: number }

const LETTERS = "ABCDE";
const short = (m: string) => m.split("/").pop() ?? m;

function flatten(a: BpAgent): BpAgent[] {
  return [a, ...a.subagents.flatMap(flatten)];
}

function picks(v: VariantDraft): Record<string, string> {
  return Object.fromEntries(Object.entries(v.perAgent).map(([a, m]) => [a, m.trim()]).filter(([a, m]) => a && m));
}

function isComplete(v: VariantDraft) {
  return v.mode === "all" ? !!v.model.trim() : Object.keys(picks(v)).length > 0;
}

/** Default name: the model, or "<agent> → <model>" when one agent changes. */
function autoName(v: VariantDraft, i: number) {
  if (v.mode === "all") return short(v.model.trim());
  const p = Object.entries(picks(v));
  return p.length === 1 ? `${p[0][0]} → ${short(p[0][1])}` : `Variant ${LETTERS[i]}`;
}

/** New experiment page: 1 · which runs  2 · what changes  3 · options, with a sticky summary. */
export function NewExperiment({ onClose, preselected = [], rootName, focusAgent }: {
  onClose: () => void; preselected?: string[]; rootName?: string;
  /** Opened from a Blueprint agent: start variant A as "choose per agent" with that agent. */
  focusAgent?: string;
}) {
  const { project } = useAppState();
  const navigate = useNavigate();

  // Agents: what connected runners offer, plus every agent with a blueprint (those queue until the app connects).
  const runners = useQuery({ queryKey: ["runners", project], queryFn: () => api<Runner[]>("/api/runners", { project }), refetchInterval: 5000 });
  const blueprints = useQuery({ queryKey: ["blueprints", project], queryFn: () => api<BlueprintSummary[]>("/api/blueprints", { project }) });
  const agents = useMemo(() => {
    const seen = new Map<string, Runner["agents"][number] & { connected?: boolean }>();
    for (const b of blueprints.data ?? []) {
      seen.set(b.name, { name: b.name, source_root: b.name, description: "", read_tools: [], models: [], connected: false, ready: false });
    }
    // Freshest runner last so it wins — after an app reload the old runner lingers until it goes stale.
    const byAge = [...(runners.data ?? [])].sort((a, b) => b.seconds_ago - a.seconds_ago);
    for (const r of byAge) for (const a of r.agents) seen.set(a.name, { ...a, ready: r.ready ?? true, connected: true });
    return [...seen.values()];
  }, [runners.data, blueprints.data]);
  const [agentName, setAgentName] = useState("");
  const agent = agents.find((a) => a.name === agentName) ?? (rootName ? agents.find((a) => a.source_root === rootName) : agents[0]);
  useEffect(() => { if (agent && agent.name !== agentName) setAgentName(agent.name); }, [agent, agentName]);

  // Step 1: runs.
  const sources = useQuery({
    enabled: !!agent,
    queryKey: ["exp-sources", agent?.source_root, project],
    queryFn: () => api<SourceRun[]>("/api/experiments/sources", { root_name: agent!.source_root, project: project || undefined, limit: 50 }),
  });
  // Nothing pre-selected: you pick the runs (runs chosen on the Traces page arrive selected).
  const [picked, setPicked] = useState<Set<string>>(new Set(preselected));

  // Step 2: the agent's blueprint — every agent with its current model, for the per-agent picker.
  const bp = useQuery({
    enabled: !!agent, retry: false, queryKey: ["blueprint", project, agent?.name, "7"],
    queryFn: () => api<Blueprint>(`/api/blueprints/${project}/${agent!.name}`, { days: 7 }),
  });
  const tree = useMemo((): TreeRow[] => {
    if (!bp.data) return [];
    const st = bp.data.stats;
    const walk = (a: BpAgent, depth: number): TreeRow[] => {
      const s = st[a.name];
      const kids = [...a.subagents].sort((x, y) => ((st[y.name]?.runs ?? 0) - (st[x.name]?.runs ?? 0)) || x.name.localeCompare(y.name));
      return [{ name: a.name, depth, model: s?.models[0]?.model || a.model?.name || "", runs: (s?.runs || s?.llm_calls) ?? 0 },
              ...kids.flatMap((k) => walk(k, depth + 1))];
    };
    return walk(bp.data.blueprint.root, 0);
  }, [bp.data]);
  const currentModel = tree[0]?.model ?? "";
  const modelSuggestions = useMemo(() => {
    const s = new Set(agent?.models ?? []);
    if (bp.data) {
      for (const a of flatten(bp.data.blueprint.root)) if (a.model?.name) s.add(a.model.name);
      for (const st of Object.values(bp.data.stats)) for (const m of st.models) s.add(m.model);
    }
    return [...s].filter(Boolean).sort();
  }, [agent, bp.data]);

  // Which agents made model calls in the runs picked in step 1 — only those can be affected.
  const pickedIds = [...picked].sort().join(",");
  const used = useQuery({
    enabled: picked.size > 0, queryKey: ["source-agents", pickedIds],
    queryFn: () => api<{ agent: string; runs: number; llm_calls: number }[]>("/api/experiments/source-agents", { trace_ids: pickedIds }),
  });
  const usedAgents = useMemo(() => new Map((used.data ?? []).map((u) => [u.agent, u.runs])), [used.data]);
  const models = useQuery({ queryKey: ["models", project], staleTime: 300_000,
    queryFn: () => api<{ used: { model: string; calls: number }[]; catalog: { id: string; input: number; output: number }[] }>("/api/models", { project }) });
  const modelOptions = useMemo((): ModelOption[] => {
    const usedIds = new Set<string>();
    const out: ModelOption[] = [];
    for (const u of models.data?.used ?? []) { usedIds.add(u.model); out.push({ id: u.model, group: "used", note: `${u.calls.toLocaleString()} calls` }); }
    for (const m of modelSuggestions) if (!usedIds.has(m)) out.push({ id: m, group: "used" });
    const price = (n: number) => (n < 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(n < 10 ? 1 : 0)}`);
    for (const c of models.data?.catalog ?? []) out.push({ id: c.id, group: "catalog", note: `${price(c.input)} / ${price(c.output)} per 1M` });
    return out;
  }, [models.data, modelSuggestions]);

  const [variants, setVariants] = useState<VariantDraft[]>([
    focusAgent ? { name: "", mode: "per", model: "", perAgent: { [focusAgent]: "" } } : { name: "", mode: "all", model: "", perAgent: {} }]);
  const [tab, setTab] = useState(0);
  const setVariant = (i: number, patch: Partial<VariantDraft>) => setVariants((vs) => vs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const addVariant = () => { setVariants((vs) => [...vs, { name: "", mode: "all", model: "", perAgent: {} }]); setTab(variants.length); };
  const removeVariant = (i: number) => { setVariants((vs) => vs.filter((_, j) => j !== i)); setTab((t) => Math.max(0, t >= i ? t - 1 : t)); };

  // Step 3: options.
  const [repeats, setRepeats] = useState(1);
  const [toolMode, setToolMode] = useState<"recorded" | "live_reads" | "live">("recorded");
  const [liveConfirmed, setLiveConfirmed] = useState(false);
  const [showOptions, setShowOptions] = useState(true);

  const create = useMutation({
    mutationFn: () => apiPost<{ id: string }>("/api/experiments", {
      agent: agent!.name, project, source_trace_ids: [...picked], repeats, tool_mode: toolMode,
      variants: variants.map((v, i) => ({
        name: v.name.trim() || autoName(v, i),
        model: v.mode === "all" ? v.model.trim() : "",
        models: v.mode === "per" ? picks(v) : {},
      })),
    }),
    onSuccess: (r) => { onClose(); navigate(pp(`/experiments/${r.id}`)); },
  });

  const incomplete = variants.findIndex((v) => !isComplete(v));
  const problem = !agent ? "No agent to replay yet"
    : toolMode === "live" && !liveConfirmed ? "Confirm that replays may change live data (step 3)"
    : picked.size === 0 ? "Pick at least one run in step 1"
    : incomplete >= 0 ? `Variant ${LETTERS[incomplete]}: ${variants[incomplete].mode === "all" ? "enter a model" : "choose a model for at least one agent"}`
    : null;
  const jobs = picked.size * variants.length * repeats;

  return (
    <div className="mx-auto max-w-6xl">
      <nav className="mb-2 text-[12.5px] text-ink-3">
        <button onClick={onClose} className="hover:text-ink">Experiments</button> /
      </nav>
      <h1 className="text-[15px] font-semibold tracking-[-0.01em]">New experiment</h1>
      <p className="mb-5 text-[12.5px] text-ink-3">Re-run real runs with a different model and compare each answer with the original.</p>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="overflow-hidden rounded-xl border border-line bg-bg">
        {agents.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="font-medium">No agents yet</p>
            <p className="mx-auto mt-1 max-w-md text-ink-3">Connect your app (<span className="font-mono text-ink">imagent.init()</span>) and let it run once — its agents show up here. Experiments also need <span className="font-mono text-ink">IMAGENT_EXPERIMENTS=true</span> in the app's .env.</p>
          </div>
        ) : (
          <div className="divide-y divide-line">
            {agent && agent.connected === false && (
              <Notice>Your app isn't connected for experiments right now. You can set this up — it starts when the app connects (<span className="font-mono">IMAGENT_EXPERIMENTS=true</span> in its .env, then restart).</Notice>
            )}
            {agent && agent.connected && agent.ready === false && (
              <Notice>Your app is connected but hasn't run <span className="font-mono">{agent.name}</span> since it started — this starts after its next run.</Notice>
            )}

            {/* 1 · runs */}
            <Step n={1} title="Which runs should be replayed?"
              aside={agents.length > 1 ? (
                <select className={`ghost ${controlCls}`} value={agent?.name ?? ""} onChange={(e) => { setAgentName(e.target.value); setPicked(new Set()); }} aria-label="Agent">
                  {agents.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
                </select>
              ) : agent && <span className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-2"><Tile role="main" size={16} /> {agent.name}</span>}>
              <RunPicker runs={sources.data ?? []} loading={sources.isPending} picked={picked} setPicked={setPicked} root={agent?.source_root} />
            </Step>

            {/* 2 · what changes */}
            <Step n={2} title="What should change?"
              hint="Each variant replays every selected run. Use model ids as they appear in your traces.">
              <div className="flex items-center gap-1 border-b border-line">
                {variants.map((v, i) => (
                  <button key={i} onClick={() => setTab(i)}
                    className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[12.5px] ${tab === i ? "border-ink font-medium text-ink" : "border-transparent text-ink-3 hover:text-ink-2"}`}>
                    Variant {LETTERS[i]}
                    {isComplete(v) ? <Icon.check size={12} className="text-good" /> : <span className="size-1.5 rounded-full bg-ink-3/40" />}
                  </button>
                ))}
                {variants.length < LETTERS.length && (
                  <button onClick={addVariant} className="ml-1 px-2 py-1.5 text-[12.5px] text-accent hover:underline">+ Add variant</button>
                )}
              </div>
              <VariantEditor key={tab} v={variants[tab]} letter={LETTERS[tab]} index={tab} tree={tree} currentModel={currentModel}
                modelOptions={modelOptions} usedAgents={usedAgents} runsPicked={picked.size} focusAgent={focusAgent}
                onChange={(p) => setVariant(tab, p)} onRemove={variants.length > 1 ? () => removeVariant(tab) : undefined} />
            </Step>

            {/* 3 · options */}
            <Step n={3} title="Options" aside={
              <button onClick={() => setShowOptions((o) => !o)} className="text-[12.5px] text-ink-3 hover:text-ink">
                {showOptions ? "Hide" : `${repeats}× each · ${toolMode === "recorded" ? "recorded tools" : toolMode === "live" ? "ALL TOOLS LIVE" : "live reads"} — change`}
              </button>}>
              {showOptions && (
                <div className="grid gap-5 sm:grid-cols-2">
                  <div>
                    <div className="mb-1.5 text-[12.5px] font-medium">Run each replay</div>
                    <div className="inline-flex rounded-md bg-subtle p-0.5">
                      {[1, 2, 3, 5].map((n) => (
                        <button key={n} onClick={() => setRepeats(n)}
                          className={`h-6 rounded-[5px] px-2.5 text-[12px] font-medium ${repeats === n ? "bg-bg text-ink shadow-[0_0_0_1px_var(--border)]" : "text-ink-3"}`}>{n}×</button>
                      ))}
                    </div>
                    <p className="mt-1.5 text-[12px] text-ink-3">Models aren't deterministic — repeat to see how consistent they are.</p>
                  </div>
                  <div>
                    <div className="mb-1.5 text-[12.5px] font-medium">Tools during the replay</div>
                    <Radio checked={toolMode === "recorded"} onChange={() => setToolMode("recorded")} label="Use the recorded results"
                      hint="Nothing executes. Calls the original never made are flagged." />
                    <Radio checked={toolMode === "live_reads"} onChange={() => setToolMode("live_reads")} label="Also run read-only tools live"
                      hint={agent?.read_tools.length ? `Live: ${agent.read_tools.join(", ")}. Writes never run.` : "This agent declares no read-only tools."} />
                    <Radio checked={toolMode === "live"} onChange={() => setToolMode("live")} label="Run every tool for real"
                      hint="Full access: any route gets real data — and writes happen. Tasks get created, records change, messages may be sent." />
                    {toolMode === "live" && (
                      <label className="mt-2 flex cursor-pointer gap-2 rounded-md border border-critical/40 bg-critical/5 px-3 py-2 text-[12.5px]">
                        <input type="checkbox" className="mt-0.5 accent-[var(--critical)]" checked={liveConfirmed} onChange={(e) => setLiveConfirmed(e.target.checked)} />
                        <span>
                          <span className="block font-medium text-critical">I understand this changes live data and can contact people</span>
                          <span className="block text-ink-3">Each replay acts as the original run's user, with its real database. Every run × variant × repeat executes its tools again. Conversation memory stays separate.</span>
                        </span>
                      </label>
                    )}
                  </div>
                </div>
              )}
            </Step>
          </div>
        )}

      </div>

      {/* Summary: what will run, what's missing, and the button. Stays in view while you scroll. */}
      <aside className="rounded-xl border border-line bg-bg p-4 lg:sticky lg:top-4">
        <h2 className="text-[13px] font-semibold">Summary</h2>
        <dl className="mt-3 space-y-2 text-[12.5px]">
          <div className="flex justify-between gap-3"><dt className="text-ink-3">Agent</dt><dd className="truncate font-mono">{agent?.name ?? "—"}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-ink-3">Runs</dt><dd className="num">{picked.size || "none yet"}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-ink-3">Repeats</dt><dd className="num">{repeats}×</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-ink-3">Tools</dt>
            <dd className={toolMode === "live" ? "font-medium text-critical" : ""}>{toolMode === "recorded" ? "from the recording" : toolMode === "live" ? "all run for real" : "live reads"}</dd></div>
        </dl>
        <div className="mt-3 border-t border-line/70 pt-3">
          <div className="mb-1.5 text-[12px] text-ink-3">Variants</div>
          <ul className="space-y-1.5 text-[12.5px]">
            {variants.map((v, i) => {
              const per = Object.entries(picks(v));
              return (
                <li key={i}>
                  <button onClick={() => setTab(i)} className="flex w-full items-start gap-2 text-left hover:text-ink">
                    <span className={`mt-px grid size-4 shrink-0 place-items-center rounded text-[10px] font-semibold ${isComplete(v) ? "bg-good/15 text-good" : "bg-subtle text-ink-3"}`}>{LETTERS[i]}</span>
                    <span className="min-w-0 flex-1">
                      {v.mode === "all"
                        ? (v.model.trim() ? <span className="font-mono">{short(v.model.trim())}<span className="font-sans text-ink-3"> · every agent</span></span> : <span className="text-ink-3">no model yet</span>)
                        : per.length ? per.map(([a, m]) => <span key={a} className="block truncate"><span className="text-ink-2">{a}</span> → <span className="font-mono">{short(m)}</span></span>)
                          : <span className="text-ink-3">no agent changed yet</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="mt-4 border-t border-line/70 pt-3">
          {create.isError ? <p className="mb-2 text-[12.5px] text-critical">{(create.error as Error).message}</p>
            : problem ? <p className="mb-2 text-[12.5px] text-ink-3">{problem}</p>
            : <p className="num mb-2 text-[12.5px] text-ink-2">
                {picked.size} run{picked.size === 1 ? "" : "s"} × {variants.length} variant{variants.length === 1 ? "" : "s"}
                {repeats > 1 ? ` × ${repeats}` : ""} = <span className="font-medium text-ink">{jobs} replay{jobs === 1 ? "" : "s"}</span>
              </p>}
          <button disabled={!!problem || create.isPending} onClick={() => create.mutate()}
            className="h-9 w-full rounded-md bg-ink px-3.5 font-medium text-bg disabled:opacity-40">
            {create.isPending ? "Starting…" : "Run experiment"}
          </button>
          <button onClick={onClose} className="mt-1.5 h-8 w-full rounded-md text-ink-2 hover:bg-subtle">Cancel</button>
        </div>
      </aside>
      </div>
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="bg-subtle/60 px-5 py-2.5 text-[12.5px] text-ink-2">{children}</p>;
}

function Step({ n, title, hint, aside, children }: { n: number; title: string; hint?: string; aside?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <section className="px-5 py-4">
      <div className="mb-3 flex items-center gap-2.5">
        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-ink text-[11px] font-semibold text-bg">{n}</span>
        <h3 className="text-[13.5px] font-semibold">{title}</h3>
        {aside && <div className="ml-auto">{aside}</div>}
      </div>
      {hint && <p className="-mt-1.5 mb-3 pl-[30px] text-[12px] text-ink-3">{hint}</p>}
      {children && <div className="pl-[30px]">{children}</div>}
    </section>
  );
}

function RunPicker({ runs, loading, picked, setPicked, root }: {
  runs: SourceRun[]; loading: boolean; picked: Set<string>; setPicked: (s: Set<string>) => void; root?: string;
}) {
  const [q, setQ] = useState("");
  const shown = runs.filter((r) => !q || `${r.input_text} ${r.output_text}`.toLowerCase().includes(q.toLowerCase()));
  const toggle = (id: string, on: boolean) => { const n = new Set(picked); if (on) n.add(id); else n.delete(id); setPicked(n); };
  if (loading) return <p className="text-ink-3">Loading runs…</p>;
  if (!runs.length) return <p className="text-ink-3">No recorded “{root}” runs yet — run the agent once and they appear here.</p>;
  return (
    <>
      <div className="mb-2 flex items-center gap-2 text-[12.5px]">
        <input className={`${controlCls} w-56`} placeholder="Search runs" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="num text-ink-3">{picked.size ? `${picked.size} of ${runs.length} selected` : `${runs.length} runs — tick the ones to replay`}</span>
        <button className="ml-auto text-accent hover:underline" onClick={() => setPicked(new Set([...picked, ...shown.map((r) => r.trace_id)]))}>Select all{q ? " shown" : ""}</button>
        <button className="text-ink-3 hover:text-ink" onClick={() => setPicked(new Set())}>Clear</button>
      </div>
      <div className="max-h-[340px] overflow-auto rounded-md border border-line">
        {shown.map((s) => (
          <label key={s.trace_id} className={`flex cursor-pointer items-start gap-3 border-b border-line/70 px-3 py-2 last:border-0 ${picked.has(s.trace_id) ? "bg-accent-soft/40" : "hover:bg-hover"}`}>
            <input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={picked.has(s.trace_id)} onChange={(e) => toggle(s.trace_id, e.target.checked)} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px]">{s.input_text || <span className="text-ink-3">(no readable input)</span>}</span>
              {s.output_text && <span className="block truncate text-[12px] text-ink-3">→ {s.output_text}</span>}
            </span>
            <span className="shrink-0 text-[12px] text-ink-3"><Time value={s.start_time} /></span>
          </label>
        ))}
        {!shown.length && <p className="px-3 py-3 text-ink-3">No runs match “{q}”.</p>}
      </div>
    </>
  );
}

function VariantEditor({ v, letter, index, tree, currentModel, modelOptions, usedAgents, runsPicked, focusAgent, onChange, onRemove }: {
  v: VariantDraft; letter: string; index: number; tree: TreeRow[]; currentModel: string; modelOptions: ModelOption[];
  usedAgents: Map<string, number>; runsPicked: number; focusAgent?: string;
  onChange: (patch: Partial<VariantDraft>) => void; onRemove?: () => void;
}) {
  const changed = Object.keys(picks(v)).length;
  return (
    <div className="pt-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md bg-subtle p-0.5" role="tablist">
          {(["all", "per"] as const).map((m) => (
            <button key={m} role="tab" aria-selected={v.mode === m} onClick={() => onChange({ mode: m })}
              className={`h-7 rounded-[5px] px-3 text-[12.5px] font-medium ${v.mode === m ? "bg-bg text-ink shadow-[0_0_0_1px_var(--border)]" : "text-ink-3 hover:text-ink-2"}`}>
              {m === "all" ? "Same model for every agent" : `Choose per agent${changed ? ` · ${changed}` : ""}`}
            </button>
          ))}
        </div>
        <input className={`${controlCls} ml-auto w-48`} placeholder={`Name (default: ${isComplete(v) ? autoName(v, index) : `Variant ${letter}`})`}
          value={v.name} onChange={(e) => onChange({ name: e.target.value })} aria-label={`Variant ${letter} name`} />
        {onRemove && <button onClick={onRemove} className="text-[12.5px] text-ink-3 hover:text-critical">Remove</button>}
      </div>

      {v.mode === "all" ? (
        <div className="flex items-end gap-3">
          <label className="flex-1">
            <span className="mb-1 block text-[12px] text-ink-3">Model for the whole run</span>
            <ModelPicker autoFocus value={v.model} onChange={(model) => onChange({ model })} options={modelOptions} />
          </label>
          {currentModel && (
            <div className="shrink-0 pb-1.5 text-[12px] text-ink-3">Runs today on <span className="font-mono text-ink-2">{short(currentModel)}</span></div>
          )}
        </div>
      ) : tree.length ? (
        <AgentModels v={v} tree={tree} modelOptions={modelOptions} usedAgents={usedAgents} runsPicked={runsPicked}
          focusAgent={focusAgent} onChange={onChange} />
      ) : (
        <FreeFormAgents v={v} modelOptions={modelOptions} onChange={onChange} />
      )}
    </div>
  );
}

/** Per-agent models: agents that ran in the picked runs first; tick some, set one model for all of them. */
function AgentModels({ v, tree, modelOptions, usedAgents, runsPicked, focusAgent, onChange }: {
  v: VariantDraft; tree: TreeRow[]; modelOptions: ModelOption[]; usedAgents: Map<string, number>; runsPicked: number;
  focusAgent?: string; onChange: (patch: Partial<VariantDraft>) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(focusAgent ? [focusAgent] : []));
  const [model, setModel] = useState("");
  const [q, setQ] = useState("");
  const [showOthers, setShowOthers] = useState(false);
  const set = picks(v);
  const known = usedAgents.size > 0;
  const match = (r: TreeRow) => !q || r.name.toLowerCase().includes(q.toLowerCase());
  const usedRows = tree.filter((r) => usedAgents.has(r.name) && match(r));
  const otherRows = tree.filter((r) => !usedAgents.has(r.name) && match(r));
  const toggle = (name: string) => setSelected((s) => { const n = new Set(s); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  const apply = () => {
    const m = model.trim();
    if (!m || !selected.size) return;
    onChange({ perAgent: { ...v.perAgent, ...Object.fromEntries([...selected].map((a) => [a, m])) } });
    setSelected(new Set());
    setModel("");
  };
  const unset = (agent: string) => { const n = { ...v.perAgent }; delete n[agent]; onChange({ perAgent: n }); };

  const row = (r: TreeRow, dim: boolean) => {
    const assigned = set[r.name];
    const on = selected.has(r.name);
    return (
      <label key={r.name} className={`flex cursor-pointer items-center gap-2.5 border-b border-line/60 px-3 py-1.5 last:border-0 ${on ? "bg-accent-soft/40" : "hover:bg-hover"} ${dim && !assigned ? "opacity-60" : ""}`}>
        <input type="checkbox" className="accent-[var(--accent)]" checked={on} onChange={() => toggle(r.name)} />
        <Tile role={r.depth === 0 ? "main" : "sub"} size={18} />
        <span className="min-w-0 flex-1 truncate text-[12.5px]">{r.name}</span>
        {usedAgents.has(r.name) && <span className="num shrink-0 text-[11px] text-ink-3">in {usedAgents.get(r.name)} of {runsPicked} runs</span>}
        <span className="w-32 shrink-0 truncate text-right font-mono text-[11.5px] text-ink-3" title={r.model}>{r.model ? short(r.model) : "—"}</span>
        <span className="w-40 shrink-0 text-right">
          {assigned ? (
            <span className="inline-flex max-w-full items-center gap-1 rounded bg-accent-soft px-1.5 py-0.5 font-mono text-[11.5px] text-ink">
              → <span className="truncate">{short(assigned)}</span>
              <button type="button" onClick={(e) => { e.preventDefault(); unset(r.name); }} className="text-ink-3 hover:text-ink" aria-label={`Keep ${r.name} unchanged`}>
                <Icon.close size={11} />
              </button>
            </span>
          ) : <span className="text-[11.5px] text-ink-3">unchanged</span>}
        </span>
      </label>
    );
  };

  return (
    <div>
      {Object.keys(set).length > 0 && (
        <div className="mb-2.5 flex flex-wrap gap-1.5">
          {Object.entries(set).map(([agent, m]) => (
            <span key={agent} className="inline-flex items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-1 text-[12px]">
              <span className="text-ink-2">{agent}</span><span className="text-ink-3">→</span><span className="font-mono">{short(m)}</span>
              <button type="button" onClick={() => unset(agent)} className="text-ink-3 hover:text-ink" aria-label={`Keep ${agent} unchanged`}><Icon.close size={11} /></button>
            </span>
          ))}
        </div>
      )}

      <div className="rounded-md border border-line">{/* no overflow clip: the model dropdown must hang out of it */}
        <div className="flex flex-wrap items-center gap-2 rounded-t-md border-b border-line bg-panel px-3 py-2">
          <input className={`${controlCls} w-44`} placeholder="Find agent" value={q} onChange={(e) => setQ(e.target.value)} />
          {known && (
            <button type="button" onClick={() => setSelected(new Set(tree.filter((r) => usedAgents.has(r.name)).map((r) => r.name)))}
              className="text-[12px] text-accent hover:underline">Select all used</button>
          )}
          {selected.size > 0 && <button type="button" onClick={() => setSelected(new Set())} className="text-[12px] text-ink-3 hover:text-ink">Clear</button>}
          <div className="ml-auto flex min-w-[320px] flex-1 items-center gap-2">
            <ModelPicker value={model} onChange={setModel} options={modelOptions} className="flex-1"
              placeholder={selected.size ? `Model for ${selected.size} selected agent${selected.size === 1 ? "" : "s"}` : "Tick agents, then pick a model"} />
            <button type="button" disabled={!selected.size || !model.trim()} onClick={apply}
              className="h-8 shrink-0 rounded-md bg-ink px-3 text-[12.5px] font-medium text-bg disabled:opacity-40">
              Apply{selected.size ? ` to ${selected.size}` : ""}
            </button>
          </div>
        </div>

        <div className="max-h-80 overflow-auto">
          {!runsPicked ? (
            <p className="border-b border-line/60 px-3 py-2 text-[12px] text-ink-3">Pick runs in step 1 to see which agents they actually use.</p>
          ) : known ? (
            <div className="border-b border-line/60 bg-panel/60 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.05em] text-ink-3">
              Used in your {runsPicked} selected run{runsPicked === 1 ? "" : "s"} · {usedRows.length}
            </div>
          ) : null}
          {(known ? usedRows : tree.filter(match)).map((r) => row(r, false))}
          {known && otherRows.length > 0 && (
            <>
              <button type="button" onClick={() => setShowOthers((o) => !o)}
                className="flex w-full items-center gap-1.5 border-b border-line/60 bg-panel/60 px-3 py-1.5 text-left text-[11.5px] text-ink-3 hover:text-ink">
                <Icon.chevronRight size={11} className={`transition-transform ${showOthers || q ? "rotate-90" : ""}`} />
                Other agents · {otherRows.length} — didn't run in these runs, so changing them has no effect
              </button>
              {(showOthers || q) && otherRows.map((r) => row(r, true))}
            </>
          )}
        </div>
      </div>
      <p className="mt-1.5 text-[11.5px] text-ink-3">Agents you don't change keep the model they run on today.</p>
    </div>
  );
}

/** No blueprint yet: type the agent names. */
function FreeFormAgents({ v, modelOptions, onChange }: { v: VariantDraft; modelOptions: ModelOption[]; onChange: (patch: Partial<VariantDraft>) => void }) {
  const rows = Object.entries(v.perAgent);
  const [draft, setDraft] = useState({ agent: "", model: "" });
  return (
    <div className="space-y-1.5">
      {rows.map(([a, m]) => (
        <div key={a} className="flex items-center gap-2 text-[12.5px]">
          <span className="w-44 truncate font-mono">{a}</span><span className="text-ink-3">uses</span>
          <span className="flex-1 font-mono">{m}</span>
          <button onClick={() => { const n = { ...v.perAgent }; delete n[a]; onChange({ perAgent: n }); }} className="text-ink-3 hover:text-ink"><Icon.close size={12} /></button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <input className={`${controlCls} h-8 w-44 font-mono text-[12px]`} placeholder="agent name" value={draft.agent} onChange={(e) => setDraft({ ...draft, agent: e.target.value })} />
        <span className="text-[12.5px] text-ink-3">uses</span>
        <ModelPicker value={draft.model} onChange={(model) => setDraft({ ...draft, model })} options={modelOptions} className="flex-1" />
        <button disabled={!draft.agent.trim() || !draft.model.trim()} className="text-[12.5px] text-accent disabled:opacity-40"
          onClick={() => { onChange({ perAgent: { ...v.perAgent, [draft.agent.trim()]: draft.model.trim() } }); setDraft({ agent: "", model: "" }); }}>Add</button>
      </div>
      <p className="text-[11.5px] text-ink-3">The app hasn't published a blueprint yet, so type agent names as they appear in traces.</p>
    </div>
  );
}

function Radio({ checked, onChange, label, hint }: { checked: boolean; onChange: () => void; label: string; hint: string }) {
  return (
    <label className="mb-1.5 flex cursor-pointer gap-2">
      <input type="radio" className="mt-0.5 accent-[var(--accent)]" checked={checked} onChange={onChange} />
      <span>
        <span className="block text-[12.5px]">{label}</span>
        <span className="block text-[12px] text-ink-3">{hint}</span>
      </span>
    </label>
  );
}
