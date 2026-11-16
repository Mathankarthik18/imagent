import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { DiagnosisPanel } from "../components/Diagnosis";
import { Time } from "../components/Time";
import { ErrorBox, PageHeader, Spinner, StatStrip } from "../components/ui";
import { api, apiPost, type Diagnosis, type Issue, type IssueStatus } from "../lib/api";
import { pp } from "../lib/project";
import { SEVERITY } from "./Issues";

export function IssueDetail() {
  const { issueId = "" } = useParams();
  const qc = useQueryClient();
  const key = ["issue", issueId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<Issue & { diagnosis: Diagnosis | null }>(`/api/issues/${issueId}`),
    refetchInterval: (q) => (q.state.data?.diagnosis?.status === "running" ? 3000 : false),
  });
  const setStatus = useMutation({
    mutationFn: (status: IssueStatus) => apiPost<Issue>(`/api/issues/${issueId}`, { status }, "PATCH"),
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
        meta={<span className="inline-flex items-center gap-1.5"><span className={`size-2 rounded-full ${sev.dot}`} />{sev.label} · {i.kind === "loop" ? "loop" : "error"} in <span className="font-mono">{i.location}</span>
          {i.status !== "open" && <span className="rounded bg-subtle px-1.5 text-ink-2">{i.status}</span>}</span>}>
        {i.status === "open" ? (
          <>
            <button className={btn} disabled={setStatus.isPending} onClick={() => setStatus.mutate("ignored")}>Ignore</button>
            <button className="h-7 rounded-md bg-ink px-3 text-[12.5px] font-medium text-bg disabled:opacity-50" disabled={setStatus.isPending}
              onClick={() => setStatus.mutate("resolved")} title="Re-opens by itself if it happens again">Mark resolved</button>
          </>
        ) : <button className={btn} disabled={setStatus.isPending} onClick={() => setStatus.mutate("open")}>Re-open</button>}
      </PageHeader>

      <div className="mb-5">
        <StatStrip items={[
          { label: "Runs affected", value: i.runs },
          { label: "Runs failed", value: i.failed_runs, tone: i.failed_runs ? "critical" : undefined },
          { label: i.kind === "loop" ? "Calls" : "Occurrences", value: i.events },
          { label: "First seen", value: <Time value={i.first_seen} /> },
          { label: "Last seen", value: <Time value={i.last_seen} /> },
        ]} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0">
          <h2 className="mb-3 text-[13px] font-semibold">Diagnosis</h2>
          <DiagnosisPanel diagnosis={i.diagnosis} startPath={`/api/issues/${issueId}/diagnose`} queryKey={key} />
        </div>
        <aside className="space-y-5">
          {i.message && (
            <section>
              <h3 className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">Latest error</h3>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-subtle px-3 py-2 font-mono text-[11.5px] text-ink-2">{i.message}</pre>
            </section>
          )}
          <section>
            <h3 className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">Recent runs</h3>
            <ul className="space-y-1">
              {i.trace_ids.map((t) => (
                <li key={t}><Link to={pp(`/traces/${t}`)} className="font-mono text-[12px] text-ink-2 hover:text-accent">{t.slice(0, 16)}</Link></li>
              ))}
            </ul>
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
