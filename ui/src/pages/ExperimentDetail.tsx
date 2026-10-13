import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { CompareView, VERDICT } from "../components/CompareView";
import { Drawer } from "../components/Drawer";
import { bestByQuality, ConnectionBanner, fmtRunCost, matchRate, netScore, quality, QualityBar, QualityLegend, qualityCounts,
  useConnection, VerdictBar, VerdictLegend, type QualityCounts, type VerdictCounts } from "../components/ExperimentBits";
import { Tile } from "../components/FlowView";
import { LiveDot } from "../components/Live";
import { Time } from "../components/Time";
import { controlCls, ErrorBox, Spinner } from "../components/ui";
import { api, apiPost, type Better, type CriteriaScores, type Experiment, type ExperimentJob, type JudgeStatus, type Variant } from "../lib/api";
import { fmtCost, fmtDuration, fmtPct } from "../lib/format";
import { pp } from "../lib/project";
import { Icon } from "../components/icons";

const short = (m: string) => m.split("/").pop() ?? m;

function avg(xs: number[]) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** "−32% vs original" — green when lower is better (cost, time). */
function Delta({ base, value }: { base: number; value: number }) {
  if (!base) return null;
  const pct = (value - base) / base;
  if (Math.abs(pct) < 0.005) return <span className="text-ink-3">same as original</span>;
  return <span className={pct < 0 ? "text-good" : "text-critical"}>{pct > 0 ? "+" : "−"}{fmtPct(Math.abs(pct))} vs original</span>;
}

interface VariantResult {
  v: Variant; name: string; jobs: ExperimentJob[]; counts: VerdictCounts; pending: number;
  cost: number | null; time: number | null; toolMatch: number | null; similarity: number | null; missing: [string, number][];
  quality: QualityCounts; criteria: { original: CriteriaScores; new: CriteriaScores } | null;
}

const CRITERIA: [keyof CriteriaScores, string][] = [["correct", "Correct"], ["complete", "Complete"], ["clear", "Clear"], ["rubric", "Your rubric"]];

/** Average judge scores per criterion, for the original answers and this variant's. */
function criteriaAverages(jobs: ExperimentJob[]) {
  const js = jobs.map((j) => j.judgement?.scores).filter((x): x is NonNullable<typeof x> => !!x && !!x.new && !!x.original);
  if (!js.length) return null;
  const mean = (side: "original" | "new") => Object.fromEntries(CRITERIA.map(([k]) => {
    const vals = js.map((s) => s[side]?.[k]).filter((v): v is number => typeof v === "number");
    return [k, vals.length ? avg(vals) : undefined];
  })) as CriteriaScores;
  return { original: mean("original"), new: mean("new") };
}

function results(e: Experiment): VariantResult[] {
  return e.config.variants.map((v) => {
    const jobs = e.jobs.filter((j) => j.variant === v.name);
    const scored = jobs.filter((j) => j.score).map((j) => j.score!);
    const counts: VerdictCounts = { match: 0, partial: 0, diverged: 0, failed: jobs.filter((j) => j.status === "error").length };
    for (const s of scored) counts[s.verdict] += 1;
    const missing = new Map<string, number>();
    scored.forEach((s) => s.missing_tools.forEach((t) => missing.set(t, (missing.get(t) ?? 0) + 1)));
    const has = scored.length > 0;
    return {
      v, name: v.name, jobs, counts, pending: jobs.length - scored.length - counts.failed,
      cost: has ? avg(scored.map((s) => s.metrics.cost_usd)) : null, time: has ? avg(scored.map((s) => s.metrics.duration_ms)) : null,
      toolMatch: has ? avg(scored.map((s) => s.tool_match)) : null, similarity: has ? avg(scored.map((s) => s.output_similarity)) : null,
      missing: [...missing.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3),
      quality: qualityCounts(jobs), criteria: criteriaAverages(jobs),
    };
  });
}

