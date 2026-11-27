import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { AgentHandoff, AgentPointer, AgentViewPage } from "../components/AgentView";
import { CATEGORY, CreateFix, DiagnosisPanel, DiffView, FixChat, splitLead } from "../components/Diagnosis";
import { Icon } from "../components/icons";
import { Markdown } from "../components/Markdown";
import { Time } from "../components/Time";
import { ErrorBox, Spinner } from "../components/ui";
import { AI_ISSUE_KINDS, api, apiPost, ISSUE_KIND, ISSUE_STATUS, type Diagnosis, type DiagnosisResult, type Evidence, type FixVerification, type Issue, type IssueCheck, type IssueStatus, type RegressionExample } from "../lib/api";
import { fmtCost } from "../lib/format";
import { pp } from "../lib/project";
import { SEVERITY } from "./Issues";

type IssueData = Issue & { diagnosis: Diagnosis | null; evidence: Evidence[]; check: IssueCheck | null;
  examples: RegressionExample[]; verification: FixVerification | null };

const label = "text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3";

export function IssueDetail() {
  const { issueId = "" } = useParams();
  const [search] = useSearchParams();
  const qc = useQueryClient();
  const key = ["issue", issueId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<IssueData>(`/api/issues/${issueId}`),
    refetchInterval: (q) => (q.state.data?.diagnosis?.status === "running" || q.state.data?.check?.status === "writing"
      || q.state.data?.verification?.status === "running" ? 3000 : false),
  });
  const setStatus = useMutation({
    mutationFn: (body: { status?: IssueStatus; reason?: string; severity?: string }) => apiPost<Issue>(`/api/issues/${issueId}`, body, "PATCH"),
    onSuccess: () => { qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ["issues"] }); },
  });

  if (search.get("view") === "agent") return <AgentViewPage kind="issue" id={issueId} />;
  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <Spinner />;
  const i = q.data;
  const r = i.diagnosis?.status === "done" ? i.diagnosis.result as DiagnosisResult : null;
  const startPath = `/api/issues/${issueId}/diagnose`;

  return (
    <div className="mx-auto max-w-[1480px]">
      <AgentPointer kind="issue" id={issueId} />
      <Header i={i} busy={setStatus.isPending} set={setStatus.mutate} />

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="min-w-0 space-y-4">
          {r ? <Case i={i} r={r} queryKey={key} startPath={startPath} /> : (
            <section className="rounded-xl border border-line p-5">
              <div className={`${label} mb-3`}>Diagnosis</div>
              {i.message && <p className="mb-3 max-w-[80ch] text-[13px] text-ink-2">{i.message}</p>}
              <DiagnosisPanel diagnosis={i.diagnosis} startPath={startPath} queryKey={key} />
            </section>
          )}
          {AI_ISSUE_KINDS.includes(i.kind) && (
            <Fold title="Check & verify a fix" meta={i.check ? (i.check.status === "active" ? "check active" : i.check.status) : "no check yet"}>
              <CheckAndVerify issueId={issueId} check={i.check} examples={i.examples} verification={i.verification} queryKey={key} />
            </Fold>
          )}
          <Fold title={i.evidence.length ? "Affected runs" : "Recent runs"} meta={`${i.evidence.length || i.trace_ids.length}`}>
            <Runs i={i} />
          </Fold>
        </div>

        <aside className="h-[620px] lg:sticky lg:top-0 lg:h-[calc(100vh-5.5rem)] lg:self-start">
          {r ? <FixChat variant="side" r={r} chatPath={`/api/issues/${issueId}/chat`} queryKey={key} /> : (
            <div className="flex h-full flex-col items-center justify-center rounded-xl border border-dashed border-line px-8 text-center">
              <span className="mb-3 inline-flex size-8 items-center justify-center rounded-lg bg-accent/10 text-accent"><Icon.issues size={15} /></span>
              <div className="text-[13px] font-semibold text-ink">Ask imagent</div>
              <p className="mt-1 text-[12.5px] leading-5 text-ink-3">
                {i.diagnosis?.status === "running" ? "Available as soon as the diagnosis is done." : "Diagnose this issue first, then talk the fix through here."}
              </p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function Header({ i, busy, set }: { i: IssueData; busy: boolean; set: (b: { status?: IssueStatus; reason?: string; severity?: string }) => void }) {
  const sev = SEVERITY[i.severity];
  const active = ["open", "watching", "fixing"].includes(i.status);
  const secondary = "h-8 rounded-md border border-line px-3 text-[12.5px] text-ink-2 hover:border-line-strong hover:text-ink disabled:opacity-40";
  return (
    <header className="flex flex-col gap-4 md:flex-row md:items-start md:gap-8">
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 text-[12px] text-ink-3">
          <Link to={pp("/issues")} className="hover:text-ink">Issues</Link> <span className="text-ink-3/60">/</span> <span className="font-mono">{i.id}</span>
        </div>
        <h1 className="line-clamp-2 text-[21px] font-semibold leading-7 tracking-[-0.01em] text-ink">{i.title}</h1>
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[12px]">
          <StatusPill status={i.status} />
          <label className="relative inline-flex h-6 items-center gap-1.5 rounded-full border border-line pl-2 pr-6 text-ink-2 hover:border-line-strong" title="Severity">
            <span className={`size-2 rounded-full ${sev.dot}`} />
            <span>{sev.label}</span>
            <Icon.chevronDown size={11} className="pointer-events-none absolute right-2 text-ink-3" />
            <select value={i.severity} disabled={busy} onChange={(e) => set({ severity: e.target.value })}
              className="absolute inset-0 cursor-pointer opacity-0">
              <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
            </select>
          </label>
          <Chip>{ISSUE_KIND[i.kind] ?? i.kind}</Chip>
          <Chip mono>{i.location}</Chip>
          {i.agent && <Link to={pp(`/traces?agent=${encodeURIComponent(i.agent)}`)}><Chip mono>{i.agent}</Chip></Link>}
          <span className="ml-1 text-ink-3">
            <b className="font-medium text-ink-2">{i.runs}</b> run{i.runs === 1 ? "" : "s"}
            {i.kind === "error" && i.failed_runs > 0 && <> · <b className="font-medium text-critical">{i.failed_runs}</b> failed</>}
            {(i.peak ?? 0) > 1 && <> · worst <b className="font-medium text-ink-2">{(i.peak ?? 0).toFixed(1)}×</b> the limit</>}
            {" · "}first seen <Time value={i.first_seen} /> · last seen <Time value={i.last_seen} />
          </span>
        </div>
        {i.status_reason && <p className="mt-2 text-[12.5px] text-ink-3">{ISSUE_STATUS[i.status]}: {i.status_reason}</p>}
      </div>
      <div className="flex items-center gap-2">
        <AgentHandoff kind="issue" id={i.id} />
        {active ? (
          <>
            {i.status === "open"
              ? <button className={secondary} disabled={busy} onClick={() => set({ status: "watching" })} title="Keep counting new runs without acting yet">Watch</button>
              : <button className={secondary} disabled={busy} onClick={() => set({ status: "open" })}>Stop {i.status}</button>}
            <button className="h-8 rounded-md bg-ink px-3.5 text-[12.5px] font-medium text-bg disabled:opacity-50" disabled={busy}
              onClick={() => set({ status: "resolved" })} title="Re-opens by itself if it happens again">Mark resolved</button>
            <Menu items={[
              { label: "Incorrectly flagged…", hint: "Not a real problem — won't be filed again", onClick: () => {
                const why = window.prompt("Why isn't this a real problem? The engine learns from this (optional)");
                if (why !== null) set({ status: "incorrect", reason: why });
              } },
              { label: "Ignore", hint: "Hide it; keep it out of the list", onClick: () => set({ status: "ignored" }) },
            ]} />
          </>
        ) : <button className={secondary} disabled={busy} onClick={() => set({ status: "open" })}>Re-open</button>}
      </div>
    </header>
  );
}

/** What's wrong and the fix, up front; the diff; then the reasoning, folded. */
function Case({ i, r, queryKey, startPath }: { i: IssueData; r: DiagnosisResult; queryKey: unknown[]; startPath: string }) {
  const [again, setAgain] = useState(false);
  const [why, setWhy] = useState(false);
  const [lead, rest] = splitLead(r.fix.explanation || "");
  const edits = r.fix.changes.filter((c) => c.edits?.length || c.diff);
  const files = [...new Set(edits.map((c) => c.path))];
  const conf = r.confidence === "high" ? "bg-good" : r.confidence === "medium" ? "bg-accent" : "bg-ink-3/60";
  if (again) {
    return (
      <section className="rounded-xl border border-line p-5">
        <div className={`${label} mb-3`}>Diagnose again</div>
        <DiagnosisPanel diagnosis={null} startPath={startPath} queryKey={queryKey} />
        <button onClick={() => setAgain(false)} className="mt-2 text-[12px] text-ink-3 hover:text-ink">Cancel</button>
      </section>
    );
  }
  return (
    <>
      <section className="overflow-hidden rounded-xl border border-line">
        <div className="px-5 pb-4 pt-4">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-3">
            <span className={label}>What's wrong</span>
            <span className="rounded bg-subtle px-1.5 py-0.5 font-medium text-ink-2">{CATEGORY[r.category] ?? r.category}</span>
            <span className="inline-flex items-center gap-1"><span className={`size-1.5 rounded-full ${conf}`} />{r.confidence} confidence</span>
            {r.focus && <span>· at <span className="font-mono">{r.focus.name}</span></span>}
            <button onClick={() => setAgain(true)} className="ml-auto inline-flex items-center gap-1 hover:text-ink"><Icon.restart size={11} /> Diagnose again</button>
          </div>
          {r.title && <h2 className="text-[16px] font-semibold leading-6 text-ink">{r.title}</h2>}
          <p className="mt-1 max-w-[80ch] text-[13.5px] leading-[22px] text-ink-2">{r.summary}</p>
          {i.message && i.kind !== "error" && <p className="mt-2 text-[12px] text-ink-3">Detected: {i.message}</p>}
        </div>
        <div className="border-t border-line bg-subtle/40 px-5 py-4">
          <div className="mb-1.5 flex items-center gap-2">
            <span className={label}>The fix</span>
            {r.fix_from && <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-accent">revised in discussion</span>}
            {files.length > 0 && <span className="text-[11.5px] text-ink-3">· {files.length} file{files.length > 1 ? "s" : ""}</span>}
          </div>
          {lead ? <p className="max-w-[80ch] text-[14px] font-medium leading-[22px] text-ink">{lead}</p>
            : <p className="text-[13px] text-ink-3">No fix proposed — the model couldn't pin the cause down. Ask about it on the right, or diagnose again with a note.</p>}
          {rest && (
            <>
              {why && <Markdown text={rest} className="mt-2 max-w-[80ch] text-[13px] text-ink-2" />}
              <button onClick={() => setWhy(!why)} className="mt-1.5 text-[12px] text-ink-3 hover:text-ink">{why ? "Hide reasoning" : "Why this fix"}</button>
            </>
          )}
          {r.repo && edits.some((c) => c.edits?.length) && (
            <div className="mt-3.5"><CreateFix r={r} fixPath={startPath.replace(/diagnose$/, "fix")} queryKey={queryKey} onAgain={() => setAgain(true)} bare /></div>
          )}
        </div>
      </section>

      {r.code_error && (
        <Callout action={<Link to={pp("/settings?s=source")} className="shrink-0 font-medium text-accent hover:underline">Fix in Settings →</Link>}>
          {r.code_error}
        </Callout>
      )}
      {!r.repo && !r.code_error && (
        <Callout tone="muted" action={<Link to={pp("/settings?s=source")} className="shrink-0 font-medium text-accent hover:underline">Connect GitHub →</Link>}>
          Connect the repo to get the fix as exact code changes and open a PR from here.
        </Callout>
      )}

      {edits.length > 0 && (
        <section>
          <h3 className={`${label} mb-2`}>Changes</h3>
          {edits.map((c, n) => <DiffView key={n} change={c} repo={r.repo} />)}
        </section>
      )}

      <Fold title="Root cause & evidence" meta={r.evidence.length ? `${r.evidence.length} facts` : undefined} defaultOpen={edits.length === 0}>
        {i.kind === "error" && i.message && (
          <pre className="mb-3 max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-subtle px-3 py-2 font-mono text-[11.5px] text-ink-2">{i.message}</pre>
        )}
        <Markdown text={r.root_cause} className="max-w-[80ch] text-[13px]" />
        {r.evidence.length > 0 && (
          <ul className="mt-3 max-w-[80ch] space-y-1.5 border-t border-line/70 pt-3 text-[12.5px] text-ink-2">
            {r.evidence.map((e, n) => <li key={n} className="flex gap-2"><span className="text-ink-3">•</span><span>{e}</span></li>)}
          </ul>
        )}
      </Fold>
      {r.verify && <Fold title="How to check the fix"><Markdown text={r.verify} className="max-w-[80ch] text-[13px]" /></Fold>}

      <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 text-[11.5px] text-ink-3">
        {r.repo && <span>Code: <span className="font-mono">{r.repo.repo}@{r.repo.branch} {r.repo.commit}</span></span>}
        {r.files.length > 0 && <span title={r.files.map((f) => f.path).join("\n")}>{r.files.length} file{r.files.length > 1 ? "s" : ""} read</span>}
        {r.trace_id && <Link to={pp(`/traces/${r.trace_id}`)} className="hover:text-ink">from run {r.trace_id.slice(0, 10)}</Link>}
        <span>{r.model} · {fmtCost(r.cost)}</span>
        <span>diagnosed <Time value={r.at} /></span>
      </div>
    </>
  );
}

function Runs({ i }: { i: IssueData }) {
  if (!i.evidence.length) {
    return (
      <ul className="space-y-1">
        {i.trace_ids.map((t) => <li key={t}><Link to={pp(`/traces/${t}`)} className="font-mono text-[12px] text-ink-2 hover:text-accent">{t.slice(0, 16)}</Link></li>)}
      </ul>
    );
  }
  return (
    <ul className="-mx-1 divide-y divide-line/60">
      {i.evidence.slice(0, 20).map((e) => (
        <li key={e.trace_id + e.span_id}>
          <Link to={pp(`/traces/${e.trace_id}?span=${e.span_id}`)} className="flex items-baseline gap-3 rounded px-1 py-2 text-[12.5px] hover:bg-subtle">
            <span className="shrink-0 font-mono text-[11.5px] text-ink-2">{e.trace_id.slice(0, 10)}</span>
            <span className="min-w-0 flex-1 truncate text-ink-2">{e.note || e.detail}</span>
            <span className="shrink-0 text-[11.5px] text-ink-3"><Time value={e.start_time} /></span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Fold({ title, meta, defaultOpen = false, children }: { title: string; meta?: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-xl border border-line">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-4 py-3 text-left">
        <Icon.chevronRight size={13} className={`text-ink-3 transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="text-[13px] font-medium text-ink">{title}</span>
        {meta && <span className="text-[12px] text-ink-3">{meta}</span>}
      </button>
      {open && <div className="border-t border-line/70 px-4 py-4">{children}</div>}
    </section>
  );
}

function Callout({ children, action, tone = "warn" }: { children: ReactNode; action?: ReactNode; tone?: "warn" | "muted" }) {
  return (
    <div className={`flex items-start gap-2.5 rounded-lg border px-4 py-3 text-[12.5px] leading-5 ${tone === "warn" ? "border-accent/40 bg-accent/5 text-ink" : "border-line text-ink-2"}`}>
      <Icon.warning size={14} className={`mt-0.5 shrink-0 ${tone === "warn" ? "text-accent" : "text-ink-3"}`} />
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

function Chip({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
  return <span className={`inline-flex h-6 items-center rounded-full border border-line px-2 text-ink-2 ${mono ? "font-mono text-[11.5px]" : ""}`}>{children}</span>;
}

function StatusPill({ status }: { status: IssueStatus }) {
  const tone = status === "open" ? "border-critical/40 text-critical" : status === "resolved" ? "border-good/40 text-good"
    : status === "fixing" ? "border-accent/40 text-accent" : "border-line text-ink-2";
  return (
    <span className={`inline-flex h-6 items-center gap-1.5 rounded-full border px-2 font-medium ${tone}`}>
      <span className="size-1.5 rounded-full bg-current" />{ISSUE_STATUS[status] ?? status}
    </span>
  );
}

function Menu({ items }: { items: { label: string; hint?: string; onClick: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} title="More"
        className="inline-flex size-8 items-center justify-center rounded-md border border-line text-ink-2 hover:border-line-strong hover:text-ink">
        <span className="text-[15px] leading-none">⋯</span>
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-64 overflow-hidden rounded-lg border border-line bg-bg py-1 shadow-lg">
          {items.map((it) => (
            <button key={it.label} onClick={() => { setOpen(false); it.onClick(); }} className="block w-full px-3 py-2 text-left hover:bg-subtle">
              <div className="text-[12.5px] text-ink">{it.label}</div>
              {it.hint && <div className="text-[11.5px] text-ink-3">{it.hint}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}


/** The issue's check (tested on its evidence), its regression examples, and verifying a fix by replaying them. */
function CheckAndVerify({ issueId, check, examples, verification, queryKey }: {
  issueId: string; check: IssueCheck | null; examples: RegressionExample[]; verification: FixVerification | null; queryKey: unknown[];
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey });
  const write = useMutation({ mutationFn: () => apiPost(`/api/issues/${issueId}/check`, {}), onSuccess: refresh });
  const toggle = useMutation({ mutationFn: (status: string) => apiPost(`/api/issues/${issueId}/check`, { status }, "PATCH"), onSuccess: refresh });
  const verify = useMutation({ mutationFn: () => apiPost<{ experiment_id: string }>(`/api/issues/${issueId}/verify`, {}), onSuccess: refresh });
  const h3 = "mb-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3";
  const btn = "h-7 rounded-md border border-line px-2.5 text-[12.5px] text-ink-2 hover:border-line-strong hover:text-ink disabled:opacity-40";
  const ready = check && (check.status === "active" || check.status === "draft") && examples.length > 0;
  const v = verification;
  // Only a replay where the situation came up and was handled counts as fixed; a skip didn't reproduce it.
  const n = (r: string) => (v?.status === "done" ? v.results.filter((x) => x.result === r).length : 0);
  const [passed, failed, skipped, errored] = [n("pass"), n("fail"), n("skip"), n("error")];
  const total = v?.results.length ?? 0;
  const verdict = failed ? { tone: "text-critical", text: `✗ Not fixed — ${failed}/${total} replayed runs still show the problem` }
    : passed === total ? { tone: "text-good", text: `✓ Fixed — all ${total} replayed runs handle it correctly` }
    : passed ? { tone: "text-good", text: `✓ Fixed in ${passed}/${total} replays; the rest didn't reproduce the situation` }
    : { tone: "text-ink-2", text: `Inconclusive — ${skipped + errored}/${total} replays didn't reproduce the situation${errored ? " or failed to run" : ""}` };
  return (
    <div className="mt-6 space-y-5">
      <section>
        <h3 className={h3}>Check</h3>
        {!check ? (
          <div className="flex items-center gap-3 rounded-lg border border-line px-4 py-3 text-[12.5px]">
            <span className="text-ink-2">No check yet — one is written and tested on this issue's evidence, then reads new runs at every scan.</span>
            <button className={`ml-auto ${btn}`} disabled={write.isPending} onClick={() => write.mutate()}>Write check</button>
          </div>
        ) : check.status === "writing" ? (
          <div className="flex items-center gap-2 rounded-lg border border-line px-4 py-3 text-[12.5px] text-accent">
            <span className="size-3 animate-spin rounded-full border-2 border-line border-t-accent" /> Writing the check and testing it on the evidence…
          </div>
        ) : check.status === "failed" ? (
          <div className="flex items-center gap-3 rounded-lg border border-critical/40 px-4 py-3 text-[12.5px]">
            <span className="text-critical">Couldn't write a check: {check.instructions}</span>
            <button className={`ml-auto ${btn}`} onClick={() => write.mutate()}>Try again</button>
          </div>
        ) : (
          <div className="rounded-lg border border-line px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px]">
              <span className={`inline-flex items-center gap-1.5 font-medium ${check.status === "active" ? "text-good" : "text-ink-2"}`}>
                <span className={`size-1.5 rounded-full ${check.status === "active" ? "bg-good" : "bg-ink-3/50"}`} />
                {check.status === "active" ? "Active — reads new runs at every scan" : check.status === "draft" ? "Draft — didn't pass its test" : "Off"}
              </span>
              <span className="text-ink-3" title="Tested on this issue's evidence (should fail) and on clean runs of the same agent (should pass)">
                caught <b className="font-medium text-ink-2">{check.caught}/{check.evidence}</b> evidence runs · passed <b className="font-medium text-ink-2">{check.passed}/{check.clean}</b> clean runs
              </span>
              <span className="ml-auto flex gap-2">
                <button className="text-[12px] text-ink-3 hover:text-ink" onClick={() => setOpen(!open)}>{open ? "Hide" : "Show"} check</button>
                {check.status !== "active"
                  ? <button className="text-[12px] text-ink-3 hover:text-ink" onClick={() => toggle.mutate("active")}>Switch on</button>
                  : <button className="text-[12px] text-ink-3 hover:text-ink" onClick={() => toggle.mutate("off")}>Switch off</button>}
                <button className="text-[12px] text-ink-3 hover:text-ink" disabled={write.isPending} onClick={() => write.mutate()}>Rewrite</button>
              </span>
            </div>
            {open && <p className="mt-2 border-t border-line/70 pt-2 text-[12.5px] leading-5 text-ink-2">{check.instructions}</p>}
          </div>
        )}
      </section>

      {examples.length > 0 && (
        <section>
          <h3 className={h3}>Regression examples · {examples.length}</h3>
          <ul className="space-y-2">
            {examples.map((e) => (
              <li key={e.trace_id} className="rounded-lg border border-line px-3 py-2 text-[12.5px]">
                <div className="flex items-center gap-2">
                  <span className="truncate text-ink">{e.request || "(request not captured)"}</span>
                  <Link to={pp(`/traces/${e.trace_id}`)} className="ml-auto shrink-0 font-mono text-[11.5px] text-ink-3 hover:text-accent">{e.trace_id.slice(0, 10)}</Link>
                </div>
                <ul className="mt-1 space-y-0.5 text-ink-2">{e.claims.map((c, n) => <li key={n} className="flex gap-1.5"><Icon.check size={12} className="mt-0.5 shrink-0 text-ink-3" />{c}</li>)}</ul>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3 className={h3}>Verify a fix</h3>
        <div className="rounded-lg border border-line px-4 py-3 text-[12.5px]">
          {v?.status === "running" ? (
            <span className="inline-flex items-center gap-2 text-accent">
              <span className="size-3 animate-spin rounded-full border-2 border-line border-t-accent" />
              Replaying {examples.length} run{examples.length === 1 ? "" : "s"} on your app's current code…
              <Link to={pp(`/experiments/${v.experiment_id}`)} className="text-ink-3 hover:text-ink">open the experiment</Link>
            </span>
          ) : v?.status === "done" ? (
            <div>
              <div className={`mb-2 font-medium ${verdict.tone}`}>{verdict.text}</div>
              <ul className="space-y-1">
                {v.results.map((r) => (
                  <li key={r.source} className="flex gap-2 text-ink-2">
                    <span className={r.result === "fail" || r.result === "error" ? "text-critical" : r.result === "pass" ? "text-good" : "text-ink-3"}>{r.result === "fail" ? "✗" : r.result === "error" ? "!" : r.result === "pass" ? "✓" : "–"}</span>
                    <span className="min-w-0 flex-1">{r.reason}</span>
                    {r.replay && <Link to={pp(`/traces/${r.replay}`)} className="shrink-0 font-mono text-[11.5px] text-ink-3 hover:text-accent">replay</Link>}
                  </li>
                ))}
              </ul>
              <button className={`mt-3 ${btn}`} disabled={!ready || verify.isPending} onClick={() => verify.mutate()}>Verify again</button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <span className="min-w-0 flex-1 text-ink-2">
                Run your app with the fix (e.g. on the fix branch, with experiments on), then replay this issue's examples on it — recorded tool
                results, nothing is sent — and grade each replay with the check.
              </span>
              <button className={btn} disabled={!ready || verify.isPending} onClick={() => verify.mutate()}>{verify.isPending ? "Starting…" : "Verify fix"}</button>
            </div>
          )}
          {verify.isError && <p className="mt-2 text-critical">{(verify.error as Error).message}</p>}
          {!ready && !v && <p className="mt-2 text-[11.5px] text-ink-3">Needs a check and regression examples first.</p>}
        </div>
      </section>
    </div>
  );
}
