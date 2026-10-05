import type { RunningRun, ThreadGroup } from "../lib/api";
import { fmtCost, fmtDuration, fmtNum, fmtPct } from "../lib/format";
import { RunningLabel } from "./Live";
import { Time } from "./Time";
import { Failures, rowCls, StatusMark, td, th } from "./ui";

/** Human title for a thread: its opening message, else the agent/entry point. */
export function threadTitle(g: ThreadGroup): string {
  const text = (g.first_input_text || "").trim();
  if (text && !/^[[{]/.test(text)) return text;
  return g.agents[0] || g.last_trace_name || "Untitled thread";
}

function shortThreadId(id: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id)) return id.slice(0, 8);
  return id.length > 28 ? `${id.slice(0, 28)}…` : id;
}

/** One row per thread; clicking opens it (drawer or page — caller decides). */
export function ThreadList({ items, onOpen, active = -1, running, detailed = false }: {
  items: ThreadGroup[];
  onOpen: (g: ThreadGroup, index: number, e: React.MouseEvent | null) => void;
  active?: number;
  running?: Map<string, RunningRun>;
  detailed?: boolean;
}) {
  const maxCost = Math.max(...items.map((t) => t.cost_usd), 0);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] border-separate border-spacing-0">
        <thead>
          <tr>
            <th className={`${th} w-8 pl-3 pr-0`} aria-label="Status" />
            <th className={th}>Thread</th>
            <th className={`${th} text-right`}>Runs</th>
            {detailed && <th className={`${th} text-right`}>Span</th>}
            <th className={`${th} text-right`}>Tokens</th>
            {detailed && <th className={`${th} text-right`}>Cache</th>}
            <th className={`${th} text-right`}>Cost</th>
            <th className={`${th} text-right`}>Failures</th>
            <th className={`${th} pr-4 text-right`}>Last run</th>
          </tr>
        </thead>
        <tbody>
          {items.map((g, i) => {
            const live = g.thread_id ? running?.get(g.thread_id) : undefined;
            const unthreaded = !g.thread_id;
            const title = unthreaded ? "Runs without a thread" : threadTitle(g);
            const last = (g.last_input_text || "").trim();
            const showLast = !unthreaded && g.trace_count > 1 && last && last !== title && !/^[[{]/.test(last);
            return (
              <tr key={g.thread_id || "__none__"} data-row-index={i} onClick={(e) => onOpen(g, i, e)} className={rowCls(i === active)}>
                <td className={`${td} pl-3 pr-0`}>
                  {live ? <span className="inline-flex size-3.5 items-center justify-center"><span className="size-2 animate-pulse rounded-full bg-accent" /></span>
                    : <StatusMark errors={g.error_traces} />}
                </td>
                <td className={`${td} max-w-0 w-[50%]`}>
                  <div className={`truncate ${unthreaded ? "italic text-ink-2" : "font-medium text-ink"}`}>{title}</div>
                  <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-ink-3">
                    {!unthreaded && <span className="shrink-0 font-mono text-[11.5px]" title={g.thread_id}>{shortThreadId(g.thread_id)}</span>}
                    {g.agents.length > 0 && <><span className="shrink-0">·</span><span className="shrink-0">{g.agents.join(", ")}</span></>}
                    {g.user_id && <><span className="shrink-0">·</span><span className="shrink-0">{g.user_id}</span></>}
                    {showLast && <><span className="shrink-0">·</span><span className="truncate">latest: {last}</span></>}
                  </div>
                </td>
                <td className={`${td} num text-right`}>{g.trace_count}</td>
                {detailed && <td className={`${td} num text-right text-ink-3`}>{fmtDuration(g.duration_ms)}</td>}
                <td className={`${td} num text-right text-ink-2`}>{fmtNum(g.total_tokens)}</td>
                {detailed && <td className={`${td} num text-right text-ink-3`}>{g.input_tokens ? fmtPct(g.cache_read_tokens / g.input_tokens) : "—"}</td>}
                <td className={`${td} text-right`}>
                  <div className="flex items-center justify-end gap-2">
                    <span className="h-1 w-10 overflow-hidden rounded-full bg-subtle" aria-hidden>
                      <span className="block h-full rounded-full bg-ink-3" style={{ width: `${maxCost ? (g.cost_usd / maxCost) * 100 : 0}%` }} />
                    </span>
                    <span className="num w-14 text-ink">{fmtCost(g.cost_usd)}</span>
                  </div>
                </td>
                <td className={`${td} num text-right`}><Failures n={g.error_traces} of={g.error_traces ? g.trace_count : undefined} /></td>
                <td className={`${td} pr-4 text-right text-ink-2`}>{live ? <RunningLabel run={live} /> : <Time value={g.last_seen} />}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
