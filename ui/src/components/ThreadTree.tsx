import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useHotkey } from "../lib/keys";
import { FlowView } from "./FlowView";
import { NowPlaying, PlayerBar, usePlayer, type PlaySpan } from "./Replay";
import { SpanPanel } from "./SpanPanel";
import { SpanTree, type TreeSpan } from "./SpanTree";
import { StepsTree } from "./StepsTree";
import { Split } from "./Split";
import { useTrace } from "./TraceView";
import { Empty, ErrorBox, Panel, Spinner } from "./ui";

interface ThreadSpans {
  spans: TreeSpan[];
  truncated: boolean;
  running?: boolean;
}

const EMPTY: TreeSpan[] = [];

function useThreadSpans(threadId: string, project: string | undefined, tick?: number) {
  return useQuery({
    queryKey: ["thread-spans", threadId, project, tick],
    queryFn: () => api<ThreadSpans>(`/api/threads/${encodeURIComponent(threadId)}/spans`, { project }),
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === threadId ? prev : undefined),
    refetchInterval: (query) => (query.state.data?.running ? 3_000 : false),
  });
}

/** Every run of a thread in one tree, with the span inspector beside it. */
export function ThreadTreePanel({ threadId, project, tick, onOpenTrace, height = "calc(100vh - 120px)" }: {
  threadId: string; project?: string; tick?: number; onOpenTrace: (traceId: string) => void; height?: string;
}) {
  const q = useThreadSpans(threadId, project, tick);
  const [sel, setSel] = useState<TreeSpan | null>(null);
  const player = usePlayer((q.data?.spans ?? EMPTY) as PlaySpan[]);
  const [main, setMain] = useState<"flow" | "steps">("flow");
  const order = useRef<string[]>([]);
  const setOrder = useCallback((ids: string[]) => { order.current = ids; }, []);
  const spans = q.data?.spans ?? [];
  // Start on the latest run's root span so the inspector is never blank.
  useEffect(() => {
    if (sel || spans.length === 0) return;
    const ids = new Set(spans.map((s) => s.span_id));
    const roots = spans.filter((s) => !ids.has(s.parent_span_id));
    setSel(roots[roots.length - 1] ?? spans[0]);
  }, [spans, sel]);

  const step = (dir: 1 | -1) => {
    const ids = order.current;
    if (!ids.length) return;
    const i = sel ? ids.indexOf(sel.span_id) : -1;
    const next = spans.find((s) => s.span_id === ids[Math.min(Math.max(i + dir, 0), ids.length - 1)]);
    if (next) setSel(next);
  };
  useHotkey("]", () => step(1));
  useHotkey("[", () => step(-1));

  if (q.isError) return <ErrorBox error={q.error} />;
  if (q.isPending) return <Spinner />;
  if (spans.length === 0) return <Empty title="No spans recorded for this thread" />;

  return (
    <>
    <Split id="thread-flow" initial={56}
      height={player.on ? `calc(${height} - 66px)` : height}
      left={
        <Panel className="flex h-full flex-col overflow-hidden">
          <div className="flex shrink-0 items-center gap-3 border-b border-line px-3 py-1.5">
            {!player.on && (
              <button onClick={() => { setMain("flow"); player.start(); }} title="Play the thread back as it happened"
                className="inline-flex h-7 items-center rounded-md bg-ink px-2.5 text-[12px] font-medium text-bg">▶ Replay</button>
            )}
            {q.data.truncated && <span className="text-[12px] text-ink-3">Showing the first 5,000 spans.</span>}
            <span className="ml-auto hidden text-[11.5px] text-ink-3 lg:inline"><kbd>[</kbd> <kbd>]</kbd> step through</span>
          </div>
          {main === "steps" && !player.on && (
            <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3">
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">Steps</span>
              <span className="text-[12px] text-ink-3">· full tree with timings</span>
              <button onClick={() => setMain("flow")} className="ml-auto rounded px-2 py-0.5 text-[12px] text-ink-2 hover:bg-subtle hover:text-ink">← Back to flow</button>
            </div>
          )}
          <div className="min-h-0 flex-1">
            {main === "steps" && !player.on
              ? <SpanTree spans={spans} groupByTrace selectedId={sel?.span_id} onSelect={setSel} onOpenTrace={onOpenTrace} onOrder={setOrder} />
              : <FlowView spans={spans as never} selectedId={sel?.span_id} onSelect={(s) => setSel(s as TreeSpan)} player={player} />}
          </div>
        </Panel>
      }
      right={player.on ? <NowPlaying player={player} spans={spans as PlaySpan[]} /> : main === "steps" ? (
        sel ? <SelectedSpan traceId={sel.trace_id} spanId={sel.span_id} /> : <Panel className="h-full"><Empty title="Select a step" /></Panel>
      ) : (
        <div className="flex h-full min-h-0 flex-col gap-3">
          <div className="min-h-0 flex-1">
            {sel ? <SelectedSpan traceId={sel.trace_id} spanId={sel.span_id} /> : (
              <Panel className="h-full"><Empty title="Select a step" hint="Click a node or a step below to see its input, output and cost." /></Panel>
            )}
          </div>
          <Panel className="h-[36%] min-h-[160px] shrink-0 overflow-hidden">
            <StepsTree spans={spans as never} selectedId={sel?.span_id} onSelect={(s) => setSel(s as TreeSpan)} onOrder={setOrder} onOpenTrace={onOpenTrace} onExpand={() => setMain("steps")} />
          </Panel>
        </div>
      )} />
    {player.on && <div className="mt-3"><PlayerBar player={player} /></div>}
    </>
  );
}

/** Full span (payloads included), loaded lazily and shared with the trace page cache. */
function SelectedSpan({ traceId, spanId }: { traceId: string; spanId: string }) {
  const q = useTrace(traceId);
  if (q.isError) return <ErrorBox error={q.error} />;
  if (q.isPending) return <Panel className="h-full"><Spinner /></Panel>;
  const span = q.data.spans.find((s) => s.span_id === spanId);
  return span ? <SpanPanel span={span} /> : <Panel className="h-full"><Empty title="Span not found" /></Panel>;
}
