"""Redaction hooks applied to every captured input/output string before export."""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable

Redactor = Callable[[str], str]

_SECRET_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"), "[REDACTED_PRIVATE_KEY]"),
    (re.compile(r"\b(?:sk|pk|rk)-[A-Za-z0-9_\-]{16,}"), "[REDACTED_API_KEY]"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "[REDACTED_AWS_KEY]"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b"), "[REDACTED_GITHUB_TOKEN]"),
    (re.compile(r"\bxox[abpr]-[A-Za-z0-9\-]{10,}"), "[REDACTED_SLACK_TOKEN]"),
    (re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-~+/]{16,}=*"), "Bearer [REDACTED]"),
    (re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}"), "[REDACTED_JWT]"),
]
_CARD = re.compile(r"\b(?:\d[ -]?){13,19}\b")
_EMAIL = re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")
_PHONE = re.compile(r"(?<!\w)\+?\d[\d ()\-]{8,}\d(?!\w)")


def _luhn_ok(digits: str) -> bool:
    total, alt = 0, False
    for ch in reversed(digits):
        d = int(ch)
        if alt:
            d = d * 2 - 9 if d > 4 else d * 2
        total += d
        alt = not alt
    return total % 10 == 0


def _mask_cards(text: str) -> str:
    def repl(m: re.Match[str]) -> str:
        digits = re.sub(r"\D", "", m.group(0))
        return "[REDACTED_CARD]" if 13 <= len(digits) <= 19 and _luhn_ok(digits) else m.group(0)
    return _CARD.sub(repl, text)


def make_redactor(
    *,
    secrets: bool = True,
    cards: bool = True,
    emails: bool = False,
    phones: bool = False,
    extra_patterns: Iterable[tuple[str | re.Pattern[str], str]] = (),
) -> Redactor:
    """Build a redactor. Secrets and card numbers are on by default; emails and
    phones are opt-in because agent debugging usually needs them."""
    extra = [(re.compile(p) if isinstance(p, str) else p, r) for p, r in extra_patterns]

    def redact(text: str) -> str:
        if secrets:
            for pat, repl in _SECRET_PATTERNS:
                text = pat.sub(repl, text)
        if cards:
            text = _mask_cards(text)
        if emails:
            text = _EMAIL.sub("[REDACTED_EMAIL]", text)
        if phones:
            text = _PHONE.sub("[REDACTED_PHONE]", text)
        for pat, repl in extra:
            text = pat.sub(repl, text)
        return text

    return redact


default_redactor: Redactor = make_redactor()
