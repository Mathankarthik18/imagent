import { useState, type ReactNode } from "react";
import type { Span } from "../lib/api";
import { fmtCost, fmtDuration, fmtNum, fmtTime } from "../lib/format";
import { elapsed, useNow } from "../lib/live";
import { kindLabel, KindIcon } from "./icons";
import { LiveDot } from "./Live";
import { JsonTree, PayloadView, parsePayload } from "./Payload";
import { CopyId, Panel } from "./ui";

type Tab = "io" | "attributes" | "events";

export function SpanPanel({ span }: { span: Span }) {
  const [tab, setTab] = useState<Tab>("io");
  const tools = span.attributes["imagent.tools"] ?? span.attributes["harness.tools"];
  const metadata = parsePayload(span.metadata).json;
  const failed = span.status === "error";
  const running = span.status === "running";
  const now = useNow(running);

  const facts: [string, ReactNode][] = [
    ["Duration", running ? <span key="d" className="text-accent">{elapsed(span.start_time, now)} so far</span> : fmtDuration(span.duration_ms)],
    ["Started", fmtTime(span.start_time)],
  ];
  if (span.kind === "llm") {
    const cacheHit = span.input_tokens ? Math.round((span.cache_read_tokens / span.input_tokens) * 100) : null;
    facts.push(
      ["Model", <span key="m" className="font-mono text-[12px]">{span.model || "—"}</span>],
      ["Tokens", `${fmtNum(span.input_tokens)} in · ${fmtNum(span.output_tokens)} out`],
      ["Cache hit", cacheHit == null ? "—" : `${cacheHit}%`],
      ["Cost", <span key="c">{fmtCost(span.cost_usd)}{span.cost_source && <span className="text-ink-3"> · {span.cost_source}</span>}</span>],
    );
    if (span.ttft_ms != null) facts.push(["First token", fmtDuration(span.ttft_ms)]);
  }
  if (span.agent_name) facts.push(["Agent", span.agent_name]);
  if (span.tags.length) facts.push(["Tags", span.tags.join(", ")]);

  const tabs: [Tab, string][] = [["io", "Input & output"], ["attributes", "Attributes"], ["events", span.events.length ? `Events ${span.events.length}` : "Events"]];

  return (
    <Panel className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-line px-4 pb-3 pt-3.5">
        <div className="flex min-w-0 items-center gap-2">
          <KindIcon kind={span.kind} size={15} />
          <h3 className="truncate text-[14px] font-semibold">{span.name}</h3>
          <span className="shrink-0 text-[12px] text-ink-3">{kindLabel(span.kind)}</span>
          {failed && <span className="ml-auto shrink-0 rounded px-1.5 py-px text-[11.5px] font-medium text-critical ring-1 ring-critical/30">Failed</span>}
          {running && <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-[12px] font-medium text-accent"><LiveDot /> Running</span>}
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
          {facts.map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-[11.5px] text-ink-3">{k}</dt>
              <dd className="num truncate text-ink">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      {failed && span.status_message && (
        <div className="max-h-32 shrink-0 overflow-auto border-b border-line bg-critical/[0.06] px-4 py-2.5 font-mono text-[12px] leading-5 text-critical">{span.status_message}</div>
      )}
      <div className="flex shrink-0 gap-4 border-b border-line px-4">
        {tabs.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`-mb-px h-9 border-b-2 text-[12.5px] ${tab === id ? "border-ink font-medium text-ink" : "border-transparent text-ink-3 hover:text-ink-2"}`}>
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
        {tab === "io" && (
          <div className="space-y-6">
            <Block label="Input"><PayloadView raw={span.input} empty={running ? "Captured when the span finishes." : "Not captured"} /></Block>
            <Block label="Output"><PayloadView raw={span.output} empty={running ? "Still running — the output appears when it finishes." : failed ? "No output — the span failed." : "Not captured"} /></Block>
            {tools && (
              <details className="group">
                <summary className="cursor-pointer list-none text-[12px] text-ink-3 hover:text-ink-2">
                  <span className="inline-block w-3 transition-transform group-open:rotate-90">›</span> Tools offered to the model
                </summary>
                <div className="mt-2"><PayloadView raw={tools} /></div>
              </details>
            )}
          </div>
        )}
        {tab === "attributes" && (
          <div className="space-y-5">
            <dl className="grid grid-cols-[minmax(120px,38%)_1fr] gap-x-4 font-mono text-[12px]">
              {([["trace_id", <CopyId key="t" value={span.trace_id} />], ["span_id", <CopyId key="s" value={span.span_id} />],
                ["parent", span.parent_span_id || "—"], ["thread_id", span.thread_id || "—"], ["user_id", span.user_id || "—"],
                ...Object.entries(span.attributes).filter(([k]) => k !== "imagent.tools" && k !== "harness.tools")] as [string, ReactNode][]).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="truncate border-b border-line/70 py-1.5 text-ink-3">{k}</dt>
                  <dd className="break-all border-b border-line/70 py-1.5 text-ink-2">{v}</dd>
                </div>
              ))}
            </dl>
            {metadata !== undefined && <Block label="Metadata"><JsonTree value={metadata} defaultOpen={2} /></Block>}
          </div>
        )}
        {tab === "events" && (span.events.length === 0 ? <p className="text-ink-3">No events on this span.</p> : (
          <div className="space-y-4">
            {span.events.map((e, i) => (
              <div key={i}>
                <div className="mb-1.5 flex items-baseline justify-between gap-3">
                  <span className={`font-medium ${e.name === "exception" ? "text-critical" : ""}`}>{e.name}</span>
                  <span className="num text-[12px] text-ink-3">{fmtTime(e.time)}</span>
                </div>
                {"exception.stacktrace" in e.attributes ? (
                  <>
                    <p className="mb-1.5 font-mono text-[12px]">{String(e.attributes["exception.type"])}: {String(e.attributes["exception.message"])}</p>
                    <pre className="max-h-80 overflow-auto rounded-md bg-subtle p-3 font-mono text-[11.5px] leading-[1.55] text-ink-2">{String(e.attributes["exception.stacktrace"])}</pre>
                  </>
                ) : <JsonTree value={e.attributes as never} defaultOpen={2} />}
              </div>
            ))}
          </div>
        ))}
      </div>
    </Panel>
  );
}

function Block({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section>
      <h4 className="mb-2 text-[12px] font-medium text-ink-3">{label}</h4>
      {children}
    </section>
  );
}
