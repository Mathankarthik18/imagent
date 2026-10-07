import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, type Comparison, type RunMetrics, type ToolCallInfo, type Verdict } from "../lib/api";
import { fmtCost, fmtDuration, fmtNum, fmtPct } from "../lib/format";
import { KindIcon } from "./icons";
import { CollapsibleMarkdown } from "./Markdown";
import { SpanPanel } from "./SpanPanel";
import { SpanTree, type SpanMark } from "./SpanTree";
import { traceStats, useTrace } from "./TraceView";
import { Empty, ErrorBox, Panel, Section, Segmented, Spinner } from "./ui";

export const VERDICT: Record<Verdict, { label: string; cls: string; dot: string }> = {
  match: { label: "Matches baseline", cls: "text-good", dot: "bg-good" },
  partial: { label: "Partly matches", cls: "text-[#b77d00] dark:text-[#e0a526]", dot: "bg-[#eda100]" },
  diverged: { label: "Diverged", cls: "text-critical", dot: "bg-critical" },
  failed: { label: "Failed", cls: "text-critical", dot: "bg-critical" },
};

export function VerdictBadge({ verdict, size = "md" }: { verdict: Verdict; size?: "sm" | "md" }) {
  const v = VERDICT[verdict];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap font-medium ${v.cls} ${size === "sm" ? "text-[12px]" : "text-[13px]"}`}>
      <span className={`size-2 rounded-full ${v.dot}`} />{v.label}
    </span>
  );
}

function delta(a: number, b: number, fmt: (n: number) => string, lowerIsBetter = true): ReactNode {
  if (!a && !b) return <span className="text-ink-3">—</span>;
  if (!a) return <span className="text-ink-3">new</span>;
  const pct = (b - a) / a;
  if (Math.abs(pct) < 0.005) return <span className="text-ink-3">same</span>;
  const good = lowerIsBetter ? pct < 0 : pct > 0;
  return (
    <span className={good ? "text-good" : "text-critical"} title={`${fmt(a)} → ${fmt(b)}`}>
      {pct > 0 ? "+" : "−"}{fmtPct(Math.abs(pct))}
    </span>
  );
}

function MetricsTable({ a, b, labels }: { a: RunMetrics; b: RunMetrics; labels: [string, string] }) {
  const rows: [string, number, number, (n: number) => string, boolean][] = [
    ["Duration", a.duration_ms, b.duration_ms, fmtDuration, true],
    ["Cost", a.cost_usd, b.cost_usd, fmtCost, true],
    ["Tokens", a.input_tokens + a.output_tokens, b.input_tokens + b.output_tokens, fmtNum, true],
    ["LLM calls", a.llm_calls, b.llm_calls, fmtNum, true],
    ["Tool calls", a.tool_calls, b.tool_calls, fmtNum, false],
    ["Failed spans", a.errors, b.errors, fmtNum, true],
  ];
  return (
    <table className="w-full border-separate border-spacing-0 text-[12.5px]">
      <thead>
        <tr className="text-[11.5px] text-ink-3">
          <th className="border-b border-line py-1.5 text-left font-medium" />
          <th className="border-b border-line py-1.5 text-right font-medium">{labels[0]}</th>
          <th className="border-b border-line py-1.5 text-right font-medium">{labels[1]}</th>
          <th className="border-b border-line py-1.5 pl-3 text-right font-medium">Change</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, x, y, fmt, lower]) => (
          <tr key={label}>
            <td className="border-b border-line/70 py-1.5 text-ink-2">{label}</td>
            <td className="num border-b border-line/70 py-1.5 text-right">{fmt(x)}</td>
            <td className="num border-b border-line/70 py-1.5 text-right">{fmt(y)}</td>
            <td className="num border-b border-line/70 py-1.5 pl-3 text-right">{delta(x, y, fmt, lower)}</td>
          </tr>
        ))}
        <tr>
          <td className="py-1.5 text-ink-2">Models</td>
          <td className="py-1.5 text-right font-mono text-[11.5px] text-ink-2">{a.models.join(", ") || "—"}</td>
          <td className="py-1.5 text-right font-mono text-[11.5px] text-ink-2">{b.models.join(", ") || "—"}</td>
          <td />
        </tr>
      </tbody>
    </table>
  );
}

const ROW_STYLE = {
  same: { label: "Same", cls: "text-ink-3" },
  args_differ: { label: "Different args", cls: "text-[#b77d00] dark:text-[#e0a526]" },
  only_a: { label: "Missing", cls: "text-critical" },
  only_b: { label: "Extra", cls: "text-accent" },
} as const;

function prettyArgs(args: string) {
  try {
    const v = JSON.parse(args);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.entries(v).map(([k, x]) => `${k}: ${typeof x === "string" ? x : JSON.stringify(x)}`).join(" · ");
    }
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return args;
  }
}

function Call({ call, emphasize }: { call: ToolCallInfo | null; emphasize: boolean }) {
  if (!call) return <span className="text-ink-3">—</span>;
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <KindIcon kind="tool" size={12} />
        <span className="font-mono text-[12px] font-medium">{call.name}</span>
        {call.replay && call.replay !== "recorded" && (
          <span className={`rounded px-1 text-[10.5px] ${call.replay === "not_recorded" ? "bg-critical/10 text-critical" : "bg-subtle text-ink-3"}`}>
            {call.replay.replace("_", " ")}
          </span>
        )}
        {call.status === "error" && <span className="text-[11px] text-critical">error</span>}
      </div>
      <p className={`mt-0.5 line-clamp-2 break-all font-mono text-[11.5px] ${emphasize ? "text-ink" : "text-ink-3"}`} title={call.args}>
        {prettyArgs(call.args)}
      </p>
    </div>
  );
}

export function CompareView({ a, b, labels = ["Baseline", "Candidate"] }: { a: string; b: string; labels?: [string, string] }) {
  const q = useQuery({ queryKey: ["compare", a, b], queryFn: () => api<Comparison>("/api/compare", { a, b }) });
  const [mode, setMode] = useState<"diff" | "trees">(() => {
    try {
      return (localStorage.getItem("imagent.compare.mode") as "diff" | "trees") || "diff";
    } catch {
      return "diff";
    }
  });
  const pick = (m: "diff" | "trees") => {
    setMode(m);
    try {
      localStorage.setItem("imagent.compare.mode", m);
    } catch {
      /* storage unavailable */
    }
  };
  if (q.isError) return <ErrorBox error={q.error} />;
  if (q.isPending) return <Spinner />;
  const c = q.data;
  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-line px-4 py-3">
        <Segmented value={mode} onChange={pick} options={[{ id: "diff", label: "Diff" }, { id: "trees", label: "Trees side by side" }]} />
        <VerdictBadge verdict={c.verdict} />
        <span className="text-ink-3">Tools <span className="num font-medium text-ink">{fmtPct(c.tool_match)}</span> aligned</span>
        <span className="text-ink-3">Args <span className="num font-medium text-ink">{fmtPct(c.args_match)}</span> identical</span>
        <span className="text-ink-3">Output <span className="num font-medium text-ink">{fmtPct(c.output_similarity)}</span> similar</span>
        {c.missing_tools.length > 0 && <span className="text-critical">Missing: {c.missing_tools.join(", ")}</span>}
        {c.extra_tools.length > 0 && <span className="text-accent">Extra: {c.extra_tools.join(", ")}</span>}
        <span className="ml-auto flex gap-3 text-[12px]">
          <Link to={`/traces/${c.a}`} className="text-ink-3 hover:text-ink">{labels[0]} trace ↗</Link>
          <Link to={`/traces/${c.b}`} className="text-ink-3 hover:text-ink">{labels[1]} trace ↗</Link>
        </span>
      </div>

      {mode === "trees" ? <SideBySideTrees c={c} labels={labels} /> : <>
      <div className="grid gap-8 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
        <Section title="Tool calls, aligned">
          {c.rows.length === 0 ? <p className="text-ink-3">Neither run called a tool.</p> : (
            <table className="w-full border-separate border-spacing-0">
              <thead>
                <tr className="text-[11.5px] text-ink-3">
                  <th className="w-24 border-b border-line py-1.5 text-left font-medium" />
                  <th className="border-b border-line py-1.5 text-left font-medium">{labels[0]}</th>
                  <th className="border-b border-line py-1.5 pl-4 text-left font-medium">{labels[1]}</th>
                </tr>
              </thead>
              <tbody>
                {c.rows.map((r, i) => (
                  <tr key={i} className={r.status === "only_a" ? "bg-critical/[0.04]" : r.status === "only_b" ? "bg-accent-soft/40" : ""}>
                    <td className={`border-b border-line/70 py-2 pr-2 align-top text-[11.5px] font-medium ${ROW_STYLE[r.status].cls}`}>{ROW_STYLE[r.status].label}</td>
                    <td className="border-b border-line/70 py-2 align-top"><Call call={r.a} emphasize={r.status === "args_differ"} /></td>
                    <td className="border-b border-line/70 py-2 pl-4 align-top"><Call call={r.b} emphasize={r.status === "args_differ"} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
        <Section title="Cost & performance">
          <MetricsTable a={c.metrics.a} b={c.metrics.b} labels={labels} />
        </Section>
      </div>

      <Section title="Final output">
        <div className="grid gap-6 lg:grid-cols-2">
          {(["a", "b"] as const).map((k, i) => (
            <div key={k} className="min-w-0 rounded-lg border border-line p-4">
              <div className="mb-2 text-[12px] font-medium text-ink-3">{labels[i]}</div>
              {c.outputs[k] ? <CollapsibleMarkdown text={c.outputs[k]} maxHeight={360} /> : <p className="text-ink-3">No output</p>}
            </div>
          ))}
        </div>
      </Section>
      </>}
    </div>
  );
}

/** Both runs' span trees next to each other, with the tool-call diff marked in place.
 *  Selecting a tool call selects its counterpart on the other side. */
function SideBySideTrees({ c, labels }: { c: Comparison; labels: [string, string] }) {
  const ta = useTrace(c.a);
  const tb = useTrace(c.b);
  const { marksA, marksB, pairs } = useMemo(() => {
    const marksA = new Map<string, SpanMark>();
    const marksB = new Map<string, SpanMark>();
    const pairs = new Map<string, string>();
    for (const r of c.rows) {
      if (r.status === "only_a" && r.a) marksA.set(r.a.span_id, "missing");
      if (r.status === "only_b" && r.b) marksB.set(r.b.span_id, r.b.replay === "not_recorded" ? "not_recorded" : "extra");
      if (r.status === "args_differ" && r.a && r.b) {
        marksA.set(r.a.span_id, "args");
        marksB.set(r.b.span_id, "args");
      }
      if (r.a && r.b) {
        pairs.set(r.a.span_id, r.b.span_id);
        pairs.set(r.b.span_id, r.a.span_id);
      }
      if (r.b?.replay === "not_recorded" && r.a) marksB.set(r.b.span_id, "not_recorded");
    }
    return { marksA, marksB, pairs };
  }, [c.rows]);
  const [sel, setSel] = useState<{ a: string | null; b: string | null }>({ a: null, b: null });
  const choose = (side: "a" | "b", id: string) => {
    const other = pairs.get(id) ?? null;
    setSel(side === "a" ? { a: id, b: other ?? sel.b } : { a: other ?? sel.a, b: id });
  };

  const sides = [
    { key: "a" as const, label: labels[0], q: ta, marks: marksA },
    { key: "b" as const, label: labels[1], q: tb, marks: marksB },
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-3">
        <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-sm bg-critical/40" /> missing in the other run / not recorded</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-sm bg-[#eda100]/50" /> different arguments</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-sm bg-accent/40" /> extra</span>
        <span>· selecting a tool call selects its counterpart</span>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {sides.map(({ key, label, q, marks }) => {
          if (q.isError) return <ErrorBox key={key} error={q.error} />;
          if (q.isPending) return <Panel key={key} className="h-[52vh]"><Spinner /></Panel>;
          const spans = q.data.spans;
          const st = traceStats(spans);
          const selected = spans.find((s) => s.span_id === sel[key]);
          return (
            <div key={key} className="min-w-0 space-y-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate"><span className="font-medium">{label}</span> <span className="text-ink-3">· {st.root?.name}</span></span>
                <span className="num shrink-0 text-[12px] text-ink-3">{fmtDuration(st.duration)} · {st.llm} LLM · {st.tools} tools · {fmtCost(st.cost)}</span>
              </div>
              <Panel className="h-[52vh] overflow-hidden">
                <SpanTree spans={spans} marks={marks} selectedId={sel[key] ?? undefined} onSelect={(s) => choose(key, s.span_id)} />
              </Panel>
              <div className="h-[46vh]">
                {selected ? <SpanPanel span={selected} /> : (
                  <Panel className="h-full"><Empty title="Select a span" hint="Pick any span to see its input, output and cost here." /></Panel>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
