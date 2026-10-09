"""DSR sensitivity to the assumed number of trials N, plus effective-N from trial correlations.

Run: uv run python experiments/dsr_sensitivity.py
  1. Re-runs the 9-variant trend grid (pipeline.trend_trial_grid) on the 16-coin universe over the
     full sample (2020-01 .. last bar) at 1x costs, using current engine code.
  2. Effective N of the grid from the eigenvalues of the trial daily-return correlation matrix:
       N_eff_PR = (sum l)^2 / sum l^2      (participation ratio)
       N_eff_ent = exp(-sum p ln p), p = l / sum l   (entropy / Roy-Vetterli effective rank)
  3. DSR of the selected trend config for N in {9, 20, 50, 100}: synthetic trial Sharpe sets whose
     sample std equals the observed grid std (normal quantiles rescaled), fed to
     engine.validation.stats.deflated_sharpe.
Writes experiments/dsr_sensitivity.json.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats as st

from engine.backtest.engine import run_backtest
from engine.data.load import load_dataset
from engine.pipeline import _cost_model, load_config, trend_trial_grid
from engine.signals.trend import TrendStrategy
from engine.validation import metrics
from engine.validation.stats import deflated_sharpe, expected_max_sharpe

ROOT = Path(__file__).resolve().parents[1]
NS = (9, 20, 50, 100)


def synthetic_sharpes(n: int, sd: float, mean: float) -> list[float]:
    q = st.norm.ppf((np.arange(1, n + 1) - 0.5) / n)
    q = (q - q.mean()) / q.std(ddof=1)
    return list(mean + sd * q)


def main() -> None:
    uni, exp = load_config("universe.yaml"), load_config("experiment.yaml")
    data = load_dataset(str(ROOT / "data" / "cleaned"), symbols=uni["symbols"])
    cm = _cost_model(exp, 1.0)
    cap = float(exp["initial_capital"])
    rets: dict[str, pd.Series] = {}
    for p in trend_trial_grid(exp):
        key = f"L{p['lookbacks_days']}_vt{p['vol_target_annual']}"
        res = run_backtest(TrendStrategy(p), data, cm, cap, name=key)
        rets[key] = metrics.daily_returns(res.returns)
    df = pd.DataFrame(rets).dropna()
    sr_daily = df.mean() / df.std(ddof=1)
    base_key = (f"L{exp['strategies']['trend']['lookbacks_days']}"
                f"_vt{exp['strategies']['trend']['vol_target_annual']}")
    selected = df[base_key]

    lam = np.clip(np.linalg.eigvalsh(df.corr().to_numpy()), 0, None)
    n_pr = float(lam.sum() ** 2 / (lam**2).sum())
    p = lam[lam > 0] / lam.sum()
    n_ent = float(math.exp(-(p * np.log(p)).sum()))

    sd, mu = float(sr_daily.std(ddof=1)), float(sr_daily.mean())
    rows = []
    for n in NS:
        trials = list(sr_daily) if n == len(sr_daily) else synthetic_sharpes(n, sd, mu)
        rows.append({
            "N": n,
            "E_max_SR_annual": expected_max_sharpe(trials) * math.sqrt(365),
            "DSR": deflated_sharpe(selected, trials),
            "synthetic": n != len(sr_daily),
        })
    # Stress: trial dispersion of a broader search is likely larger than this narrow grid.
    for mult in (2.0, 3.0):
        for n in NS:
            rows.append({
                "N": n, "sd_mult": mult,
                "E_max_SR_annual": expected_max_sharpe(synthetic_sharpes(n, sd * mult, mu)) * math.sqrt(365),
                "DSR": deflated_sharpe(selected, synthetic_sharpes(n, sd * mult, mu)),
                "synthetic": True,
            })
    out = {
        "period": [str(df.index[0]), str(df.index[-1])],
        "n_days": len(df),
        "selected": base_key,
        "selected_sharpe_annual": float(selected.mean() / selected.std(ddof=1) * math.sqrt(365)),
        "trial_sharpe_annual": {k: float(v * math.sqrt(365)) for k, v in sr_daily.items()},
        "trial_sharpe_sd_annual": sd * math.sqrt(365),
        "mean_pairwise_corr": float(df.corr().to_numpy()[np.triu_indices(len(df.columns), 1)].mean()),
        "eigenvalues": [float(x) for x in sorted(lam, reverse=True)],
        "n_eff_participation_ratio": n_pr,
        "n_eff_entropy": n_ent,
        "dsr_table": rows,
    }
    (ROOT / "experiments" / "dsr_sensitivity.json").write_text(json.dumps(out, indent=1))
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
