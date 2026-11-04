"""Why each source did or didn't make it, recorded once and reported everywhere.

Reasons are kept short, written into briefing.json (so the page can show them), and, on
GitHub Actions, emitted as workflow annotations. Annotations appear on the public run page
without signing in, so a failed run explains itself.
"""
from __future__ import annotations

import os
import traceback

REASONS: dict[str, str] = {}


def short(e: BaseException) -> str:
    """One readable line: exception type, message, and the frame it came from."""
    tb = traceback.extract_tb(e.__traceback__)
    where = f" ({os.path.basename(tb[-1].filename)}:{tb[-1].lineno})" if tb else ""
    msg = " ".join(str(e).split())[:220]
    return f"{type(e).__name__}: {msg}{where}"


def fail(label: str, reason: str) -> None:
    REASONS[label] = reason
    annotate("warning", f"{label} unavailable", reason)


def annotate(level: str, title: str, message: str) -> None:
    if os.environ.get("GITHUB_ACTIONS") == "true":
        clean = message.replace("%", "%25").replace("\r", "").replace("\n", "%0A")
        print(f"::{level} title={title}::{clean}", flush=True)
