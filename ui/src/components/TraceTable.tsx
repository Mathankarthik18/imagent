import type { RunningRun, TraceSummary } from "../lib/api";
import { RunningLabel } from "./Live";
import { fmtCost, fmtDuration, fmtNum, shortId } from "../lib/format";
import { Time } from "./Time";
import { KindIcon, rowCls, StatusMark, td, th } from "./ui";

/** Dense trace list. Rows are keyboard-selectable (`active`) and open via `onOpen`. */
export function TraceTable({ items, onOpen, active = -1, showThread = true, indexOffset = 0, running, selected, onToggle }: {
  items: TraceSummary[];
  selected?: Set<string>;
  onToggle?: (t: TraceSummary) => void;
  running?: Map<string, RunningRun>;
  onOpen: (t: TraceSummary, index: number) => void;
  active?: number;
  showThread?: boolean;
  indexOffset?: number;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] border-separate border-spacing-0">
        <thead>
          <tr>
            {onToggle && <th className={`${th} w-8 pl-3 pr-0`} aria-label="Select" />}
            <th className={`${th} w-8 pl-3 pr-0`} aria-label="Status" />
            <th className={th}>Trace</th>
            {showThread && <th className={th}>Thread</th>}
            <th className={`${th} text-right`}>Started</th>
            <th className={`${th} text-right`}>Duration</th>
            <th className={`${th} text-right`}>Calls</th>
            <th className={`${th} text-right`}>Tokens</th>
            <th className={`${th} pr-4 text-right`}>Cost</th>
          </tr>
        </thead>
        <tbody>
          {items.map((t, i) => {
            const idx = i + indexOffset;
            const failed = t.error_count > 0;
            const live = running?.get(t.trace_id);
            // While the root is still open, the list only knows finished children — show the run's real name.
            const name = live ? live.name : t.name;
            const kind = live ? live.kind : t.kind;
            return (
              <tr key={t.trace_id} data-row-index={idx} onClick={() => onOpen(t, idx)} className={rowCls(idx === active)}>
                {onToggle && (
                  <td className={`${td} pl-3 pr-0`} onClick={(e) => { e.stopPropagation(); onToggle(t); }}>
                    <input type="checkbox" aria-label="Select run" className="accent-[var(--accent)]" checked={selected?.has(t.trace_id) ?? false} readOnly />
                  </td>
                )}
                <td className={`${td} pl-3 pr-0`}><StatusMark errors={t.error_count} /></td>
                <td className={`${td} max-w-0 w-[52%]`}>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <KindIcon kind={kind} size={13} />
                    <span className="truncate font-medium text-ink">{name}</span>
                    {t.agent_name && t.agent_name !== name && <span className="truncate text-ink-3">{t.agent_name}</span>}
                  </div>
                  {failed && t.error_message ? (
                    <p className="mt-0.5 truncate font-mono text-[11.5px] text-critical">{t.error_message}</p>
                  ) : (t.input_text || t.output_text) ? (
                    <p className="mt-0.5 truncate text-[12px] text-ink-3">
                      {t.input_text && <span className="text-ink-2">{t.input_text}</span>}
                      {t.input_text && t.output_text && <span className="px-1.5">→</span>}
                      {t.output_text}
                    </p>
                  ) : null}
                </td>
                {showThread && (
                  <td className={`${td} max-w-40 truncate font-mono text-[12px] text-ink-3`}>
                    {t.thread_id ? shortId(t.thread_id, 14) : "—"}
                  </td>
                )}
                <td className={`${td} text-right text-ink-2`}>
                  {live ? <RunningLabel run={live} /> : <Time value={t.start_time} />}
                </td>
                <td className={`${td} num text-right text-ink-2`}>{fmtDuration(t.duration_ms)}</td>
                <td className={`${td} num whitespace-nowrap text-right text-ink-3`} title={`${t.llm_calls} LLM calls · ${t.tool_calls} tool calls`}>
                  {t.llm_calls}<span className="px-0.5 text-ink-3/60">/</span>{t.tool_calls}
                </td>
                <td className={`${td} num text-right text-ink-2`}>{fmtNum(t.input_tokens + t.output_tokens)}</td>
                <td className={`${td} num pr-4 text-right text-ink`}>{fmtCost(t.cost_usd)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
