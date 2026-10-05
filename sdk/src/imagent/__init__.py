"""imagent — OpenTelemetry-native tracing for LLM agents.

    import imagent
    imagent.init(service="bosun")            # LangChain/LangGraph auto-instrumented

    @imagent.observe(kind="tool")
    def lookup_vessel(imo: str): ...

    with imagent.context(thread_id=email_thread_id, user_id=user.id):
        graph.invoke(...)
"""

from ._context import context
from .decorators import observe
from .redact import default_redactor, make_redactor
from .runtime import ImagentConfig, flush, get_config, init, shutdown


def get_callback_handler():
    """LangChain callback handler (only needed when auto_instrument_langchain=False)."""
    from .integrations.langchain import get_callback_handler as _get

    return _get()


__all__ = [
    "ImagentConfig",
    "default_redactor",
    "flush",
    "get_callback_handler",
    "get_config",
    "context",
    "init",
    "make_redactor",
    "observe",
    "shutdown",
]
__version__ = "0.1.0"
