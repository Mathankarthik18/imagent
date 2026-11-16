import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ConnectSteps, KeyReveal } from "../components/Connect";
import { Icon } from "../components/icons";
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

      <GithubSettings project={p.data} onSaved={() => qc.invalidateQueries({ queryKey: ["project", project] })} />

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

/** The app's GitHub repo, read when diagnosing issues: "Connect GitHub" (device code), then pick the
 *  repo — the folder is found from the app's agent/tool names. A pasted token still works. */
function GithubSettings({ project: p, onSaved }: { project: Project; onSaved: () => void }) {
  const app = useQuery({ queryKey: ["github-app"], queryFn: () => api<GithubApp>("/api/github") });
  const [manual, setManual] = useState(false);
  const connected = !!p.github_token_hint;
  const save = useMutation({
    mutationFn: (patch: Record<string, string>) => apiPost<Project>(`/api/projects/${p.id}`, patch, "PATCH"),
    onSuccess: onSaved,
  });
  const disconnect = () => {
    if (confirm("Disconnect GitHub from this project?"))
      save.mutate({ github_repo: "", github_token: "", github_branch: "", github_path: "" });
  };
  return (
    <Block title="Source code (for diagnosing issues)">
      <p className="mb-3 text-[12.5px] text-ink-3">
        Connect the app's GitHub repo and diagnosis reads the code behind a failure — the files in the stack trace and the
        agent's tools and prompts — and suggests the fix as a diff. Read-only: imagent never writes to the repo.
      </p>
      {connected ? (
        <>
          <div className="mb-3 flex items-center gap-2 rounded-md bg-subtle px-3 py-2 text-[12.5px]">
            <span className="size-2 rounded-full bg-good" />
            <span>Connected{p.github_login ? <> as <span className="font-medium">@{p.github_login}</span></> : <> with a token <span className="font-mono text-ink-3">{p.github_token_hint}</span></>}</span>
            {p.github_repo && <span className="text-ink-3">· <span className="font-mono text-ink-2">{p.github_repo}{p.github_path ? `/${p.github_path}` : ""}</span></span>}
            <button onClick={disconnect} className="ml-auto text-ink-3 hover:text-critical">Disconnect</button>
          </div>
          <RepoPicker project={p} app={app.data} onSaved={onSaved} />
        </>
      ) : manual || (app.data && !app.data.enabled) ? (
        <>
          {app.data && !app.data.enabled && (
            <p className="mb-3 rounded-md bg-subtle px-3 py-2 text-[12px] text-ink-2">
              One-click “Connect GitHub” needs a GitHub App on this server (<span className="font-mono">IMAGENT_GITHUB_CLIENT_ID</span> —
              see the server README). Until then, paste a token:
            </p>
          )}
          <TokenForm project={p} onSaved={onSaved} />
          {app.data?.enabled && <button onClick={() => setManual(false)} className="mt-2 text-[12px] text-ink-3 hover:text-ink">← Connect GitHub instead</button>}
        </>
      ) : (
        <ConnectGithub projectId={p.id} onConnected={onSaved} onManual={() => setManual(true)} />
      )}
    </Block>
  );
}

interface GithubApp { enabled: boolean; app_slug: string; install_url: string }
interface GithubRepo { full_name: string; default_branch: string; private: boolean; pushed_at: string }

