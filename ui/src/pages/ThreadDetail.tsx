import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { KindIcon } from "../components/icons";
import { RunningStrip } from "../components/Live";
import { CollapsibleMarkdown } from "../components/Markdown";
import { PayloadView } from "../components/Payload";
import { TracePeek } from "../components/Peek";
import { ThreadTreePanel } from "../components/ThreadTree";
import { Time } from "../components/Time";
import { CopyId, Empty, ErrorBox, Section, Segmented, Spinner, StatStrip } from "../components/ui";
import { api, ApiError, type Page, type ThreadDetailSummary, type TraceSummary } from "../lib/api";
import { turnInput, turnOutput, type Turn } from "../lib/conversation";
import { fmtCost, fmtDuration, fmtNum, fmtPct, fmtTime } from "../lib/format";
import { useAppState } from "../lib/state";

export function ThreadDetail() {
  const { threadId = "" } = useParams();
  const { project, tick } = useAppState();
  const [peek, setPeek] = useState<string | null>(null);
  const [mode, setMode] = useState<"conversation" | "payloads">("conversation");
  const p = { project: project || undefined };
  const summary = useQuery({
    queryKey: ["thread-summary", threadId, project, tick],
    queryFn: () => api<ThreadDetailSummary>(`/api/threads/${encodeURIComponent(threadId)}/summary`, p),
    placeholderData: undefined,
    refetchInterval: (query) => (query.state.error ? 5_000 : false),
  });
  const traces = useQuery({
    queryKey: ["thread", threadId, project, tick],
    queryFn: () => api<Page<TraceSummary>>(`/api/threads/${encodeURIComponent(threadId)}`, p),
    placeholderData: undefined,
  });

  if (summary.isError && summary.error instanceof ApiError && summary.error.status === 404) {
    return (
      <div className="space-y-6">
        <h1 className="truncate"><CopyId value={threadId} display={threadId} className="text-[14px] font-medium text-ink" /></h1>
        <RunningStrip threadId={threadId} onOpen={(r) => setPeek(r.trace_id)} />
        <Empty title="No finished runs in this thread yet" hint="If a run is in progress it shows above; this page fills in as spans finish." />
        {peek && <TracePeek traceId={peek} onClose={() => setPeek(null)} />}
      </div>
    );
  }
  if (summary.isError) return <ErrorBox error={summary.error} />;
  if (traces.isError) return <ErrorBox error={traces.error} />;
  if (summary.isPending || traces.isPending) return <Spinner />;

  const s = summary.data.summary;
  const items = traces.data.items;

  return (
    <div className="space-y-8">
      <div>
        <nav className="mb-2 flex items-center gap-1.5 text-[12.5px] text-ink-3">
          <Link to="/traces" className="hover:text-ink">Traces</Link><span>/</span><span>Thread</span>
        </nav>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="min-w-0 truncate"><CopyId value={threadId} display={threadId} className="text-[14px] font-medium text-ink" /></h1>
          <span className="flex flex-wrap items-center gap-x-3 text-[12.5px] text-ink-3">
            <span>{s.project}</span>
            {s.agents.length > 0 && <span>{s.agents.join(", ")}</span>}
            <span className="num">{fmtTime(s.first_seen)} → {fmtTime(s.last_seen)}</span>
            {s.users.length > 0 && <span>{s.users.join(", ")}</span>}
            {s.tags.map((t) => <span key={t} className="rounded bg-subtle px-1.5 text-[11.5px] text-ink-2">{t}</span>)}
          </span>
        </div>
      </div>

      <RunningStrip threadId={threadId} onOpen={(r) => setPeek(r.trace_id)} />

      <StatStrip items={[
        { label: "Runs", value: s.traces, sub: `over ${fmtDuration(s.duration_ms)}` },
        { label: "Cost", value: fmtCost(s.cost_usd), sub: `${fmtCost(s.traces ? s.cost_usd / s.traces : 0)} per run` },
        { label: "Tokens", value: fmtNum(s.input_tokens + s.output_tokens), sub: `${fmtNum(s.input_tokens)} in · ${fmtNum(s.output_tokens)} out` },
        { label: "Cache hit", value: s.input_tokens ? fmtPct(s.cache_read_tokens / s.input_tokens) : "—" },
        { label: "Calls", value: `${s.llm_calls} · ${s.tool_calls}`, sub: `LLM · tool, p95 ${fmtDuration(s.llm_p95_ms)}` },
        { label: "Failed runs", value: `${s.error_traces} / ${s.traces}`, sub: `${s.error_spans} failed spans`, tone: s.error_traces ? "critical" : undefined },
      ]} />

      {items.length > 1 && (
        <div className="grid gap-8 lg:grid-cols-2">
          <PerRunChart title="Cost per run" items={items} dataKey="cost_usd" format={fmtCost} onOpen={setPeek} />
          <PerRunChart title="Duration per run" items={items} dataKey="duration_ms" format={fmtDuration} onOpen={setPeek} />
        </div>
      )}

      <Section title="Thread tree">
        <ThreadTreePanel threadId={threadId} project={project || undefined} tick={tick} onOpenTrace={setPeek} />
      </Section>

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_280px]">
        <Section title={`Conversation · ${items.length} runs`}
          actions={<Segmented value={mode} onChange={setMode} options={[{ id: "conversation", label: "Conversation" }, { id: "payloads", label: "Payloads" }]} />}>
          {items.length === 0 ? <Empty title="No runs in this thread" /> : (
            <ol className="divide-y divide-line border-y border-line">
              {items.map((t, i) => <TurnRow key={t.trace_id} index={i + 1} trace={t} mode={mode} onOpen={() => setPeek(t.trace_id)} />)}
            </ol>
          )}
        </Section>
        <div className="space-y-8">
          <Section title="Models">
            <MiniTable rows={summary.data.by_model.map((m) => [
              <span key="m" className="font-mono text-[12px]">{m.model || "unknown"}</span>, `${m.calls}×`, fmtCost(m.cost_usd)])} />
          </Section>
          <Section title="Tools">
            <MiniTable rows={summary.data.by_tool.map((t) => [
              <span key="t" className="font-mono text-[12px]">{t.name}</span>,
              <span key="c">{t.calls}×{t.errors > 0 && <span className="text-critical"> · {t.errors} failed</span>}</span>,
              fmtDuration(t.avg_ms)])} />
          </Section>
        </div>
      </div>

      {peek && <TracePeek traceId={peek} onClose={() => setPeek(null)} />}
    </div>
  );
}

