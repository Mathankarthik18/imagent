import { Link, useParams, useSearchParams } from "react-router-dom";
import { KindIcon } from "../components/icons";
import { Time } from "../components/Time";
import { traceStats, TraceView, useTrace } from "../components/TraceView";
import { CopyId } from "../components/ui";

export function TraceDetail() {
  const { traceId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const q = useTrace(traceId);
  const root = q.data?.spans.length ? traceStats(q.data.spans).root : null;

  const select = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("span", id);
    setParams(next, { replace: true });
  };

  return (
    <div>
      <nav className="mb-2 flex items-center gap-1.5 text-[12.5px] text-ink-3">
        <Link to="/traces" className="hover:text-ink">Traces</Link>
        <span>/</span>
        <CopyId value={traceId} display={traceId.slice(0, 12)} />
      </nav>
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
        {root && <KindIcon kind={root.kind} size={16} />}
        <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em]">{root?.name ?? "Trace"}</h1>
        {root && (
          <span className="flex flex-wrap items-center gap-x-3 text-[12.5px] text-ink-3">
            <Time value={root.start_time} />
            <span>{root.project}{root.environment ? ` · ${root.environment}` : ""}</span>
            {root.thread_id && (
              <Link to={`/threads/${encodeURIComponent(root.thread_id)}`} className="font-mono text-[12px] hover:text-ink">
                thread {root.thread_id.length > 20 ? `${root.thread_id.slice(0, 20)}…` : root.thread_id}
              </Link>
            )}
            {root.user_id && <span>{root.user_id}</span>}
          </span>
        )}
        {root && (
          <Link to={`/experiments?new=1&root=${encodeURIComponent(root.name)}&sources=${traceId}`}
            className="ml-auto inline-flex h-7 items-center rounded-md border border-line px-2.5 text-[12.5px] text-ink-2 hover:border-line-strong hover:text-ink">
            Replay with another model
          </Link>
        )}
      </div>
      <TraceView traceId={traceId} selected={params.get("span")} onSelect={select} />
    </div>
  );
}
