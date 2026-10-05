# imagent (Python SDK)

OpenTelemetry-native tracing for LLM agents. Spans follow the OTel GenAI
semantic conventions (`gen_ai.*`) plus `imagent.*` extensions, so they work in
the Imagent UI **and** any OTel backend (SigNoz, Jaeger, Tempo).

```bash
pip install -e ./sdk            # or: uv pip install -e ./sdk
```

```python
import imagent

imagent.init(service="bosun", endpoint="http://localhost:8300")   # or IMAGENT_* env vars
# Every LangChain / LangGraph run is now traced — no callbacks=[...] needed.

@imagent.observe(kind="tool")
def lookup_vessel(imo: str): ...

with imagent.context(thread_id=email_thread_id, user_id=user_id, tags=["email"]):
    await graph.ainvoke(...)
```

| Env var | Default | Meaning |
|---|---|---|
| `IMAGENT_ENABLED` | `true` | master switch |
| `IMAGENT_ENDPOINT` | `http://localhost:8300` | imagent server (OTLP/HTTP at `/v1/traces`) |
| `IMAGENT_API_KEY` | – | sent as `x-imagent-key` |
| `IMAGENT_SERVICE` | `OTEL_SERVICE_NAME` / `default` | project name in the UI |
| `IMAGENT_ENVIRONMENT` | – | `deployment.environment` |
| `IMAGENT_CAPTURE_CONTENT` | `true` | capture prompts / completions / tool I/O |
| `IMAGENT_MAX_CONTENT_CHARS` | `32000` | per-payload truncation |
| `IMAGENT_SAMPLE_RATE` | `1.0` | trace-id ratio sampling |
| `IMAGENT_EXTRA_OTLP_ENDPOINTS` | – | comma list, e.g. a SigNoz collector |

Redaction: secrets (API keys, bearer tokens, JWTs, private keys) and Luhn-valid
card numbers are masked by default. `imagent.init(redact=imagent.make_redactor(emails=True, phones=True))`
for stricter masking, or pass any `Callable[[str], str]`.
