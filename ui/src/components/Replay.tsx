import { useCallback, useEffect, useMemo, useState } from "react";
import type { Span } from "../lib/api";
import { turnOutput } from "../lib/conversation";
import { fmtCost, fmtDuration, fmtNum, parseTime } from "../lib/format";
import { KindIcon } from "./icons";
import { LiveDot } from "./Live";
import { Markdown } from "./Markdown";
import { PayloadView } from "./Payload";
import { StepsTree } from "./StepsTree";
import { useTrace } from "./TraceView";
import { Panel, Spinner } from "./ui";

/** The span fields playback needs (full spans and the thread endpoint's lite spans both fit). */
export type PlaySpan = Pick<Span, "span_id" | "parent_span_id" | "trace_id" | "name" | "kind" | "status" | "start_time" |
  "duration_ms" | "model" | "input_tokens" | "output_tokens" | "cost_usd">;

export type Phase = "pending" | "running" | "done";

const ts = (s: PlaySpan) => parseTime(s.start_time).getTime();
const IGNORED = new Set(["write_todos", "ls", "read_file", "write_file", "edit_file", "glob", "grep"]);

/** One "chapter" of the run: an LLM call or tool call, with the agent it happened in. */
export interface Chapter {
  span: PlaySpan;
  at: number;      // ms from run start
  end: number;
  agent: string;   // agent / sub-agent it ran in
  depth: number;   // 0 = main agent, 1 = sub-agent, …
}

export interface Player {
  on: boolean;
  playing: boolean;
  t: number;              // ms since run start
  dur: number;
  t0: number;             // epoch ms of run start
  vnow: number;           // epoch ms at playback position
  speed: number | "auto";
  follow: boolean;
  chapters: Chapter[];
  current: Chapter | undefined;
  phaseOf: (s: PlaySpan) => Phase;
  start: () => void;
  play: () => void;
  pause: () => void;
  seek: (t: number) => void;
  setSpeed: (s: number | "auto") => void;
  setFollow: (v: boolean) => void;
  close: () => void;
}

