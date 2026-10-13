import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { bestByQuality, ConnectionBanner, fmtRate, matchRate, QualityBar, QLABEL, useConnection, VerdictBar } from "../components/ExperimentBits";
import { Time } from "../components/Time";
import { Empty, ErrorBox, framedTable, PageHeader, Spinner, th } from "../components/ui";
import { api, type ExperimentSummary } from "../lib/api";
import { fmtCost } from "../lib/format";
import { pp } from "../lib/project";
import { useAppState } from "../lib/state";
import { Icon } from "../components/icons";

export function Experiments() {
  const { project } = useAppState();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const newExperiment = () => navigate(pp("/experiments/new"));
  // Old links (?new=1&sources=…) open the New experiment page.
  useEffect(() => {
    if (params.get("new") === "1") {
      const next = new URLSearchParams(params);
      next.delete("new");
      navigate(pp(`/experiments/new?${next}`), { replace: true });
    }
  }, [params, navigate]);
  const exps = useQuery({
    queryKey: ["experiments", project], queryFn: () => api<ExperimentSummary[]>("/api/experiments", { project }),
    refetchInterval: (q) => ((q.state.data ?? []).some((e) => e.jobs.pending > 0) ? 3000 : 15000),
  });
  const conn = useConnection(project);

  return (
    <>
      <PageHeader title="Experiments" meta="Replay real runs with other models and see which does better">
        <button onClick={newExperiment} className="h-7 rounded-md bg-ink px-3 text-[12.5px] font-medium text-bg">New experiment</button>
      </PageHeader>

      {!conn.loading && <div className="mb-5"><ConnectionBanner state={conn.state} hosts={conn.runners.map((r) => r.host)} /></div>}

      {exps.isError ? <ErrorBox error={exps.error} /> : exps.isPending ? <Spinner /> : (exps.data ?? []).length === 0 ? (
        <Empty title="No experiments yet"
          hint={<>Pick recorded runs, choose a model — for the whole run or for single agents on the blueprint — and imagent replays them
            inside your app with the original tool outputs, then scores each against the original.</>}
          action={<button onClick={newExperiment} className="text-accent hover:underline">Start one</button>} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className={`${framedTable} min-w-[860px] text-[12.5px]`}>
            <thead>
              <tr>
                <th className={`${th} pl-4`}>Experiment</th>
                <th className={th}>Variants — answers vs original</th>
                <th className={`${th} text-right`}>Replays</th>
                <th className={th}>Status</th>
                <th className={`${th} pr-4 text-right`}>Started</th>
              </tr>
            </thead>
            <tbody>
              {(exps.data ?? []).map((e) => <ExperimentRow key={e.id} e={e} onOpen={() => navigate(pp(`/experiments/${e.id}`))} />)}
            </tbody>
          </table>
        </div>
      )}

    </>
  );
}

function ExperimentRow({ e, onOpen }: { e: ExperimentSummary; onOpen: () => void }) {
  const results = (e.results ?? []).map((r) => ({
    name: r.name, counts: r.verdicts, total: r.total, cost: r.avg_cost, quality: r.better ?? { new: 0, tie: 0, original: 0 } }));
  const best = bestByQuality(results);
  const finished = e.jobs.done + e.jobs.failed;
  const cell = "border-b border-line/70 px-3 py-2.5 align-top";
  return (
    <tr className="group cursor-pointer hover:bg-hover" onClick={onOpen}>
      <td className={`${cell} w-[30%] max-w-0 pl-4`}>
        <div className="truncate font-medium text-ink">{e.name}</div>
        <div className="truncate text-[12px] text-ink-3">{e.agent} · {e.tool_mode === "recorded" ? "recorded tools"
          : e.tool_mode === "live" ? <span className="text-critical">all tools live</span> : "live reads"}</div>
      </td>
      <td className={cell}>
        <div className="space-y-1">
          {results.map((r) => {
            const judged = r.quality.new + r.quality.tie + r.quality.original;
            const rate = matchRate(r.counts);
            return (
              <div key={r.name} className="flex items-center gap-2 text-[12px]">
                <span className="flex w-36 min-w-0 items-center gap-1 truncate font-mono text-ink-2">
                  {r.name === best && <span className="inline-flex text-[#eda100]" title="Best answers so far"><Icon.star size={12} className="" /></span>}{r.name}
                </span>
                {judged ? <QualityBar counts={r.quality} total={r.total} className="w-24 shrink-0" /> : <VerdictBar counts={r.counts} total={r.total} className="w-24 shrink-0" />}
                <span className="num truncate text-ink-3">
                  {judged ? `${r.quality.new} ${QLABEL.new} · ${r.quality.tie} ${QLABEL.tie} · ${r.quality.original} ${QLABEL.original}`
                    : r.total > 0 && r.counts.failed === r.total ? <span className="text-critical">replay failed</span>
                    : rate == null ? "—" : `not judged · ${fmtRate(rate)} same behaviour`}
                  {r.cost ? ` · ${fmtCost(r.cost)}` : ""}
                </span>
              </div>
            );
          })}
        </div>
      </td>
      <td className={`${cell} num text-right text-ink-2`}>
        {e.sources} × {e.variants.length}{e.repeats > 1 ? ` × ${e.repeats}` : ""}
        <div className="text-[11.5px] text-ink-3">runs × variants</div>
      </td>
      <td className={`${cell} w-40`}>
        {e.jobs.pending > 0 ? (
          <span className="flex items-center gap-2 text-accent">
            <span className="h-1.5 w-16 overflow-hidden rounded-full bg-subtle"><span className="block h-full rounded-full bg-accent" style={{ width: `${(finished / Math.max(e.jobs.total, 1)) * 100}%` }} /></span>
            <span className="num text-[12px]">{finished}/{e.jobs.total}</span>
          </span>
        ) : e.jobs.failed === e.jobs.total && e.jobs.total > 0 ? (
          <span className="text-critical">failed</span>
        ) : (
          <span className="num text-ink-2">{e.jobs.done} done{e.jobs.failed ? <span className="text-critical"> · {e.jobs.failed} failed</span> : ""}</span>
        )}
      </td>
      <td className={`${cell} pr-4 text-right text-ink-3`}><Time value={e.created_at} /></td>
    </tr>
  );
}
