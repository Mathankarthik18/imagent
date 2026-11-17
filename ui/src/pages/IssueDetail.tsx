import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { DiagnosisPanel } from "../components/Diagnosis";
import { Time } from "../components/Time";
import { ErrorBox, PageHeader, Spinner, StatStrip } from "../components/ui";
import { AI_ISSUE_KINDS, api, apiPost, ISSUE_KIND, ISSUE_STATUS, type Diagnosis, type Evidence, type FixVerification, type Issue, type IssueCheck, type IssueStatus, type RegressionExample } from "../lib/api";
import { useState } from "react";
import { Icon } from "../components/icons";
import { pp } from "../lib/project";
import { SEVERITY } from "./Issues";

export function IssueDetail() {
  const { issueId = "" } = useParams();
  const qc = useQueryClient();
  const key = ["issue", issueId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<Issue & { diagnosis: Diagnosis | null; evidence: Evidence[]; check: IssueCheck | null;
      examples: RegressionExample[]; verification: FixVerification | null }>(`/api/issues/${issueId}`),
    refetchInterval: (q) => (q.state.data?.diagnosis?.status === "running" || q.state.data?.check?.status === "writing"
      || q.state.data?.verification?.status === "running" ? 3000 : false),
  });
  const setStatus = useMutation({
    mutationFn: (body: { status?: IssueStatus; reason?: string; severity?: string }) => apiPost<Issue>(`/api/issues/${issueId}`, body, "PATCH"),
    onSuccess: () => { qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ["issues"] }); },
  });

  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <Spinner />;
  const i = q.data;
  const sev = SEVERITY[i.severity];
  const btn = "h-7 rounded-md border border-line px-2.5 text-[12.5px] text-ink-2 hover:border-line-strong hover:text-ink disabled:opacity-40";
  return (
    <div className="max-w-5xl">
      <div className="mb-2 text-[12.5px] text-ink-3"><Link to={pp("/issues")} className="hover:text-ink">Issues</Link> /</div>
      <PageHeader title={<span className="line-clamp-2">{i.title}</span>}
        meta={<span className="inline-flex items-center gap-1.5"><span className={`size-2 rounded-full ${sev.dot}`} />{sev.label} · {ISSUE_KIND[i.kind] ?? i.kind} · <span className="font-mono">{i.location}</span>
          {i.status !== "open" && <span className="rounded bg-subtle px-1.5 text-ink-2">{ISSUE_STATUS[i.status] ?? i.status}</span>}</span>}>
        <select value={i.severity} disabled={setStatus.isPending} onChange={(e) => setStatus.mutate({ severity: e.target.value })}
          title="Severity" className="h-7 rounded-md border border-line bg-bg px-2 text-[12.5px] text-ink-2">
          <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
        </select>
        {["open", "watching", "fixing"].includes(i.status) ? (
          <>
            {i.status === "open"
              ? <button className={btn} disabled={setStatus.isPending} onClick={() => setStatus.mutate({ status: "watching" })}
                  title="Keep it open and keep counting new runs, without acting on it yet">Watch</button>
              : <button className={btn} disabled={setStatus.isPending} onClick={() => setStatus.mutate({ status: "open" })}>Stop {i.status}</button>}
            <button className={btn} disabled={setStatus.isPending}
              onClick={() => { const r = window.prompt("Why isn't this a real problem? The engine learns from this (optional)"); if (r !== null) setStatus.mutate({ status: "incorrect", reason: r }); }}
              title="Not a real problem — the engine won't file it again">Incorrectly flagged</button>
            <button className={btn} disabled={setStatus.isPending} onClick={() => setStatus.mutate({ status: "ignored" })}>Ignore</button>
            <button className="h-7 rounded-md bg-ink px-3 text-[12.5px] font-medium text-bg disabled:opacity-50" disabled={setStatus.isPending}
              onClick={() => setStatus.mutate({ status: "resolved" })} title="Re-opens by itself if it happens again">Mark resolved</button>
          </>
        ) : <button className={btn} disabled={setStatus.isPending} onClick={() => setStatus.mutate({ status: "open" })}>Re-open</button>}
      </PageHeader>

      {(i.message && !["error"].includes(i.kind)) || i.status_reason ? (
        <div className="mb-4 max-w-3xl space-y-1.5 text-[13px] leading-5">
          {i.message && i.kind !== "error" && <p className="text-ink-2">{i.message}</p>}
          {i.status_reason && <p className="text-[12.5px] text-ink-3">{ISSUE_STATUS[i.status]}: {i.status_reason}</p>}
        </div>
      ) : null}

      <div className="mb-5">
        <StatStrip items={[
          { label: "Runs affected", value: i.runs },
          ...(i.kind === "error" ? [{ label: "Runs failed", value: i.failed_runs, tone: (i.failed_runs ? "critical" : undefined) as "critical" | undefined }]
            : (i.peak ?? 0) > 0 ? [{ label: "Worst vs limit", value: `${(i.peak ?? 0).toFixed(1)}×` }] : []),
          { label: i.kind === "loop" ? "Calls" : i.kind === "error" ? "Occurrences" : "Steps flagged", value: i.events },
          { label: "First seen", value: <Time value={i.first_seen} /> },
          { label: "Last seen", value: <Time value={i.last_seen} /> },
        ]} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0">
          <h2 className="mb-3 text-[13px] font-semibold">Diagnosis</h2>
          <DiagnosisPanel diagnosis={i.diagnosis} startPath={`/api/issues/${issueId}/diagnose`} queryKey={key} />
          {AI_ISSUE_KINDS.includes(i.kind) && <CheckAndVerify issueId={issueId} check={i.check} examples={i.examples} verification={i.verification} queryKey={key} />}
        </div>
        <aside className="space-y-5">
          {i.message && i.kind === "error" && (
            <section>
              <h3 className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">{i.kind === "error" ? "Latest error" : "Latest finding"}</h3>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-subtle px-3 py-2 font-mono text-[11.5px] text-ink-2">{i.message}</pre>
            </section>
          )}
          <section>
            <h3 className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">
              {i.evidence.length ? `Evidence · ${i.evidence.length} step${i.evidence.length === 1 ? "" : "s"}` : "Recent runs"}
            </h3>
            {i.evidence.length ? (
              <ul className="space-y-2.5">
                {i.evidence.slice(0, 12).map((e) => (
                  <li key={e.trace_id + e.span_id} className="text-[12px] leading-[17px]">
                    <Link to={pp(`/traces/${e.trace_id}?span=${e.span_id}`)} className="font-mono text-ink-2 hover:text-accent">{e.trace_id.slice(0, 12)}</Link>
                    <span className="text-ink-3"> · <Time value={e.start_time} /></span>
                    <div className="text-ink-2">{e.note || e.detail}</div>
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="space-y-1">
                {i.trace_ids.map((t) => (
                  <li key={t}><Link to={pp(`/traces/${t}`)} className="font-mono text-[12px] text-ink-2 hover:text-accent">{t.slice(0, 16)}</Link></li>
                ))}
              </ul>
            )}
          </section>
          {i.agent && (
            <section>
              <h3 className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">Agent</h3>
              <Link to={pp(`/traces?agent=${encodeURIComponent(i.agent)}&status=error`)} className="font-mono text-[12px] text-ink-2 hover:text-accent">{i.agent}</Link>
            </section>
          )}
        </aside>
      </div>
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
