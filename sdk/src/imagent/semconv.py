"""Span attribute names.

LLM attributes follow the OpenTelemetry GenAI semantic conventions (``gen_ai.*``)
so any OTel backend (SigNoz, Jaeger, Tempo) can read them. Everything the
conventions don't cover lives under ``imagent.*``.
"""

TRACER_NAME = "imagent"

# ── OTel GenAI semantic conventions ──────────────────────────────────────────
GEN_AI_OPERATION = "gen_ai.operation.name"          # chat | text_completion | execute_tool | invoke_agent
GEN_AI_SYSTEM = "gen_ai.system"                     # anthropic | openai | openrouter ...
GEN_AI_REQUEST_MODEL = "gen_ai.request.model"
GEN_AI_RESPONSE_MODEL = "gen_ai.response.model"
GEN_AI_REQUEST_TEMPERATURE = "gen_ai.request.temperature"
GEN_AI_REQUEST_MAX_TOKENS = "gen_ai.request.max_tokens"
GEN_AI_RESPONSE_FINISH_REASONS = "gen_ai.response.finish_reasons"
GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens"     # total prompt tokens, cached included
GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens"
GEN_AI_USAGE_CACHE_READ = "gen_ai.usage.cache_read_input_tokens"
GEN_AI_USAGE_CACHE_WRITE = "gen_ai.usage.cache_creation_input_tokens"
GEN_AI_TOOL_NAME = "gen_ai.tool.name"
GEN_AI_TOOL_CALL_ID = "gen_ai.tool.call.id"
GEN_AI_AGENT_NAME = "gen_ai.agent.name"

# ── imagent extensions ───────────────────────────────────────────────────────
SPAN_KIND = "imagent.span_kind"        # agent | node | chain | llm | tool | retriever | span
ROOT = "imagent.root"                  # True when no imagent span is above this one
INPUT = "imagent.input"                # JSON (possibly truncated)
OUTPUT = "imagent.output"
TOOLS = "imagent.tools"                # JSON list of tool schemas offered to the model
METADATA = "imagent.metadata"          # JSON
TAGS = "imagent.tags"                  # string[]
THREAD_ID = "imagent.thread_id"
USER_ID = "imagent.user_id"
SESSION_ID = "imagent.session_id"
COST_USD = "imagent.cost_usd"          # provider-reported cost, when available
TTFT_MS = "imagent.ttft_ms"            # time to first streamed token
ENVIRONMENT = "deployment.environment"
