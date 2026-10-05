import os

# Must be set before harness_server modules are imported.
os.environ.setdefault("CLICKHOUSE_DATABASE", "harness_test")
os.environ.setdefault("CLICKHOUSE_USER", "harness")
os.environ.setdefault("CLICKHOUSE_PASSWORD", "harness")
os.environ.setdefault("HARNESS_INGEST_KEY", "ingest-secret")
os.environ.setdefault("HARNESS_READ_KEY", "")
os.environ.setdefault("HARNESS_UI_DIR", "/nonexistent")
os.environ.setdefault("HARNESS_STITCH", "false")  # tests call /api/stitch explicitly
os.environ.setdefault("HARNESS_PRICE_SYNC", "false")  # no network in tests

import pytest
from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter


@pytest.fixture
def sdk_spans():
    """Run code under the real harness SDK and return the finished spans."""
    import harness_moni as hm
    from harness_moni import runtime

    runtime.shutdown()
    exporter = InMemorySpanExporter()
    hm.init(service="bosun-test", exporters=[exporter], environment="test")

    def collect():
        hm.flush()
        return list(exporter.get_finished_spans())

    yield collect
    runtime.shutdown()


def otlp_bytes(spans) -> bytes:
    return encode_spans(spans).SerializeToString()
