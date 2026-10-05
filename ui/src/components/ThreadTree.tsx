import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useHotkey } from "../lib/keys";
import { SpanPanel } from "./SpanPanel";
import { SpanTree, type TreeSpan } from "./SpanTree";
import { Split } from "./Split";
import { useTrace } from "./TraceView";
import { Empty, ErrorBox, Panel, Spinner } from "./ui";

interface ThreadSpans {
  spans: TreeSpan[];
  truncated: boolean;
  running?: boolean;
}

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
    <Split id="thread-tree" height={height}
      left={
        <Panel className="flex h-full flex-col overflow-hidden">
          {q.data.truncated && <p className="shrink-0 border-b border-line px-3 py-1.5 text-[12px] text-ink-3">Showing the first 5,000 spans.</p>}
          <div className="min-h-0 flex-1"><SpanTree spans={spans} groupByTrace selectedId={sel?.span_id} onSelect={setSel} onOpenTrace={onOpenTrace} onOrder={setOrder} /></div>
        </Panel>
      }
      right={sel ? <SelectedSpan traceId={sel.trace_id} spanId={sel.span_id} /> : (
        <Panel className="h-full"><Empty title="Select a span" hint={<>Click a span to see its input, output and cost. <kbd>[</kbd> <kbd>]</kbd> step through them.</>} /></Panel>
      )} />
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
