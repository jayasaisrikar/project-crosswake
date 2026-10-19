"""Write reports/regimes/summary.md (+ labels.parquet) on data strictly before H2_START.

Usage: uv run python -m engine.regimes.report
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from engine.data.load import load_dataset
from engine.regimes.api import RULE_COLUMNS, labels, transition_stats
from engine.research.contract import H2_START

OUT = Path("reports/regimes")
UNIVERSE = ["BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "DOGE", "AVAX", "DOT", "LINK", "LTC", "BCH", "TRX"]


def md_table(df: pd.DataFrame) -> str:
    """Minimal markdown table (no tabulate dependency)."""
    d = df.round(4).reset_index()
    head = "| " + " | ".join(map(str, d.columns)) + " |"
    sep = "|" + "---|" * len(d.columns)
    rows = ["| " + " | ".join("" if pd.isna(v) else str(v) for v in r) + " |"
            for r in d.itertuples(index=False)]
    return "\n".join([head, sep, *rows])


def run(root: str = "data/cleaned") -> pd.DataFrame:
    OUT.mkdir(parents=True, exist_ok=True)
    ds = load_dataset(root, symbols=UNIVERSE, end=H2_START - pd.Timedelta(hours=1))
    lab = labels(ds)
    assert lab.index.max() < H2_START
    lab.to_parquet(OUT / "labels.parquet")
    r_btc = np.log(ds.perp.close["BTC"]).diff().shift(-1)  # next-bar return, for description only
    lines = ["# Regime summary (data < H2_START = 2025-10-01, sealed holdout untouched)", "",
             f"Bars: {len(lab)} hourly, {lab.index.min()} -> {lab.index.max()}.",
             f"Universe: {', '.join(UNIVERSE)}.",
             "All labels causal (row t uses bars <= t); thresholds are expanding quantiles of past values;",
             "HMM = 2-state Gaussian on daily BTC log returns, monthly expanding refits,",
             "FILTERED (forward-only) probabilities;",
             "CUSUM on daily variance. Daily labels apply from the next UTC day.", "",
             "Next-bar BTC return by state is descriptive (ex-post) and NOT a trading result.", ""]
    for col in [*RULE_COLUMNS, "hmm_state"]:
        s = lab[col]
        desc = pd.DataFrame({"share": s.value_counts(normalize=True),
                             "next_1h_btc_mean_bps": r_btc.groupby(s).mean() * 1e4,
                             "next_1h_btc_vol_bps": r_btc.groupby(s).std() * 1e4})
        lines += [f"## {col}", "", f"Coverage: {s.notna().mean():.1%} of bars labelled.", "",
                  md_table(desc), "",
                  "Transition matrix (hourly, row = from):", "", md_table(transition_stats(s)), ""]
    cp = lab["cp_flag"].resample("1D").first()
    lines += ["## CUSUM change points", "",
              f"Vol-up alarms: {(cp == 1).sum()}, vol-down alarms: {(cp == -1).sum()} "
              f"over {cp.notna().sum()} days.",
              "", "Dates (vol-up): " + ", ".join(str(d.date()) for d in cp[cp == 1].index[:40]), ""]
    (OUT / "summary.md").write_text("\n".join(lines), encoding="utf-8")
    return lab


if __name__ == "__main__":
    run()
