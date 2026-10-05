import { fmtTime, parseTime, timeAgo } from "../lib/format";
import { useAppState } from "../lib/state";

/** A timestamp that follows the global relative/absolute setting; click flips it. */
export function Time({ value, className = "" }: { value: string; className?: string }) {
  const { timeMode, toggleTimeMode } = useAppState();
  if (!value) return <span className="text-ink-3">—</span>;
  const abs = fmtTime(value);
  const rel = timeAgo(value);
  return (
    <time dateTime={parseTime(value).toISOString()} title={timeMode === "relative" ? abs : rel}
      onClick={(e) => { e.stopPropagation(); toggleTimeMode(); }}
      className={`num cursor-default whitespace-nowrap ${className}`}>
      {timeMode === "relative" ? rel : abs}
    </time>
  );
}
