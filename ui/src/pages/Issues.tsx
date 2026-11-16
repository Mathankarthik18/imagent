import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Icon } from "../components/icons";
import { Time } from "../components/Time";
import { Empty, ErrorBox, framedTable, PageHeader, Segmented, Spinner, th } from "../components/ui";
import { api, apiPost, type Issue, type IssueStatus, type Severity } from "../lib/api";
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
  const status = (params.get("status") as IssueStatus) || "open";
  const issues = useQuery({
    queryKey: ["issues", project, status],
    queryFn: () => api<Issue[]>("/api/issues", { project, status }),
    refetchInterval: (q) => ((q.state.data ?? []).some((i) => i.diagnosis_status === "running") ? 4000 : 30000),
  });
  const scan = useMutation({
    mutationFn: () => apiPost<{ issues: number; new: number; diagnosing: number }>(`/api/issues/scan?project=${encodeURIComponent(project)}`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["issues", project] }),
  });

  return (
    <>
      <PageHeader title="Issues" meta="What keeps going wrong in production runs, and why — checked every few hours">
        <Segmented value={status} onChange={(v) => setParams(v === "open" ? {} : { status: v })}
          options={[{ id: "open", label: "Open" }, { id: "resolved", label: "Resolved" }, { id: "ignored", label: "Ignored" }]} />
        <button onClick={() => scan.mutate()} disabled={scan.isPending}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-bg disabled:opacity-50">
          <Icon.refresh size={12} className={scan.isPending ? "animate-spin" : ""} /> {scan.isPending ? "Scanning…" : "Scan now"}
        </button>
      </PageHeader>

      {scan.data && (
        <div className="mb-3 text-[12.5px] text-ink-3">
          Scanned the last 7 days: {scan.data.issues} issue{scan.data.issues === 1 ? "" : "s"}, {scan.data.new} new
          {scan.data.diagnosing ? ` · diagnosing the top ${scan.data.diagnosing}` : ""}.
        </div>
      )}
      {scan.isError && <div className="mb-3"><ErrorBox error={scan.error} /></div>}

      {issues.isError ? <ErrorBox error={issues.error} /> : issues.isPending ? <Spinner /> : (issues.data ?? []).length === 0 ? (
        <Empty title={status === "open" ? "No open issues" : `No ${status} issues`}
          hint={status === "open" ? <>Failed steps and runaway tool loops from the last 7 days show up here, grouped by cause.
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
              {(issues.data ?? []).map((i) => <IssueRow key={i.id} i={i} onOpen={() => navigate(pp(`/issues/${i.id}`))} />)}
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
        <div className="truncate font-medium text-ink">{i.title}</div>
        <div className="truncate text-[12px] text-ink-3">
          {i.kind === "loop" ? "Loop" : "Error"} in <span className="font-mono">{i.location}</span>
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
