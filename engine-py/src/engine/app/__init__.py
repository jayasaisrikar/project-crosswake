"""Local, self-contained HTML app explaining the whole engine to non-experts (reports/app/index.html)."""

from __future__ import annotations

from pathlib import Path

from engine.app.collect import collect
from engine.app.render import render, write

__all__ = ["build", "collect", "render", "write"]


def build(root: Path = Path("."), out: Path | None = None) -> Path:
    """Collect from existing repo files and write the single-file app. Never touches the network."""
    return write(collect(root), out or root / "reports/app/index.html")
