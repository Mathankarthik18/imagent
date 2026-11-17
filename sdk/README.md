# imagent (Python SDK)

OpenTelemetry-native tracing for LLM agents. Spans follow the OTel GenAI
semantic conventions (`gen_ai.*`) plus `imagent.*` extensions, so they work in
the Imagent UI **and** any OTel backend (SigNoz, Jaeger, Tempo).

```bash
pip install "imagent @ git+https://github.com/Mathankarthik18/imagent.git#subdirectory=sdk"
echo "IMAGENT_API_KEY=imk_…" >> .env    # the project key from the imagent UI
```

```python
import imagent

imagent.init()   # reads IMAGENT_* from the environment or ./.env
# Every LangChain / LangGraph / deepagents run is now traced — no callbacks=[...] needed.
# (imagent.init_if_configured() does nothing unless a key/endpoint is set, and stays off under pytest.)

@imagent.observe(kind="tool")
def lookup_vessel(imo: str): ...

with imagent.context(thread_id=email_thread_id, user_id=user_id, tags=["email"]):
    await graph.ainvoke(...)

# A user's 👍/👎 on an answer — the issue engine reads 👎 runs first
imagent.feedback(thread_id=email_thread_id, score=0, comment="wrong vessel")
```

What the SDK records for the issue engine, with no extra code:

- `thread_id` / `user_id` from LangChain's `config["metadata"]` (as set for LangSmith)
- human-in-the-loop pauses (`interrupt()`, e.g. an approval gate) as `imagent.interrupt`, and the
  decision a resumed run got as `imagent.resume` — how *guardrail bypass* is detected
- long payloads keep their start **and** end, so a model call keeps both its system prompt and its
  latest messages

| Env var | Default | Meaning |
|---|---|---|
| `IMAGENT_ENABLED` | `true` | master switch (`init_if_configured` is off under pytest unless `true`) |
| `IMAGENT_ENDPOINT` | `http://localhost:8300` | imagent server (OTLP/HTTP at `/v1/traces`) |
| `IMAGENT_API_KEY` | – | sent as `x-imagent-key` |
| `IMAGENT_SERVICE` | `OTEL_SERVICE_NAME` / `default` | project name in the UI |
| `IMAGENT_ENVIRONMENT` | – | `deployment.environment` |
| `IMAGENT_CAPTURE_CONTENT` | `true` | capture prompts / completions / tool I/O |
| `IMAGENT_MAX_CONTENT_CHARS` | `32000` | per-payload truncation (start and end kept) |
| `IMAGENT_EXPERIMENTS` | `false` | let this app replay runs for experiments and fix verification |
| `IMAGENT_SAMPLE_RATE` | `1.0` | trace-id ratio sampling |
| `IMAGENT_EXTRA_OTLP_ENDPOINTS` | – | comma list, e.g. a SigNoz collector |

Redaction: secrets (API keys, bearer tokens, JWTs, private keys) and Luhn-valid
card numbers are masked by default. `imagent.init(redact=imagent.make_redactor(emails=True, phones=True))`
for stricter masking, or pass any `Callable[[str], str]`.
