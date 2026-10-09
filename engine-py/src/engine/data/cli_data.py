"""Entry points used by the main CLI. cfg = parsed config/universe.yaml."""

from __future__ import annotations

import logging
from collections import Counter
from pathlib import Path
from typing import Any

from engine.data.clean import clean_all
from engine.data.download import download_all, month_range

log = logging.getLogger(__name__)


def run_download(cfg: dict[str, Any], raw_root: str | Path = "data/raw", workers: int = 8) -> dict[str, int]:
    months = month_range(str(cfg.get("start", "2020-01")), cfg.get("end"))
    kinds = [m for m in cfg.get("markets", ["spot", "perp"])]
    if "perp" in kinds:
        kinds.append("funding")
    results = download_all(
        cfg["symbols"], months, kinds=kinds, raw_root=raw_root,
        quote=cfg.get("quote", "USDT"), interval=cfg.get("interval", "1h"), workers=workers,
    )
    counts = dict(Counter(r.status for r in results))
    errors = [r for r in results if r.status == "error"]
    for r in errors:
        log.warning("download error %s: %s", r.url, r.error)
    log.info("download done: %s", counts)
    return counts


def run_clean(cfg: dict[str, Any], raw_root: str | Path = "data/raw",
              out_root: str | Path = "data/cleaned") -> dict[str, Any]:
    return clean_all(cfg["symbols"], cfg.get("markets", ["spot", "perp"]), raw_root, out_root)
