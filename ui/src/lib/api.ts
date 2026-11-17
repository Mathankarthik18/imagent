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
  users: string[];
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

/** A role the agent can run on its own model (orchestrator, sub-agents, ...). */
export interface ModelSlot { key: string; label: string; default: string; description: string }
export interface RunnerAgent { name: string; source_root: string; description: string; read_tools: string[]; models: string[]; model_slots?: ModelSlot[]; auto?: boolean; ready?: boolean }
export interface Runner { runner_id: string; host: string; agents: RunnerAgent[]; seconds_ago: number; ready?: boolean; live_agents?: string[] | null }

/** model: one model for the whole run; models: per-slot picks (unset slots keep the app default). */
export interface Variant { name: string; model: string; models?: Record<string, string> }

const shortModel = (m: string) => m.split("/").pop() ?? m;

/** One-line description of a variant's models, e.g. "Sub-agents: glm-5.3-flash · calculation: o4". */
export function variantModels(v: Variant, slots?: ModelSlot[]): string {
  const picks = Object.entries(v.models ?? {}).filter(([, m]) => m);
  if (!picks.length) return v.model || "app default";
  const label = (k: string) => slots?.find((s) => s.key === k)?.label ?? k;
  return picks.map(([k, m]) => `${label(k)}: ${shortModel(m)}`).join(" · ");
}

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

export type Better = "new" | "original" | "tie";
export type CriteriaScores = Partial<Record<"correct" | "complete" | "clear" | "rubric", number>>;
export interface Judgement {
  better?: Better; reason?: string; model?: string; cost?: number; at?: string; error?: string;
  scores?: Partial<Record<"original" | "new", CriteriaScores>>;
}
export interface JudgeStatus { configured: boolean; model: string; source: "project" | "server" | ""; base_url: string }

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
  /** AI judge: which answer is better (original run vs this replay). */
  judgement: Judgement | null;
  /** A person's verdict — overrides the judge. */
  review: { better: Better; note: string; at: string } | null;
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
  config: { source_trace_ids: string[]; variants: Variant[]; repeats: number; tool_mode: "recorded" | "live_reads" | "live" };
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
  results?: { name: string; verdicts: Record<Verdict, number>; total: number; avg_cost: number | null; better?: Record<Better, number> }[];
}

