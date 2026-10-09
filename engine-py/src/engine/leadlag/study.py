"""Run the event study + lagged cross-correlations; writes CSVs to reports/leadlag/.

Usage: uv run python -m engine.leadlag.study [config/leadlag.yaml]
"""

from __future__ import annotations

import sys
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


def run(cfg: dict[str, Any]) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    leader, fol = cfg["leader"], list(cfg["followers"])
    ds = load_dataset(cfg["data_root"], symbols=[leader, *fol])
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
    run(load_cfg(sys.argv[1] if len(sys.argv) > 1 else "config/leadlag.yaml"))
