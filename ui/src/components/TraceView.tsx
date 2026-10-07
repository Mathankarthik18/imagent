import { useQuery } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { api, type Span } from "../lib/api";
import { fmtCost, fmtDuration, fmtNum, parseTime } from "../lib/format";
import { useHotkey } from "../lib/keys";
import { FlowView } from "./FlowView";
import { NowPlaying, PlayerBar, usePlayer } from "./Replay";
import { SpanTree } from "./SpanTree";
import { StepsTree } from "./StepsTree";
import { LiveDot } from "./Live";
import { SpanPanel } from "./SpanPanel";
import { Split } from "./Split";
import { ErrorBox, Panel, Spinner } from "./ui";

export function useTrace(traceId: string) {
  return useQuery({
    queryKey: ["trace", traceId],
    queryFn: () => api<{ trace_id: string; spans: Span[]; running?: boolean }>(`/api/traces/${traceId}`),
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === traceId ? prev : undefined),
    refetchInterval: (query) => (query.state.data?.running ? 3_000 : false),
  });
}

const EMPTY: Span[] = [];

export function traceStats(spans: Span[]) {
  const ids = new Set(spans.map((s) => s.span_id));
  const root = spans.find((s) => !ids.has(s.parent_span_id)) ?? spans[0];
  const starts = spans.map((s) => parseTime(s.start_time).getTime());
  const t0 = Math.min(...starts);
  const running = spans.some((s) => s.status === "running");
  const t1 = running ? Date.now() : Math.max(...spans.map((s, i) => starts[i] + s.duration_ms));
  return {
    root,
    running,
    duration: Math.max(t1 - t0, 0),
    cost: spans.reduce((a, s) => a + s.cost_usd, 0),
    tokens: spans.reduce((a, s) => a + s.input_tokens + s.output_tokens, 0),
    llm: spans.filter((s) => s.kind === "llm").length,
    tools: spans.filter((s) => s.kind === "tool").length,
    failed: spans.filter((s) => s.status === "error").length,
  };
}

/** Span tree + details for one trace. `[` / `]` step through spans. */
export function TraceView({ traceId, selected, onSelect, splitId = "trace", height = "calc(100vh - 196px)" }: {
  traceId: string; selected: string | null; onSelect: (spanId: string) => void; splitId?: string; height?: string;
}) {
  const q = useTrace(traceId);
  const player = usePlayer(q.data?.spans ?? EMPTY);
  const [main, setMain] = useState<"flow" | "steps">("flow");
  // Space toggles play/pause while replaying.
  useHotkey(" ", (e) => { if (player.on) { e.preventDefault(); if (player.playing) player.pause(); else player.play(); } });
  const order = useRef<string[]>([]);
  const setOrder = useCallback((ids: string[]) => { order.current = ids; }, []);

  const spans = q.data?.spans ?? [];
  const stats = spans.length ? traceStats(spans) : null;
  const current = selected && spans.some((s) => s.span_id === selected) ? selected : stats?.root?.span_id ?? null;

  const step = (dir: 1 | -1) => {
    const ids = order.current;
    if (!ids.length) return;
    const i = current ? ids.indexOf(current) : -1;
    onSelect(ids[Math.min(Math.max(i + dir, 0), ids.length - 1)]);
  };
  useHotkey("]", () => step(1));
  useHotkey("[", () => step(-1));

  if (q.isError) return <ErrorBox error={q.error} />;
  if (q.isPending || !stats) return <Spinner />;
  const span = spans.find((s) => s.span_id === current) ?? spans[0];

  return (
    <div className="space-y-3">
      <div className="num flex flex-wrap items-center gap-x-5 gap-y-1 text-[12.5px] text-ink-3">
        {!player.on && (
          <button onClick={() => { setMain("flow"); player.start(); }} title="Play the run back as it happened"
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-ink px-2.5 text-[12px] font-medium text-bg">▶ Replay</button>
        )}
        <span><span className="text-ink">{fmtDuration(stats.duration)}</span> {stats.running ? "so far" : "total"}</span>
        <span><span className="text-ink">{spans.length}</span> spans</span>
        <span><span className="text-ink">{stats.llm}</span> LLM · <span className="text-ink">{stats.tools}</span> tool calls</span>
        <span><span className="text-ink">{fmtNum(stats.tokens)}</span> tokens</span>
        <span><span className="text-ink">{fmtCost(stats.cost)}</span></span>
        {stats.running && <span className="inline-flex items-center gap-1.5 text-accent"><LiveDot /> running · updates every 3s</span>}
        {stats.failed > 0 && <span className="text-critical">{stats.failed} failed span{stats.failed > 1 ? "s" : ""}</span>}
        <span className="ml-auto hidden lg:inline"><kbd>[</kbd> <kbd>]</kbd> step through</span>
      </div>
      <Split id={`${splitId}-flow`} initial={56}
        height={player.on ? `calc(${height} - 66px)` : height}
        left={<Panel className="flex h-full flex-col overflow-hidden">
          {main === "steps" && !player.on ? (
            <>
              <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
                <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">Steps</span>
                <span className="text-[12px] text-ink-3">· full tree with timings</span>
                <button onClick={() => setMain("flow")} className="ml-auto rounded px-2 py-0.5 text-[12px] text-ink-2 hover:bg-subtle hover:text-ink">← Back to flow</button>
              </div>
              <div className="min-h-0 flex-1"><SpanTree spans={spans} selectedId={span.span_id} onSelect={(s) => onSelect(s.span_id)} onOrder={setOrder} /></div>
            </>
          ) : <FlowView spans={spans} selectedId={span.span_id} onSelect={(s) => onSelect(s.span_id)} player={player} />}
        </Panel>}
        right={player.on ? <NowPlaying player={player} spans={spans} /> : main === "steps" ? <SpanPanel span={span} /> : (
          <div className="flex h-full min-h-0 flex-col gap-3">
            <div className="min-h-0 flex-1"><SpanPanel span={span} /></div>
            <Panel className="h-[36%] min-h-[160px] shrink-0 overflow-hidden">
              <StepsTree spans={spans} selectedId={span.span_id} onSelect={(s) => onSelect(s.span_id)} onOrder={setOrder} onExpand={() => setMain("steps")} />
            </Panel>
          </div>
        )} />
      {player.on && <PlayerBar player={player} />}
    </div>
  );
}
