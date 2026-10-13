import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ConnectSteps, KeyReveal } from "../components/Connect";
import { ErrorBox, PageHeader, Spinner, controlCls } from "../components/ui";
import { api, apiPost, type JudgeStatus, type Project, type ProjectWithKey } from "../lib/api";
import { useAppState } from "../lib/state";

export function ProjectSettings() {
  const { project } = useAppState();
  const qc = useQueryClient();
  const p = useQuery({ queryKey: ["project", project], queryFn: () => api<Project>(`/api/projects/${project}`) });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rubric, setRubric] = useState("");
  const judge = useQuery({ queryKey: ["judge", project], queryFn: () => api<JudgeStatus>("/api/judge", { project }) });
  useEffect(() => {
    if (p.data) { setName(p.data.name); setDescription(p.data.description); setRubric(p.data.rubric ?? ""); }
  }, [p.data]);
  const saveRubric = useMutation({
    mutationFn: () => apiPost<Project>(`/api/projects/${project}`, { rubric }, "PATCH"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", project] }),
  });
  const save = useMutation({
    mutationFn: () => apiPost<Project>(`/api/projects/${project}`, { name, description }, "PATCH"),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["project", project] }); qc.invalidateQueries({ queryKey: ["projects"] }); },
  });
  const rotate = useMutation({
    mutationFn: () => apiPost<ProjectWithKey>(`/api/projects/${project}/rotate-key`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", project] }),
  });

  if (p.isError) return <ErrorBox error={p.error} />;
  if (!p.data) return <Spinner />;
  const dirty = name !== p.data.name || description !== p.data.description;
  return (
    <div className="max-w-2xl">
      <PageHeader title="Settings" meta={<span className="font-mono">{p.data.id}</span>} />

      <Block title="Project">
        <label className="block">
          <span className="mb-1.5 block text-[12.5px] text-ink-3">Name</span>
          <input className={`${controlCls} w-full`} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="mt-3 block">
          <span className="mb-1.5 block text-[12.5px] text-ink-3">Description</span>
          <input className={`${controlCls} w-full`} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="mt-3 flex items-center gap-3">
          <button disabled={!dirty || !name.trim() || save.isPending} onClick={() => save.mutate()}
            className="h-7 rounded-md bg-ink px-3 text-[12.5px] font-medium text-bg disabled:opacity-40">Save</button>
          {save.isSuccess && !dirty && <span className="text-[12px] text-ink-3">Saved</span>}
        </div>
      </Block>

      <JudgeSettings project={p.data} rubric={rubric} setRubric={setRubric} saveRubric={() => saveRubric.mutate()} savingRubric={saveRubric.isPending}
        status={judge.data} onSaved={() => { qc.invalidateQueries({ queryKey: ["project", project] }); qc.invalidateQueries({ queryKey: ["judge"] }); }} />

      <Block title="API key">
        <div className="flex items-center gap-3">
          <span className="font-mono text-[12.5px]">{p.data.key_hint || "—"}</span>
          <button onClick={() => { if (confirm("Rotate the key? Apps using the current key stop sending until they get the new one.")) rotate.mutate(); }}
            className="ml-auto h-7 rounded-md border border-line px-2.5 text-[12.5px] text-ink-2 hover:border-line-strong hover:text-ink">
            {rotate.isPending ? "Rotating…" : "Rotate key"}
          </button>
        </div>
        {rotate.data && <div className="mt-3"><KeyReveal apiKey={rotate.data.key} /></div>}
      </Block>

      <Block title="Connect your app">
        <ConnectSteps apiKey={rotate.data?.key} />
      </Block>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-4 rounded-lg border border-line px-4 py-3.5">
      <h2 className="mb-3 text-[13px] font-semibold">{title}</h2>
      {children}
    </section>
  );
}

const DEFAULT_JUDGE = "anthropic/claude-sonnet-5.5";

