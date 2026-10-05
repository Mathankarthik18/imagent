import os

# Must be set before imagent_server modules are imported.
os.environ.setdefault("CLICKHOUSE_DATABASE", "imagent_test")
os.environ.setdefault("CLICKHOUSE_USER", "imagent")
os.environ.setdefault("CLICKHOUSE_PASSWORD", "imagent")
os.environ.setdefault("IMAGENT_INGEST_KEY", "ingest-secret")
os.environ.setdefault("IMAGENT_READ_KEY", "")
os.environ.setdefault("IMAGENT_UI_DIR", "/nonexistent")
os.environ.setdefault("IMAGENT_STITCH", "false")  # tests call /api/stitch explicitly
os.environ.setdefault("IMAGENT_PRICE_SYNC", "false")  # no network in tests

import pytest
from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter


@pytest.fixture
def sdk_spans():
    """Run code under the real imagent SDK and return the finished spans."""
    import imagent
    from imagent import runtime

    runtime.shutdown()
    exporter = InMemorySpanExporter()
    imagent.init(service="bosun-test", exporters=[exporter], environment="test")

    def collect():
        imagent.flush()
        return list(exporter.get_finished_spans())

    yield collect
    runtime.shutdown()


def otlp_bytes(spans) -> bytes:
    return encode_spans(spans).SerializeToString()
