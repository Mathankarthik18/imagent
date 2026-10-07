import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { NewExperiment } from "../components/NewExperiment";
import { Time } from "../components/Time";
import { Empty, ErrorBox, PageHeader, rowCls, Spinner, td, th } from "../components/ui";
import { api, type ExperimentSummary, type Runner } from "../lib/api";

export function Experiments() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState(params.get("new") === "1");
  const preselected = (params.get("sources") ?? "").split(",").filter(Boolean);
  const exps = useQuery({
    queryKey: ["experiments"], queryFn: () => api<ExperimentSummary[]>("/api/experiments"),
    refetchInterval: (q) => ((q.state.data ?? []).some((e) => e.jobs.pending > 0) ? 3000 : 15000),
  });
  const runners = useQuery({ queryKey: ["runners"], queryFn: () => api<Runner[]>("/api/runners"), refetchInterval: 5000 });

  return (
    <>
      <PageHeader title="Experiments" meta="Replay real runs with other models and compare">
        <button onClick={() => setOpen(true)} className="h-7 rounded-md bg-ink px-3 text-[12.5px] font-medium text-bg">New experiment</button>
      </PageHeader>

      <RunnerStatus runners={runners.data ?? []} loading={runners.isPending} />

      {exps.isError ? <ErrorBox error={exps.error} /> : exps.isPending ? <Spinner /> : (exps.data ?? []).length === 0 ? (
        <Empty title="No experiments yet"
          hint="Pick recorded runs of an agent, choose the models to try, and imagent replays them inside your app with the original tool outputs — then scores each against the original."
          action={<button onClick={() => setOpen(true)} className="text-accent hover:underline">Start one</button>} />
      ) : (
        <table className="w-full border-separate border-spacing-0">
          <thead>
            <tr>
              <th className={th}>Experiment</th>
              <th className={th}>Models</th>
              <th className={`${th} text-right`}>Runs</th>
              <th className={th}>Progress</th>
              <th className={`${th} pr-4 text-right`}>Started</th>
            </tr>
          </thead>
          <tbody>
            {(exps.data ?? []).map((e) => {
              const pct = e.jobs.total ? (e.jobs.done + e.jobs.failed) / e.jobs.total : 0;
              return (
                <tr key={e.id} className={rowCls(false)} onClick={() => navigate(`/experiments/${e.id}`)}>
                  <td className={`${td} max-w-0 w-[40%]`}>
                    <div className="truncate font-medium">{e.name}</div>
                    <div className="truncate text-[12px] text-ink-3">{e.agent} · {e.tool_mode === "recorded" ? "recorded tools" : "live reads"}</div>
                  </td>
                  <td className={`${td} max-w-60 truncate font-mono text-[12px] text-ink-2`}>{e.variants.join(", ")}</td>
                  <td className={`${td} num text-right text-ink-2`}>{e.sources} × {e.variants.length}{e.repeats > 1 ? ` × ${e.repeats}` : ""}</td>
                  <td className={`${td} w-56`}>
                    <div className="flex items-center gap-2">
                      <span className="h-1.5 w-24 overflow-hidden rounded-full bg-subtle">
                        <span className={`block h-full rounded-full ${e.jobs.pending ? "bg-accent" : e.jobs.failed ? "bg-critical/70" : "bg-good"}`} style={{ width: `${pct * 100}%` }} />
                      </span>
                      <span className="num text-[12px] text-ink-3">
                        {e.jobs.pending ? `${e.jobs.done + e.jobs.failed}/${e.jobs.total}` : `${e.jobs.done} done${e.jobs.failed ? ` · ${e.jobs.failed} failed` : ""}`}
                      </span>
                    </div>
                  </td>
                  <td className={`${td} pr-4 text-right text-ink-2`}><Time value={e.created_at} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {open && <NewExperiment preselected={preselected} rootName={params.get("root") ?? undefined}
        onClose={() => { setOpen(false); setParams(new URLSearchParams(), { replace: true }); }} />}
    </>
  );
}

function RunnerStatus({ runners, loading }: { runners: Runner[]; loading: boolean }) {
  if (loading) return null;
  if (runners.length === 0) {
    return (
      <div className="mb-5 rounded-lg border border-line px-4 py-3">
        <div className="flex items-center gap-2 font-medium"><span className="size-2 rounded-full bg-ink-3/50" /> No runner connected</div>
        <p className="mt-1 text-ink-3">Experiments execute inside your app (real agent, recorded tools). In the app, register an agent and start the runner:</p>
        <pre className="mt-2 overflow-auto rounded-md bg-subtle p-3 font-mono text-[12px] leading-5 text-ink-2">{`imagent.register_agent("email_orchestrator", replay_email, source_root="bosun_orchestrator")
asyncio.create_task(imagent.runner.run_forever())`}</pre>
      </div>
    );
  }
  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-line px-4 py-2.5 text-[12.5px]">
      <span className="inline-flex items-center gap-2 font-medium"><span className="size-2 rounded-full bg-good" /> Runner connected</span>
      {runners.map((r) => (
        <span key={r.runner_id} className="text-ink-3">
          {r.host} · {r.agents.map((a) => a.name).join(", ") || "no agents"}
        </span>
      ))}
    </div>
  );
}
