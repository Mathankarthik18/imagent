import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type RunningRun } from "./api";
import { parseTime } from "./format";
import { useAppState } from "./state";

/** Runs in progress for the current project; polls fast while anything is running. */
export function useRunning() {
  const { project } = useAppState();
  const q = useQuery({
    queryKey: ["running", project],
    queryFn: () => api<{ runs: RunningRun[]; server_time: string }>("/api/running", { project: project || undefined }),
    refetchInterval: (query) => ((query.state.data?.runs.length ?? 0) > 0 ? 3_000 : 10_000),
    placeholderData: (prev) => prev,
  });
  const runs = q.data?.runs ?? [];
  return {
    runs,
    byTrace: new Map(runs.map((r) => [r.trace_id, r])),
    byThread: new Map(runs.filter((r) => r.thread_id).map((r) => [r.thread_id, r])),
  };
}

/** Re-render every `ms` while enabled — drives ticking elapsed timers. */
export function useNow(enabled = true, ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [enabled, ms]);
  return now;
}

export function elapsed(fromIso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - parseTime(fromIso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}:${String(s % 60).padStart(2, "0")}`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
