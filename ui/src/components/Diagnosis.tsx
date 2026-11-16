import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, apiPost, type Diagnosis, type DiagnosisResult, type FixBranch, type FixChange, type JudgeStatus } from "../lib/api";
import { fmtCost } from "../lib/format";
import { pp } from "../lib/project";
import { useAppState } from "../lib/state";
import { Icon } from "./icons";
import { Markdown } from "./Markdown";
import { Time } from "./Time";
import { controlCls } from "./ui";

const CATEGORY: Record<string, string> = {
  tool_error: "Tool error", code_bug: "Code bug", prompt: "Prompt", model: "Model", config: "Configuration",
  external: "External service", loop: "Loop", other: "Other",
};

/** Diagnose a run or an issue: start it, follow it, show root cause and the proposed fix. */
export function DiagnosisPanel({ diagnosis, startPath, queryKey, compact = false }: {
  diagnosis: Diagnosis | null | undefined; startPath: string; queryKey: unknown[]; compact?: boolean;
}) {
  const { project } = useAppState();
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const [asking, setAsking] = useState(false);
  const judge = useQuery({ queryKey: ["judge", project], queryFn: () => api<JudgeStatus>("/api/judge", { project }) });
  const start = useMutation({
    mutationFn: () => apiPost<{ started: boolean }>(startPath, { note: note.trim() }),
    onSuccess: () => { setAsking(false); qc.invalidateQueries({ queryKey }); },
  });
  const running = diagnosis?.status === "running" || start.isPending;

  if (judge.data && !judge.data.configured) {
    return (
      <div className="rounded-lg border border-line px-4 py-3 text-[12.5px] text-ink-2">
        Diagnosis uses this project's model. Add an API key under{" "}
        <Link to={pp("/settings")} className="text-accent hover:underline">Settings › Judging</Link> first.
      </div>
    );
  }

  const form = (
    <div className="space-y-2">
      <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
        placeholder="Optional: what looks wrong? e.g. “the answer ignores the charter party speed”"
        className={`${controlCls} w-full py-2 leading-5`} />
      <div className="flex items-center gap-2">
        <button onClick={() => start.mutate()} disabled={start.isPending}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-bg disabled:opacity-50">
          <Icon.issues size={12} /> {diagnosis ? "Diagnose again" : "Diagnose"}
        </button>
        {diagnosis && <button onClick={() => setAsking(false)} className="h-7 px-2 text-[12.5px] text-ink-3 hover:text-ink">Cancel</button>}
        <span className="text-[11.5px] text-ink-3">Reads the run{judge.data ? <> with <span className="font-mono">{judge.data.model}</span></> : ""}, and your code when a repo is connected.</span>
      </div>
      {start.isError && <div className="text-[12px] text-critical">{(start.error as Error).message}</div>}
    </div>
  );

  if (running) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-line px-4 py-3 text-[12.5px]">
        <span className="size-3.5 animate-spin rounded-full border-2 border-line border-t-accent" />
        <div>
          <div className="text-ink">Diagnosing…</div>
          <div className="text-ink-3">Reading the run and the code behind it. This takes a minute or two.</div>
        </div>
      </div>
    );
  }
  if (!diagnosis || asking) return form;
  if (diagnosis.status === "error") {
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-critical/40 bg-critical/5 px-4 py-3 text-[12.5px] text-critical">Diagnosis failed: {diagnosis.error}</div>
        {form}
      </div>
    );
  }
  const r = diagnosis.result as DiagnosisResult;
  return <DiagnosisView r={r} note={diagnosis.note} onAgain={() => setAsking(true)} compact={compact}
    fixPath={startPath.replace(/diagnose$/, "fix")} queryKey={queryKey} />;
}