export async function apiPost<T>(path: string, body: unknown, method: "POST" | "PATCH" = "POST"): Promise<T> {
  const key = getReadKey();
  const res = await fetch(path, {
    method,
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

// ── Blueprint: app structure read from the agent framework (imagent.publish_blueprint) ──
export interface BpModel { name: string; class: string; provider: string; params?: Record<string, string | number | boolean> }
export interface BpTool { name: string; description: string; args: string[]; builtin: boolean }
export interface BpMiddleware { name: string; class: string; module: string; hooks: string[] }
export interface BpAgent {
  name: string; description: string; model: BpModel | null; system_prompt: string;
  tools: BpTool[]; middleware: BpMiddleware[]; subagents: BpAgent[];
  graph: { nodes: { id: string; type: string }[]; edges: { source: string; target: string; conditional: boolean }[] };
}
export interface BpToolStats { calls: number; errors: number; p50: number; p95: number; last_call: string }
export interface BpAgentStats {
  runs: number; errors: number; p50: number | null; p95: number | null; last_run: string | null; cost: number;
  llm_calls: number; tokens: number; models: { model: string; calls: number; errors: number; cost: number; p50: number; p95: number }[];
  tools: Record<string, BpToolStats>;
}
export interface BlueprintSummary {
  project: string; name: string; framework: string; hash: string; versions: Record<string, string>;
  model: string; agents: number; tools: number; first_seen: string; updated_at: string;
}
export interface Blueprint {
  project: string; name: string; hash: string; first_seen: string; updated_at: string; days: number;
  blueprint: { schema: number; framework: string; versions: Record<string, string>; root: BpAgent };
  stats: Record<string, BpAgentStats>;
}

// ── projects ──
export interface Project {
  id: string; name: string; description: string; key_hint: string; archived: boolean; created_at: string; updated_at: string;
  rubric?: string;
  judge_model?: string; judge_base_url?: string; judge_key_hint?: string;
  github_repo?: string; github_branch?: string; github_path?: string; github_token_hint?: string; github_login?: string;
  engine?: EngineSettings; overview?: string; preferences?: Preferences;
  runs_24h?: number; cost_24h?: number; errors_24h?: number; runs_total?: number; last_trace?: string | null; services?: string[];
}
export interface ProjectList { projects: Project[]; unclaimed: { id: string; runs_total: number; last_trace: string | null }[] }
/** Returned once, on create / rotate. */
export type ProjectWithKey = Project & { key: string };

export type IssueStatus = "open" | "watching" | "fixing" | "resolved" | "ignored" | "incorrect";
export const ISSUE_STATUS: Record<IssueStatus, string> = {
  open: "Open", watching: "Watching", fixing: "Fixing", resolved: "Resolved", ignored: "Ignored", incorrect: "Incorrectly flagged",
};
export interface Evidence { trace_id: string; span_id: string; rule: string; detail: string; note: string; start_time: string }
export type IssueKind = "error" | "loop" | "hallucination" | "task_evasion" | "response_truncation" | "missing_capability"
  | "feature_gap" | "silent_tool_error" | "wrong_tool" | "incorrect_tool_args" | "failed_error_recovery" | "agent_looping"
  | "flawed_plan" | "prompt_drift" | "guardrail_bypass" | "pii_leak" | "context_explosion";
export const ISSUE_KIND: Record<IssueKind, string> = {
  error: "Error", loop: "Agent looping", hallucination: "Hallucination", task_evasion: "Task evasion",
  response_truncation: "Response truncation", missing_capability: "Missing capability awareness", feature_gap: "Feature gap",
  silent_tool_error: "Silent tool error", wrong_tool: "Wrong tool", incorrect_tool_args: "Incorrect tool args",
  failed_error_recovery: "Failed error recovery", agent_looping: "Agent looping", flawed_plan: "Flawed plan",
  prompt_drift: "System prompt drift", guardrail_bypass: "Guardrail bypass", pii_leak: "PII leak", context_explosion: "Context explosion",
};
/** Issue kinds a model files (and that get a per-issue check). */
export const AI_ISSUE_KINDS: IssueKind[] = ["hallucination", "task_evasion", "missing_capability", "feature_gap", "silent_tool_error",
  "wrong_tool", "incorrect_tool_args", "failed_error_recovery", "agent_looping", "flawed_plan", "prompt_drift", "guardrail_bypass", "pii_leak"];
export interface Signal { span_id: string; category: IssueKind; rule: string; issue_id: string; location: string; value: number; detail: string }
export type Severity = "high" | "medium" | "low";
export interface Issue {
  project: string; id: string; kind: IssueKind; title: string; location: string; agent: string; message: string;
  runs: number; events: number; failed_runs: number; first_seen: string; last_seen: string; trace_ids: string[];
  status: IssueStatus; resolved_at: string | null; severity: Severity; peak?: number; level?: string; status_reason?: string;
  diagnosis_status?: "" | DiagnosisStatus; summary?: string; category?: string;
}
export type DiagnosisStatus = "running" | "done" | "error";
export interface FixChange { path: string; diff: string; applies: boolean | null; edits?: { find: string; replace: string }[]; problem?: string }
export interface FixBranch { branch: string; commit: string; url: string; base: string; pr_number: number; pr_url: string; draft: boolean; at: string }
export interface DiagnosisResult {
  title: string; category: string; summary: string; root_cause: string; evidence: string[];
  fix: { explanation: string; changes: FixChange[] }; verify: string; confidence: "high" | "medium" | "low";
  focus: { span_id: string; name: string; kind: string } | null;
  files: { path: string; lines: number[] }[]; repo: { repo: string; branch: string; commit: string } | null;
  code_error: string; model: string; cost: number; at: string; trace_id?: string; fix_branch?: FixBranch;
}
export interface Diagnosis {
  target: string; status: DiagnosisStatus; error: string; note: string; created_at: string; updated_at: string;
  result: DiagnosisResult | Record<string, never>;
}

export interface EngineSettings {
  enabled: boolean; categories: string[]; screener_model: string; investigator_model: string;
  level: "reduced" | "standard" | "expanded"; monthly_cap_usd: number; guarded_tools: string[];
  context_tokens_limit: number; tool_output_chars_limit: number;
}
export interface EngineCategory { label: string; group: string; how: "model" | "rule" | "rule+model"; definition: string }
export interface Feedback {
  id: string; trace_id: string; thread_id: string; score: number | null; comment: string; key: string; source: string;
  user_id: string; created_at: string;
}

export interface Preferences {
  categories: Record<string, { priority: "high" | "medium" | "low"; why: string }>;
  rules: string[]; learned_at: string; pending: unknown[];
}

export interface IssueCheck {
  status: "writing" | "active" | "draft" | "off" | "failed"; instructions?: string; caught?: number; evidence?: number;
  passed?: number; clean?: number; model?: string; cost?: number; created_at?: string;
}
export interface RegressionExample { trace_id: string; request: string; claims: string[] }
export interface FixVerification {
  experiment_id: string; status: "running" | "done"; updated_at: string;
  results: { source: string; replay?: string; result: "pass" | "fail" | "skip" | "error"; reason: string }[];
}
