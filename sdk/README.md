# ai-harness-moni (Python SDK)

OpenTelemetry-native tracing for LLM agents. Spans follow the OTel GenAI
semantic conventions (`gen_ai.*`) plus `harness.*` extensions, so they work in
the Harness UI **and** any OTel backend (SigNoz, Jaeger, Tempo).

```bash
pip install -e ./sdk            # or: uv pip install -e ./sdk
```

```python
import harness_moni as hm

hm.init(service="bosun", endpoint="http://localhost:8300")   # or HARNESS_* env vars
# Every LangChain / LangGraph run is now traced — no callbacks=[...] needed.

@hm.observe(kind="tool")
def lookup_vessel(imo: str): ...

with hm.harness_context(thread_id=email_thread_id, user_id=user_id, tags=["email"]):
    await graph.ainvoke(...)
```

| Env var | Default | Meaning |
|---|---|---|
| `HARNESS_ENABLED` | `true` | master switch |
| `HARNESS_ENDPOINT` | `http://localhost:8300` | harness server (OTLP/HTTP at `/v1/traces`) |
| `HARNESS_API_KEY` | – | sent as `x-harness-key` |
| `HARNESS_SERVICE` | `OTEL_SERVICE_NAME` / `default` | project name in the UI |
| `HARNESS_ENVIRONMENT` | – | `deployment.environment` |
| `HARNESS_CAPTURE_CONTENT` | `true` | capture prompts / completions / tool I/O |
| `HARNESS_MAX_CONTENT_CHARS` | `32000` | per-payload truncation |
| `HARNESS_SAMPLE_RATE` | `1.0` | trace-id ratio sampling |
| `HARNESS_EXTRA_OTLP_ENDPOINTS` | – | comma list, e.g. a SigNoz collector |

Redaction: secrets (API keys, bearer tokens, JWTs, private keys) and Luhn-valid
card numbers are masked by default. `hm.init(redact=hm.make_redactor(emails=True, phones=True))`
for stricter masking, or pass any `Callable[[str], str]`.
