"""Run the event study + lagged cross-correlations; writes CSVs to reports/leadlag/.

Usage: uv run python -m engine.leadlag.study [config/leadlag.yaml] [--open-h2 --reason "..."]

By default the data stop before H2_START (2025-10-01, sealed; AUDIT_REPORT B8): the "holdout" segment
is H1 only (consumed, ordinary OOS) and no per-year segment reaches H2. `--open-h2` includes H2 and
appends a logged view (with params_hash) to experiments/holdout_log.jsonl.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import pandas as pd
import yaml

from engine.data.load import load_dataset
from engine.leadlag.events import (
    detect_impulses,
    event_panel,
    lagged_xcorr,
    log_returns,
    rolling_beta,
    summarize,
)

OUT = Path("reports/leadlag")


def load_cfg(path: str = "config/leadlag.yaml") -> dict[str, Any]:
    with open(path) as f:
        return dict(yaml.safe_load(f))


def cfg_hash(cfg: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(cfg, sort_keys=True, default=str).encode()).hexdigest()[:16]


def run(cfg: dict[str, Any], open_h2: bool = False, reason: str = "",
        log_path: str | Path | None = None) -> None:
    from engine.pipeline import h2_last_bar, log_holdout_view

    leader, fol = cfg["leader"], list(cfg["followers"])
    if open_h2:
        log_holdout_view(reason, cfg_hash(cfg), source="leadlag.study --open-h2", window="H2",
                         log_path=log_path)
    OUT.mkdir(parents=True, exist_ok=True)
    ds = load_dataset(cfg["data_root"], symbols=[leader, *fol])
    if not open_h2:
        ds = ds.truncate(h2_last_bar())
    md = ds.perp
    r = log_returns(md.close, md.is_filled)
    r_btc, r_alt = r[leader], r[fol]
    beta = rolling_beta(r_alt, r_btc, int(cfg["beta_lookback_bars"]))
    hs = [int(h) for h in cfg["horizons"]]
    dev_end = pd.Timestamp(cfg["dev_end"], tz="UTC")
    cols = ["gap"] + [f"raw_{h}" for h in hs] + [f"abn_{h}" for h in hs]
    lags = {c: (int(c.split("_")[1]) if "_" in c else 1) for c in cols}

    tables = []
    for k in cfg["k_values"]:
        imp = detect_impulses(r_btc, float(k), int(cfg["vol_lookback_bars"]))
        panel = event_panel(r_alt, r_btc, imp, beta, hs)
        ts = pd.DatetimeIndex(panel.index.get_level_values("ts"))
        segs: dict[str, pd.DataFrame] = {"dev": panel[ts <= dev_end], "holdout": panel[ts > dev_end]}
        for y in sorted(set(ts.year)):
            segs[str(y)] = panel[ts.year == y]
        for seg, p in segs.items():
            s = summarize(p, cols, lags)
            s["k"], s["segment"], s["n_events"] = k, seg, p.index.get_level_values("ts").nunique()
            tables.append(s.reset_index())
        panel.to_csv(OUT / f"events_k{k:g}.csv")
    res = pd.concat(tables, ignore_index=True)
    res.to_csv(OUT / "event_study.csv", index=False)

    xc = {}
    ridx = pd.DatetimeIndex(r.index)
    for y in sorted(set(ridx.year)):
        m = ridx.year == y
        xc[str(y)] = lagged_xcorr(r_alt[m], r_btc[m], int(cfg["max_lag"]))
    xc_df = pd.DataFrame(xc).T
    xc_df.index.name = "year"
    xc_df.to_csv(OUT / "xcorr_by_year.csv")

    pd.set_option("display.width", 200)
    show = res[res.segment.isin(["dev", "holdout"])].round(3)
    print(show.to_string())
    print(res[res.metric.isin(["gap", "raw_1", "abn_1", "abn_4"])].round(3).to_string())
    print(xc_df.round(4).to_string())


if __name__ == "__main__":
    ap = argparse.ArgumentParser(prog="engine.leadlag.study")
    ap.add_argument("config", nargs="?", default="config/leadlag.yaml")
    ap.add_argument("--open-h2", action="store_true", help="include sealed H2 (logged)")
    ap.add_argument("--reason", default="")
    a = ap.parse_args()
    run(load_cfg(a.config), open_h2=a.open_h2, reason=a.reason)