/** Judge key + model + rules for this project. The key is write-only: only a hint comes back. */
function JudgeSettings({ project: p, rubric, setRubric, saveRubric, savingRubric, status, onSaved }: {
  project: Project; rubric: string; setRubric: (v: string) => void; saveRubric: () => void; savingRubric: boolean;
  status?: JudgeStatus; onSaved: () => void;
}) {
  const [key, setKey] = useState("");
  const [model, setModel] = useState(p.judge_model || "");
  const [baseUrl, setBaseUrl] = useState(p.judge_base_url || "");
  const [advanced, setAdvanced] = useState(!!p.judge_base_url);
  const save = useMutation({
    mutationFn: (patch: Record<string, string>) => apiPost<Project>(`/api/projects/${p.id}`, patch, "PATCH"),
    onSuccess: () => { setKey(""); onSaved(); },
  });
  const test = useMutation({
    mutationFn: () => apiPost<{ ok: boolean; error?: string; model?: string; cost?: number }>(`/api/projects/${p.id}/judge/test`,
      { key, model: model.trim(), base_url: baseUrl.trim() }),
  });
  const dirty = !!key.trim() || model.trim() !== (p.judge_model || "") || baseUrl.trim() !== (p.judge_base_url || "");
  return (
    <Block title="Judging experiment answers">
      <p className="mb-3 text-[12.5px] text-ink-3">
        The original run isn't necessarily the right answer. A judge model compares each replay's answer with the original's —
        correct against the tool data, complete, clear, and your rules — without knowing which is which.
      </p>

      <div className="mb-3 flex items-center gap-2 rounded-md bg-subtle px-3 py-2 text-[12.5px]">
        <span className={`size-2 rounded-full ${status?.configured ? "bg-good" : "bg-ink-3/50"}`} />
        {status?.configured
          ? <span>On · <span className="font-mono">{status.model}</span>{status.source === "server" ? <span className="text-ink-3"> · using the server's key</span> : ""}</span>
          : <span className="text-ink-2">Off — add an API key below</span>}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-[12.5px] text-ink-3">API key {p.judge_key_hint && <span className="font-mono">· saved {p.judge_key_hint}</span>}</span>
          <input type="password" autoComplete="off" className={`${controlCls} w-full font-mono`} value={key} onChange={(e) => setKey(e.target.value)}
            placeholder={p.judge_key_hint ? "Enter a new key to replace it" : "sk-or-… (OpenRouter)"} />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[12.5px] text-ink-3">Judge model</span>
          <input className={`${controlCls} w-full font-mono`} value={model} onChange={(e) => setModel(e.target.value)} placeholder={DEFAULT_JUDGE} />
        </label>
      </div>
      {advanced ? (
        <label className="mt-3 block">
          <span className="mb-1.5 block text-[12.5px] text-ink-3">API endpoint (any OpenAI-compatible)</span>
          <input className={`${controlCls} w-full font-mono`} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://openrouter.ai/api/v1" />
        </label>
      ) : (
        <button onClick={() => setAdvanced(true)} className="mt-2 text-[12px] text-ink-3 hover:text-ink">Use a different endpoint…</button>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button disabled={!dirty || save.isPending}
          onClick={() => save.mutate({ ...(key.trim() ? { judge_key: key.trim() } : {}), judge_model: model.trim(), judge_base_url: baseUrl.trim() })}
          className="h-7 rounded-md bg-ink px-3 text-[12.5px] font-medium text-bg disabled:opacity-40">{save.isPending ? "Saving…" : "Save"}</button>
        <button onClick={() => test.mutate()} disabled={test.isPending || (!key.trim() && !status?.configured)}
          className="h-7 rounded-md border border-line px-2.5 text-[12.5px] text-ink-2 hover:border-line-strong hover:text-ink disabled:opacity-40">
          {test.isPending ? "Testing…" : "Test"}
        </button>
        {p.judge_key_hint && (
          <button onClick={() => { if (confirm("Remove this project's judge key?")) save.mutate({ judge_key: "" }); }}
            className="h-7 px-2 text-[12.5px] text-ink-3 hover:text-critical">Remove key</button>
        )}
        {test.data && (test.data.ok
          ? <span className="text-[12.5px] text-good">✓ Works — {test.data.model}</span>
          : <span className="max-w-full truncate text-[12.5px] text-critical" title={test.data.error}>{test.data.error}</span>)}
        {save.isError && <span className="text-[12.5px] text-critical">{(save.error as Error).message}</span>}
      </div>
      <p className="mt-2 text-[11.5px] text-ink-3">Stored on your imagent server and never shown again. Each judged replay costs one call to this model.</p>

      <label className="mt-4 block border-t border-line/70 pt-3">
        <span className="mb-1.5 block text-[12.5px] text-ink-3">Your rules for a good answer (optional)</span>
        <textarea className={`${controlCls} h-28 w-full py-2 leading-5`} value={rubric} onChange={(e) => setRubric(e.target.value)}
          placeholder={"e.g.\n- Always name the vessel and its IMO\n- Dates as DD MMM YYYY\n- Say when data is missing instead of guessing"} />
      </label>
      <div className="mt-2 flex items-center gap-3">
        <button disabled={rubric === (p.rubric ?? "") || savingRubric} onClick={saveRubric}
          className="h-7 rounded-md bg-ink px-3 text-[12.5px] font-medium text-bg disabled:opacity-40">Save rules</button>
        <span className="text-[12px] text-ink-3">Applies to replays judged from now on.</span>
      </div>
    </Block>
  );
}
