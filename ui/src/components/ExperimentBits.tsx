import { useQuery } from "@tanstack/react-query";
import { api, type Better, type ExperimentJob, type Runner, type Verdict } from "../lib/api";

export const VERDICT_ORDER: Verdict[] = ["match", "partial", "diverged", "failed"];
// Behaviour vs the original — neutral greys: "different" is not "worse".
const BAR: Record<Verdict, string> = { match: "bg-ink-3", partial: "bg-ink-3/55", diverged: "bg-ink-3/25", failed: "bg-critical" };
const LABEL: Record<Verdict, string> = { match: "same", partial: "partly different", diverged: "different", failed: "failed" };

export type VerdictCounts = Record<Verdict, number>;

/** Stacked bar of how a variant's replays compared with the originals; grey track = still to come. */
export function VerdictBar({ counts, total, className = "" }: { counts: VerdictCounts; total: number; className?: string }) {
  return (
    <div className={`flex h-2 overflow-hidden rounded-full bg-subtle ${className}`}>
      {VERDICT_ORDER.map((v) => counts[v] > 0 && (
        <span key={v} className={BAR[v]} style={{ width: `${(counts[v] / Math.max(total, 1)) * 100}%` }} title={`${counts[v]} ${LABEL[v]}`} />
      ))}
    </div>
  );
}

export function VerdictLegend({ counts, pending = 0 }: { counts: VerdictCounts; pending?: number }) {
  return (
    <span className="num inline-flex flex-wrap gap-x-2.5 text-[11.5px] text-ink-3">
      {VERDICT_ORDER.filter((v) => counts[v]).map((v) => (
        <span key={v} className="inline-flex items-center gap-1"><span className={`size-1.5 rounded-full ${BAR[v]}`} />{counts[v]} {LABEL[v]}</span>
      ))}
      {pending > 0 && <span>{pending} to go</span>}
    </span>
  );
}

/** "67%" — whole percents read cleaner for a handful of replays. */
export function fmtRate(r: number): string {
  return `${Math.round(r * 100)}%`;
}

/** Cost of a run; 0 means the model has no known price, not that it was free. */
export function fmtRunCost(usd: number | null | undefined, fmt: (n: number) => string): string {
  return usd ? fmt(usd) : "not priced";
}

/** Share of replays that matched the original — the headline number for a variant. */
export function matchRate(c: VerdictCounts): number | null {
  const n = VERDICT_ORDER.reduce((a, v) => a + c[v], 0);
  return n ? c.match / n : null;
}

/** Best variant: most matches, then partial matches, then cheapest. Only once it has results. */
export function bestOf<T extends { name: string; counts: VerdictCounts; cost: number | null }>(rows: T[]): string | null {
  const scored = rows.filter((r) => matchRate(r.counts) != null);
  if (scored.length < 2) return null;
  const key = (r: T) => [matchRate(r.counts)!, r.counts.partial / Math.max(1, VERDICT_ORDER.reduce((a, v) => a + r.counts[v], 0)), -(r.cost ?? Infinity)];
  const sorted = [...scored].sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
    return 0;
  });
  return sorted[0].name;
}

export type Connection = "ready" | "waiting" | "offline";

/** Whether the project's app can run experiments right now. */
export function useConnection(project: string, agent?: string) {
  const runners = useQuery({ queryKey: ["runners", project], queryFn: () => api<Runner[]>("/api/runners", { project }), refetchInterval: 5000 });
  const mine = (runners.data ?? []).filter((r) => !agent || r.agents.some((a) => a.name === agent));
  const state: Connection = mine.some((r) => r.ready !== false) ? "ready" : mine.length ? "waiting" : "offline";
  return { state, runners: mine, loading: runners.isPending };
}

const CONN: Record<Connection, { dot: string; title: string; hint: React.ReactNode }> = {
  ready: { dot: "bg-good", title: "App connected", hint: "Experiments run as soon as you start them." },
  waiting: { dot: "bg-[#eda100]", title: "App connected — waiting for its first run",
             hint: "The app hasn't run this agent since it started. Queued replays begin after its next run." },
  offline: { dot: "bg-ink-3/50", title: "App not connected for experiments",
             hint: <>Add <span className="font-mono text-ink">IMAGENT_EXPERIMENTS=true</span> to the app's .env and restart it. You can still set experiments up — they wait in the queue.</> },
};

export function ConnectionBanner({ state, hosts, compact = false }: { state: Connection; hosts?: string[]; compact?: boolean }) {
  const c = CONN[state];
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line px-3.5 ${compact ? "py-2" : "py-2.5"} text-[12.5px]`}>
      <span className="inline-flex items-center gap-2 font-medium"><span className={`size-2 rounded-full ${c.dot}`} />{c.title}</span>
      <span className="text-ink-3">{c.hint}</span>
      {hosts && hosts.length > 0 && <span className="ml-auto font-mono text-[11.5px] text-ink-3">{hosts.join(", ")}</span>}
    </div>
  );
}


// ── answer quality: is the replay's answer better than the original's? ──────────
export type QualityCounts = Record<Better, number>;
const QBAR: Record<Better, string> = { new: "bg-good", tie: "bg-ink-3/40", original: "bg-critical" };
export const QLABEL: Record<Better, string> = { new: "better", tie: "tie", original: "worse" };

/** A person's review wins over the AI judge. */
export function quality(job: ExperimentJob): Better | null {
  return job.review?.better ?? job.judgement?.better ?? null;
}

export function qualityCounts(jobs: ExperimentJob[]): QualityCounts {
  const c: QualityCounts = { new: 0, tie: 0, original: 0 };
  for (const j of jobs) {
    const q = quality(j);
    if (q) c[q] += 1;
  }
  return c;
}

export function QualityBar({ counts, total, className = "" }: { counts: QualityCounts; total: number; className?: string }) {
  return (
    <div className={`flex h-2 overflow-hidden rounded-full bg-subtle ${className}`}>
      {(["new", "tie", "original"] as Better[]).map((b) => counts[b] > 0 && (
        <span key={b} className={QBAR[b]} style={{ width: `${(counts[b] / Math.max(total, 1)) * 100}%` }} title={`${counts[b]} ${QLABEL[b]}`} />
      ))}
    </div>
  );
}

export function QualityLegend({ counts }: { counts: QualityCounts }) {
  return (
    <span className="num inline-flex flex-wrap gap-x-2.5 text-[11.5px] text-ink-3">
      {(["new", "tie", "original"] as Better[]).map((b) => (
        <span key={b} className="inline-flex items-center gap-1"><span className={`size-1.5 rounded-full ${QBAR[b]}`} />{counts[b]} {QLABEL[b]}</span>
      ))}
    </span>
  );
}

/** Net wins per judged replay, −1…1 (better − worse) / judged. */
export function netScore(c: QualityCounts): number | null {
  const n = c.new + c.tie + c.original;
  return n ? (c.new - c.original) / n : null;
}

/** Best variant by answer quality: most net wins, then cheapest. None until answers are judged;
 *  a lone variant is "best" only if it beats the original. */
export function bestByQuality<T extends { name: string; quality: QualityCounts; cost: number | null }>(rows: T[]): string | null {
  const judged = rows.filter((r) => netScore(r.quality) != null);
  if (!judged.length) return null;
  const top = [...judged].sort((a, b) => (netScore(b.quality)! - netScore(a.quality)!) || ((a.cost ?? Infinity) - (b.cost ?? Infinity)))[0];
  return rows.length === 1 && netScore(top.quality)! <= 0 ? null : top.name;
}
