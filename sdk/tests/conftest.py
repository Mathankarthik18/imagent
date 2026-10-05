import pytest
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

import harness_moni as hm
from harness_moni import runtime


class Spans:
    def __init__(self, exporter: InMemorySpanExporter):
        self.exporter = exporter

    def all(self):
        hm.flush()
        return list(self.exporter.get_finished_spans())

    def by_name(self, name):
        matches = [s for s in self.all() if s.name == name]
        assert matches, f"no span named {name!r}; have {[s.name for s in self.all()]}"
        return matches[0]

    def children(self, parent):
        return [s for s in self.all() if s.parent is not None and s.parent.span_id == parent.context.span_id]


@pytest.fixture
def spans():
    runtime.shutdown()
    exporter = InMemorySpanExporter()
    hm.init(service="test", exporters=[exporter], environment="test")
    yield Spans(exporter)
    runtime.shutdown()
