import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { EmptyWindow } from "../components/EmptyWindow";
import { RunningStrip } from "../components/Live";
import { Time } from "../components/Time";
import { ErrorBox, PageHeader, Section, Spinner, StatStrip, td, th } from "../components/ui";
import { api, type Stats } from "../lib/api";
import { fmtCost, fmtDuration, fmtNum, fmtPct, parseTime } from "../lib/format";
import { useAppState, useBaseParams } from "../lib/state";

export function Dashboard() {
  const base = useBaseParams();
  const { rangeLabel } = useAppState();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["stats", base], queryFn: () => api<Stats>("/api/stats", base) });

  if (q.isError) return <ErrorBox error={q.error} />;
  if (q.isPending) return <Spinner />;
  const { summary: s, series, by_model, by_agent, by_tool, errors, bucket_seconds } = q.data;
  if (!s.traces) return <><PageHeader title="Overview" /><RunningStrip onOpen={(r) => navigate(`/traces/${r.trace_id}`)} /><EmptyWindow what="traces" /></>;

  const multiDay = bucket_seconds >= 6 * 3600;
  const fmtTick = (t: string) => {
    const d = parseTime(t);
    return multiDay ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  };
  // Empty buckets have no latency — draw a gap, not a dive to zero.
  const data = series.map((p) => ({
    ...p, label: fmtTick(p.t),
    llm_p50_ms: p.llm_calls ? p.llm_p50_ms : null, llm_p95_ms: p.llm_calls ? p.llm_p95_ms : null,
  }));

  return (
    <div className="space-y-8">
      <PageHeader title="Overview" meta={rangeLabel} />
      <RunningStrip onOpen={(r) => navigate(`/traces/${r.trace_id}`)} />

      <StatStrip items={[
        { label: "Traces", value: fmtNum(s.traces), sub: `${fmtNum(s.llm_calls)} LLM · ${fmtNum(s.tool_calls)} tool calls` },
        { label: "Cost", value: fmtCost(s.cost_usd), sub: s.unpriced_llm_calls ? `${s.unpriced_llm_calls} calls unpriced` : `${fmtCost(s.cost_usd / s.traces)} per trace` },
        { label: "Tokens", value: fmtNum(s.input_tokens + s.output_tokens), sub: `${fmtNum(s.input_tokens)} in · ${fmtNum(s.output_tokens)} out` },
        { label: "Cache hit", value: fmtPct(s.input_tokens ? s.cache_read_tokens / s.input_tokens : 0), sub: `${fmtNum(s.cache_read_tokens)} cached tokens` },
        { label: "Failed traces", value: fmtPct(s.error_traces / s.traces), sub: `${s.error_traces} of ${s.traces}`, tone: s.error_traces ? "critical" : undefined },
        { label: "LLM latency", value: fmtDuration(s.llm_p95_ms), sub: `p95 · p50 ${fmtDuration(s.llm_p50_ms)}` },
      ]} />

      <div className="grid gap-x-10 gap-y-8 lg:grid-cols-2">
        <Chart title="Cost">
          <AreaChart data={data} margin={chartMargin}>
            <defs>
              <linearGradient id="costFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--series-1)" stopOpacity={0.18} />
                <stop offset="100%" stopColor="var(--series-1)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <Grid /><XAxis dataKey="label" {...axis} minTickGap={32} />
            <YAxis {...axis} width={52} tickFormatter={(v: number) => fmtCost(v)} />
            <Tooltip content={<Tip format={fmtCost} />} cursor={{ stroke: "var(--border-strong)" }} />
            <Area type="monotone" dataKey="cost_usd" name="Cost" stroke="var(--series-1)" strokeWidth={1.75} fill="url(#costFill)"
              activeDot={{ r: 3.5, stroke: "var(--bg)", strokeWidth: 2 }} />
          </AreaChart>
        </Chart>
        <Chart title="LLM latency" legend={[["p50", "var(--series-1)"], ["p95", "var(--series-2)"]]}>
          <LineChart data={data} margin={chartMargin}>
            <Grid /><XAxis dataKey="label" {...axis} minTickGap={32} />
            <YAxis {...axis} width={52} tickFormatter={(v: number) => fmtDuration(v)} />
            <Tooltip content={<Tip format={fmtDuration} />} cursor={{ stroke: "var(--border-strong)" }} />
            <Line type="monotone" dataKey="llm_p50_ms" name="p50" stroke="var(--series-1)" strokeWidth={1.75} dot={false} activeDot={{ r: 3.5, stroke: "var(--bg)", strokeWidth: 2 }} />
            <Line type="monotone" dataKey="llm_p95_ms" name="p95" stroke="var(--series-2)" strokeWidth={1.75} dot={false} activeDot={{ r: 3.5, stroke: "var(--bg)", strokeWidth: 2 }} />
          </LineChart>
        </Chart>
        <Chart title="Traces">
          <BarChart data={data} margin={chartMargin} barCategoryGap={2}>
            <Grid /><XAxis dataKey="label" {...axis} minTickGap={32} />
            <YAxis {...axis} width={36} allowDecimals={false} />
            <Tooltip content={<Tip format={fmtNum} />} cursor={{ fill: "var(--subtle)" }} />
            <Bar dataKey="traces" name="Traces" fill="var(--series-1)" radius={[3, 3, 0, 0]} maxBarSize={22} />
          </BarChart>
        </Chart>
        <Chart title="Failed spans">
          <BarChart data={data} margin={chartMargin} barCategoryGap={2}>
            <Grid /><XAxis dataKey="label" {...axis} minTickGap={32} />
            <YAxis {...axis} width={36} allowDecimals={false} />
            <Tooltip content={<Tip format={fmtNum} />} cursor={{ fill: "var(--subtle)" }} />
            <Bar dataKey="errors" name="Failed" fill="var(--critical)" radius={[3, 3, 0, 0]} maxBarSize={22} />
          </BarChart>
        </Chart>
      </div>

      <div className="grid gap-x-10 gap-y-8 xl:grid-cols-2">
        <Section title="Models">
          <Table head={["Model", "Calls", "In / out", "Cache", "p95", "Failed", "Cost"]}
            rows={by_model.map((m) => [
              <span className="font-mono text-[12px]" key="m">{m.model || "unknown"}</span>, fmtNum(m.calls),
              `${fmtNum(m.input_tokens)} / ${fmtNum(m.output_tokens)}`, fmtPct(m.input_tokens ? m.cache_read_tokens / m.input_tokens : 0),
              fmtDuration(m.p95_ms), <Fail n={m.errors} key="e" />, <span className="text-ink" key="c">{fmtCost(m.cost_usd)}</span>,
            ])} />
        </Section>
        <Section title="Agents">
          <Table head={["Agent", "Traces", "LLM", "Tools", "Run p95", "Failed", "Cost"]}
            onRow={(i) => by_agent[i].agent !== "(none)" && navigate(`/traces?agent=${encodeURIComponent(by_agent[i].agent)}`)}
            rows={by_agent.map((a) => [
              a.agent === "(none)" ? <span className="text-ink-3" key="a">unattributed</span> : a.agent,
              fmtNum(a.traces), fmtNum(a.llm_calls), fmtNum(a.tool_calls), fmtDuration(a.p95_ms),
              <Fail n={a.errors} key="e" />, <span className="text-ink" key="c">{fmtCost(a.cost_usd)}</span>,
            ])} />
        </Section>
        <Section title="Tools">
          <Table head={["Tool", "Calls", "Failure rate", "Avg", "p95"]}
            rows={by_tool.map((t) => [
              <span className="font-mono text-[12px]" key="t">{t.name}</span>, fmtNum(t.calls),
              <span key="r" className={t.errors ? "text-critical" : ""}>{fmtPct(t.calls ? t.errors / t.calls : 0)}</span>,
              fmtDuration(t.avg_ms), fmtDuration(t.p95_ms),
            ])} />
        </Section>
        <Section title="Top failures">
          {errors.length === 0 ? <p className="border-t border-line py-3 text-ink-3">No failures in this window.</p> : (
            <ul className="border-t border-line">
              {errors.map((e, i) => (
                <li key={i} onClick={() => navigate(`/traces/${e.sample_trace_id}`)} className="cursor-pointer border-b border-line/70 py-2.5 hover:bg-hover">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate font-medium">{e.name}</span>
                    <span className="num shrink-0 text-[12px] text-ink-3">{e.count}× · <Time value={e.last_seen} /></span>
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[12px] text-critical">{e.message || "no message"}</p>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}

const chartMargin = { top: 6, right: 4, bottom: 0, left: 0 };
const axis = { tick: { fill: "var(--text-3)", fontSize: 11 }, tickLine: false, axisLine: { stroke: "var(--border)" } } as const;

function Grid() {
  return <CartesianGrid stroke="var(--grid)" vertical={false} />;
}

function Chart({ title, legend, children }: { title: string; legend?: [string, string][]; children: ReactNode }) {
  return (
    <Section title={title} actions={legend && (
      <div className="flex gap-3 text-[11.5px] text-ink-3">
        {legend.map(([l, c]) => <span key={l} className="inline-flex items-center gap-1.5"><span className="h-0.5 w-3 rounded" style={{ background: c }} />{l}</span>)}
      </div>
    )}>
      <div className="h-48"><ResponsiveContainer width="100%" height="100%">{children as never}</ResponsiveContainer></div>
    </Section>
  );
}

function Tip({ active, label, payload, format }: {
  active?: boolean; label?: string; payload?: { name: string; value: number; color: string }[]; format: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-line bg-bg px-3 py-2 text-[12px] shadow-lg">
      <div className="mb-1 text-ink-3">{label}</div>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="h-0.5 w-3 rounded" style={{ background: p.color }} />
          <span className="text-ink-2">{p.name}</span>
          <span className="num ml-auto pl-4 font-medium">{p.value == null ? "—" : format(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

function Fail({ n }: { n: number }) {
  return <span className={n ? "text-critical" : "text-ink-3"}>{n || "—"}</span>;
}

function Table({ head, rows, onRow }: { head: string[]; rows: ReactNode[][]; onRow?: (i: number) => void }) {
  if (rows.length === 0) return <p className="border-t border-line py-3 text-ink-3">Nothing recorded.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] border-separate border-spacing-0">
        <thead><tr>{head.map((h, i) => <th key={h} className={`${th} ${i ? "text-right" : ""} first:pl-0 last:pr-0`}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} onClick={onRow ? () => onRow(i) : undefined} className={`border-b border-line/70 ${onRow ? "cursor-pointer hover:bg-hover" : ""}`}>
              {r.map((c, j) => <td key={j} className={`${td} num whitespace-nowrap border-b border-line/70 first:pl-0 last:pr-0 ${j ? "text-right text-ink-2" : "max-w-[240px] truncate"}`}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
