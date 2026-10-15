import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
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
  const [step, setStep] = useState(0);

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

  const [scope, setScope] = useState<"some" | "all">("some");
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
    <div className="mx-auto max-w-3xl">
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
                  <div className="mb-4 inline-flex rounded-md bg-subtle p-0.5">
                    {(["some", "all"] as const).map((m) => (
                      <button key={m} onClick={() => setScope(m)}
                        className={`h-7 rounded-[5px] px-3 text-[12.5px] font-medium ${scope === m ? "bg-bg text-ink shadow-[0_0_0_1px_var(--border)]" : "text-ink-3 hover:text-ink-2"}`}>
                        {m === "some" ? "Change specific agents" : "One model for every agent"}
                      </button>
                    ))}
                  </div>
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

/** The agent tree with today's models. Click "Change model" on a row to pick its new model right there.
 *  Agents that never ran in the chosen runs are folded away — changing them would have no effect. */
function AgentSetup({ tree, usedAgents, usedKnown, runs, perAgent, setPerAgent, modelOptions }: {
  tree: TreeRow[]; usedAgents: Map<string, number>; usedKnown: boolean; runs: number;
  perAgent: Record<string, string>; setPerAgent: (f: (p: Record<string, string>) => Record<string, string>) => void; modelOptions: ModelOption[];
}) {
  const [showOthers, setShowOthers] = useState(false);
  const known = usedKnown && usedAgents.size > 0;
  // The main agent always counts as used: it ran every one of these runs.
  const isUsed = (r: TreeRow) => !known || r.depth === 0 || usedAgents.has(r.name);
  const usedRows = tree.filter(isUsed);
  const otherRows = tree.filter((r) => !isUsed(r));
  const edit = (a: string, m: string | null) => setPerAgent((p) => { const n = { ...p }; if (m === null) delete n[a]; else n[a] = m; return n; });

  const row = (r: TreeRow, dim: boolean) => {
    const editing = r.name in perAgent;
    const changed = !!perAgent[r.name]?.trim();
    return (
      <div key={r.name} className={`border-b border-line/70 px-3 py-2 last:border-0 ${changed ? "bg-accent-soft/30" : ""}`}>
        <div className="flex items-center gap-2.5" style={{ paddingLeft: Math.min(r.depth, 3) * 18 }}>
          <Tile role={r.depth === 0 ? "main" : "sub"} size={20} />
          <div className={`min-w-0 flex-1 ${dim ? "opacity-60" : ""}`}>
            <div className="truncate text-[13px] text-ink">{r.name}</div>
            <div className="truncate text-[11.5px] text-ink-3">
              <span className={`font-mono ${changed ? "line-through" : ""}`}>{r.model ? short(r.model) : "model unknown"}</span>
              {known && r.depth > 0 && usedAgents.has(r.name) && <span> · ran in {usedAgents.get(r.name)} of {runs} runs</span>}
            </div>
          </div>
          {!editing ? (
            <button onClick={() => edit(r.name, "")}
              className="h-7 shrink-0 rounded-md border border-line px-2.5 text-[12.5px] text-ink-2 hover:border-line-strong hover:text-ink">Change model</button>
          ) : (
            <div className="flex w-[300px] shrink-0 items-center gap-1.5">
              <ModelPicker autoFocus={!changed} value={perAgent[r.name]} onChange={(m) => edit(r.name, m)} options={modelOptions}
                placeholder="New model for this agent" className="flex-1" />
              <button onClick={() => edit(r.name, null)} title="Keep today's model" aria-label={`Keep ${r.name} unchanged`}
                className="grid size-7 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-hover hover:text-ink"><Icon.close size={13} /></button>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div>
      <div className="rounded-lg border border-line">{/* no overflow clip: the model dropdown hangs out of it */}
        {known && (
          <div className="rounded-t-lg border-b border-line bg-panel px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.05em] text-ink-3">
            Ran in your {runs} run{runs === 1 ? "" : "s"} · {usedRows.length}
          </div>
        )}
        {usedRows.map((r) => row(r, false))}
        {otherRows.length > 0 && (
          <>
            <button onClick={() => setShowOthers((o) => !o)}
              className="flex w-full items-center gap-1.5 border-t border-line bg-panel px-3 py-1.5 text-left text-[12px] text-ink-3 last:rounded-b-lg hover:text-ink">
              <Icon.chevronRight size={11} className={`transition-transform ${showOthers ? "rotate-90" : ""}`} />
              {otherRows.length} other agents didn't run in these runs — changing them has no effect
            </button>
            {showOthers && otherRows.map((r) => row(r, true))}
          </>
        )}
      </div>
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