function TurnRow({ index, trace: t, mode, onOpen }: { index: number; trace: TraceSummary; mode: "conversation" | "payloads"; onOpen: () => void }) {
  const input = turnInput(t.input_preview);
  const output = turnOutput(t.output_preview);
  return (
    <li className="py-4">
      <div className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
        <span className="num w-5 text-right text-ink-3">{index}</span>
        <KindIcon kind={t.kind} size={13} />
        <button onClick={onOpen} className="font-medium hover:underline">{t.name}</button>
        <Time value={t.start_time} className="text-ink-3" />
        <span className="num ml-auto flex items-center gap-4 text-ink-3">
          <span>{fmtDuration(t.duration_ms)}</span>
          <span>{t.llm_calls} LLM · {t.tool_calls} tools</span>
          <span>{fmtNum(t.input_tokens + t.output_tokens)} tok</span>
          <span className="text-ink">{fmtCost(t.cost_usd)}</span>
        </span>
      </div>
      {mode === "payloads" ? (
        <div className="grid gap-6 pl-8 lg:grid-cols-2">
          <div className="min-w-0"><Label>Input</Label><PayloadView raw={t.input_preview} /></div>
          <div className="min-w-0"><Label>Output</Label><PayloadView raw={t.output_preview} /></div>
        </div>
      ) : (
        <div className="space-y-3 pl-8">
          <Message who="in" turn={input} />
          {t.error_count > 0 && (
            <div className="flex items-start gap-2 font-mono text-[12px] leading-5 text-critical">
              <span>✕</span><span className="min-w-0 flex-1">{t.error_message || `${t.error_count} span(s) failed`}</span>
              <button onClick={onOpen} className="shrink-0 font-sans text-ink-3 hover:text-ink">Inspect</button>
            </div>
          )}
          {(output.text || t.error_count === 0) && <Message who="out" turn={output} />}
        </div>
      )}
    </li>
  );
}

