import { useState } from "react";
import type { RunningRun } from "../lib/api";
import { fmtCost, fmtNum, parseTime } from "../lib/format";
import { elapsed, useNow, useRunning } from "../lib/live";
import { Icon, KindIcon } from "./icons";

/** Pulsing dot: blue while running, amber-free red ring when stalled. */
export function LiveDot({ stalled = false }: { stalled?: boolean }) {
  return stalled ? (
    <span className="relative inline-flex size-2 shrink-0 rounded-full bg-ink-3/50" title="Stalled — no activity for 5 minutes. Closed as failed if it stays silent." />
  ) : (
    <span className="relative inline-flex size-2 shrink-0" title="Running">
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-60" />
      <span className="relative inline-flex size-2 rounded-full bg-accent" />
    </span>
  );
}

/** Compact "running 0:42" / "stalled 6:10" label for list rows. */
export function RunningLabel({ run }: { run: RunningRun }) {
  const now = useNow();
  return (
    <span className={`num inline-flex items-center gap-1.5 whitespace-nowrap ${run.stalled ? "text-critical" : "text-accent"}`}>
      <LiveDot stalled={run.stalled} />
      {run.stalled ? "stalled" : "running"} {elapsed(run.started, now)}
    </span>
  );
}

function stepLabel(run: RunningRun) {
  const c = run.current;
  const verb = c.kind === "llm" ? "LLM" : c.kind === "tool" ? "tool" : c.kind === "retriever" ? "retrieving" : c.kind;
  return { verb, name: c.kind === "llm" && c.model ? c.model : c.name };
}

/** Runs idle past the server's timeout are closed as failed; say when. */
function closesIn(lastActivity: string, timeoutSeconds: number, now: number) {
  const left = Math.ceil((parseTime(lastActivity).getTime() + timeoutSeconds * 1000 - now) / 60_000);
  return left > 0 ? `closes as failed in ${left}m` : "closing as failed";
}

const VISIBLE = 5;

/** "Running now" strip shown above lists. Only runs that are progressing are listed; runs that
 *  stopped reporting fold into one collapsed line (they close as failed on their own). */
export function RunningStrip({ onOpen, threadId }: { onOpen: (run: RunningRun) => void; threadId?: string }) {
  const { runs: all, timeoutSeconds } = useRunning();
  const runs = threadId ? all.filter((r) => r.thread_id === threadId) : all;
  const active = runs.filter((r) => !r.stalled);
  const stuck = runs.filter((r) => r.stalled);
  const [showStuck, setShowStuck] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const now = useNow(runs.length > 0);
  if (runs.length === 0) return null;
  const shown = showAll ? active : active.slice(0, VISIBLE);
  return (
    <section className={`mb-5 overflow-hidden rounded-lg border ${active.length ? "border-accent/25" : "border-line"}`}>
      {active.length > 0 && (
        <>
          <header className="flex h-8 items-center gap-2 border-b border-accent/20 bg-accent-soft/50 px-3 text-[12px]">
            <LiveDot />
            <span className="font-medium text-ink">Running now</span>
            <span className="text-ink-3">{active.length}</span>
            <span className="ml-auto text-ink-3">updates every 3s</span>
          </header>
          <ul>{shown.map((r) => <RunRow key={r.trace_id} r={r} now={now} timeoutSeconds={timeoutSeconds} onOpen={onOpen} />)}</ul>
          {active.length > VISIBLE && (
            <button onClick={() => setShowAll((v) => !v)} className="w-full border-t border-line/70 py-1.5 text-center text-[12px] text-ink-3 hover:bg-hover hover:text-ink">
              {showAll ? "Show fewer" : `Show ${active.length - VISIBLE} more running`}
            </button>
          )}
        </>
      )}
      {stuck.length > 0 && (
        <>
          <button onClick={() => setShowStuck((v) => !v)}
            className={`flex h-8 w-full items-center gap-2 px-3 text-left text-[12px] text-ink-3 hover:bg-hover hover:text-ink ${active.length ? "border-t border-line/70" : ""}`}
            title="Runs that stopped reporting. Each closes as failed after the timeout.">
            <Icon.chevronRight size={12} className={`transition-transform ${showStuck ? "rotate-90" : ""}`} />
            <span className="size-1.5 rounded-full bg-ink-3/50" />
            {stuck.length} stuck {stuck.length === 1 ? "run" : "runs"} — no activity, closing as failed
          </button>
          {showStuck && <ul className="border-t border-line/70">{stuck.map((r) => <RunRow key={r.trace_id} r={r} now={now} timeoutSeconds={timeoutSeconds} onOpen={onOpen} />)}</ul>}
        </>
      )}
    </section>
  );
}

function RunRow({ r, now, timeoutSeconds, onOpen }: { r: RunningRun; now: number; timeoutSeconds: number; onOpen: (run: RunningRun) => void }) {
  const step = stepLabel(r);
  return (
    <li onClick={() => onOpen(r)}
      className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-line/70 px-3 py-2 last:border-b-0 hover:bg-hover">
      <LiveDot stalled={r.stalled} />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <KindIcon kind={r.kind} size={13} />
          <span className="truncate font-medium">{r.name}</span>
          {r.thread_id && <span className="truncate font-mono text-[12px] text-ink-3">{r.thread_id}</span>}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[12px] text-ink-3">
          {r.stalled ? (
            <span className="truncate">
              No activity for {elapsed(r.last_activity, now)} — stuck at {step.verb} {step.name} · {closesIn(r.last_activity, timeoutSeconds, now)}
            </span>
          ) : (
            <>
              {r.path.slice(0, -1).map((p, i) => (
                <span key={i} className="inline-flex min-w-0 items-center gap-1">
                  <span className="truncate">{p.name}</span><Icon.chevronRight size={11} className="shrink-0" />
                </span>
              ))}
              <KindIcon kind={r.current.kind} size={12} />
              <span className="truncate text-ink-2">{step.verb} <span className="font-mono text-[11.5px]">{step.name}</span></span>
              <span className="num shrink-0">· {elapsed(r.current.started, now)}</span>
            </>
          )}
        </div>
      </div>
      <div className="num flex items-center gap-4 whitespace-nowrap text-[12px] text-ink-3">
        <span className="max-md:hidden">{r.done.llm} LLM · {r.done.tools} tools done</span>
        {r.done.tokens > 0 && <span className="max-lg:hidden">{fmtNum(r.done.tokens)} tok · {fmtCost(r.done.cost)}</span>}
        {r.done.errors > 0 && <span className="text-critical">{r.done.errors} failed</span>}
        <span className={`w-14 text-right text-[13px] font-medium ${r.stalled ? "text-ink-3" : "text-ink"}`}>{elapsed(r.started, now)}</span>
      </div>
    </li>
  );
}
