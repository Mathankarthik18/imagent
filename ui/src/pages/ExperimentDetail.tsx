import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { CompareView, VERDICT } from "../components/CompareView";
import { Drawer } from "../components/Drawer";
import { LiveDot } from "../components/Live";
import { Time } from "../components/Time";
import { ErrorBox, Section, Spinner } from "../components/ui";
import { api, apiPost, type Experiment, type ExperimentJob, type Verdict } from "../lib/api";
import { fmtCost, fmtDuration, fmtPct } from "../lib/format";

const VERDICTS: Verdict[] = ["match", "partial", "diverged", "failed"];

function avg(xs: number[]) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function Change({ base, value, fmt }: { base: number; value: number; fmt: (n: number) => string }) {
  if (!base) return <span className="num">{fmt(value)}</span>;
  const pct = (value - base) / base;
  return (
    <span className="num">
      {fmt(value)} <span className={Math.abs(pct) < 0.005 ? "text-ink-3" : pct < 0 ? "text-good" : "text-critical"}>
        {Math.abs(pct) < 0.005 ? "same" : `${pct > 0 ? "+" : "−"}${fmtPct(Math.abs(pct))}`}
      </span>
    </span>
  );
}

export function ExperimentDetail() {
  const { experimentId = "" } = useParams();
  const qc = useQueryClient();
  const [open, setOpen] = useState<ExperimentJob | null>(null);
  const q = useQuery({
    queryKey: ["experiment", experimentId],
    queryFn: () => api<Experiment>(`/api/experiments/${experimentId}`),
    refetchInterval: (query) => (query.state.data?.status === "running" || query.state.data?.jobs.some((j) => j.status === "done" && !j.score) ? 3000 : false),
  });
  const cancel = useMutation({
    mutationFn: () => apiPost(`/api/experiments/${experimentId}/cancel`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["experiment", experimentId] }),
  });

  if (q.isError) return <ErrorBox error={q.error} />;
  if (q.isPending) return <Spinner />;
  const e = q.data;
  const finished = e.jobs.filter((j) => j.status === "done" || j.status === "error").length;
  const baselineCost = avg(e.sources.map((s) => s.metrics.cost_usd ?? 0));
  const baselineTime = avg(e.sources.map((s) => s.metrics.duration_ms ?? 0));
  const sourceIndex = new Map(e.sources.map((s, i) => [s.trace_id, i + 1]));

  return (
    <div className="space-y-8">
      <div>
        <nav className="mb-2 text-[12.5px] text-ink-3"><Link to="/experiments" className="hover:text-ink">Experiments</Link> /</nav>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-[15px] font-semibold tracking-[-0.01em]">{e.name}</h1>
          {e.status === "running"
            ? <span className="inline-flex items-center gap-1.5 text-[12.5px] text-accent"><LiveDot /> running · {finished}/{e.jobs.length}</span>
            : <span className="text-[12.5px] text-ink-3">{e.status} · {e.jobs.length} replays</span>}
          <span className="text-[12.5px] text-ink-3">{e.agent} · {e.config.tool_mode === "recorded" ? "recorded tool outputs" : "live read-only tools"} · <Time value={e.created_at} /></span>
          {e.status === "running" && (
            <button onClick={() => cancel.mutate()} className="ml-auto h-7 rounded-md border border-line px-2.5 text-[12.5px] text-ink-2 hover:border-critical/50 hover:text-critical">
              Cancel queued
            </button>
          )}
        </div>
      </div>

      <Section title="By model — compared with the original runs">
        <table className="w-full border-separate border-spacing-0 text-[12.5px]">
          <thead>
            <tr className="text-[11.5px] text-ink-3">
              {["Model", "Verdicts", "Tool match", "Output similarity", "Avg cost", "Avg duration", "Most often missing"].map((h, i) => (
                <th key={h} className={`border-b border-line py-1.5 font-medium ${i ? "text-right" : "text-left"} ${i === 1 ? "text-left pl-4" : ""}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="text-ink-3">
              <td className="border-b border-line/70 py-2">Original runs (baseline)</td>
              <td className="border-b border-line/70 py-2 pl-4">—</td>
              <td className="border-b border-line/70 py-2 text-right">100%</td>
              <td className="border-b border-line/70 py-2 text-right">100%</td>
              <td className="num border-b border-line/70 py-2 text-right">{fmtCost(baselineCost)}</td>
              <td className="num border-b border-line/70 py-2 text-right">{fmtDuration(baselineTime)}</td>
              <td className="border-b border-line/70 py-2 text-right">—</td>
            </tr>
            {e.config.variants.map((v) => {
              const jobs = e.jobs.filter((j) => j.variant === v.name);
              const scored = jobs.filter((j) => j.score).map((j) => j.score!);
              const errored = jobs.filter((j) => j.status === "error").length;
              const counts = Object.fromEntries(VERDICTS.map((x) => [x, scored.filter((s) => s.verdict === x).length + (x === "failed" ? errored : 0)]));
              const missing = new Map<string, number>();
              scored.forEach((s) => s.missing_tools.forEach((t) => missing.set(t, (missing.get(t) ?? 0) + 1)));
              const topMissing = [...missing.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
              return (
                <tr key={v.name}>
                  <td className="border-b border-line/70 py-2">
                    <div className="font-medium">{v.name}</div>
                    <div className="font-mono text-[11.5px] text-ink-3">{v.model || "app default"}</div>
                  </td>
                  <td className="border-b border-line/70 py-2 pl-4">
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                      {VERDICTS.filter((x) => counts[x]).map((x) => (
                        <span key={x} className={`inline-flex items-center gap-1 ${VERDICT[x].cls}`}><span className={`size-1.5 rounded-full ${VERDICT[x].dot}`} />{counts[x]} {x}</span>
                      ))}
                      {jobs.length - scored.length - errored > 0 && <span className="text-ink-3">{jobs.length - scored.length - errored} pending</span>}
                    </div>
                  </td>
                  <td className="num border-b border-line/70 py-2 text-right">{scored.length ? fmtPct(avg(scored.map((s) => s.tool_match))) : "—"}</td>
                  <td className="num border-b border-line/70 py-2 text-right">{scored.length ? fmtPct(avg(scored.map((s) => s.output_similarity))) : "—"}</td>
                  <td className="border-b border-line/70 py-2 text-right">{scored.length ? <Change base={baselineCost} value={avg(scored.map((s) => s.metrics.cost_usd))} fmt={fmtCost} /> : "—"}</td>
                  <td className="border-b border-line/70 py-2 text-right">{scored.length ? <Change base={baselineTime} value={avg(scored.map((s) => s.metrics.duration_ms))} fmt={fmtDuration} /> : "—"}</td>
                  <td className="border-b border-line/70 py-2 text-right font-mono text-[11.5px] text-critical">
                    {topMissing.map(([t, n]) => `${t} ×${n}`).join(", ") || <span className="font-sans text-ink-3">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>

      <Section title="Every replay — click one to compare with its original">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-separate border-spacing-0">
            <thead>
              <tr className="text-[11.5px] text-ink-3">
                <th className="border-b border-line py-1.5 text-left font-medium">Original run</th>
                {e.config.variants.map((v) => <th key={v.name} className="border-b border-line py-1.5 pl-4 text-left font-medium">{v.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {e.sources.map((s) => (
                <tr key={s.trace_id}>
                  <td className="max-w-0 w-[34%] border-b border-line/70 py-2.5 pr-3 align-top">
                    <div className="flex items-baseline gap-2">
                      <span className="num text-[11.5px] text-ink-3">{sourceIndex.get(s.trace_id)}</span>
                      <Link to={`/traces/${s.trace_id}`} className="truncate hover:underline">{s.input_text || s.name}</Link>
                    </div>
                    <div className="num mt-0.5 pl-5 text-[12px] text-ink-3">{s.metrics.tool_calls ?? 0} tools · {fmtDuration(s.metrics.duration_ms)} · {fmtCost(s.metrics.cost_usd)}</div>
                  </td>
                  {e.config.variants.map((v) => (
                    <td key={v.name} className="border-b border-line/70 py-2.5 pl-4 align-top">
                      <div className="flex flex-wrap gap-1.5">
                        {e.jobs.filter((j) => j.source_trace_id === s.trace_id && j.variant === v.name).map((j) => <JobChip key={j.id} job={j} onOpen={() => setOpen(j)} />)}
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {open && (
        <Drawer onClose={() => setOpen(null)} href={open.result_trace_id ? `/compare?a=${open.source_trace_id}&b=${open.result_trace_id}` : undefined}
          title={<span>Original vs <span className="font-mono text-[12.5px]">{open.variant}</span>{open.repeat ? ` · repeat ${open.repeat + 1}` : ""}</span>}>
          {open.status === "error" ? (
            <div className="rounded-md border border-critical/30 p-4 font-mono text-[12px] text-critical">{open.error || "Replay failed"}</div>
          ) : open.result_trace_id ? (
            <CompareView a={open.source_trace_id} b={open.result_trace_id} labels={["Original", open.variant]} />
          ) : <Spinner label="Waiting for the replay" />}
        </Drawer>
      )}
    </div>
  );
}

function JobChip({ job, onOpen }: { job: ExperimentJob; onOpen: () => void }) {
  if (job.status === "queued") return <span className="rounded-md border border-dashed border-line px-2 py-1 text-[12px] text-ink-3">queued</span>;
  if (job.status === "running") return <span className="inline-flex items-center gap-1.5 rounded-md border border-accent/30 px-2 py-1 text-[12px] text-accent"><LiveDot /> running</span>;
  if (job.status === "error") {
    return <button onClick={onOpen} className="rounded-md border border-critical/30 px-2 py-1 text-[12px] text-critical hover:bg-critical/5" title={job.error}>failed</button>;
  }
  const s = job.score;
  if (!s) return <span className="rounded-md border border-line px-2 py-1 text-[12px] text-ink-3">scoring…</span>;
  const v = VERDICT[s.verdict];
  return (
    <button onClick={onOpen} className="group rounded-md border border-line px-2 py-1 text-left hover:border-line-strong hover:bg-hover"
      title={s.missing_tools.length ? `Missing: ${s.missing_tools.join(", ")}` : undefined}>
      <span className={`flex items-center gap-1.5 text-[12px] font-medium ${v.cls}`}><span className={`size-1.5 rounded-full ${v.dot}`} />{s.verdict}</span>
      <span className="num block text-[11px] text-ink-3">{fmtDuration(s.metrics.duration_ms)} · {fmtCost(s.metrics.cost_usd)}</span>
    </button>
  );
}