function DiagnosisView({ r, note, onAgain, compact, fixPath, queryKey }: {
  r: DiagnosisResult; note: string; onAgain: () => void; compact: boolean; fixPath: string; queryKey: unknown[];
}) {
  const tone = r.confidence === "high" ? "text-good" : r.confidence === "medium" ? "text-ink-2" : "text-ink-3";
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-line px-4 py-3.5">
        <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11.5px]">
          <span className="rounded bg-subtle px-1.5 py-0.5 font-medium text-ink-2">{CATEGORY[r.category] ?? r.category}</span>
          <span className={tone}>{r.confidence} confidence</span>
          {r.focus && <span className="text-ink-3">· at <span className="font-mono">{r.focus.name}</span></span>}
          <button onClick={onAgain} className="ml-auto text-ink-3 hover:text-ink">Diagnose again</button>
        </div>
        {r.title && <div className="text-[14px] font-semibold text-ink">{r.title}</div>}
        <p className="mt-1 text-[13px] leading-5 text-ink-2">{r.summary}</p>
        {note && <p className="mt-2 text-[12px] text-ink-3">You noted: “{note}”</p>}
      </div>

      <Block title="Root cause">
        <Markdown text={r.root_cause} className="text-[13px]" />
        {r.evidence.length > 0 && (
          <ul className="mt-3 space-y-1 border-t border-line/70 pt-3 text-[12.5px] text-ink-2">
            {r.evidence.map((e, i) => <li key={i} className="flex gap-2"><span className="text-ink-3">•</span><span>{e}</span></li>)}
          </ul>
        )}
      </Block>

      <Block title="Suggested fix">
        {r.fix.explanation ? <Markdown text={r.fix.explanation} className="text-[13px]" />
          : r.fix.changes.length === 0 && (
            <p className="text-[12.5px] text-ink-3">
              No fix proposed — the model couldn't pin down the cause with enough certainty
              {r.code_error ? " (see below)" : r.repo ? ". Add a note about what looks wrong and diagnose again" : ". Connecting the repo usually fixes this"}.
            </p>
          )}
        {r.fix.changes.map((c, i) => <DiffView key={i} change={c} repo={r.repo} />)}
        {r.repo && r.fix.changes.some((c) => c.edits?.length) && <CreateFix r={r} fixPath={fixPath} queryKey={queryKey} onAgain={onAgain} />}
        {!r.repo && !r.code_error && (
          <p className="mt-3 text-[12px] text-ink-3">
            Connect your GitHub repo in <Link to={pp("/settings")} className="text-accent hover:underline">Settings</Link> to get code-level diffs.
          </p>
        )}
        {r.code_error && <p className="mt-3 text-[12px] text-critical">{r.code_error}</p>}
      </Block>

      {r.verify && <Block title="How to check the fix"><Markdown text={r.verify} className="text-[13px]" /></Block>}

      <div className={`flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-ink-3 ${compact ? "" : "px-1"}`}>
        {r.repo && <span>Code: <span className="font-mono">{r.repo.repo}@{r.repo.branch} {r.repo.commit}</span></span>}
        {r.files.length > 0 && <span title={r.files.map((f) => f.path).join("\n")}>{r.files.length} file{r.files.length > 1 ? "s" : ""} read</span>}
        {r.trace_id && <Link to={pp(`/traces/${r.trace_id}`)} className="hover:text-ink">from run {r.trace_id.slice(0, 10)}</Link>}
        <span>{r.model} · {fmtCost(r.cost)}</span>
        <Time value={r.at} />
      </div>
    </div>
  );
}

