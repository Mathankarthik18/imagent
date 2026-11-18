import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Icon } from "../components/icons";
import { Time } from "../components/Time";
import { Empty, ErrorBox, framedTable, PageHeader, Segmented, Spinner, th } from "../components/ui";
import { api, apiPost, ISSUE_KIND, ISSUE_STATUS, type Issue, type IssueKind, type Severity } from "../lib/api";
import { pp } from "../lib/project";
import { useAppState } from "../lib/state";

export const SEVERITY: Record<Severity, { label: string; dot: string }> = {
  high: { label: "High", dot: "bg-critical" },
  medium: { label: "Medium", dot: "bg-[#eda100]" },
  low: { label: "Low", dot: "bg-ink-3/50" },
};

export function Issues() {
  const { project } = useAppState();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const status = params.get("status") || "open";
  const kind = params.get("kind") ?? "";
  const setParam = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n); };
  const issues = useQuery({
    queryKey: ["issues", project, status],
    queryFn: () => api<Issue[]>("/api/issues", { project, status }),
    refetchInterval: (q) => ((q.state.data ?? []).some((i) => i.diagnosis_status === "running") ? 4000 : 30000),
  });
  const engine = useQuery({
    queryKey: ["engine-status", project],
    queryFn: () => api<{ screening: boolean; to_investigate: number; screened_7d: number; flagged_7d: number; month_spend: number; monthly_cap: number; enabled: boolean }>("/api/engine/status", { project }),
    refetchInterval: (q) => (q.state.data?.screening ? 4000 : 60000),
  });
  const wasScreening = useRef(false);
  useEffect(() => {  // screening finished: its findings are on the board now
    if (wasScreening.current && engine.data && !engine.data.screening) qc.invalidateQueries({ queryKey: ["issues", project] });
    wasScreening.current = !!engine.data?.screening;
  }, [engine.data, project, qc]);
  const scan = useMutation({
    mutationFn: () => apiPost<{ issues: number; new: number; diagnosing: number; errors?: string[] }>(`/api/issues/scan?project=${encodeURIComponent(project)}`, {}),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["issues", project] }); qc.invalidateQueries({ queryKey: ["engine-status", project] }); },
  });

  return (
    <>
      <PageHeader title="Issues" meta="What keeps going wrong in production runs, and why — checked every few hours">
        <Segmented value={status} onChange={(v) => setParam("status", v === "open" ? "" : v)}
          options={[{ id: "open", label: "Open" }, { id: "resolved", label: "Resolved" }, { id: "dismissed", label: "Dismissed" }]} />
        <button onClick={() => scan.mutate()} disabled={scan.isPending}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-bg disabled:opacity-50">
          <Icon.refresh size={12} className={scan.isPending ? "animate-spin" : ""} /> {scan.isPending ? "Scanning…" : "Scan now"}
        </button>
      </PageHeader>

      {engine.data && (
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-ink-3">
          {!engine.data.enabled ? (
            <span>The issue engine is off — <Link to={pp("/settings?s=engine")} className="text-accent hover:underline">turn it on</Link> to read runs for silent failures.</span>
          ) : engine.data.screening ? (
            <span className="inline-flex items-center gap-2 text-accent">
              <span className="size-3 animate-spin rounded-full border-2 border-line border-t-accent" />
              {engine.data.to_investigate ? `Investigating ${engine.data.to_investigate} flagged run${engine.data.to_investigate === 1 ? "" : "s"}…` : "Reading new runs for silent failures…"}
            </span>
          ) : (
            <span>Read <span className="text-ink-2">{engine.data.screened_7d}</span> runs in the last 7 days · <span className="text-ink-2">{engine.data.flagged_7d}</span> flagged</span>
          )}
          <span title="Issue engine model spend this month vs the cap (Settings › Issue engine)">
            ${engine.data.month_spend.toFixed(2)} of ${engine.data.monthly_cap.toFixed(0)} this month
          </span>
          {scan.data && <span>Last scan: {scan.data.issues} issue{scan.data.issues === 1 ? "" : "s"}, {scan.data.new} new</span>}
        </div>
      )}
      {scan.isError && <div className="mb-3"><ErrorBox error={scan.error} /></div>}
      {!!scan.data?.errors?.length && (
        <div className="mb-3 rounded-lg border border-accent/40 bg-accent/5 px-4 py-3 text-[12.5px] text-ink">
          <div className="font-medium">The scan finished, but part of it failed:</div>
          <ul className="mt-1 space-y-0.5 text-ink-2">{scan.data.errors.map((e) => <li key={e}>• {e}</li>)}</ul>
        </div>
      )}

      {(issues.data ?? []).length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {["", ...new Set((issues.data ?? []).map((i) => i.kind))].map((k) => {
            const n = (issues.data ?? []).filter((i) => !k || i.kind === k).length;
            return (
              <button key={k || "all"} onClick={() => setParam("kind", k)}
                className={`h-7 rounded-full border px-3 text-[12px] ${kind === k ? "border-ink/40 bg-subtle font-medium text-ink" : "border-line text-ink-2 hover:border-line-strong hover:text-ink"}`}>
                {k ? ISSUE_KIND[k as IssueKind] ?? k : "All"} <span className="text-ink-3">{n}</span>
              </button>
            );
          })}
        </div>
      )}

      {issues.isError ? <ErrorBox error={issues.error} /> : issues.isPending ? <Spinner /> : (issues.data ?? []).length === 0 ? (
        <Empty title={status === "open" ? "No open issues" : `No ${status} issues`}
          hint={status === "open" ? <>Failed steps, runaway loops, context explosions and actions run without approval from the last 7 days show up here, grouped by cause.
            Open any one to see the root cause and a suggested fix.</> : undefined}
          action={status === "open" ? <button onClick={() => scan.mutate()} className="text-accent hover:underline">Scan now</button> : undefined} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className={`${framedTable} min-w-[860px] text-[12.5px]`}>
            <thead>
              <tr>
                <th className={`${th} w-24 pl-4`}>Severity</th>
                <th className={th}>Issue</th>
                <th className={`${th} text-right`}>Runs</th>
                <th className={th}>Diagnosis</th>
                <th className={`${th} pr-4 text-right`}>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {(issues.data ?? []).filter((i) => !kind || i.kind === kind).map((i) => <IssueRow key={i.id} i={i} onOpen={() => navigate(pp(`/issues/${i.id}`))} />)}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function IssueRow({ i, onOpen }: { i: Issue; onOpen: () => void }) {
  const cell = "border-b border-line/70 px-3 py-2.5 align-top";
  const sev = SEVERITY[i.severity];
  return (
    <tr className="cursor-pointer hover:bg-hover" onClick={onOpen}>
      <td className={`${cell} pl-4`}>
        <span className="inline-flex items-center gap-1.5 text-ink-2"><span className={`size-2 rounded-full ${sev.dot}`} />{sev.label}</span>
      </td>
      <td className={`${cell} max-w-0 w-[48%]`}>
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-ink">{i.title}</span>
          {(i.status === "watching" || i.status === "fixing" || i.status === "incorrect") && (
            <span className="shrink-0 rounded bg-subtle px-1.5 text-[11px] text-ink-2">{ISSUE_STATUS[i.status]}</span>
          )}
        </div>
        <div className="truncate text-[12px] text-ink-3">
          <span className="text-ink-2">{ISSUE_KIND[i.kind] ?? i.kind}</span> · <span className="font-mono">{i.location}</span>
          {i.agent && i.agent !== i.location && <> · <span className="font-mono">{i.agent}</span></>}
        </div>
      </td>
      <td className={`${cell} num text-right text-ink-2`}>
        {i.runs}
        {i.failed_runs > 0 && <div className="text-[11.5px] text-critical">{i.failed_runs} failed</div>}
      </td>
      <td className={`${cell} max-w-0 w-[30%]`}>
        {i.diagnosis_status === "running" ? <span className="text-accent">Diagnosing…</span>
          : i.diagnosis_status === "done" ? <span className="line-clamp-2 text-ink-2">{i.summary}</span>
          : i.diagnosis_status === "error" ? <span className="text-critical">Diagnosis failed</span>
          : <span className="text-ink-3">—</span>}
      </td>
      <td className={`${cell} pr-4 text-right text-ink-3`}><Time value={i.last_seen} /></td>
    </tr>
  );
}