/** Playback clock for a run: mimics it from recorded timestamps (nothing re-executes). */
export function usePlayer(spans: PlaySpan[]): Player {
  const meta = useMemo(() => {
    const byId = new Map(spans.map((s) => [s.span_id, s]));
    const starts = spans.map(ts);
    const t0 = spans.length ? Math.min(...starts) : 0;
    const t1 = spans.length ? Math.max(...spans.map((s, i) => (s.status === "running" ? Date.now() : starts[i] + s.duration_ms))) : 0;
    const agentOf = (s: PlaySpan): { name: string; depth: number } => {
      let depth = 0;
      let name = "";
      let cur = byId.get(s.parent_span_id);
      for (let hops = 0; cur && hops < 200; hops++) {
        const parent = byId.get(cur.parent_span_id);
        const isAgent = cur.kind === "agent" || (cur.kind === "chain" && parent?.kind === "tool");
        if (isAgent && !cur.name.startsWith("replay:")) {
          if (!name) name = cur.name;
          depth++;
        }
        cur = parent;
      }
      return { name, depth: Math.max(depth - 1, 0) };
    };
    const chapters: Chapter[] = spans
      .filter((s) => (s.kind === "llm" || s.kind === "tool") && !IGNORED.has(s.name))
      .map((s) => {
        const a = agentOf(s);
        const at = ts(s) - t0;
        return { span: s, at, end: at + Math.max(s.duration_ms, 1), agent: a.name, depth: a.depth };
      })
      .sort((a, b) => a.at - b.at);
    return { t0, dur: Math.max(t1 - t0, 1), chapters };
  }, [spans]);

  const [on, setOn] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [speed, setSpeed] = useState<number | "auto">("auto");
  const [follow, setFollow] = useState(true);
  const rate = speed === "auto" ? Math.max(1, meta.dur / 20_000) : speed;

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (nowMs: number) => {
      const dt = nowMs - last;
      last = nowMs;
      setT((x) => {
        const nt = Math.min(meta.dur, x + dt * rate);
        if (nt >= meta.dur) setPlaying(false);
        return nt;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, rate, meta.dur]);

  const vnow = meta.t0 + t;
  const phaseOf = useCallback((s: PlaySpan): Phase => {
    const st = ts(s);
    const en = s.status === "running" ? Infinity : st + s.duration_ms;
    return vnow < st ? "pending" : vnow < en ? "running" : "done";
  }, [vnow]);
  const current = on
    ? [...meta.chapters].reverse().find((c) => c.at <= t && t < c.end) ?? [...meta.chapters].reverse().find((c) => c.at <= t)
    : undefined;

  return {
    on, playing, t, dur: meta.dur, t0: meta.t0, vnow, speed, follow, chapters: meta.chapters, current, phaseOf,
    start: () => { setOn(true); setT(0); setPlaying(true); },
    play: () => { if (t >= meta.dur) setT(0); setPlaying(true); },
    pause: () => setPlaying(false),
    seek: (x) => setT(Math.max(0, Math.min(meta.dur, x))),
    setSpeed, setFollow,
    close: () => { setOn(false); setPlaying(false); },
  };
}

/** Close markdown markers left open by a partially typed string, so it renders cleanly. */
function balanceMarkdown(text: string): string {
  let out = text;
  if ((out.match(/```/g) ?? []).length % 2) out += "\n```";
  else if ((out.replace(/```/g, "").match(/`/g) ?? []).length % 2) out += "`";
  if ((out.match(/\*\*/g) ?? []).length % 2) out += "**";
  return out;
}

function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Docked timeline: transport controls + scrubber with one segment per step ("chapters"). */
export function PlayerBar({ player: p }: { player: Player }) {
  return (
    <div className="flex h-14 items-center gap-3 rounded-lg border border-line bg-panel px-3">
      <button onClick={p.playing ? p.pause : p.play} title={p.playing ? "Pause (space)" : "Play (space)"}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-ink text-[12px] text-bg">{p.playing ? "❚❚" : "▶"}</button>
      <button onClick={() => { p.seek(0); p.play(); }} title="Restart" className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-subtle">⟲</button>
      <span className="num w-[92px] shrink-0 text-[12.5px] text-ink">{clock(p.t)} <span className="text-ink-3">/ {clock(p.dur)}</span></span>
      <div className="relative h-8 min-w-0 flex-1">
        {/* chapter segments */}
        <div className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 overflow-hidden rounded-full bg-subtle">
          {p.chapters.map((c) => (
            <span key={c.span.span_id} className={`absolute inset-y-0 ${c.span.kind === "llm" ? "bg-[#1baf7a]" : "bg-[#eb6834]"} ${p.t >= c.at ? "opacity-90" : "opacity-30"}`}
              style={{ left: `${(c.at / p.dur) * 100}%`, width: `max(2px, ${((c.end - c.at) / p.dur) * 100}%)` }} />
          ))}
        </div>
        <div className="pointer-events-none absolute left-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-accent/25" style={{ width: `${(p.t / p.dur) * 100}%` }} />
        <input type="range" min={0} max={p.dur} step={Math.max(p.dur / 2000, 1)} value={p.t} onChange={(e) => p.seek(Number(e.target.value))}
          aria-label="Playback position" className="absolute inset-0 w-full cursor-pointer opacity-0" />
        <span className="pointer-events-none absolute top-1/2 h-5 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent shadow-[0_0_0_3px_var(--accent-soft)]"
          style={{ left: `${(p.t / p.dur) * 100}%` }} />
      </div>
      <select value={String(p.speed)} onChange={(e) => p.setSpeed(e.target.value === "auto" ? "auto" : Number(e.target.value))}
        className="ghost h-7 shrink-0 rounded-md border border-line bg-bg px-2 text-[12px] text-ink-2" aria-label="Playback speed">
        <option value="auto">Auto · ~20s</option>
        {[1, 2, 5, 10, 30].map((x) => <option key={x} value={x}>{x}×</option>)}
      </select>
      <label className="inline-flex shrink-0 items-center gap-1.5 text-[12px] text-ink-2" title="Keep the canvas and card on the current step">
        <input type="checkbox" className="accent-[var(--accent)]" checked={p.follow} onChange={(e) => p.setFollow(e.target.checked)} /> Follow
      </label>
      <button onClick={p.close} className="h-7 shrink-0 rounded-md px-2 text-[12px] text-ink-3 hover:bg-subtle hover:text-ink">Exit replay</button>
    </div>
  );
}

function outputParts(raw: string): { text: string; calls: { name: string; args: string }[] } {
  if (!raw) return { text: "", calls: [] };
  try {
    const v = JSON.parse(raw);
    if (typeof v === "string") return { text: v, calls: [] };
    if (v && typeof v === "object" && !Array.isArray(v) && !Array.isArray(v.messages)) {
      const c = v.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((b: { text?: string }) => b?.text ?? "").join("\n") : "";
      const calls = Array.isArray(v.tool_calls) ? v.tool_calls.map((tc: { name?: string; args?: unknown }) => ({
        name: tc.name ?? "tool", args: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args ?? {}, null, 1) })) : [];
      return { text, calls };
    }
    return { text: turnOutput(raw).text, calls: [] };
  } catch {
    return { text: raw, calls: [] };
  }
}

function inputSummary(raw: string, kind: string): string {
  if (!raw) return "not captured";
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) {
      const sys = v.filter((m) => m?.role === "system").length;
      return `${sys ? "system prompt + " : ""}${v.length - sys} message${v.length - sys === 1 ? "" : "s"} · ${fmtNum(raw.length)} chars`;
    }
    if (kind === "tool" && v && typeof v === "object") {
      return Object.entries(v).map(([k, x]) => `${k}: ${typeof x === "string" ? x : JSON.stringify(x)}`).join(" · ").slice(0, 140) || "no arguments";
    }
  } catch {
    /* truncated capture */
  }
  return `${fmtNum(raw.length)} chars`;
}

/** Right-hand card while replaying: the current step, output first (typing), then the step list. */
export function NowPlaying({ player: p, spans }: { player: Player; spans: PlaySpan[] }) {
  const cur = p.current;
  const trace = useTrace(cur?.span.trace_id ?? "");
  const full = trace.data?.spans.find((s) => s.span_id === cur?.span.span_id);
  const [showInput, setShowInput] = useState(false);

  const phase = cur ? p.phaseOf(cur.span) : "pending";
  const elapsedMs = cur ? Math.min(Math.max(p.t - cur.at, 0), cur.span.duration_ms) : 0;
  const progress = cur ? Math.min(1, elapsedMs / Math.max(cur.span.duration_ms, 1)) : 0;
  const out = full ? outputParts(full.output) : { text: "", calls: [] };
  const typed = phase === "running" ? balanceMarkdown(out.text.slice(0, Math.floor(out.text.length * progress))) : out.text;

  return (
    <Panel className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-line px-4 pb-3 pt-3">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">Now playing</div>
        {cur ? (
          <>
            <div className="mt-1.5 flex min-w-0 items-center gap-2">
              <KindIcon kind={cur.span.kind} size={16} />
              <span className="truncate text-[14px] font-semibold">{cur.span.kind === "llm" ? cur.span.model || cur.span.name : cur.span.name}</span>
              <span className="ml-auto shrink-0">
                {phase === "running"
                  ? <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-accent"><LiveDot /> {fmtDuration(elapsedMs)} / {fmtDuration(cur.span.duration_ms)}</span>
                  : <span className="text-[12px] text-ink-3">✓ {fmtDuration(cur.span.duration_ms)}</span>}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[12px] text-ink-3">
              <span>{cur.span.kind === "llm" ? "LLM call" : "Tool call"} in <span className={cur.depth ? "text-[#4a3aa7] dark:text-[#b8b0f2]" : "text-[#2a78d6] dark:text-[#6da7ec]"}>{cur.agent || "agent"}</span>{cur.depth ? " (sub-agent)" : ""}</span>
              {cur.span.kind === "llm" && cur.span.input_tokens + cur.span.output_tokens > 0 && (
                <span className="num">{fmtNum(cur.span.input_tokens)} in · {fmtNum(cur.span.output_tokens)} out · {fmtCost(cur.span.cost_usd)}</span>
              )}
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-subtle">
              <div className="h-full rounded-full bg-accent" style={{ width: `${progress * 100}%` }} />
            </div>
          </>
        ) : <p className="mt-1.5 text-ink-3">Press play — steps appear here as they happen.</p>}
      </div>

      {cur && (
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          <div className="mb-1.5 text-[12px] font-medium text-ink-3">Output</div>
          {!full ? <Spinner label="Loading step" /> : (
            <div className="space-y-2">
              {typed ? (
                <div className="rounded-lg border border-line px-3 py-2.5 text-[13.5px]">
                  <Markdown text={typed} />
                  {phase === "running" && <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-accent" />}
                </div>
              ) : phase === "running" && !out.calls.length ? (
                <p className="text-ink-3">{cur.span.kind === "llm" ? "Thinking…" : "Running…"}</p>
              ) : null}
              {out.calls.map((c, i) => {
                const reveal = phase === "running" ? Math.max(0, progress * (out.calls.length + 1) - i) : 1;
                if (reveal <= 0) return null;
                return (
                  <div key={i} className="rounded-lg bg-subtle px-3 py-2">
                    <div className="font-mono text-[12px] text-[#c2541f] dark:text-[#ef9a6e]">→ calls {c.name}()</div>
                    <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11.5px] text-ink-2">
                      {c.args.slice(0, Math.floor(c.args.length * Math.min(1, reveal)))}
                    </pre>
                  </div>
                );
              })}
              {!typed && !out.calls.length && phase !== "running" && <p className="text-ink-3">No output captured.</p>}
            </div>
          )}

          {full && (
            <div className="mt-4">
              <button onClick={() => setShowInput((v) => !v)} className="flex w-full items-center gap-1.5 text-left text-[12px] text-ink-3 hover:text-ink">
                <span className={`inline-block transition-transform ${showInput ? "rotate-90" : ""}`}>▸</span>
                Input <span className="truncate font-normal">· {inputSummary(full.input, full.kind)}</span>
              </button>
              {showInput && <div className="mt-2"><PayloadView raw={full.input} /></div>}
            </div>
          )}
        </div>
      )}

      <div className="h-[42%] min-h-[180px] shrink-0 border-t border-line">
        <StepsTree spans={spans} player={p} />
      </div>
    </Panel>
  );
}
