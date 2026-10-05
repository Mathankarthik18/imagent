import { useQuery } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";

export const RANGES = [
  { id: "15m", label: "Last 15 minutes", short: "15m", ms: 15 * 60_000 },
  { id: "1h", label: "Last hour", short: "1h", ms: 3_600_000 },
  { id: "6h", label: "Last 6 hours", short: "6h", ms: 6 * 3_600_000 },
  { id: "24h", label: "Last 24 hours", short: "24h", ms: 86_400_000 },
  { id: "7d", label: "Last 7 days", short: "7d", ms: 7 * 86_400_000 },
  { id: "30d", label: "Last 30 days", short: "30d", ms: 30 * 86_400_000 },
] as const;
export type PresetId = (typeof RANGES)[number]["id"];
export type Range = { kind: "preset"; id: PresetId } | { kind: "custom"; start: string; end: string };
export type Theme = "light" | "dark";
export type TimeMode = "relative" | "absolute";

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

interface AppState {
  project: string;
  setProject: (p: string) => void;
  range: Range;
  setRange: (r: Range) => void;
  tick: number;
  refresh: () => void;
  autoRefresh: boolean;
  setAutoRefresh: (v: boolean) => void;
  theme: Theme;
  toggleTheme: () => void;
  timeMode: TimeMode;
  toggleTimeMode: () => void;
  window: { start: string; end: string };
  rangeLabel: string;
}

const Ctx = createContext<AppState | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [project, setProjectRaw] = useState<string>(() => load("imagent.project.v2", ""));
  const [range, setRangeRaw] = useState<Range>(() => load<Range>("imagent.range.v2", { kind: "preset", id: "24h" }));
  const [tick, setTick] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [timeMode, setTimeMode] = useState<TimeMode>(() => load<TimeMode>("imagent.timeMode", "relative"));
  const [theme, setTheme] = useState<Theme>(() =>
    load<Theme | "">("imagent.theme.v2", "") || (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (!autoRefresh || range.kind === "custom") return;
    const id = setInterval(() => setTick((t) => t + 1), 15_000);
    return () => clearInterval(id);
  }, [autoRefresh, range.kind]);

  const setProject = useCallback((p: string) => {
    setProjectRaw(p);
    save("imagent.project.v2", p);
  }, []);
  const setRange = useCallback((r: Range) => {
    setRangeRaw(r);
    save("imagent.range.v2", r);
    setTick((t) => t + 1);
  }, []);
  const toggleTheme = useCallback(() => setTheme((t) => {
    const next = t === "dark" ? "light" : "dark";
    save("imagent.theme.v2", next);
    return next;
  }), []);
  const toggleTimeMode = useCallback(() => setTimeMode((m) => {
    const next = m === "relative" ? "absolute" : "relative";
    save("imagent.timeMode", next);
    return next;
  }), []);

  const win = useMemo(() => {
    if (range.kind === "custom") return { start: range.start, end: range.end };
    const ms = RANGES.find((r) => r.id === range.id)?.ms ?? 86_400_000;
    const end = new Date();
    return { start: new Date(end.getTime() - ms).toISOString(), end: end.toISOString() };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, tick]);

  const rangeLabel = range.kind === "custom"
    ? `${new Date(range.start).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} – ${new Date(range.end).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
    : RANGES.find((r) => r.id === range.id)?.label ?? "Last 24 hours";

  const value: AppState = {
    project, setProject, range, setRange, tick, refresh: () => setTick((t) => t + 1), autoRefresh, setAutoRefresh,
    theme, toggleTheme, timeMode, toggleTimeMode, window: win, rangeLabel,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppState(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAppState outside provider");
  return v;
}

export function useBaseParams() {
  const { project, window } = useAppState();
  return { project: project || undefined, start: window.start, end: window.end };
}

/** Newest span for the current project — distinguishes "empty window" from "no data / server down". */
export function useLatest() {
  const { project, tick } = useAppState();
  return useQuery({
    queryKey: ["latest", project, tick],
    queryFn: () => api<{ last_seen: string | null }>("/api/latest", { project: project || undefined }),
    refetchInterval: 30_000,
  });
}
