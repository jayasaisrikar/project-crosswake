"""Run the predictive lead-lag tests (§4.C Granger, §4.E rolling lag, §4.G OOS R^2) on the DEV window
and write the evidence tables to reports/leadlag/. Holdout is never touched here.

Usage: uv run python -m engine.leadlag.research_predictive [config/leadlag.yaml]
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pandas as pd
import yaml

from engine.data.load import load_dataset
from engine.leadlag.events import log_returns
from engine.leadlag.predictive import granger_table, oos_predictive_r2, rolling_lag_stability
from engine.validation.walkforward import ExperimentRegistry

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "reports" / "leadlag"


def _cfg(path: str) -> dict[str, Any]:
    with open(path, encoding="utf-8") as f:
        return dict(yaml.safe_load(f))


def run(cfg: dict[str, Any], p: int = 6) -> dict[str, pd.DataFrame]:
    OUT.mkdir(parents=True, exist_ok=True)
    leader, fol = cfg["leader"], list(cfg["followers"])
    ds = load_dataset(cfg["data_root"], symbols=[leader, *fol]).perp
    r = log_returns(ds.close, ds.is_filled)
    dev_end = pd.Timestamp(cfg["dev_end"], tz="UTC")
    r = r.loc[r.index <= dev_end]                       # DEV ONLY (holdout stays locked)
    r_btc, r_alt = r[leader], r[[c for c in fol if c in r.columns]]

    exp = _cfg(str(ROOT / "config" / "experiment.yaml"))
    wf = exp["walk_forward"]
    window, step = int(cfg["beta_lookback_bars"]), 24 * 7   # weekly rolling-lag sampling
    max_lag = int(cfg["max_lag"])

    gr = granger_table(r_alt, r_btc, p)
    rl = rolling_lag_stability(r_alt, r_btc, window, max_lag, step)
    oos = oos_predictive_r2(r_alt, r_btc, p, int(wf["train_months"]), int(wf["test_months"]),
                            int(wf["embargo_bars"]))

    gr.to_csv(OUT / "predictive_granger.csv", index=False)
    rl.to_csv(OUT / "rolling_lag.csv", index=False)
    oos.to_csv(OUT / "predictive_oos.csv", index=False)

    reg = ExperimentRegistry(str(ROOT / "experiments" / "registry.jsonl"))
    reg.log(strategy="leadlag_predictive",
            params={"lags": p, "max_lag": max_lag, "window_bars": window, "segment": "dev"},
            metrics={"n_followers": int(r_alt.shape[1]),
                     "n_granger_fdr_reject": int(gr["fdr_reject"].sum()) if len(gr) else 0,
                     "median_granger_p": float(gr["p_value"].median()) if len(gr) else None,
                     "n_oos_incremental_positive": int((oos["incremental"] > 0).sum()) if len(oos) else 0,
                     "median_incremental_oos_r2": float(oos["incremental"].median()) if len(oos) else None},
            data_hash="")

    pd.set_option("display.width", 200, "display.max_columns", 20)
    print("=== Granger (lagged BTC -> alt, controlling own lags; BH-FDR @0.10) ===")
    print(gr.round(4).to_string(index=False))
    print("\n=== Rolling best-lag stability ===")
    print(rl.to_string(index=False))
    print("\n=== Walk-forward OOS R^2 (own vs own+BTC lags) ===")
    print(oos.to_string(index=False))
    return {"granger": gr, "rolling_lag": rl, "oos": oos}


if __name__ == "__main__":
    run(_cfg(sys.argv[1] if len(sys.argv) > 1 else str(ROOT / "config" / "leadlag.yaml")))