function DiffView({ change, repo }: { change: FixChange; repo: DiagnosisResult["repo"] }) {
  const [copied, setCopied] = useState(false);
  const href = repo ? `https://github.com/${repo.repo}/blob/${repo.branch}/${change.path}` : "";
  return (
    <div className="mt-3 overflow-hidden rounded-md border border-line">
      <div className="flex items-center gap-2 border-b border-line bg-subtle px-3 py-1.5 text-[12px]">
        {href ? <a href={href} target="_blank" rel="noreferrer" className="truncate font-mono text-ink hover:underline">{change.path}</a>
          : <span className="truncate font-mono text-ink">{change.path}</span>}
        {change.applies === true && <span className="shrink-0 text-good">applies cleanly</span>}
        {change.applies === false && <span className="shrink-0 text-ink-3" title={change.problem || "Some lines differ from the file as read — check before applying"}>needs adjusting</span>}
        <button onClick={() => { navigator.clipboard.writeText(change.diff); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
          className="ml-auto inline-flex shrink-0 items-center gap-1 text-ink-3 hover:text-ink">
          {copied ? <Icon.check size={12} /> : <Icon.copy size={12} />} {copied ? "Copied" : "Copy diff"}
        </button>
      </div>
      <pre className="max-h-[420px] overflow-auto py-1.5 font-mono text-[11.5px] leading-[18px]">
        {change.diff.split("\n").map((l, i) => (
          <div key={i} className={`px-3 ${l.startsWith("+") && !l.startsWith("+++") ? "bg-good/10 text-good"
            : l.startsWith("-") && !l.startsWith("---") ? "bg-critical/10 text-critical"
            : l.startsWith("@@") ? "text-ink-3" : "text-ink-2"}`}>{l || " "}</div>
        ))}
      </pre>
    </div>
  );
}

/** Commit the fix to a new branch and open a draft PR — after a confirm, on the latest code. */
function CreateFix({ r, fixPath, queryKey, onAgain }: { r: DiagnosisResult; fixPath: string; queryKey: unknown[]; onAgain: () => void }) {
  const qc = useQueryClient();
  const make = useMutation({
    mutationFn: () => apiPost<FixBranch>(fixPath, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  });
  const done = r.fix_branch ?? make.data;
  const clean = r.fix.changes.every((c) => !c.edits?.length || c.applies);
  const files = [...new Set(r.fix.changes.filter((c) => c.edits?.length).map((c) => c.path))];
  if (done) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-good/40 bg-good/5 px-3 py-2 text-[12.5px]">
        <Icon.check size={13} className="text-good" />
        <a href={done.pr_url} target="_blank" rel="noreferrer" className="font-medium text-ink hover:underline">
          {done.draft ? "Draft PR" : "PR"} #{done.pr_number} opened
        </a>
        <span className="text-ink-3">on branch <a href={done.url} target="_blank" rel="noreferrer" className="font-mono hover:text-ink">{done.branch}</a> → {done.base}</span>
        <a href={done.pr_url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-ink-2 hover:text-ink">Review on GitHub <Icon.external size={11} /></a>
      </div>
    );
  }
  const stale = make.error instanceof Error && /changed since this diagnosis/.test(make.error.message);
  return (
    <div className="mt-3 rounded-md border border-line px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <button disabled={!clean || make.isPending}
          onClick={() => { if (confirm(`Create a branch in ${r.repo!.repo} with this fix (${files.join(", ")}) and open a draft pull request?`)) make.mutate(); }}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-bg disabled:opacity-40">
          {make.isPending ? "Creating branch…" : "Create fix branch & draft PR"}
        </button>
        <span className="text-[12px] text-ink-3">
          {clean ? <>Commits to a new <span className="font-mono">imagent/fix-…</span> branch from <span className="font-mono">{r.repo!.branch}</span>. Nothing is merged.</>
            : "Some edits don't match the code — diagnose again before creating a branch."}
        </span>
      </div>
      {make.isError && (
        <div className="mt-2 text-[12.5px] text-critical">
          {(make.error as Error).message}
          {stale && <button onClick={onAgain} className="ml-2 text-accent hover:underline">Diagnose again</button>}
        </div>
      )}
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">{title}</h3>
      {children}
    </section>
  );
}

/** "Diagnose" on a run: opens the diagnosis beside the trace. */
export function useTraceDiagnosis(traceId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["diagnosis", "trace", traceId],
    queryFn: () => api<{ diagnosis: Diagnosis | null }>(`/api/traces/${traceId}/diagnosis`).then((r) => r.diagnosis),
    enabled,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 3000 : false),
  });
}
