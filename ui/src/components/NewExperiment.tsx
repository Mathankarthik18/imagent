import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, apiPost, type Runner } from "../lib/api";
import { useAppState } from "../lib/state";
import { Icon } from "./icons";
import { Time } from "./Time";
import { controlCls } from "./ui";

interface SourceRun { trace_id: string; project: string; start_time: string; thread_id: string; input_text: string; output_text: string }

/** Dialog: pick runs to replay, the models to try, repeats and tool mode. */
export function NewExperiment({ onClose, preselected = [], rootName }: { onClose: () => void; preselected?: string[]; rootName?: string }) {
  const { project } = useAppState();
  const navigate = useNavigate();
  const runners = useQuery({ queryKey: ["runners"], queryFn: () => api<Runner[]>("/api/runners"), refetchInterval: 5000 });
  const agents = useMemo(() => {
    const seen = new Map<string, Runner["agents"][number]>();
    for (const r of runners.data ?? []) for (const a of r.agents) seen.set(a.name, a);
    return [...seen.values()];
  }, [runners.data]);
  const [agentName, setAgentName] = useState("");
  const agent = agents.find((a) => a.name === agentName) ?? (rootName ? agents.find((a) => a.source_root === rootName) : agents[0]);
  useEffect(() => { if (agent && agent.name !== agentName) setAgentName(agent.name); }, [agent, agentName]);

  const sources = useQuery({
    enabled: !!agent,
    queryKey: ["exp-sources", agent?.source_root, project],
    queryFn: () => api<SourceRun[]>("/api/experiments/sources", { root_name: agent!.source_root, project: project || undefined, limit: 30 }),
  });
  const [picked, setPicked] = useState<Set<string>>(new Set(preselected));
  useEffect(() => {
    if (picked.size === 0 && sources.data?.length) setPicked(new Set(sources.data.slice(0, 5).map((s) => s.trace_id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources.data]);

  const [variants, setVariants] = useState([{ name: "", model: "" }]);
  const [repeats, setRepeats] = useState(1);
  const [toolMode, setToolMode] = useState<"recorded" | "live_reads">("recorded");
  const create = useMutation({
    mutationFn: () => apiPost<{ id: string }>("/api/experiments", {
      agent: agent!.name, project, source_trace_ids: [...picked], repeats, tool_mode: toolMode,
      variants: variants.filter((v) => v.model.trim()).map((v) => ({ name: v.name.trim() || v.model.trim().split("/").pop(), model: v.model.trim() })),
    }),
    onSuccess: (r) => { onClose(); navigate(`/experiments/${r.id}`); },
  });
  const validVariants = variants.filter((v) => v.model.trim()).length;
  const jobs = picked.size * validVariants * repeats;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/20 px-4 py-[6vh] dark:bg-black/50" onClick={onClose}>
      <div className="w-full max-w-3xl rounded-xl border border-line bg-bg shadow-[0_24px_64px_-16px_rgb(0_0_0/0.35)]" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center border-b border-line px-5 py-3.5">
          <h2 className="text-[14px] font-semibold">New experiment</h2>
          <span className="ml-2 text-ink-3">Replay real runs with another model and compare against the original</span>
          <button onClick={onClose} className="ml-auto text-ink-3 hover:text-ink"><Icon.close size={15} /></button>
        </header>

        {agents.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="font-medium">No runner connected</p>
            <p className="mx-auto mt-1 max-w-md text-ink-3">Experiments run inside your app so they can use its real agents and tools. Register an agent and start the runner in the app, then come back.</p>
          </div>
        ) : (
          <div className="space-y-6 px-5 py-5">
            <Field label="Agent">
              <select className={`ghost ${controlCls}`} value={agent?.name ?? ""} onChange={(e) => { setAgentName(e.target.value); setPicked(new Set()); }}>
                {agents.map((a) => <option key={a.name} value={a.name}>{a.name} — replays “{a.source_root}” runs</option>)}
              </select>
            </Field>

            <Field label="Runs to replay" hint={`${picked.size} selected · each is replayed with its recorded tool outputs`}>
              <div className="max-h-64 overflow-auto rounded-md border border-line">
                {sources.isPending ? <p className="px-3 py-4 text-ink-3">Loading runs…</p> : (sources.data ?? []).length === 0 ? (
                  <p className="px-3 py-4 text-ink-3">No recorded “{agent?.source_root}” runs yet.</p>
                ) : (sources.data ?? []).map((s) => (
                  <label key={s.trace_id} className="flex cursor-pointer items-start gap-3 border-b border-line/70 px-3 py-2 last:border-0 hover:bg-hover">
                    <input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={picked.has(s.trace_id)}
                      onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(s.trace_id); else n.delete(s.trace_id); return n; })} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{s.input_text || <span className="text-ink-3">(no readable input)</span>}</span>
                      {s.output_text && <span className="block truncate text-[12px] text-ink-3">→ {s.output_text}</span>}
                    </span>
                    <span className="shrink-0 text-[12px] text-ink-3"><Time value={s.start_time} /></span>
                  </label>
                ))}
              </div>
            </Field>

            <Field label="Models to try" hint="Each is compared against the original run (the baseline). Use your app's model id, e.g. openrouter/z-ai/glm-5.3-flash.">
              <div className="space-y-2">
                {variants.map((v, i) => (
                  <div key={i} className="flex gap-2">
                    <input className={`${controlCls} w-40`} placeholder="Label (optional)" value={v.name}
                      onChange={(e) => setVariants((vs) => vs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                    <input className={`${controlCls} flex-1 font-mono text-[12px]`} placeholder="model id" value={v.model} list="model-suggestions"
                      onChange={(e) => setVariants((vs) => vs.map((x, j) => (j === i ? { ...x, model: e.target.value } : x)))} />
                    {variants.length > 1 && (
                      <button className="px-1 text-ink-3 hover:text-critical" onClick={() => setVariants((vs) => vs.filter((_, j) => j !== i))}><Icon.close size={13} /></button>
                    )}
                  </div>
                ))}
                <datalist id="model-suggestions">{(agent?.models ?? []).map((m) => <option key={m} value={m} />)}</datalist>
                {variants.length < 5 && (
                  <button className="text-[12.5px] text-accent hover:underline" onClick={() => setVariants((vs) => [...vs, { name: "", model: "" }])}>+ Add model</button>
                )}
              </div>
            </Field>

            <div className="grid gap-6 sm:grid-cols-2">
              <Field label="Repeats per run" hint="Models aren't deterministic — repeat to see consistency.">
                <select className={`ghost ${controlCls}`} value={repeats} onChange={(e) => setRepeats(Number(e.target.value))}>
                  {[1, 2, 3, 5].map((n) => <option key={n} value={n}>{n}×</option>)}
                </select>
              </Field>
              <Field label="Tools during replay">
                <div className="space-y-1.5">
                  <Radio checked={toolMode === "recorded"} onChange={() => setToolMode("recorded")} label="Recorded outputs only"
                    hint="Nothing executes. Calls the original never made are flagged “not recorded”." />
                  <Radio checked={toolMode === "live_reads"} onChange={() => setToolMode("live_reads")} label="Recorded + live read-only tools"
                    hint={agent?.read_tools.length ? `Live: ${agent.read_tools.join(", ")}. Writes are always stubbed.` : "This agent declares no read-only tools, so everything new is stubbed."} />
                </div>
              </Field>
            </div>
          </div>
        )}

        <footer className="flex items-center gap-3 border-t border-line px-5 py-3">
          {create.isError && <span className="text-critical">{(create.error as Error).message}</span>}
          <span className="num ml-auto text-[12.5px] text-ink-3">{jobs} replay{jobs === 1 ? "" : "s"}</span>
          <button onClick={onClose} className="h-8 rounded-md px-3 text-ink-2 hover:bg-subtle">Cancel</button>
          <button disabled={!agent || picked.size === 0 || validVariants === 0 || create.isPending} onClick={() => create.mutate()}
            className="h-8 rounded-md bg-ink px-3.5 font-medium text-bg disabled:opacity-40">
            {create.isPending ? "Starting…" : "Run experiment"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[12.5px] font-medium">{label}</div>
      {children}
      {hint && <p className="mt-1 text-[12px] text-ink-3">{hint}</p>}
    </div>
  );
}

function Radio({ checked, onChange, label, hint }: { checked: boolean; onChange: () => void; label: string; hint: string }) {
  return (
    <label className="flex cursor-pointer gap-2">
      <input type="radio" className="mt-0.5 accent-[var(--accent)]" checked={checked} onChange={onChange} />
      <span>
        <span className="block">{label}</span>
        <span className="block text-[12px] text-ink-3">{hint}</span>
      </span>
    </label>
  );
}
