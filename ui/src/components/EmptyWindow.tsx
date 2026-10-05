import { parseTime, timeAgo } from "../lib/format";
import { useAppState, useLatest } from "../lib/state";
import { Empty } from "./ui";

/** Empty state that says *why* it's empty: filters, a quiet window, or no data at all. */
export function EmptyWindow({ what, filtered, onClear }: { what: string; filtered?: boolean; onClear?: () => void }) {
  const { rangeLabel, setRange, window: win } = useAppState();
  const latest = useLatest();
  const last = latest.data?.last_seen;

  if (filtered) {
    return <Empty title={`No ${what} match these filters`} hint={rangeLabel}
      action={onClear && <button onClick={onClear} className="text-accent hover:underline">Clear filters</button>} />;
  }
  if (!last) {
    return <Empty title="Nothing recorded yet"
      hint={<>Point an app at this server — <code className="font-mono text-[12px]">hm.init(service="my-app", endpoint="http://localhost:8300")</code>. LangChain and LangGraph runs are traced automatically.</>} />;
  }
  const lastT = parseTime(last).getTime();
  const before = lastT < new Date(win.start).getTime();
  const span = Date.now() - lastT;
  const suggest = span < 86_400_000 ? "24h" : span < 7 * 86_400_000 ? "7d" : "30d";
  return (
    <Empty title={`No ${what} in ${rangeLabel.toLowerCase()}`}
      hint={before ? `The latest trace arrived ${timeAgo(last)}.` : undefined}
      action={before && (
        <button onClick={() => setRange({ kind: "preset", id: suggest })} className="text-accent hover:underline">
          Show the last {suggest === "24h" ? "24 hours" : suggest === "7d" ? "7 days" : "30 days"}
        </button>
      )} />
  );
}
