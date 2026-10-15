import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, apiPost, type Blueprint, type BlueprintSummary, type BpAgent, type Runner } from "../lib/api";
import { pp } from "../lib/project";
import { useAppState } from "../lib/state";
import { Tile } from "./FlowView";
import { Icon } from "./icons";
import { ModelPicker, useModelOptions, type ModelOption } from "./ModelPicker";
import { Time } from "./Time";
import { controlCls } from "./ui";

interface SourceRun { trace_id: string; project: string; start_time: string; thread_id: string; input_text: string; output_text: string }
interface TreeRow { name: string; depth: number; model: string }
type ToolMode = "recorded" | "live_reads" | "live";

const short = (m: string) => m.split("/").pop() ?? m;
const LATEST = [5, 10, 20, 50];
const STEPS = ["Runs", "Agents", "Options"] as const;

/** New experiment, one question per screen: 1 · which runs  2 · which agents get which model  3 · options. */
export function NewExperiment({ onClose, preselected = [], rootName, focusAgent }: {
  onClose: () => void; preselected?: string[]; rootName?: string;
  /** Opened from one agent: its model row starts open on screen 2. */
  focusAgent?: string;
}) {
  const { project } = useAppState();
  const navigate = useNavigate();
  // Started from a run ("Try another model" on a trace): the run is already chosen — go straight to the agents.
  const [step, setStep] = useState(preselected.length ? 1 : 0);

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

  // Screen 1: runs — the latest N, or ones you pick (runs chosen on the Traces page arrive picked).
  const sources = useQuery({
    enabled: !!agent,
    queryKey: ["exp-sources", agent?.source_root, project],
    queryFn: () => api<SourceRun[]>("/api/experiments/sources", { root_name: agent!.source_root, project: project || undefined, limit: 100 }),
  });
  const [runMode, setRunMode] = useState<"latest" | "pick">(preselected.length ? "pick" : "latest");
  const [latest, setLatest] = useState(10);
  const [picked, setPicked] = useState<Set<string>>(new Set(preselected));
  const runIds = useMemo(
    () => (runMode === "latest" ? (sources.data ?? []).slice(0, latest).map((r) => r.trace_id) : [...picked]),
    [runMode, latest, picked, sources.data]);

  // Screen 2: the agent setup — every agent with today's model, and which of them ran in those runs.
  const bp = useQuery({
    enabled: !!agent, retry: false, queryKey: ["blueprint", project, agent?.name, "7"],
    queryFn: () => api<Blueprint>(`/api/blueprints/${project}/${agent!.name}`, { days: 7 }),
  });
  const tree = useMemo((): TreeRow[] => {
    if (!bp.data) return [];
    const st = bp.data.stats;
    const walk = (a: BpAgent, depth: number): TreeRow[] => [
      { name: a.name, depth, model: st[a.name]?.models[0]?.model || a.model?.name || "" },
      ...[...a.subagents].sort((x, y) => x.name.localeCompare(y.name)).flatMap((k) => walk(k, depth + 1))];
    return walk(bp.data.blueprint.root, 0);
  }, [bp.data]);
  const idsKey = [...runIds].sort().join(",");
  const used = useQuery({
    enabled: runIds.length > 0, queryKey: ["source-agents", idsKey],
    queryFn: () => api<{ agent: string; runs: number; llm_calls: number }[]>("/api/experiments/source-agents", { trace_ids: idsKey }),
  });
  const usedAgents = useMemo(() => new Map((used.data ?? []).map((u) => [u.agent, u.runs])), [used.data]);
  const modelOptions = useModelOptions(project, tree.map((r) => r.model));

  // One model for every agent is a column's "All →" in the matrix — no separate mode.
  const scope = "some" as "some" | "all";
  const [perAgent, setPerAgent] = useState<Record<string, string>>(focusAgent ? { [focusAgent]: "" } : {});
  const [allModel, setAllModel] = useState("");
  const changes: Record<string, string> = Object.fromEntries(Object.entries(perAgent).map(([a, m]) => [a, m.trim()]).filter(([, m]) => m));
  const nChanges = scope === "all" ? (allModel.trim() ? 1 : 0) : Object.keys(changes).length;

  // Screen 3: options.
  const [repeats, setRepeats] = useState(1);
  const [toolMode, setToolMode] = useState<ToolMode>("recorded");
  const [liveConfirmed, setLiveConfirmed] = useState(false);

  const variantName = scope === "all" ? short(allModel.trim())
    : Object.entries(changes).map(([a, m]) => `${a} → ${short(m)}`).join(", ");
  const create = useMutation({
    mutationFn: () => apiPost<{ id: string }>("/api/experiments", {
      agent: agent!.name, project, source_trace_ids: runIds, repeats, tool_mode: toolMode,
      variants: [{ name: variantName.length > 80 ? `${Object.keys(changes).length} agents changed` : variantName,
                   model: scope === "all" ? allModel.trim() : "", models: scope === "all" ? {} : changes }],
    }),
    onSuccess: (r) => { onClose(); navigate(pp(`/experiments/${r.id}`)); },
  });

  // What blocks each screen's Continue.
  const blocked = [
    !agent ? "No agent to replay yet" : runIds.length === 0 ? (runMode === "pick" ? "Tick at least one run" : "No recorded runs yet") : null,
    nChanges === 0 ? (scope === "all" ? "Pick a model" : "Change the model of at least one agent") : null,
    toolMode === "live" && !liveConfirmed ? "Confirm that replays may change live data" : null,
  ];
  const canOpen = (i: number) => blocked.slice(0, i).every((b) => !b);
  const jobs = runIds.length * repeats;

  return (
    <div>
      <nav className="mb-2 text-[12.5px] text-ink-3">
        <button onClick={onClose} className="hover:text-ink">Experiments</button> /
      </nav>
      <div className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-2">
        <h1 className="text-[15px] font-semibold tracking-[-0.01em]">New experiment</h1>
        <ol className="ml-auto flex items-center gap-1 text-[12.5px]">
          {STEPS.map((s, i) => (
            <li key={s} className="flex items-center gap-1">
              {i > 0 && <span className="mx-1 h-px w-5 bg-line-strong" />}
              <button disabled={!canOpen(i)} onClick={() => setStep(i)}
                className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 disabled:cursor-default ${i === step ? "font-medium text-ink" : "text-ink-3 enabled:hover:text-ink"}`}>
                <span className={`grid size-5 place-items-center rounded-full text-[11px] font-semibold ${i === step ? "bg-ink text-bg" : i < step ? "bg-good/15 text-good" : "bg-subtle text-ink-3"}`}>
                  {i < step ? <Icon.check size={11} /> : i + 1}
                </span>
                {s}
              </button>
            </li>
          ))}
        </ol>
      </div>

      <div className="rounded-xl border border-line bg-bg">
        {agents.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="font-medium">No agents yet</p>
            <p className="mx-auto mt-1 max-w-md text-ink-3">Connect your app (<span className="font-mono text-ink">imagent.init()</span>) and let it run once — its agents show up here. Experiments also need <span className="font-mono text-ink">IMAGENT_EXPERIMENTS=true</span> in the app's .env.</p>
          </div>
        ) : (
          <>
            {agent && agent.connected === false && (
              <Notice>Your app isn't connected for experiments right now. You can set this up — it starts when the app connects (<span className="font-mono">IMAGENT_EXPERIMENTS=true</span> in its .env, then restart).</Notice>
            )}
            {agent && agent.connected && agent.ready === false && (
              <Notice>Your app is connected but hasn't run <span className="font-mono">{agent.name}</span> since it started — this starts after its next run.</Notice>
            )}

            <div className="px-6 py-5">
              {step === 0 && (
                <Screen title="Which runs do you want to test?" hint="imagent replays them with the new models and compares each answer with the original.">
                  {agents.length > 1 && (
                    <label className="mb-4 flex items-center gap-2 text-[12.5px] text-ink-3">Agent
                      <select className={controlCls} value={agent?.name ?? ""} onChange={(e) => { setAgentName(e.target.value); setPicked(new Set()); setPerAgent({}); }}>
                        {agents.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
                      </select>
                    </label>
                  )}
                  <div className="space-y-2.5">
                    <Choice checked={runMode === "latest"} onPick={() => setRunMode("latest")} title={
                      <span className="inline-flex flex-wrap items-center gap-1.5">The latest
                        <select className={controlCls} value={latest}
                          onChange={(e) => { setLatest(Number(e.target.value)); setRunMode("latest"); }}>
                          {LATEST.map((n) => <option key={n} value={n}>{n}</option>)}
                        </select>
                        runs
                      </span>}
                      hint={sources.isPending ? "Loading runs…" : sources.data?.length
                        ? <>Recommended. {Math.min(latest, sources.data.length)} runs, newest from <Time value={sources.data[0].start_time} />.</>
                        : "No recorded runs of this agent yet — run it once and they appear here."} />
                    <Choice checked={runMode === "pick"} onPick={() => setRunMode("pick")} title="Let me choose the runs"
                      hint={picked.size ? `${picked.size} picked` : "Search and tick specific runs, e.g. ones that went wrong."}>
                      {runMode === "pick" && (
                        <div className="mt-3"><RunPicker runs={sources.data ?? []} loading={sources.isPending} picked={picked} setPicked={setPicked} root={agent?.source_root} /></div>
                      )}
                    </Choice>
                  </div>
                </Screen>
              )}

              {step === 1 && (
                <Screen title="Which agents should use a different model?"
                  hint={`Your setup for ${agent?.name}. Agents you leave alone keep the model they run on today.`}>
                  {scope === "all" ? (
                    <div>
                      <ModelPicker autoFocus value={allModel} onChange={setAllModel} options={modelOptions} />
                      {tree[0]?.model && <p className="mt-2 text-[12px] text-ink-3">Today: <span className="font-mono text-ink-2">{tree[0].model}</span>{tree.length > 1 ? " (and the sub-agents' own models)" : ""}</p>}
                    </div>
                  ) : tree.length ? (
                    <AgentSetup tree={tree} usedAgents={usedAgents} usedKnown={used.isSuccess} runs={runIds.length}
                      perAgent={perAgent} setPerAgent={setPerAgent} modelOptions={modelOptions} />
                  ) : bp.isPending ? <p className="text-ink-3">Loading your agent setup…</p> : (
                    <FreeFormAgents perAgent={perAgent} setPerAgent={setPerAgent} modelOptions={modelOptions} />
                  )}
                </Screen>
              )}

              {step === 2 && (
                <Screen title="Options" hint="The defaults are safe: nothing in your app executes for real.">
                  <div className="mb-5 rounded-lg border border-line bg-panel px-4 py-3 text-[12.5px]">
                    <Review label="Runs" onEdit={() => setStep(0)}>
                      {runMode === "latest" ? `The latest ${runIds.length}` : `${runIds.length} picked`} run{runIds.length === 1 ? "" : "s"} of <span className="font-mono">{agent?.name}</span>
                    </Review>
                    <Review label="Changes" onEdit={() => setStep(1)}>
                      {scope === "all" ? <>Every agent → <span className="font-mono">{allModel.trim()}</span></>
                        : Object.entries(changes).map(([a, m]) => (
                          <span key={a} className="block truncate">{a}: <span className="font-mono text-ink-3 line-through">{short(tree.find((r) => r.name === a)?.model ?? "")}</span> → <span className="font-mono">{short(m)}</span></span>
                        ))}
                    </Review>
                  </div>
                  <div className="grid gap-6 sm:grid-cols-[auto_1fr]">
                    <div>
                      <div className="mb-1.5 text-[12.5px] font-medium">Run each replay</div>
                      <div className="inline-flex rounded-md bg-subtle p-0.5">
                        {[1, 2, 3, 5].map((n) => (
                          <button key={n} onClick={() => setRepeats(n)}
                            className={`h-6 rounded-[5px] px-2.5 text-[12px] font-medium ${repeats === n ? "bg-bg text-ink shadow-[0_0_0_1px_var(--border)]" : "text-ink-3"}`}>{n}×</button>
                        ))}
                      </div>
                      <p className="mt-1.5 max-w-[220px] text-[12px] text-ink-3">Repeat to see how consistent the model is.</p>
                    </div>
                    <div>
                      <div className="mb-1.5 text-[12.5px] font-medium">Tools during the replay</div>
                      <Radio checked={toolMode === "recorded"} onChange={() => setToolMode("recorded")} label="Use the recorded results (recommended)"
                        hint="Nothing executes. Calls the original never made are flagged." />
                      <Radio checked={toolMode === "live_reads"} onChange={() => setToolMode("live_reads")} label="Also run read-only tools live"
                        hint={agent?.read_tools.length ? `Live: ${agent.read_tools.join(", ")}. Writes never run.` : "This agent declares no read-only tools."} />
                      <Radio checked={toolMode === "live"} onChange={() => setToolMode("live")} label="Run every tool for real"
                        hint="Full access: real data — and writes happen. Tasks get created, records change, messages may be sent." />
                      {toolMode === "live" && (
                        <label className="mt-2 flex cursor-pointer gap-2 rounded-md border border-critical/40 bg-critical/5 px-3 py-2 text-[12.5px]">
                          <input type="checkbox" className="mt-0.5 accent-[var(--critical)]" checked={liveConfirmed} onChange={(e) => setLiveConfirmed(e.target.checked)} />
                          <span>
                            <span className="block font-medium text-critical">I understand this changes live data and can contact people</span>
                            <span className="block text-ink-3">Each replay acts as the original run's user, with its real database.</span>
                          </span>
                        </label>
                      )}
                    </div>
                  </div>
                </Screen>
              )}
            </div>

            <footer className="flex items-center gap-3 rounded-b-xl border-t border-line bg-panel px-6 py-3">
              <button onClick={step === 0 ? onClose : () => setStep(step - 1)} className="h-8 rounded-md px-3 text-ink-2 hover:bg-subtle">
                {step === 0 ? "Cancel" : "Back"}
              </button>
              <span className="ml-auto text-[12.5px] text-ink-3">
                {create.isError ? <span className="text-critical">{(create.error as Error).message}</span>
                  : blocked[step] ?? (step === 0 ? `${runIds.length} run${runIds.length === 1 ? "" : "s"}`
                    : step === 1 ? `${nChanges} ${scope === "all" ? "model" : nChanges === 1 ? "agent changed" : "agents changed"}`
                    : `${jobs} replay${jobs === 1 ? "" : "s"}`)}
              </span>
              {step < 2 ? (
                <button disabled={!!blocked[step]} onClick={() => setStep(step + 1)}
                  className="h-8 rounded-md bg-ink px-4 font-medium text-bg disabled:opacity-40">Continue</button>
              ) : (
                <button disabled={!!blocked[2] || create.isPending} onClick={() => create.mutate()}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-4 font-medium text-bg disabled:opacity-40">
                  <Icon.play size={11} /> {create.isPending ? "Starting…" : "Run experiment"}
                </button>
              )}
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="rounded-t-xl border-b border-line bg-subtle/60 px-6 py-2.5 text-[12.5px] text-ink-2">{children}</p>;
}

function Screen({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
      {hint && <p className="mt-0.5 text-[12.5px] text-ink-3">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** A big radio option: title, one-line hint, optional body shown under it. */
function Choice({ checked, onPick, title, hint, children }: {
  checked: boolean; onPick: () => void; title: React.ReactNode; hint: React.ReactNode; children?: React.ReactNode;
}) {
  return (
    <div onClick={checked ? undefined : onPick}
      className={`rounded-lg border px-4 py-3 ${checked ? "border-accent shadow-[0_0_0_3px_var(--accent-soft)]" : "cursor-pointer border-line hover:border-line-strong"}`}>
      <div className="flex gap-3" onClick={onPick}>
        <span className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border ${checked ? "border-accent" : "border-line-strong"}`}>
          {checked && <span className="size-2 rounded-full bg-accent" />}
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-ink">{title}</div>
          <div className="mt-0.5 text-[12px] text-ink-3">{hint}</div>
        </div>
      </div>
      {children}
    </div>
  );
}

function Review({ label, onEdit, children }: { label: string; onEdit: () => void; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 border-b border-line/70 py-1.5 last:border-0">
      <span className="w-16 shrink-0 text-ink-3">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
      <button onClick={onEdit} className="shrink-0 text-accent hover:underline">Edit</button>
    </div>
  );
}

/** The agent × model matrix: one row per agent, one column per model. Click a cell to move that
 *  agent to that model; a column's "All" moves every shown agent. Columns start as the models your
 *  agents use today — add any other model as a new column. */
function AgentSetup({ tree, usedAgents, usedKnown, runs, perAgent, setPerAgent, modelOptions }: {
  tree: TreeRow[]; usedAgents: Map<string, number>; usedKnown: boolean; runs: number;
  perAgent: Record<string, string>; setPerAgent: (f: (p: Record<string, string>) => Record<string, string>) => void; modelOptions: ModelOption[];
}) {
  const known = usedKnown && usedAgents.size > 0;
  const isUsed = (r: TreeRow) => !known || r.depth === 0 || usedAgents.has(r.name);  // the main agent ran every run
  const [showAll, setShowAll] = useState(true);  // every agent and sub-agent by default
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [newModel, setNewModel] = useState("");
  const focus = Object.entries(perAgent).find(([, m]) => !m.trim())?.[0];  // opened for one agent

  const today = useMemo(() => {
    const seen: string[] = [];
    for (const r of tree) if (r.model && !seen.includes(r.model)) seen.push(r.model);
    return seen;
  }, [tree]);
  const [extra, setExtra] = useState<string[]>(() => Object.values(perAgent).map((m) => m.trim()).filter((m) => m && !today.includes(m)));
  const columns = [...today, ...extra.filter((m) => !today.includes(m))];
  // A newly added model column is shown right away, even when the table scrolls sideways.
  const scroller = useRef<HTMLDivElement>(null);
  const lastCount = useRef(columns.length);
  useEffect(() => {
    if (columns.length > lastCount.current && scroller.current) {
      scroller.current.scrollTo({ left: scroller.current.scrollWidth, behavior: "smooth" });
    }
    lastCount.current = columns.length;
  }, [columns.length]);

  const hidden = tree.filter((r) => !isUsed(r)).length;
  const rows = tree.filter((r) => (showAll || isUsed(r))
    && (!q.trim() || r.name.toLowerCase().includes(q.trim().toLowerCase())));
  const current = (r: TreeRow) => perAgent[r.name]?.trim() || r.model;
  const set = (names: TreeRow[], model: string) => setPerAgent((p) => {
    const n = { ...p };
    for (const r of names) {
      if (model === r.model) delete n[r.name]; else n[r.name] = model;  // back to today's model = no change
    }
    return n;
  });
  const changed = tree.filter((r) => perAgent[r.name]?.trim() && perAgent[r.name].trim() !== r.model);
  const addColumn = () => {
    const m = newModel.trim();
    if (m && !columns.includes(m)) setExtra((e) => [...e, m]);
    setNewModel("");
    setAdding(false);
  };
  const dropColumn = (m: string) => {  // agents moved to a removed model go back to today's
    setExtra((e) => e.filter((x) => x !== m));
    setPerAgent((p) => Object.fromEntries(Object.entries(p).filter(([, v]) => v.trim() !== m)));
  };

  // "+ Model" opens a floating panel (fixed position) so the scrolling table never clips it.
  const addBtn = useRef<HTMLButtonElement>(null);
  const [addAt, setAddAt] = useState<{ top: number; right: number } | null>(null);
  const openAdd = () => {
    const r = addBtn.current?.getBoundingClientRect();
    if (r) setAddAt({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    setAdding(true);
  };
  const closeAdd = () => { setAdding(false); setNewModel(""); setAddAt(null); };
  useEffect(() => {
    if (!adding) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeAdd(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // Opened for one agent (Try another model on a sub-agent): bring its row into view.
  useEffect(() => {
    if (!focus) return;
    const row = scroller.current?.querySelector(`[data-agent="${CSS.escape(focus)}"]`);
    row?.scrollIntoView({ block: "center" });
  }, [focus, rows.length]);
  const headTop = "sticky top-0";  // the model header stays in view while the agent list scrolls

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Icon.search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-3" />
          <input className={`${controlCls} h-8 w-56 pl-7`} placeholder="Search agents" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {known && hidden > 0 && (
          <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-ink-3">
            <input type="checkbox" className="accent-[var(--accent)]" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            Include {hidden} that didn't run in these {runs} runs
          </label>
        )}
        <span className="ml-auto text-[12.5px] text-ink-3">
          {changed.length ? <>{changed.length} agent{changed.length === 1 ? "" : "s"} changed ·{" "}
            <button onClick={() => setPerAgent(() => ({}))} className="text-accent hover:underline">Reset all</button></> : "Click a cell to change an agent's model"}
        </span>
      </div>

      <div ref={scroller} onScroll={() => adding && closeAdd()}
        className="max-h-[calc(100vh-300px)] min-h-[320px] overflow-auto rounded-lg border border-line">
        <table className="w-full border-separate border-spacing-0 text-[12.5px]">
          <thead>
            <tr className="bg-panel">
              <th className={`${headTop} sticky left-0 z-[3] min-w-[170px] border-b border-line bg-panel px-3 py-2 text-left text-[11px] font-medium uppercase tracking-[0.05em] text-ink-3`}>Agent</th>
              {columns.map((m) => {
                const on = rows.filter((r) => current(r) === m).length;
                const isNew = !today.includes(m);
                return (
                  <th key={m} className={`${headTop} z-[2] min-w-[104px] border-b border-l border-line bg-panel px-2 py-1.5 align-bottom font-normal`}>
                    <div className="flex items-center justify-center gap-1">
                      <span className={`whitespace-nowrap font-mono text-[12px] ${isNew ? "text-accent" : "text-ink"}`} title={m}>{short(m)}</span>
                      {isNew && <button onClick={() => dropColumn(m)} title="Remove this model" aria-label={`Remove ${m}`}
                        className="grid size-4 place-items-center rounded text-ink-3 hover:text-ink"><Icon.close size={10} /></button>}
                    </div>
                    <div className="mt-0.5 flex items-center justify-center gap-1.5 text-[11px] text-ink-3">
                      <span className="num">{on}</span>
                      <button onClick={() => set(rows, m)} title={`Move every agent shown to ${m}`}
                        className="rounded px-1 text-accent hover:bg-accent-soft">All →</button>
                    </div>
                  </th>
                );
              })}
              {/* pinned to the right edge: always visible however many models there are */}
              <th className={`${headTop} sticky right-0 z-[3] w-[1%] border-b border-l border-line bg-panel px-2 py-1.5 align-middle`}>
                <button ref={addBtn} onClick={() => (adding ? closeAdd() : openAdd())} title="Add another model as a column"
                  className={`whitespace-nowrap rounded-md border border-dashed px-2 py-1 text-[12px] ${adding ? "border-accent text-accent" : "border-line-strong text-ink-2 hover:border-ink-3 hover:text-ink"}`}>
                  + Model
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const now = current(r);
              const isChanged = now !== r.model;
              return (
                <tr key={r.name} data-agent={r.name}
                  className={isChanged ? "bg-accent-soft/25" : r.name === focus ? "bg-accent-soft/40 outline outline-1 -outline-offset-1 outline-accent/50" : ""}>
                  <td className={`sticky left-0 z-[1] border-b border-line/70 px-3 py-1.5 ${isChanged ? "bg-[color-mix(in_srgb,var(--accent-soft)_25%,var(--bg))]" : "bg-bg"}`}>
                    <div className="flex items-center gap-2" style={{ paddingLeft: Math.min(r.depth, 3) * 12 }}>
                      <Tile role={r.depth === 0 ? "main" : "sub"} size={16} />
                      <span className={`min-w-0 ${isUsed(r) ? "" : "opacity-60"}`}>
                        <span className="block truncate">{r.name}</span>
                        {known && r.depth > 0 && usedAgents.has(r.name) && <span className="block text-[11px] text-ink-3">ran in {usedAgents.get(r.name)} of {runs} runs</span>}
                      </span>
                      {isChanged && (
                        <button onClick={() => set([r], r.model)} title={`Back to ${r.model}`} className="ml-auto text-[11px] text-ink-3 hover:text-ink">undo</button>
                      )}
                    </div>
                  </td>
                  {columns.map((m) => {
                    const on = now === m;
                    const wasToday = r.model === m;
                    return (
                      <td key={m} className="border-b border-l border-line/70 p-0 text-center">
                        <button onClick={() => set([r], m)} aria-label={`${r.name} uses ${m}`} aria-pressed={on}
                          title={on ? `${r.name} uses ${m}` : `Use ${m} for ${r.name}`}
                          className="group flex h-9 w-full items-center justify-center hover:bg-hover">
                          <span className={`grid size-[18px] place-items-center rounded-full border-2 transition-colors ${
                            on ? (isChanged ? "border-accent bg-accent" : "border-ink-2 bg-ink-2") : wasToday ? "border-dashed border-ink-3/60" : "border-line-strong group-hover:border-ink-3"}`}>
                            {on && <span className="size-1.5 rounded-full bg-bg" />}
                          </span>
                        </button>
                      </td>
                    );
                  })}
                  <td className="sticky right-0 border-b border-l border-line/70 bg-bg" />
                </tr>
              );
            })}
            {!rows.length && (
              <tr><td colSpan={columns.length + 2} className="px-3 py-3 text-ink-3">No agents match “{q}”.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11.5px] text-ink-3">
        <span className="mr-3 inline-flex items-center gap-1"><span className="size-2.5 rounded-full bg-ink-2" /> today's model</span>
        <span className="mr-3 inline-flex items-center gap-1"><span className="size-2.5 rounded-full bg-accent" /> changed</span>
        <span className="inline-flex items-center gap-1"><span className="size-2.5 rounded-full border border-dashed border-ink-3" /> was today's</span>
      </p>

      {adding && addAt && (
        <div className="fixed z-[60] w-[360px] rounded-lg border border-line bg-bg p-2.5 shadow-[0_12px_32px_-8px_rgb(0_0_0/0.35)]"
          style={{ top: addAt.top, right: addAt.right }}>
          <div className="mb-1.5 text-[12px] text-ink-3">Add a model as a new column</div>
          <div className="flex items-center gap-1.5">
            <ModelPicker autoFocus value={newModel} onChange={setNewModel} options={modelOptions} placeholder="Search or type a model id" className="flex-1" />
            <button onClick={() => { addColumn(); closeAdd(); }} disabled={!newModel.trim()}
              className="h-8 shrink-0 rounded-md bg-ink px-3 text-[12.5px] font-medium text-bg disabled:opacity-40">Add</button>
            <button onClick={closeAdd} aria-label="Cancel" className="grid size-8 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-hover hover:text-ink"><Icon.close size={13} /></button>
          </div>
        </div>
      )}
    </div>
  );
}

/** No blueprint yet: type the agent names. */
function FreeFormAgents({ perAgent, setPerAgent, modelOptions }: {
  perAgent: Record<string, string>; setPerAgent: (f: (p: Record<string, string>) => Record<string, string>) => void; modelOptions: ModelOption[];
}) {
  const rows = Object.entries(perAgent).filter(([, m]) => m.trim());
  const [draft, setDraft] = useState({ agent: "", model: "" });
  return (
    <div className="space-y-1.5">
      {rows.map(([a, m]) => (
        <div key={a} className="flex items-center gap-2 text-[12.5px]">
          <span className="w-44 truncate font-mono">{a}</span><span className="text-ink-3">uses</span>
          <span className="flex-1 font-mono">{m}</span>
          <button onClick={() => setPerAgent((p) => { const n = { ...p }; delete n[a]; return n; })} className="text-ink-3 hover:text-ink"><Icon.close size={12} /></button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <input className={`${controlCls} h-8 w-44 font-mono text-[12px]`} placeholder="agent name" value={draft.agent} onChange={(e) => setDraft({ ...draft, agent: e.target.value })} />
        <span className="text-[12.5px] text-ink-3">uses</span>
        <ModelPicker value={draft.model} onChange={(model) => setDraft({ ...draft, model })} options={modelOptions} className="flex-1" />
        <button disabled={!draft.agent.trim() || !draft.model.trim()} className="text-[12.5px] text-accent disabled:opacity-40"
          onClick={() => { setPerAgent((p) => ({ ...p, [draft.agent.trim()]: draft.model.trim() })); setDraft({ agent: "", model: "" }); }}>Add</button>
      </div>
      <p className="text-[11.5px] text-ink-3">The app hasn't published its agent setup yet, so type agent names as they appear in traces.</p>
    </div>
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
        <span className="num text-ink-3">{picked.size ? `${picked.size} of ${runs.length} selected` : `${runs.length} runs`}</span>
        <button className="ml-auto text-accent hover:underline" onClick={() => setPicked(new Set([...picked, ...shown.map((r) => r.trace_id)]))}>Select all{q ? " shown" : ""}</button>
        <button className="text-ink-3 hover:text-ink" onClick={() => setPicked(new Set())}>Clear</button>
      </div>
      <div className="max-h-[340px] overflow-auto rounded-md border border-line bg-bg">
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