export function ExperimentDetail() {
  const { experimentId = "" } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState<ExperimentJob | null>(null);
  const q = useQuery({
    queryKey: ["experiment", experimentId],
    queryFn: () => api<Experiment>(`/api/experiments/${experimentId}`),
    refetchInterval: (query) => (query.state.data?.status === "running"
      || query.state.data?.jobs.some((j) => j.status === "done" && (!j.score || !j.judgement)) ? 3000 : false),
  });
  const conn = useConnection(q.data?.project ?? "", q.data?.agent);
  const judgeStatus = useQuery({ enabled: !!q.data, queryKey: ["judge", q.data?.project], staleTime: 60_000,
    queryFn: () => api<JudgeStatus>("/api/judge", { project: q.data!.project }) });
  const cancel = useMutation({
    mutationFn: () => apiPost(`/api/experiments/${experimentId}/cancel`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["experiment", experimentId] }),
  });
  const rejudge = useMutation({
    mutationFn: () => apiPost(`/api/experiments/${experimentId}/rejudge`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["experiment", experimentId] }),
  });
  const again = useMutation({
    mutationFn: (e: Experiment) => apiPost<{ id: string }>("/api/experiments", {
      name: e.name, agent: e.agent, project: e.project, source_trace_ids: e.config.source_trace_ids,
      variants: e.config.variants, repeats: e.config.repeats, tool_mode: e.config.tool_mode,
    }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["experiments"] }); navigate(pp(`/experiments/${r.id}`)); },
  });

  if (q.isError) return <ErrorBox error={q.error} />;
  if (q.isPending) return <Spinner />;
  const e = q.data;
  const done = e.jobs.filter((j) => j.status === "done" || j.status === "error").length;
  const queued = e.jobs.filter((j) => j.status === "queued").length;
  const rows = results(e);
  const best = bestByQuality(rows);
  const baseCost = avg(e.sources.map((s) => s.metrics.cost_usd ?? 0));
  const baseTime = avg(e.sources.map((s) => s.metrics.duration_ms ?? 0));
  const sourceIndex = new Map(e.sources.map((s, i) => [s.trace_id, i + 1]));

  return (
    <div className="space-y-6">
      <div>
        <nav className="mb-2 text-[12.5px] text-ink-3"><Link to={pp("/experiments")} className="hover:text-ink">Experiments</Link> /</nav>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-[15px] font-semibold tracking-[-0.01em]">{e.name}</h1>
          {e.status === "running"
            ? <span className="inline-flex items-center gap-1.5 text-[12.5px] text-accent"><LiveDot /> running</span>
            : <span className={`text-[12.5px] ${e.status === "failed" ? "text-critical" : "text-ink-3"}`}>{e.status}</span>}
          <div className="ml-auto flex items-center gap-2">
            {queued > 0 && (
              <button onClick={() => cancel.mutate()} className="h-7 rounded-md border border-line px-2.5 text-[12.5px] text-ink-2 hover:border-critical/50 hover:text-critical">
                Cancel {queued} queued
              </button>
            )}
            {judgeStatus.data?.configured && e.jobs.some((j) => j.status === "done") && (
              <button onClick={() => rejudge.mutate()} disabled={rejudge.isPending}
                title={`Judge every answer again with ${judgeStatus.data.model} (e.g. after changing the judge model or rules)`}
                className="h-7 rounded-md border border-line px-2.5 text-[12.5px] text-ink-2 hover:border-line-strong hover:text-ink disabled:opacity-50">
                {rejudge.isPending ? "Queuing…" : "Judge again"}
              </button>
            )}
            <button onClick={() => {
              if (e.config.tool_mode === "live" && !confirm("This experiment runs every tool for real. Running it again changes live data and can contact people again. Continue?")) return;
              again.mutate(e);
            }} disabled={again.isPending}
              className="h-7 rounded-md border border-line px-2.5 text-[12.5px] text-ink-2 hover:border-line-strong hover:text-ink disabled:opacity-50">
              {again.isPending ? "Starting…" : "Run again"}
            </button>
          </div>
        </div>
        <div className="num mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink-3">
          <span>{e.agent}</span>
          <span>{e.sources.length} run{e.sources.length === 1 ? "" : "s"} × {e.config.variants.length} variant{e.config.variants.length === 1 ? "" : "s"}{e.config.repeats > 1 ? ` × ${e.config.repeats}` : ""}</span>
          <span className={e.config.tool_mode === "live" ? "font-medium text-critical" : ""}>
            {e.config.tool_mode === "recorded" ? "tools from the recording" : e.config.tool_mode === "live" ? "all tools ran for real" : "live read-only tools"}
          </span>
          <Time value={e.created_at} />
          <span className="flex items-center gap-2">
            <span className="h-1.5 w-28 overflow-hidden rounded-full bg-subtle">
              <span className={`block h-full rounded-full ${e.status === "running" ? "bg-accent" : "bg-good"}`} style={{ width: `${(done / Math.max(e.jobs.length, 1)) * 100}%` }} />
            </span>
            {done}/{e.jobs.length} replays
          </span>
        </div>
      </div>

      {queued > 0 && conn.state !== "ready" && !conn.loading && <ConnectionBanner state={conn.state} compact />}
      {queued > 0 && conn.state === "ready" && e.config.tool_mode === "live"
        && !conn.runners.some((r) => r.live_agents == null || r.live_agents.includes(e.agent)) && (
        <div className="flex items-center gap-2 rounded-lg border border-line px-3.5 py-2 text-[12.5px]">
          <span className="size-2 rounded-full bg-[#eda100]" />
          <span className="font-medium">Waiting for a live connection</span>
          <span className="text-ink-3">— live replays use the app's database connection, which it opens when it runs <span className="font-mono">{e.agent}</span>. This starts automatically after the app's next chat or email.</span>
        </div>
      )}
      {judgeStatus.data && !judgeStatus.data.configured && (
        <div className="rounded-lg border border-line px-3.5 py-2 text-[12.5px]">
          <span className="font-medium">AI judge is off</span>
          <span className="text-ink-3"> — the original isn't necessarily right, so a judge model compares the answers for quality.
            {" "}<Link to={pp("/settings")} className="text-accent hover:underline">Add a judge key in Settings</Link>. Meanwhile, open a replay and mark which answer is better yourself.</span>
        </div>
      )}

      {/* Scorecards: the original next to each variant. */}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <div className="rounded-xl border border-line bg-panel px-4 py-3.5">
          <div className="text-[12px] font-medium text-ink-3">Original runs</div>
          <div className="mt-0.5 text-[13.5px] font-medium">Baseline</div>
          <dl className="num mt-3 space-y-1.5 text-[12.5px]">
            <Row k="Avg cost" v={fmtCost(baseCost)} />
            <Row k="Avg time" v={fmtDuration(baseTime)} />
            <Row k="Avg tool calls" v={avg(e.sources.map((s) => s.metrics.tool_calls ?? 0)).toFixed(1)} />
          </dl>
        </div>
        {rows.map((r) => <Scorecard key={r.name} r={r} best={r.name === best} baseCost={baseCost} baseTime={baseTime} />)}
      </div>

      <section>
        <h2 className="mb-2 text-[13px] font-semibold">Every replay <span className="font-normal text-ink-3">— click one to compare it with its original</span></h2>
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[720px] border-separate border-spacing-0">
            <thead>
              <tr className="bg-panel text-[11.5px] text-ink-3">
                <th className="border-b border-line px-4 py-2 text-left font-medium">Original run</th>
                {e.config.variants.map((v) => (
                  <th key={v.name} className="border-b border-line px-3 py-2 text-left font-medium">
                    {v.name === best && <span className="mr-1 inline-flex align-[-1px] text-[#eda100]"><Icon.star size={12} className="" /></span>}<span className="font-mono">{v.name}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {e.sources.map((s) => (
                <tr key={s.trace_id}>
                  <td className="w-[36%] max-w-0 border-b border-line/70 px-4 py-2.5 align-top">
                    <div className="flex items-baseline gap-2">
                      <span className="num text-[11.5px] text-ink-3">{sourceIndex.get(s.trace_id)}</span>
                      <Link to={pp(`/traces/${s.trace_id}`)} className="truncate text-[13px] hover:underline" title={s.input_text}>{s.input_text || s.name}</Link>
                    </div>
                    <div className="num mt-0.5 pl-5 text-[11.5px] text-ink-3">{s.metrics.tool_calls ?? 0} tools · {fmtDuration(s.metrics.duration_ms)} · {fmtCost(s.metrics.cost_usd)}</div>
                  </td>
                  {e.config.variants.map((v) => (
                    <td key={v.name} className="border-b border-line/70 px-3 py-2.5 align-top">
                      <div className="flex flex-wrap gap-1.5">
                        {e.jobs.filter((j) => j.source_trace_id === s.trace_id && j.variant === v.name).map((j) => (
                          <JobChip key={j.id} job={j} base={s.metrics} onOpen={() => setOpen(j)} />
                        ))}
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {open && (
        <Drawer onClose={() => setOpen(null)} href={open.result_trace_id ? pp(`/compare?a=${open.source_trace_id}&b=${open.result_trace_id}`) : undefined}
          title={<span>Original vs <span className="font-mono text-[12.5px]">{open.variant}</span>{open.repeat ? ` · repeat ${open.repeat + 1}` : ""}</span>}>
          {open.status === "error" ? (
            <div className="rounded-md border border-critical/30 p-4 font-mono text-[12px] text-critical">{open.error || "Replay failed"}</div>
          ) : open.result_trace_id ? (
            <>
              <QualityPanel job={e.jobs.find((j) => j.id === open.id) ?? open} variant={open.variant}
                onSaved={() => qc.invalidateQueries({ queryKey: ["experiment", experimentId] })} />
              <CompareView a={open.source_trace_id} b={open.result_trace_id} labels={["Original", open.variant]} />
            </>
          ) : <Spinner label="Waiting for the replay" />}
        </Drawer>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="flex items-baseline justify-between gap-3"><dt className="text-ink-3">{k}</dt><dd className="text-right">{v}</dd></div>;
}

function Scorecard({ r, best, baseCost, baseTime }: { r: VariantResult; best: boolean; baseCost: number; baseTime: number }) {
  const judged = r.quality.new + r.quality.tie + r.quality.original;
  const net = netScore(r.quality);
  const rate = matchRate(r.counts);
  const per = Object.entries(r.v.models ?? {}).filter(([, m]) => m);
  return (
    <div className={`rounded-xl border bg-bg px-4 py-3.5 ${best ? "border-[#eda100]/60 shadow-[0_0_0_3px_rgb(237_161_0/0.12)]" : "border-line"}`}>
      <div className="flex items-center gap-2">
        <span className="truncate font-mono text-[13px] font-medium">{r.name}</span>
        {best && <span className="shrink-0 rounded bg-[#eda100]/15 px-1.5 py-0.5 text-[10.5px] font-semibold text-[#9a6700] dark:text-[#f0b440]"><span className="inline-flex items-center gap-1"><Icon.star size={12} className="" /> Best answers</span></span>}
      </div>

      {/* 1 · is the answer better? */}
      <div className="mt-3">
        <div className="flex items-baseline justify-between">
          <span className="text-[12px] font-medium">Answers vs original</span>
          <span className={`num text-[15px] font-semibold ${net == null ? "text-ink-3" : net > 0 ? "text-good" : net < 0 ? "text-critical" : "text-ink-2"}`}>
            {net == null ? <span className="text-[12px] font-normal">{r.pending ? "running…" : "not judged yet"}</span>
              : net > 0 ? "Better" : net < 0 ? "Worse" : "About the same"}
          </span>
        </div>
        <QualityBar counts={r.quality} total={r.jobs.length} className="mt-1.5" />
        <div className="mt-1.5">{judged > 0 ? <QualityLegend counts={r.quality} /> : <span className="text-[11.5px] text-ink-3">Open a replay to judge it yourself</span>}</div>
        {r.criteria && (
          <table className="num mt-2.5 w-full text-[12px]">
            <thead><tr className="text-[11px] text-ink-3"><th className="text-left font-normal" /><th className="w-16 text-right font-normal">Original</th><th className="w-16 text-right font-normal">This</th></tr></thead>
            <tbody>
              {CRITERIA.filter(([k]) => r.criteria!.new[k] != null).map(([k, label]) => {
                const o = r.criteria!.original[k] ?? 0, n = r.criteria!.new[k] ?? 0;
                return (
                  <tr key={k}>
                    <td className="py-0.5 text-ink-3">{label}</td>
                    <td className="text-right text-ink-2">{o.toFixed(1)}</td>
                    <td className={`text-right font-medium ${n > o + 0.05 ? "text-good" : n < o - 0.05 ? "text-critical" : ""}`}>{n.toFixed(1)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* 2 · cost and speed */}
      <dl className="num mt-3 space-y-1.5 border-t border-line/70 pt-2.5 text-[12.5px]">
        <Row k="Avg cost" v={r.cost == null ? "—" : !r.cost ? <span className="text-ink-3" title="imagent has no price for this model">not priced</span>
          : <>{fmtCost(r.cost)} <span className="text-[11.5px]"><Delta base={baseCost} value={r.cost} /></span></>} />
        <Row k="Avg time" v={r.time == null ? "—" : <>{fmtDuration(r.time)} <span className="text-[11.5px]"><Delta base={baseTime} value={r.time} /></span></>} />
      </dl>

      {/* 3 · did it behave the same? (not a quality score) */}
      <div className="mt-3 border-t border-line/70 pt-2.5">
        <div className="flex items-baseline justify-between text-[12px]">
          <span className="text-ink-3" title="How closely the replay followed the original: same tools, similar answer. Different isn't worse.">Behaviour vs original</span>
          <span className="num text-ink-2">{rate == null ? "—" : `${Math.round(rate * 100)}% same`}</span>
        </div>
        <VerdictBar counts={r.counts} total={r.jobs.length} className="mt-1.5 !h-1.5" />
        <div className="mt-1"><VerdictLegend counts={r.counts} /></div>
        <dl className="num mt-1.5 space-y-1 text-[12px]">
          <Row k="Same tools called" v={r.toolMatch == null ? "—" : fmtPct(r.toolMatch)} />
          {r.missing.length > 0 && (
            <Row k="Skipped tools" v={<span className="font-mono text-[11.5px] text-ink-2">{r.missing.map(([t, n]) => `${t}${n > 1 ? ` ×${n}` : ""}`).join(", ")}</span>} />
          )}
        </dl>
      </div>

      <div className="mt-3 border-t border-line/70 pt-2.5 text-[12px]">
        <div className="mb-1 text-ink-3">Models</div>
        {r.v.model && <div className="flex items-center gap-1.5"><span className="text-ink-3">All agents</span><span className="ml-auto font-mono">{short(r.v.model)}</span></div>}
        {per.map(([agent, m]) => (
          <div key={agent} className="flex items-center gap-1.5">
            <Tile role="sub" size={14} /><span className="truncate">{agent}</span><span className="ml-auto shrink-0 font-mono">{short(m)}</span>
          </div>
        ))}
        {!r.v.model && per.length > 0 && <div className="text-ink-3">Other agents unchanged</div>}
      </div>
    </div>
  );
}

const BETTER: Record<Better, { label: string; cls: string; dot: string }> = {
  new: { label: "Better", cls: "text-good", dot: "bg-good" },
  tie: { label: "Same quality", cls: "text-ink-2", dot: "bg-ink-3/50" },
  original: { label: "Worse", cls: "text-critical", dot: "bg-critical" },
};

/** Which answer is better — the AI judge's verdict and the buttons to give your own. */
function QualityPanel({ job, variant, onSaved }: { job: ExperimentJob; variant: string; onSaved: () => void }) {
  const [note, setNote] = useState(job.review?.note ?? "");
  const save = useMutation({
    mutationFn: (better: Better | null) => apiPost(`/api/experiments/jobs/${job.id}/review`, { better, note }),
    onSuccess: onSaved,
  });
  const j = job.judgement;
  const mine = job.review?.better;
  const opts: [Better, string][] = [["original", "Original is better"], ["tie", "About the same"], ["new", `${variant} is better`]];
  return (
    <section className="mb-5 rounded-xl border border-line px-4 py-3.5">
      <h3 className="text-[13px] font-semibold">Which answer is better?</h3>
      {j?.better ? (
        <div className="mt-2 text-[12.5px]">
          <span className={`inline-flex items-center gap-1.5 font-medium ${BETTER[j.better].cls}`}>
            <span className={`size-1.5 rounded-full ${BETTER[j.better].dot}`} />
            AI judge: {j.better === "new" ? `${variant} is better` : j.better === "original" ? "the original is better" : "about the same"}
          </span>
          <span className="ml-2 font-mono text-[11px] text-ink-3">{j.model}{j.cost ? ` · ${fmtCost(j.cost)}` : ""}</span>
          {j.reason && <p className="mt-1 text-ink-2">{j.reason}</p>}
          {j.scores?.original && j.scores?.new && (
            <div className="num mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-ink-3">
              {CRITERIA.filter(([k]) => j.scores!.new![k] != null).map(([k, label]) => (
                <span key={k}>{label}: <span className="text-ink-2">{j.scores!.original![k]}</span> → <span className="font-medium text-ink">{j.scores!.new![k]}</span></span>
              ))}
            </div>
          )}
        </div>
      ) : j?.error ? (
        <p className="mt-2 text-[12.5px] text-critical">The judge couldn't score this one: {j.error}</p>
      ) : (
        <p className="mt-2 text-[12.5px] text-ink-3">Not judged by AI{job.score ? " yet" : ""}. You can decide below.</p>
      )}

      <div className="mt-3 border-t border-line/70 pt-3">
        <div className="mb-1.5 text-[12px] text-ink-3">Your verdict {mine ? "(overrides the AI judge)" : ""}</div>
        <div className="flex flex-wrap items-center gap-1.5">
          {opts.map(([b, label]) => (
            <button key={b} onClick={() => save.mutate(mine === b ? null : b)} disabled={save.isPending}
              className={`h-7 rounded-md border px-2.5 text-[12.5px] ${mine === b ? `border-current font-medium ${BETTER[b].cls} bg-subtle` : "border-line text-ink-2 hover:border-line-strong hover:text-ink"}`}>
              {label}
            </button>
          ))}
          <input className={`${controlCls} min-w-40 flex-1`} placeholder="Why? (optional)" value={note} onChange={(ev) => setNote(ev.target.value)}
            onBlur={() => mine && note !== (job.review?.note ?? "") && save.mutate(mine)} />
        </div>
      </div>
    </section>
  );
}

function JobChip({ job, base, onOpen }: { job: ExperimentJob; base: { cost_usd?: number; duration_ms?: number }; onOpen: () => void }) {
  if (job.status === "queued") return <span className="rounded-md border border-dashed border-line px-2 py-1 text-[12px] text-ink-3">queued</span>;
  if (job.status === "running") return <span className="inline-flex items-center gap-1.5 rounded-md border border-accent/30 px-2 py-1 text-[12px] text-accent"><LiveDot /> running</span>;
  if (job.status === "error") {
    return <button onClick={onOpen} className="max-w-56 truncate rounded-md border border-critical/30 px-2 py-1 text-left text-[12px] text-critical hover:bg-critical/5" title={job.error}>failed · {job.error.split(":")[0] || "error"}</button>;
  }
  const s = job.score;
  if (!s) return <span className="rounded-md border border-line px-2 py-1 text-[12px] text-ink-3">scoring…</span>;
  const q = quality(job);
  const v = q ? BETTER[q] : null;
  const cheaper = base.cost_usd ? s.metrics.cost_usd < base.cost_usd * 0.995 : false;
  return (
    <button onClick={onOpen} className="rounded-md border border-line px-2 py-1 text-left hover:border-line-strong hover:bg-hover"
      title={`${VERDICT[s.verdict].label}${s.missing_tools.length ? ` · skipped ${s.missing_tools.join(", ")}` : ""} — click to compare`}>
      <span className={`flex items-center gap-1.5 text-[12px] font-medium ${v ? v.cls : "text-ink-3"}`}>
        <span className={`size-1.5 rounded-full ${v ? v.dot : "bg-ink-3/30"}`} />
        {v ? v.label : job.judgement?.error ? "judge failed" : "not judged"}{job.review ? " ✓" : ""}
      </span>
      <span className="num block text-[11px] text-ink-3">
        {fmtDuration(s.metrics.duration_ms)} · <span className={cheaper && s.metrics.cost_usd ? "text-good" : ""}>{fmtRunCost(s.metrics.cost_usd, fmtCost)}</span>
      </span>
    </button>
  );
}
