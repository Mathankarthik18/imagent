import time

from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

import harness_moni as hm
from harness_moni import runtime
from harness_moni import semconv as sc


def test_long_running_span_reported_once_while_open_fast_span_never():
    runtime.shutdown()
    done, pending = InMemorySpanExporter(), InMemorySpanExporter()
    hm.init(service="t", exporters=[done], pending_exporter=pending, pending_delay_s=0.05)
    proc = next(p for p in runtime._state.provider._active_span_processor._span_processors
                if type(p).__name__ == "PendingSpanProcessor")
    try:
        @hm.observe("fast")
        def fast():
            return 1

        fast()
        with hm.harness_context(thread_id="t-live"):
            tracer = runtime.get_tracer()
            with tracer.start_as_current_span("slow", attributes={sc.SPAN_KIND: "agent", sc.INPUT: "big payload"}):
                time.sleep(0.1)
                proc.flush_pending()
                proc.flush_pending()  # second pass must not re-report
                snaps = pending.get_finished_spans()
                assert [s.name for s in snaps] == ["slow"]
                assert snaps[0].attributes["harness.pending"] is True
                assert sc.INPUT not in snaps[0].attributes          # payloads stay out
                assert snaps[0].end_time == snaps[0].start_time
        assert "fast" not in [s.name for s in pending.get_finished_spans()]
    finally:
        runtime.shutdown()