function ConnectGithub({ projectId, onConnected, onManual }: { projectId: string; onConnected: () => void; onManual: () => void }) {
  const [code, setCode] = useState<{ user_code: string; verification_uri: string; interval: number } | null>(null);
  const [status, setStatus] = useState("");
  const [copied, setCopied] = useState(false);
  const connected = useRef(onConnected);
  connected.current = onConnected;
  const start = useMutation({
    mutationFn: () => apiPost<{ user_code: string; verification_uri: string; interval: number; expires_in: number }>(
      `/api/projects/${projectId}/github/connect`, {}),
    onSuccess: (d) => { setCode(d); setStatus("pending"); },
  });
  useEffect(() => {
    if (!code || status !== "pending") return;
    let wait = Math.max(code.interval, 5) * 1000;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await apiPost<{ status: string; interval?: number; error?: string }>(`/api/projects/${projectId}/github/poll`, {});
        if (stop) return;
        if (r.status === "connected") { setStatus("connected"); connected.current(); return; }
        if (r.status === "slow_down") wait = (r.interval ?? wait / 1000 + 5) * 1000;
        if (r.status === "pending" || r.status === "slow_down") { timer = setTimeout(poll, wait); return; }
        setStatus(r.status);
      } catch { if (!stop) timer = setTimeout(poll, wait); }
    };
    timer = setTimeout(poll, wait);
    return () => { stop = true; clearTimeout(timer); };
  }, [code, status, projectId]);

  const open = () => {
    if (!code) return;
    navigator.clipboard.writeText(code.user_code).then(() => setCopied(true), () => {});
    window.open(code.verification_uri, "_blank", "noopener");
  };

  if (code && status === "pending") {
    return (
      <div className="rounded-lg border border-line px-4 py-4">
        <div className="text-[12.5px] text-ink-2">Enter this code on GitHub and approve imagent:</div>
        <div className="my-3 flex flex-wrap items-center gap-3">
          <span className="rounded-md bg-subtle px-3 py-1.5 font-mono text-[20px] font-semibold tracking-[0.18em] text-ink">{code.user_code}</span>
          <button onClick={open} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-bg">
            <Icon.external size={12} /> {copied ? "Code copied — open GitHub" : "Copy code & open GitHub"}
          </button>
        </div>
        <div className="flex items-center gap-2 text-[12px] text-ink-3">
          <span className="size-3 animate-spin rounded-full border-2 border-line border-t-accent" /> Waiting for you to approve on GitHub…
          <button onClick={() => { setCode(null); setStatus(""); }} className="ml-auto hover:text-ink">Cancel</button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button onClick={() => start.mutate()} disabled={start.isPending}
        className="inline-flex h-8 items-center gap-2 rounded-md bg-ink px-3.5 text-[13px] font-medium text-bg disabled:opacity-50">
        <GithubMark /> {start.isPending ? "Starting…" : "Connect GitHub"}
      </button>
      <button onClick={onManual} className="text-[12px] text-ink-3 hover:text-ink">Use a token instead</button>
      {status === "expired" && <span className="text-[12.5px] text-critical">The code expired — try again.</span>}
      {status === "denied" && <span className="text-[12.5px] text-critical">Access was denied on GitHub.</span>}
      {start.isError && <span className="text-[12.5px] text-critical">{(start.error as Error).message}</span>}
    </div>
  );
}

