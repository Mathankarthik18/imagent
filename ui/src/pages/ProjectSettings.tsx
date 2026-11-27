import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ConnectSteps, KeyReveal } from "../components/Connect";
import { Icon } from "../components/icons";
import { Time } from "../components/Time";
import { ErrorBox, PageHeader, Spinner, controlCls } from "../components/ui";
import { api, apiPost, ISSUE_KIND, type EngineCategory, type EngineSettings, type JudgeStatus, type Project, type ProjectWithKey } from "../lib/api";
import { useAppState } from "../lib/state";

type SectionId = "general" | "model" | "engine" | "overview" | "experiments" | "source" | "sdk";

const SECTIONS: { id: SectionId; label: string; group: string }[] = [
  { id: "general", label: "General", group: "Project" },
  { id: "sdk", label: "API key & SDK", group: "Project" },
  { id: "model", label: "AI model", group: "Project" },
  { id: "engine", label: "Issue engine", group: "Issues" },
  { id: "overview", label: "Agent overview", group: "Issues" },
  { id: "source", label: "Source code", group: "Issues" },
  { id: "experiments", label: "Answer rules", group: "Experiments" },
];

export function ProjectSettings() {
  const { project } = useAppState();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const section = (SECTIONS.find((x) => x.id === params.get("s"))?.id ?? "general") as SectionId;
  const p = useQuery({ queryKey: ["project", project], queryFn: () => api<Project>(`/api/projects/${project}`) });
  const judge = useQuery({ queryKey: ["judge", project], queryFn: () => api<JudgeStatus>("/api/judge", { project }) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["project", project] }); qc.invalidateQueries({ queryKey: ["projects"] }); qc.invalidateQueries({ queryKey: ["judge"] }); };

  if (p.isError) return <ErrorBox error={p.error} />;
  if (!p.data) return <Spinner />;
  const d = p.data;
  const status: Record<SectionId, React.ReactNode> = {
    general: null,
    sdk: null,
    model: <Dot on={!!judge.data?.configured} />,
    engine: <Dot on={!!d.engine?.enabled && !!judge.data?.configured} />,
    overview: d.overview ? null : <span className="text-[10.5px] text-ink-3">empty</span>,
    source: <Dot on={!!d.github_repo} />,
    experiments: null,
  };
  const groups = [...new Set(SECTIONS.map((x) => x.group))];
  return (
    <>
      <PageHeader title="Settings" meta={<span className="font-mono">{d.id}</span>} />
      <div className="flex flex-col gap-6 md:flex-row md:items-start">
        <nav className="flex shrink-0 gap-1 overflow-x-auto md:sticky md:top-4 md:w-48 md:flex-col md:gap-4">
          {groups.map((g) => (
            <div key={g} className="flex gap-1 md:flex-col md:gap-px">
              <div className="hidden px-2.5 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3 md:block">{g}</div>
              {SECTIONS.filter((x) => x.group === g).map((x) => (
                <button key={x.id} onClick={() => setParams(x.id === "general" ? {} : { s: x.id })}
                  className={`flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-2.5 text-left text-[13px] ${section === x.id ? "bg-subtle font-medium text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"}`}>
                  {x.label}<span className="ml-auto">{status[x.id]}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="min-w-0 max-w-3xl flex-1">
          {section === "general" && <GeneralSettings project={d} onSaved={refresh} />}
          {section === "sdk" && <SdkSettings project={d} onSaved={refresh} />}
          {section === "model" && <JudgeSettings project={d} status={judge.data} onSaved={refresh} />}
          {section === "engine" && <EngineSettingsBlock project={d} judgeOn={!!judge.data?.configured} onSaved={refresh}
            go={(s) => setParams({ s })} />}
          {section === "overview" && <><AgentOverview project={d} onSaved={refresh} /><LearnedPreferences project={d} onSaved={refresh} /></>}
          {section === "source" && <GithubSettings project={d} onSaved={refresh} />}
          {section === "experiments" && <RubricSettings project={d} onSaved={refresh} />}
        </div>
      </div>
    </>
  );
}

function Dot({ on }: { on: boolean }) {
  return <span className={`block size-1.5 rounded-full ${on ? "bg-good" : "bg-ink-3/40"}`} title={on ? "On" : "Off"} />;
}

/** One settings area: a heading with what it's for, then its content. */
function Block({ title, description, children, aside }: {
  title: string; description?: React.ReactNode; children: React.ReactNode; aside?: React.ReactNode;
}) {
  return (
    <section className="mb-4 rounded-xl border border-line">
      <div className="flex items-start gap-3 border-b border-line/70 px-5 py-3.5">
        <div className="min-w-0">
          <h2 className="text-[13.5px] font-semibold text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-[12.5px] leading-5 text-ink-3">{description}</p>}
        </div>
        {aside && <div className="ml-auto shrink-0">{aside}</div>}
      </div>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

const primaryBtn = "h-7 rounded-md bg-ink px-3 text-[12.5px] font-medium text-bg disabled:opacity-40";
const secondaryBtn = "h-7 rounded-md border border-line px-2.5 text-[12.5px] text-ink-2 hover:border-line-strong hover:text-ink disabled:opacity-40";

function Field({ label, hint, children }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12.5px] font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] text-ink-3">{hint}</span>}
    </label>
  );
}

function GeneralSettings({ project: p, onSaved }: { project: Project; onSaved: () => void }) {
  const [name, setName] = useState(p.name);
  const [description, setDescription] = useState(p.description);
  const save = useMutation({
    mutationFn: () => apiPost<Project>(`/api/projects/${p.id}`, { name, description }, "PATCH"),
    onSuccess: onSaved,
  });
  const dirty = name !== p.name || description !== p.description;
  return (
    <Block title="General" description="How this project appears in imagent.">
      <div className="space-y-3">
        <Field label="Name"><input className={`${controlCls} w-full`} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Description"><input className={`${controlCls} w-full`} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label="Project id" hint="Used in URLs and stored on every trace. Can't be changed.">
          <input className={`${controlCls} w-full font-mono text-ink-3`} value={p.id} readOnly />
        </Field>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button disabled={!dirty || !name.trim() || save.isPending} onClick={() => save.mutate()} className={primaryBtn}>Save</button>
        {save.isSuccess && !dirty && <span className="text-[12px] text-ink-3">Saved</span>}
      </div>
    </Block>
  );
}

function SdkSettings({ project: p, onSaved }: { project: Project; onSaved: () => void }) {
  const rotate = useMutation({
    mutationFn: () => apiPost<ProjectWithKey>(`/api/projects/${p.id}/rotate-key`, {}),
    onSuccess: onSaved,
  });
  return (
    <>
      <Block title="API key" description="Your app sends traces, blueprints and feedback with this key.">
        <div className="flex items-center gap-3">
          <span className="font-mono text-[12.5px]">{p.key_hint || "—"}</span>
          <button onClick={() => { if (confirm("Rotate the key? Apps using the current key stop sending until they get the new one.")) rotate.mutate(); }}
            className={`ml-auto ${secondaryBtn}`}>{rotate.isPending ? "Rotating…" : "Rotate key"}</button>
        </div>
        {rotate.data && <div className="mt-3"><KeyReveal apiKey={rotate.data.key} /></div>}
      </Block>
      <Block title="Connect your app" description="Three steps; works with LangChain / LangGraph and the other supported frameworks.">
        <ConnectSteps apiKey={rotate.data?.key} />
      </Block>
    </>
  );
}

/** "Your rules for a good answer" — used when judging experiment replays. */
function RubricSettings({ project: p, onSaved }: { project: Project; onSaved: () => void }) {
  const [rubric, setRubric] = useState(p.rubric ?? "");
  const save = useMutation({
    mutationFn: () => apiPost<Project>(`/api/projects/${p.id}`, { rubric }, "PATCH"),
    onSuccess: onSaved,
  });
  return (
    <Block title="Answer rules" description="Your rules for a good answer. The judge scores every experiment replay against them, alongside correct, complete and clear.">
      <textarea className={`${controlCls} h-40 w-full py-2 leading-5`} value={rubric} onChange={(e) => setRubric(e.target.value)}
        placeholder={"e.g.\n- Always name the vessel and its IMO\n- Dates as DD MMM YYYY\n- Say when data is missing instead of guessing"} />
      <div className="mt-3 flex items-center gap-3">
        <button disabled={rubric === (p.rubric ?? "") || save.isPending} onClick={() => save.mutate()} className={primaryBtn}>Save rules</button>
        <span className="text-[12px] text-ink-3">Applies to replays judged from now on.</span>
      </div>
    </Block>
  );
}

const DEFAULT_JUDGE = "anthropic/claude-sonnet-5.5";

/** Judge key + model + rules for this project. The key is write-only: only a hint comes back. */
function JudgeSettings({ project: p, status, onSaved }: { project: Project; status?: JudgeStatus; onSaved: () => void }) {
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
    <Block title="AI model"
      description="One key and model for everything imagent asks a model to do: judging experiment answers, diagnosing issues, and the issue engine's investigations. Any OpenAI-compatible endpoint; OpenRouter by default."
      aside={<span className="inline-flex items-center gap-1.5 rounded-full bg-subtle px-2.5 py-1 text-[12px]">
        <span className={`size-1.5 rounded-full ${status?.configured ? "bg-good" : "bg-ink-3/50"}`} />
        {status?.configured ? <>On{status.source === "server" ? " · server key" : ""}</> : "Off"}
      </span>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-[12.5px] text-ink-3">API key {p.judge_key_hint && <span className="font-mono">· saved {p.judge_key_hint}</span>}</span>
          <input type="password" autoComplete="off" className={`${controlCls} w-full font-mono`} value={key} onChange={(e) => setKey(e.target.value)}
            placeholder={p.judge_key_hint ? "Enter a new key to replace it" : "sk-or-… (OpenRouter)"} />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[12.5px] text-ink-3">Model</span>
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
          className={primaryBtn}>{save.isPending ? "Saving…" : "Save"}</button>
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
      <p className="mt-2 text-[11.5px] text-ink-3">The key is stored on your imagent server and never shown again.</p>

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
    <Block title="Source code"
      description="Connect the app's GitHub repo: diagnosis reads the code behind a failure and suggests the fix as a diff; Create fix branch opens a draft PR. imagent never merges or touches existing branches.">
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
          className={primaryBtn}>{save.isPending ? "Saving…" : "Use this repo"}</button>
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
          className={primaryBtn}>{save.isPending ? "Saving…" : "Save"}</button>
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

const LEVEL_LABEL: Record<EngineSettings["level"], string> = { reduced: "Reduced", standard: "Standard", expanded: "Expanded" };

/** What the issue engine looks for, with which models, how much it reads, and what it may spend. */
function EngineSettingsBlock({ project: p, judgeOn, onSaved, go }: {
  project: Project; judgeOn: boolean; onSaved: () => void; go: (s: SectionId) => void;
}) {
  const meta = useQuery({ queryKey: ["engine-categories"], queryFn: () => api<{ categories: Record<string, EngineCategory>; levels: Record<string, number> }>("/api/engine/categories") });
  const tools = useQuery({ queryKey: ["project-tools", p.id], queryFn: () => api<{ name: string; calls: number; paused: number; sends: boolean }[]>(`/api/projects/${p.id}/tools`) });
  const saved = p.engine!;
  const [e, setE] = useState<EngineSettings>(saved);
  const [toolFilter, setToolFilter] = useState("");
  const [onlyPicked, setOnlyPicked] = useState(false);
  useEffect(() => setE(saved), [JSON.stringify(saved)]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    mutationFn: () => apiPost<Project>(`/api/projects/${p.id}`, { engine: e }, "PATCH"),
    onSuccess: onSaved,
  });
  const dirty = JSON.stringify(e) !== JSON.stringify(saved);
  const set = (patch: Partial<EngineSettings>) => setE({ ...e, ...patch });
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const q = toolFilter.trim().toLowerCase();
  const shownTools = (tools.data ?? []).filter((t) => t.name.toLowerCase().includes(q) && (!onlyPicked || e.guarded_tools.includes(t.name)));
  const off = !e.enabled;

  return (
    <div className="pb-16">
      {!judgeOn && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-[#eda100]/40 bg-[#eda100]/5 px-4 py-3 text-[12.5px]">
          <Icon.warning size={14} className="shrink-0 text-[#eda100]" />
          <span className="text-ink-2">The engine needs a model to read runs.</span>
          <button onClick={() => go("model")} className="ml-auto font-medium text-accent hover:underline">Set up the AI model →</button>
        </div>
      )}

      <Block title="Issue engine"
        description="Reads production runs to find what goes wrong — including failures that raise no error — groups them into issues and diagnoses them against your code."
        aside={<Toggle on={e.enabled} onChange={(v) => set({ enabled: v })} />}>
        <div className={off ? "pointer-events-none opacity-50" : ""}>
          <div className="mb-2 flex items-baseline gap-2">
            <span className="text-[12.5px] font-medium text-ink-2">What to look for</span>
            <span className="text-[11.5px] text-ink-3">{e.categories.length} of {Object.keys(meta.data?.categories ?? {}).length} on</span>
          </div>
          {[...new Set(Object.values(meta.data?.categories ?? {}).map((c) => c.group))].map((group) => {
            const ids = Object.entries(meta.data?.categories ?? {}).filter(([, c]) => c.group === group).map(([id]) => id);
            const allOn = ids.every((id) => e.categories.includes(id));
            return (
              <div key={group} className="mb-3">
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{group}</span>
                  <button onClick={() => set({ categories: allOn ? e.categories.filter((c) => !ids.includes(c)) : [...new Set([...e.categories, ...ids])] })}
                    className="text-[11.5px] text-ink-3 hover:text-ink">{allOn ? "none" : "all"}</button>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {ids.map((id) => {
                    const c = meta.data!.categories[id];
                    const on = e.categories.includes(id);
                    return (
                      <button key={id} onClick={() => set({ categories: toggle(e.categories, id) })}
                        className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${on ? "border-line-strong bg-subtle/60" : "border-line opacity-70 hover:border-line-strong hover:opacity-100"}`}>
                        <span className="flex items-center gap-2">
                          <span className={`flex size-4 shrink-0 items-center justify-center rounded border ${on ? "border-ink bg-ink text-bg" : "border-line-strong"}`}>
                            {on && <Icon.check size={11} />}
                          </span>
                          <span className="text-[13px] font-medium text-ink">{c.label}</span>
                          <span className="ml-auto rounded bg-subtle px-1.5 py-px text-[10.5px] text-ink-3">
                            {c.how === "rule" ? "Rule" : c.how === "model" ? "AI" : "Rule + AI"}
                          </span>
                        </span>
                        <span className="mt-1 block pl-6 text-[11.5px] leading-[17px] text-ink-3">{c.definition}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
          <p className="mt-2 text-[11.5px] text-ink-3"><b className="font-medium text-ink-2">Rule</b> checks run on every run for free. <b className="font-medium text-ink-2">AI</b> checks need a model to read the run.</p>
        </div>
      </Block>

      <div className={off ? "pointer-events-none opacity-50" : ""}>
        <Block title="Models" description="A cheap model screens every run in batches; a strong one investigates only the runs it flags.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Screening model" hint="Reads a short outline of every run.">
              <input className={`${controlCls} w-full font-mono`} value={e.screener_model} onChange={(ev) => set({ screener_model: ev.target.value })} />
            </Field>
            <Field label="Investigating model" hint="Reads flagged runs in full, with your code.">
              <input className={`${controlCls} w-full font-mono`} value={e.investigator_model} onChange={(ev) => set({ investigator_model: ev.target.value })}
                placeholder={p.judge_model || "same as the AI model"} />
            </Field>
          </div>
        </Block>

        <Block title="Budget" description="How much each scan reads, and the most it may spend in a month. Errors, flagged runs and 👎 are read first.">
          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <div>
              <span className="mb-1.5 block text-[12.5px] font-medium text-ink-2">Runs read per scan</span>
              <div className="grid grid-cols-3 gap-2">
                {(Object.keys(LEVEL_LABEL) as EngineSettings["level"][]).map((l) => (
                  <button key={l} onClick={() => set({ level: l })}
                    className={`rounded-lg border px-3 py-2 text-left ${e.level === l ? "border-ink/40 bg-subtle" : "border-line hover:border-line-strong"}`}>
                    <span className="block text-[13px] font-medium text-ink">{LEVEL_LABEL[l]}</span>
                    <span className="block text-[11.5px] text-ink-3">{meta.data?.levels[l]} runs</span>
                  </button>
                ))}
              </div>
            </div>
            <Field label="Monthly cap" hint="Scans pause when reached.">
              <span className="relative block">
                <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[12.5px] text-ink-3">$</span>
                <input type="number" min={0} step={1} className={`${controlCls} w-32 pl-6`} value={e.monthly_cap_usd}
                  onChange={(ev) => set({ monthly_cap_usd: Number(ev.target.value) })} />
              </span>
            </Field>
          </div>
        </Block>

        {e.categories.includes("guardrail_bypass") && (
          <Block title="Tools that need approval"
            description="Running one of these without a person approving it first is a guardrail bypass."
            aside={<span className="text-[12px] text-ink-3">{e.guarded_tools.length} selected</span>}>
            <div className="overflow-hidden rounded-lg border border-line">
              <div className="flex items-center gap-2 border-b border-line px-3">
                <Icon.search size={13} className="shrink-0 text-ink-3" />
                <input value={toolFilter} onChange={(ev) => setToolFilter(ev.target.value)} placeholder="Search tools"
                  className="h-8 min-w-0 flex-1 bg-transparent text-[12.5px] outline-none" />
                <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-ink-3">
                  <input type="checkbox" checked={onlyPicked} onChange={(ev) => setOnlyPicked(ev.target.checked)} /> Selected only
                </label>
              </div>
              <div className="max-h-64 overflow-y-auto">
                {tools.isPending ? <div className="px-3 py-2 text-[12.5px] text-ink-3">Loading tools…</div>
                  : shownTools.length === 0 ? <div className="px-3 py-2 text-[12.5px] text-ink-3">{onlyPicked ? "None selected yet." : "No tools seen in the last 30 days."}</div>
                  : shownTools.map((t) => (
                    <label key={t.name} className="flex cursor-pointer items-center gap-2.5 border-b border-line/50 px-3 py-1.5 text-[12.5px] last:border-b-0 hover:bg-hover">
                      <input type="checkbox" checked={e.guarded_tools.includes(t.name)} onChange={() => set({ guarded_tools: toggle(e.guarded_tools, t.name) })} />
                      <span className="truncate font-mono text-ink">{t.name}</span>
                      {t.paused > 0 && <span className="shrink-0 rounded bg-subtle px-1.5 text-[10.5px] text-ink-3">asked for approval {t.paused}×</span>}
                      <span className="ml-auto shrink-0 text-[11.5px] text-ink-3">{t.calls} calls</span>
                    </label>
                  ))}
              </div>
            </div>
          </Block>
        )}

        {e.categories.includes("leaked_narration") && (
          <SendTools tools={tools.data ?? []} loading={tools.isPending} e={e} set={set} />
        )}

        {e.categories.includes("context_explosion") && (
          <Block title="Context limits" description="When a run counts as a context explosion.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="One model call reads more than" hint="tokens">
                <input type="number" min={1000} step={1000} className={`${controlCls} w-40`} value={e.context_tokens_limit}
                  onChange={(ev) => set({ context_tokens_limit: Number(ev.target.value) })} />
              </Field>
              <Field label="One tool returns more than" hint="characters">
                <input type="number" min={1000} step={1000} className={`${controlCls} w-40`} value={e.tool_output_chars_limit}
                  onChange={(ev) => set({ tool_output_chars_limit: Number(ev.target.value) })} />
              </Field>
            </div>
          </Block>
        )}
      </div>

      {(dirty || save.isError) && (
        <div className="fixed inset-x-0 bottom-4 z-20 flex justify-center px-4 md:pl-60">
          <div className="flex items-center gap-3 rounded-xl border border-line bg-bg px-4 py-2.5 shadow-[0_8px_30px_-8px_rgb(0_0_0/0.25)]">
            <span className="text-[12.5px] text-ink-2">{save.isError ? <span className="text-critical">{(save.error as Error).message}</span> : "Unsaved changes"}</span>
            <button onClick={() => setE(saved)} className={secondaryBtn}>Discard</button>
            <button disabled={save.isPending} onClick={() => save.mutate()} className={primaryBtn}>{save.isPending ? "Saving…" : "Save changes"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button role="switch" aria-checked={on} onClick={() => onChange(!on)}
      className="flex items-center gap-2 text-[12.5px] text-ink-2">
      <span className={`relative h-5 w-9 rounded-full transition-colors ${on ? "bg-good" : "bg-ink-3/30"}`}>
        <span className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
      </span>
      {on ? "On" : "Off"}
    </button>
  );
}

/** A page about the app every scan reads: what it does, its rules, what "good" looks like. */
function AgentOverview({ project: p, onSaved }: { project: Project; onSaved: () => void }) {
  const [text, setText] = useState(p.overview ?? "");
  useEffect(() => setText(p.overview ?? ""), [p.overview]);
  const save = useMutation({
    mutationFn: () => apiPost<Project>(`/api/projects/${p.id}`, { overview: text }, "PATCH"),
    onSuccess: onSaved,
  });
  return (
    <Block title="Agent overview"
      description="What the issue engine should know about this app — who uses it, what it must always or never do, what isn't a problem. Every scan reads it, so one sentence here prevents a whole class of false alarms.">
      <textarea className={`${controlCls} h-40 w-full py-2 font-mono text-[12px] leading-5`} value={text} onChange={(ev) => setText(ev.target.value)}
        placeholder={"e.g.\nBosun helps ship operators and commercial managers run dry-bulk and tanker vessels.\n- Facts about vessels must come from tools (noon reports, CP, KB); never estimate.\n- Sending email / Signal always needs the user's approval.\n- Runs from tests (fake ids like u1, t1) are not real traffic."} />
      <div className="mt-2 flex items-center gap-3">
        <button disabled={text === (p.overview ?? "") || save.isPending} onClick={() => save.mutate()}
          className={primaryBtn}>{save.isPending ? "Saving…" : "Save"}</button>
        <span className="text-[11.5px] text-ink-3">The engine will also add what it learns from your actions on issues.</span>
      </div>
    </Block>
  );
}

const KIND_LABEL: Record<string, string> = { ...ISSUE_KIND, error: "Errors" };

/** What the engine learned from how the team handled issues — editable. */
function LearnedPreferences({ project: p, onSaved }: { project: Project; onSaved: () => void }) {
  const saved = p.preferences ?? { categories: {}, rules: [], learned_at: "", pending: [] };
  const [prefs, setPrefs] = useState(saved);
  const [draft, setDraft] = useState("");
  useEffect(() => setPrefs(saved), [JSON.stringify(saved)]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    mutationFn: (next: typeof prefs) => apiPost<Project>(`/api/projects/${p.id}`, { preferences: next }, "PATCH"),
    onSuccess: onSaved,
  });
  const commit = (next: typeof prefs) => { setPrefs(next); save.mutate(next); };
  const cats = Object.entries(prefs.categories);
  return (
    <Block title="Learned from your actions"
      description={<>When you mark an issue <b className="font-medium text-ink-2">Incorrectly flagged</b>, ignore or resolve it, change its severity or open a fix PR, the engine adjusts at the next scan. Edit anything here.</>}
      aside={prefs.learned_at ? <span className="text-[11.5px] text-ink-3">Updated <Time value={prefs.learned_at} /></span> : undefined}>
      <div className="mb-1.5 text-[12.5px] font-medium text-ink-2">Category priority</div>
      {cats.length === 0 ? (
        <p className="mb-4 text-[12.5px] text-ink-3">Nothing yet — every category is high priority until you act on issues.</p>
      ) : (
        <div className="mb-4 overflow-hidden rounded-lg border border-line">
          {cats.map(([kind, c]) => (
            <div key={kind} className="flex items-center gap-3 border-b border-line/60 px-3 py-2 text-[12.5px] last:border-b-0">
              <span className="w-40 shrink-0 font-medium text-ink">{KIND_LABEL[kind] ?? kind}</span>
              <span className="min-w-0 flex-1 truncate text-ink-3" title={c.why}>{c.why}</span>
              <select value={c.priority} disabled={save.isPending}
                onChange={(e) => commit({ ...prefs, categories: { ...prefs.categories, [kind]: { ...c, priority: e.target.value as "high", why: "Set by hand in Settings" } } })}
                className="h-7 shrink-0 rounded-md border border-line bg-bg px-2 text-[12.5px] text-ink-2">
                <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
              </select>
            </div>
          ))}
        </div>
      )}
      <div className="mb-1.5 text-[12.5px] font-medium text-ink-2">Rules the engine follows</div>
      {prefs.rules.length === 0 && <p className="mb-2 text-[12.5px] text-ink-3">None yet — the reasons you give when dismissing issues become rules here.</p>}
      <ul className="mb-2 space-y-1">
        {prefs.rules.map((r, n) => (
          <li key={n} className="group flex items-start gap-2 rounded-md px-2 py-1 text-[12.5px] hover:bg-hover">
            <span className="text-ink-3">•</span><span className="min-w-0 flex-1 text-ink-2">{r}</span>
            <button onClick={() => commit({ ...prefs, rules: prefs.rules.filter((_, k) => k !== n) })}
              className="shrink-0 text-ink-3 opacity-0 hover:text-critical group-hover:opacity-100" title="Remove this rule"><Icon.close size={12} /></button>
          </li>
        ))}
      </ul>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { commit({ ...prefs, rules: [...prefs.rules, draft.trim()] }); setDraft(""); } }}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a rule, e.g. “Scheduled reports may use tables — not prompt drift”"
          className={`${controlCls} min-w-0 flex-1`} />
        <button disabled={!draft.trim() || save.isPending} className={secondaryBtn}>Add</button>
      </form>
      {prefs.pending.length > 0 && <p className="mt-2 text-[11.5px] text-ink-3">{prefs.pending.length} reason{prefs.pending.length === 1 ? "" : "s"} waiting to become rules at the next scan.</p>}
      {save.isError && <p className="mt-2 text-[12.5px] text-critical">{(save.error as Error).message}</p>}
    </Block>
  );
}


/** Which tools send a message to a person — their text is checked for leaked working notes. */
function SendTools({ tools, loading, e, set }: {
  tools: { name: string; calls: number; sends: boolean }[]; loading: boolean; e: EngineSettings; set: (p: Partial<EngineSettings>) => void;
}) {
  const [filter, setFilter] = useState("");
  const [all, setAll] = useState(false);
  const on = (t: { name: string; sends: boolean }) =>
    !(e.not_message_tools ?? []).includes(t.name) && (t.sends || (e.message_tools ?? []).includes(t.name));
  const flip = (t: { name: string; sends: boolean }) => {
    const add = (l: string[]) => [...new Set([...l, t.name])], drop = (l: string[]) => l.filter((x) => x !== t.name);
    const msg = e.message_tools ?? [], not = e.not_message_tools ?? [];
    if (on(t)) set(t.sends ? { not_message_tools: add(not) } : { message_tools: drop(msg) });
    else set(t.sends ? { not_message_tools: drop(not) } : { message_tools: add(msg) });
  };
  const q = filter.trim().toLowerCase();
  const picked = tools.filter(on).length;
  const shown = tools.filter((t) => t.name.toLowerCase().includes(q) && (all || q || on(t) || t.sends));
  return (
    <Block title="Tools that send messages to people"
      description="The text these tools send is what a person reads — it's checked for the agent's working notes (“I now have all the data. Let me compose…”) instead of the real message. Picked by name automatically; adjust here."
      aside={<span className="text-[12px] text-ink-3">{picked} checked</span>}>
      <div className="overflow-hidden rounded-lg border border-line">
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Icon.search size={13} className="shrink-0 text-ink-3" />
          <input value={filter} onChange={(ev) => setFilter(ev.target.value)} placeholder="Search tools"
            className="h-8 min-w-0 flex-1 bg-transparent text-[12.5px] outline-none" />
          <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-ink-3">
            <input type="checkbox" checked={all} onChange={(ev) => setAll(ev.target.checked)} /> Show all tools
          </label>
        </div>
        <div className="max-h-64 overflow-y-auto">
          {loading ? <div className="px-3 py-2 text-[12.5px] text-ink-3">Loading tools…</div>
            : shown.length === 0 ? <div className="px-3 py-2 text-[12.5px] text-ink-3">No sending tools found — tick “Show all tools” to pick one.</div>
            : shown.map((t) => (
              <label key={t.name} className="flex cursor-pointer items-center gap-2.5 border-b border-line/50 px-3 py-1.5 text-[12.5px] last:border-b-0 hover:bg-hover">
                <input type="checkbox" checked={on(t)} onChange={() => flip(t)} />
                <span className="truncate font-mono text-ink">{t.name}</span>
                {t.sends && <span className="shrink-0 rounded bg-subtle px-1.5 text-[10.5px] text-ink-3">auto</span>}
                <span className="ml-auto shrink-0 text-[11.5px] text-ink-3">{t.calls} calls</span>
              </label>
            ))}
        </div>
      </div>
    </Block>
  );
}
