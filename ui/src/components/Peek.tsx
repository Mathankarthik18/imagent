import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type ThreadDetailSummary } from "../lib/api";
import { fmtCost, fmtDuration, fmtNum } from "../lib/format";
import { Drawer } from "./Drawer";
import { KindIcon } from "./icons";
import { ThreadTreePanel } from "./ThreadTree";
import { traceStats, TraceView, useTrace } from "./TraceView";
import { CopyId } from "./ui";

export function TracePeek({ traceId, onClose }: { traceId: string; onClose: () => void }) {
  const [span, setSpan] = useState<string | null>(null);
  const q = useTrace(traceId);
  const root = q.data?.spans.length ? traceStats(q.data.spans).root : null;
  return (
    <Drawer onClose={onClose} href={`/traces/${traceId}${span ? `?span=${span}` : ""}`}
      title={<span className="flex min-w-0 items-center gap-2">
        {root && <KindIcon kind={root.kind} size={14} />}
        <span className="truncate">{root?.name ?? "Trace"}</span>
        <CopyId value={traceId} display={traceId.slice(0, 8)} />
      </span>}>
      <TraceView traceId={traceId} selected={span} onSelect={setSpan} splitId="peek" height="calc(100vh - 118px)" />
    </Drawer>
  );
}

export function ThreadPeek({ threadId, project, onClose, onOpenTrace }: {
  threadId: string; project?: string; onClose: () => void; onOpenTrace: (traceId: string) => void;
}) {
  const s = useQuery({
    queryKey: ["thread-summary", threadId, project],
    queryFn: () => api<ThreadDetailSummary>(`/api/threads/${encodeURIComponent(threadId)}/summary`, { project }),
  }).data?.summary;
  return (
    <Drawer onClose={onClose} href={`/threads/${encodeURIComponent(threadId)}`}
      title={<span className="flex min-w-0 items-center gap-2"><span className="text-ink-3">Thread</span><span className="truncate font-mono text-[12.5px]">{threadId}</span></span>}>
      {s && (
        <div className="num mb-3 flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] text-ink-3">
          <span><span className="text-ink">{s.traces}</span> runs over {fmtDuration(s.duration_ms)}</span>
          <span><span className="text-ink">{s.llm_calls}</span> LLM · <span className="text-ink">{s.tool_calls}</span> tool calls</span>
          <span><span className="text-ink">{fmtNum(s.input_tokens + s.output_tokens)}</span> tokens</span>
          <span className="text-ink">{fmtCost(s.cost_usd)}</span>
          {s.error_traces > 0 && <span className="text-critical">{s.error_traces} failed run{s.error_traces > 1 ? "s" : ""}</span>}
          {s.agents.length > 0 && <span>{s.agents.join(", ")}</span>}
        </div>
      )}
      <ThreadTreePanel threadId={threadId} project={project} onOpenTrace={onOpenTrace} height="calc(100vh - 118px)" />
    </Drawer>
  );
}