function RepoPicker({ project: p, app, onSaved }: { project: Project; app?: GithubApp; onSaved: () => void }) {
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState(!p.github_repo);
  const [repo, setRepo] = useState(p.github_repo || "");
  const [branch, setBranch] = useState(p.github_branch || "");
  const [path, setPath] = useState(p.github_path || "");
  const [matched, setMatched] = useState<string[]>([]);
  const repos = useQuery({ queryKey: ["github-repos", p.id], queryFn: () => api<GithubRepo[]>(`/api/projects/${p.id}/github/repos`), enabled: editing });
  const suggest = useMutation({
    mutationFn: (r: GithubRepo) => api<{ path: string; matched: string[] }>(`/api/projects/${p.id}/github/suggest`, { repo: r.full_name, branch: r.default_branch }),
    onSuccess: (d) => { setPath(d.path); setMatched(d.matched); },
  });
  const save = useMutation({
    mutationFn: () => apiPost<Project>(`/api/projects/${p.id}`, { github_repo: repo, github_branch: branch, github_path: path }, "PATCH"),
    onSuccess: () => { setEditing(false); onSaved(); },
  });
  const test = useMutation({
    mutationFn: () => apiPost<{ ok: boolean; error?: string; branch?: string; commit?: string; files?: number }>(
      `/api/projects/${p.id}/github/test`, { repo, branch, path }),
  });
  const pick = (r: GithubRepo) => { setRepo(r.full_name); setBranch(r.default_branch); setPath(""); setMatched([]); suggest.mutate(r); };
  const shown = (repos.data ?? []).filter((r) => r.full_name.toLowerCase().includes(filter.trim().toLowerCase()));

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setEditing(true)} className="h-7 rounded-md border border-line px-2.5 text-[12.5px] text-ink-2 hover:border-line-strong hover:text-ink">Change repo</button>
        <button onClick={() => test.mutate()} disabled={test.isPending}
          className="h-7 rounded-md border border-line px-2.5 text-[12.5px] text-ink-2 hover:border-line-strong hover:text-ink disabled:opacity-40">{test.isPending ? "Checking…" : "Test"}</button>
        {test.data && (test.data.ok
          ? <span className="text-[12.5px] text-good">✓ Can read {test.data.files} files on {test.data.branch} ({test.data.commit})</span>
          : <span className="max-w-full truncate text-[12.5px] text-critical" title={test.data.error}>{test.data.error}</span>)}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-md border border-line">
        <div className="relative border-b border-line">
          <Icon.search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search your repositories"
            className="h-8 w-full bg-transparent pl-8 pr-3 text-[12.5px] outline-none" />
        </div>
        <div className="max-h-56 overflow-y-auto">
          {repos.isPending ? <div className="px-3 py-2 text-[12.5px] text-ink-3">Loading repositories…</div>
            : repos.isError ? <div className="px-3 py-2 text-[12.5px] text-critical">{(repos.error as Error).message}</div>
            : shown.length === 0 ? <div className="px-3 py-2 text-[12.5px] text-ink-3">No repositories{filter ? " match" : ""}.</div>
            : shown.map((r) => (
              <button key={r.full_name} onClick={() => pick(r)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-hover ${repo === r.full_name ? "bg-subtle" : ""}`}>
                <span className="truncate font-mono text-ink">{r.full_name}</span>
                {r.private && <span className="rounded bg-subtle px-1 text-[10.5px] text-ink-3">private</span>}
                {repo === r.full_name && <Icon.check size={13} className="ml-auto text-good" />}
              </button>
            ))}
        </div>
        {app?.install_url && (
          <a href={app.install_url} target="_blank" rel="noreferrer" className="block border-t border-line px-3 py-1.5 text-[12px] text-ink-3 hover:text-ink">
            Don't see your repo? Give imagent access to it on GitHub →
          </a>
        )}
      </div>

      {repo && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] text-ink-3">Branch</span>
            <input className={`${controlCls} w-full font-mono`} value={branch} onChange={(e) => setBranch(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] text-ink-3">
              App folder {suggest.isPending ? "· finding it…" : matched.length > 0 ? "· found from your agent and tool names" : ""}
            </span>
            <input className={`${controlCls} w-full font-mono`} value={path} onChange={(e) => setPath(e.target.value)} placeholder="whole repo" />
          </label>
        </div>
      )}
      <div className="flex items-center gap-2">
        <button disabled={!repo || save.isPending} onClick={() => save.mutate()}
          className="h-7 rounded-md bg-ink px-3 text-[12.5px] font-medium text-bg disabled:opacity-40">{save.isPending ? "Saving…" : "Use this repo"}</button>
        {p.github_repo && <button onClick={() => setEditing(false)} className="h-7 px-2 text-[12.5px] text-ink-3 hover:text-ink">Cancel</button>}
        {save.isError && <span className="text-[12.5px] text-critical">{(save.error as Error).message}</span>}
      </div>
    </div>
  );
}

function TokenForm({ project: p, onSaved }: { project: Project; onSaved: () => void }) {
  const [repo, setRepo] = useState(p.github_repo || "");
  const [token, setToken] = useState("");
  const [branch, setBranch] = useState(p.github_branch || "");
  const [path, setPath] = useState(p.github_path || "");
  const save = useMutation({
    mutationFn: () => apiPost<Project>(`/api/projects/${p.id}`, { github_repo: repo.trim(), github_branch: branch.trim(), github_path: path.trim(),
      ...(token.trim() ? { github_token: token.trim() } : {}) }, "PATCH"),
    onSuccess: () => { setToken(""); onSaved(); },
  });
  const validRepo = /^[\w.-]+\/[\w.-]+$/.test(repo.trim());
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-[12.5px] text-ink-3">Repository</span>
          <input className={`${controlCls} w-full font-mono`} value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[12.5px] text-ink-3">Access token</span>
          <input type="password" autoComplete="off" className={`${controlCls} w-full font-mono`} value={token} onChange={(e) => setToken(e.target.value)}
            placeholder="github_pat_… (read-only: Contents)" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[12.5px] text-ink-3">Branch</span>
          <input className={`${controlCls} w-full font-mono`} value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="default branch" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[12.5px] text-ink-3">Folder (if the app is part of a bigger repo)</span>
          <input className={`${controlCls} w-full font-mono`} value={path} onChange={(e) => setPath(e.target.value)} placeholder="e.g. backend" />
        </label>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button disabled={!validRepo || save.isPending} onClick={() => save.mutate()}
          className="h-7 rounded-md bg-ink px-3 text-[12.5px] font-medium text-bg disabled:opacity-40">{save.isPending ? "Saving…" : "Save"}</button>
        {save.isError && <span className="text-[12.5px] text-critical">{(save.error as Error).message}</span>}
      </div>
      <p className="mt-2 text-[11.5px] text-ink-3">A fine-grained token limited to this repo with read-only Contents access. Public repos work without one.</p>
    </>
  );
}

function GithubMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
