export type SpanKind = "agent" | "node" | "chain" | "llm" | "tool" | "retriever" | "embedding" | "span";

export interface TraceSummary {
  trace_id: string;
  project: string;
  start_time: string;
  end_time: string;
  duration_ms: number;
  name: string;
  kind: SpanKind;
  thread_id: string;
  user_id: string;
  agent_name: string;
  models: string[];
  tags: string[];
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  llm_calls: number;
  tool_calls: number;
  error_count: number;
  error_message: string;
  span_count: number;
  input_text: string;
  output_text: string;
  input_preview: string;
  output_preview: string;
}

export interface SpanEvent {
  name: string;
  time: string;
  attributes: Record<string, unknown>;
}

export interface Span {
  project: string;
  environment: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string;
  is_root: number;
  name: string;
  kind: SpanKind;
  status: "ok" | "error" | "running";
  status_message: string;
  start_time: string;
  end_time: string;
  duration_ms: number;
  thread_id: string;
  user_id: string;
  session_id: string;
  agent_name: string;
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  cost_source: string;
  ttft_ms: number | null;
  input: string;
  output: string;
  tags: string[];
  metadata: string;
  attributes: Record<string, string>;
  events: SpanEvent[];
}

/** One thread (or the "" = no-thread bucket) aggregated from its traces. */
export interface ThreadGroup {
  thread_id: string;
  project: string;
  trace_count: number;
  first_seen: string;
  last_seen: string;
  duration_ms: number;
  user_id: string;
  agents: string[];
  models: string[];
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  llm_calls: number;
  tool_calls: number;
  error_traces: number;
  error_count: number;
  last_trace_name: string;
  first_input_text: string;
  last_input_text: string;
}

export interface ThreadDetailSummary {
  summary: {
    project: string;
    first_seen: string;
    last_seen: string;
    duration_ms: number;
    traces: number;
    llm_calls: number;
    tool_calls: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cost_usd: number;
    error_spans: number;
    error_traces: number;
    llm_p95_ms: number;
    agents: string[];
    models: string[];
    users: string[];
    tags: string[];
  };
  by_model: { model: string; calls: number; tokens: number; cost_usd: number }[];
  by_tool: { name: string; calls: number; errors: number; avg_ms: number }[];
}

export const NO_THREAD = "__none__";

/** A run in progress (server: /api/running). */
export interface RunningRun {
  trace_id: string;
  project: string;
  thread_id: string;
  user_id: string;
  name: string;
  kind: SpanKind;
  agent_name: string;
  started: string;
  current: { name: string; kind: SpanKind; model: string; started: string };
  path: { name: string; kind: SpanKind }[];
  open_spans: number;
  done: { llm: number; tools: number; spans: number; tokens: number; cost: number; errors: number };
  last_activity: string;
  stalled: boolean;
}

export const THREAD_SORTS = [
  { id: "recent", label: "Most recent" },
  { id: "cost", label: "Highest cost" },
  { id: "errors", label: "Most failures" },
  { id: "traces", label: "Most traces" },
  { id: "duration", label: "Longest" },
  { id: "tokens", label: "Most tokens" },
] as const;

export interface Page<T> {
  items: T[];
  has_more: boolean;
}

export interface Stats {
  bucket_seconds: number;
  summary: {
    traces: number;
    llm_calls: number;
    tool_calls: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    cost_usd: number;
    error_spans: number;
    error_traces: number;
    llm_p50_ms: number;
    llm_p95_ms: number;
    ttft_p50_ms: number;
    root_p95_ms: number;
    unpriced_llm_calls: number;
  };
  series: {
    t: string;
    traces: number;
    llm_calls: number;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    errors: number;
    llm_p50_ms: number;
    llm_p95_ms: number;
  }[];
  by_model: { model: string; provider: string; calls: number; input_tokens: number; output_tokens: number;
    cache_read_tokens: number; cost_usd: number; avg_ms: number; p95_ms: number; errors: number }[];
  by_agent: { agent: string; traces: number; llm_calls: number; tool_calls: number; cost_usd: number;
    tokens: number; errors: number; p95_ms: number }[];
  by_tool: { name: string; calls: number; errors: number; avg_ms: number; p95_ms: number }[];
  errors: { name: string; kind: string; message: string; count: number; last_seen: string; sample_trace_id: string }[];
}

export interface Facets {
  projects: string[];
  environments: string[];
  models: string[];
  agents: string[];
  root_names: string[];
  tags: string[];
}

const KEY_STORAGE = "imagent.readKey";

export function getReadKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

export function setReadKey(key: string) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* storage unavailable */
  }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") qs.set(k, String(v));
  }
  const key = getReadKey();
  const res = await fetch(`${path}${qs.size ? `?${qs}` : ""}`, {
    headers: key ? { "x-imagent-key": key } : {},
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

// ── compare & experiments ────────────────────────────────────────────────────
export interface ToolCallInfo {
  span_id: string;
  trace_id: string;
  name: string;
  args: string;
  output: string;
  status: string;
  duration_ms: number;
  replay: string;
}

export interface RunMetrics {
  duration_ms: number;
  llm_calls: number;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  models: string[];
  errors: number;
}

export type Verdict = "match" | "partial" | "diverged" | "failed";

export interface Comparison {
  a: string;
  b: string;
  verdict: Verdict;
  tool_match: number;
  args_match: number;
  output_similarity: number;
  missing_tools: string[];
  extra_tools: string[];
  rows: { status: "same" | "args_differ" | "only_a" | "only_b"; a: ToolCallInfo | null; b: ToolCallInfo | null }[];
  outputs: { a: string; b: string };
  metrics: { a: RunMetrics; b: RunMetrics };
  names: { a: string; b: string };
}

export interface RunnerAgent { name: string; source_root: string; description: string; read_tools: string[]; models: string[] }
export interface Runner { runner_id: string; host: string; agents: RunnerAgent[]; seconds_ago: number }

export interface Variant { name: string; model: string }

export interface JobScore {
  verdict: Verdict;
  tool_match: number;
  args_match: number;
  output_similarity: number;
  missing_tools: string[];
  extra_tools: string[];
  metrics: RunMetrics;
  baseline_metrics: RunMetrics;
  output: string;
}

export interface ExperimentJob {
  id: string;
  source_trace_id: string;
  variant: string;
  repeat: number;
  status: "queued" | "running" | "done" | "error";
  result_trace_id: string;
  error: string;
  output: string;
  score: JobScore | null;
  created_at: string;
  finished_at: string | null;
}

export interface ExperimentSource {
  trace_id: string;
  name: string;
  start_time: string;
  input_text: string;
  output_text: string;
  metrics: RunMetrics;
}

export interface Experiment {
  id: string;
  name: string;
  agent: string;
  project: string;
  status: "running" | "done" | "failed";
  created_at: string;
  config: { source_trace_ids: string[]; variants: Variant[]; repeats: number; tool_mode: "recorded" | "live_reads" };
  sources: ExperimentSource[];
  jobs: ExperimentJob[];
}

export interface ExperimentSummary {
  id: string;
  name: string;
  agent: string;
  status: string;
  created_at: string;
  variants: string[];
  sources: number;
  repeats: number;
  tool_mode: string;
  jobs: { total: number; done: number; failed: number; pending: number };
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const key = getReadKey();
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "x-imagent-key": key } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}