function Message({ who, turn }: { who: "in" | "out"; turn: Turn }) {
  const [expanded, setExpanded] = useState(false);
  const limit = 900;
  const long = turn.text.length > limit;
  const text = long && !expanded ? `${turn.text.slice(0, limit)}…` : turn.text;
  const label = who === "in" ? (turn.isMessage ? "User" : "Input") : (turn.isMessage ? "Assistant" : "Output");
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-3">
      <span className={`pt-px text-[12px] ${who === "in" ? "text-[#2a78d6] dark:text-[#6da7ec]" : "text-[#0f8a5f] dark:text-[#4cc79a]"}`}>{label}</span>
      <div>
        {!turn.text ? <span className="text-ink-3">Not captured</span>
          : turn.isMessage ? <CollapsibleMarkdown text={turn.text} maxHeight={320} />
          : <>
              <pre className="whitespace-pre-wrap break-words font-mono text-[12px] text-ink-2">{text}</pre>
              {long && <button className="mt-1 text-[12px] text-ink-3 hover:text-ink" onClick={() => setExpanded((e) => !e)}>{expanded ? "Show less" : "Show all"}</button>}
            </>}
      </div>
    </div>
  );
}

function PerRunChart({ title, items, dataKey, format, onOpen }: {
  title: string; items: TraceSummary[]; dataKey: "cost_usd" | "duration_ms"; format: (v: number) => string; onOpen: (traceId: string) => void;
}) {
  const data = items.map((t, i) => ({ ...t, run: `${i + 1}` }));
  return (
    <Section title={<>{title} <span className="text-ink-3">· failed runs in red · click a bar to inspect</span></>}>
      <div className="h-44">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap={3}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis dataKey="run" tick={{ fill: "var(--text-3)", fontSize: 11 }} tickLine={false} axisLine={{ stroke: "var(--border)" }} minTickGap={6} />
            <YAxis tick={{ fill: "var(--text-3)", fontSize: 11 }} tickLine={false} axisLine={false} width={52} tickFormatter={(v: number) => format(v)} />
            <Tooltip cursor={{ fill: "var(--subtle)" }} content={({ active, payload }) => {
              const t = active && payload?.[0]?.payload as (TraceSummary & { run: string }) | undefined;
              if (!t) return null;
              return (
                <div className="rounded-md border border-line bg-bg px-3 py-2 text-[12px] shadow-lg">
                  <div className="font-medium">Run {t.run} · {t.name}</div>
                  <div className="text-ink-3">{fmtTime(t.start_time)}</div>
                  <div className="num mt-1">{format(t[dataKey])}{t.error_count > 0 && <span className="text-critical"> · failed</span>}</div>
                </div>
              );
            }} />
            <Bar dataKey={dataKey} radius={[3, 3, 0, 0]} maxBarSize={28} cursor="pointer"
              onClick={(d: { payload?: TraceSummary }) => d.payload && onOpen(d.payload.trace_id)}>
              {data.map((t) => <Cell key={t.trace_id} fill={t.error_count ? "var(--critical)" : "var(--series-1)"} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Section>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <h4 className="mb-2 text-[12px] font-medium text-ink-3">{children}</h4>;
}

function MiniTable({ rows }: { rows: ReactNode[][] }) {
  if (rows.length === 0) return <p className="text-ink-3">None</p>;
  return (
    <table className="w-full border-t border-line">
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-line/70">
            {r.map((c, j) => <td key={j} className={`num py-1.5 ${j ? "pl-3 text-right text-ink-2" : "max-w-[140px] truncate"}`}>{c}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
