"""ai-harness-moni — OpenTelemetry-native tracing for LLM agents.

    import harness_moni as hm
    hm.init(service="bosun")            # LangChain/LangGraph auto-instrumented

    @hm.observe(kind="tool")
    def lookup_vessel(imo: str): ...

    with hm.harness_context(thread_id=email_thread_id, user_id=user.id):
        graph.invoke(...)
"""

from .context import harness_context
from .decorators import observe
from .redact import default_redactor, make_redactor
from .runtime import HarnessConfig, flush, get_config, init, shutdown


def get_callback_handler():
    """LangChain callback handler (only needed when auto_instrument_langchain=False)."""
    from .integrations.langchain import get_callback_handler as _get

    return _get()


__all__ = [
    "HarnessConfig",
    "default_redactor",
    "flush",
    "get_callback_handler",
    "get_config",
    "harness_context",
    "init",
    "make_redactor",
    "observe",
    "shutdown",
]
__version__ = "0.1.0"
