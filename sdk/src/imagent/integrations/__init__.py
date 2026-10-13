"""Framework integrations, switched on by ``imagent.init()`` for whatever is installed."""

from __future__ import annotations

import logging

logger = logging.getLogger("imagent")


def auto_install() -> list[str]:
    """Instrument every supported framework that's importable. Returns the ones installed."""
    on: list[str] = []
    for name, module in (("openai", "openai_sdk"), ("anthropic", "anthropic_sdk"), ("openai-agents", "openai_agents"),
                         ("llamaindex", "llamaindex"), ("crewai", "crewai")):
        try:
            mod = __import__(f"{__name__}.{module}", fromlist=["install"])
            if mod.install():
                on.append(name)
        except Exception as exc:  # noqa: BLE001 — an integration must never break init()
            logger.warning("imagent: %s integration not installed: %s", name, exc)
    if on:
        logger.info("imagent: instrumented %s", ", ".join(on))
    return on
