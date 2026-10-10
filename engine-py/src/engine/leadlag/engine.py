"""LEAD_LAG_ENGINE (Phase 5): multi-method, multiple-testing-corrected, walk-forward lead-lag study.

Pairs: BTC->alts, ETH->alts, perp->spot and spot->perp (same asset), large-cap basket->small caps.
Lags: 1, 2, 4, 8, 24 hours. Hourly bars are the finest data in data/cleaned, so sub-hour lead-lag
(where the literature finds the effect, seconds-minutes) CANNOT be tested here.

Two layers, kept separate:
  1. Statistics (methods.py) on all data < H2_START, BH-corrected across pairs x lags x methods.
  2. Tradability: expanding walk-forward. The lag (and OLS beta) is selected ONLY on the training
     window and evaluated on the next 6-month test fold; never on the full sample.
Verdict per pair: "EDGE EXISTS" / "EDGE DOES NOT SURVIVE" / "INSUFFICIENT EVIDENCE".

Usage: uv run python -m engine.leadlag.engine
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import statsmodels.api as sm
import yaml

from engine.contracts import Dataset
from engine.costs import CostModel
from engine.data.load import load_dataset
from engine.leadlag import methods as M
from engine.regimes.labelers import trend
from engine.research.contract import H2_START

LAGS = (1, 2, 4, 8, 24)
OUT = Path("reports/leadlag/engine")
ALTS = ["ETH", "BNB", "SOL", "XRP", "ADA", "DOGE", "AVAX", "DOT", "LINK", "LTC", "BCH", "TRX", "EOS"]
SAME_ASSET = ["BTC", "ETH", "BNB", "SOL", "XRP", "DOGE"]
BASKET = ["BTC", "ETH", "BNB", "SOL", "XRP"]
SMALL = ["ZEC", "XTZ", "IOTA", "VET", "THETA", "ALGO"]
TEST_MONTHS = 6
MIN_TRAIN = 24 * 365
REF_NOTIONAL = 10_000.0
ALPHA = 0.05
HOURS_PER_YEAR = 24 * 365

EDGE, NO_EDGE, INSUFF = "EDGE EXISTS", "EDGE DOES NOT SURVIVE", "INSUFFICIENT EVIDENCE"


@dataclass
class Pair:
    pair_id: str
    group: str
    x: pd.Series            # leader hourly log returns
    y: pd.Series            # follower hourly log returns
    symbol: str             # traded follower symbol
    market: str             # traded follower market


def log_rets(ds: Dataset, market: str) -> pd.DataFrame:
    md = ds.market(market)  # type: ignore[arg-type]
    return pd.DataFrame(np.log(md.close.where(~md.is_filled))).diff()


def build_pairs(ds: Dataset) -> list[Pair]:
    rp, rs = log_rets(ds, "perp"), log_rets(ds, "spot")
    pairs: list[Pair] = []
    for lead in ("BTC", "ETH"):
        for a in ALTS:
            if a != lead and a in rp:
                pairs.append(Pair(f"{lead}->{a}", f"{lead}->alts", rp[lead], rp[a], a, "perp"))
    for a in SAME_ASSET:
        if a in rp and a in rs:
            pairs.append(Pair(f"{a}:perp->spot", "perp->spot", rp[a], rs[a], a, "spot"))
            pairs.append(Pair(f"{a}:spot->perp", "spot->perp", rs[a], rp[a], a, "perp"))
    basket = rp[[b for b in BASKET if b in rp]].mean(axis=1, skipna=True)
    for a in SMALL:
        if a in rp:
            pairs.append(Pair(f"LARGE5->{a}", "basket->smallcap", basket, rp[a], a, "perp"))
    return pairs


# ---------------------------------------------------------------- layer 1: statistics
def pair_statistics(p: Pair, lags: tuple[int, ...] = LAGS, n_surr: int = 199) -> list[dict[str, Any]]:
    x, y = p.x, p.y
    rows: list[dict[str, Any]] = []
    tests: dict[str, Callable[[pd.Series, pd.Series, int], dict[str, float]]] = {
        "xcorr": M.lagged_xcorr, "ols_hac": M.lagged_ols_hac, "granger": M.granger,
        "rolling_stability": M.rolling_stability,
        "mutual_info": lambda a, b, L: M.mutual_information(a, b, L, n_surr=n_surr),
        "transfer_entropy": lambda a, b, L: M.transfer_entropy(a, b, L, n_surr=n_surr),
    }
    for L in lags:
        for name, fn in tests.items():
            r = fn(x, y, L)
            rows.append({"pair": p.pair_id, "lag_h": L, "method": name, "stat": r["stat"], "p": r["p"]})
    for L, r in M.var_irf(x, y, list(lags)).items():
        rows.append({"pair": p.pair_id, "lag_h": L, "method": "var_irf", "stat": r["stat"], "p": r["p"]})
    return rows


# ---------------------------------------------------------------- layer 2: walk-forward tradability
def fold_starts(index: pd.DatetimeIndex, end: pd.Timestamp = H2_START) -> list[pd.Timestamp]:
    first = index[0] + pd.Timedelta(hours=MIN_TRAIN)
    s = pd.date_range(first.normalize() + pd.offsets.MonthBegin(0), end, freq=f"{TEST_MONTHS}MS")
    return [t for t in s if t < end]


def _fit(x: pd.Series, y: pd.Series, L: int) -> tuple[float, float, float]:
    """(alpha, beta, HAC t) of y_t = a + b x_{t-L} on the given (training) data."""
    df = pd.concat([x.shift(L), y], axis=1).dropna()
    if len(df) < 500:
        return 0.0, 0.0, 0.0
    res = sm.OLS(df.iloc[:, 1].to_numpy(), sm.add_constant(df.iloc[:, 0].to_numpy())).fit(
        cov_type="HAC", cov_kwds={"maxlags": M.HAC_LAGS})
    return float(res.params[0]), float(res.params[1]), float(res.tvalues[1])


Fit = tuple[float, float, float]


def select_lag(x_train: pd.Series, y_train: pd.Series,
               lags: tuple[int, ...] = LAGS) -> tuple[int, dict[int, Fit]]:
    """Pick the lag with the largest |HAC t| using TRAINING data only."""
    fits = {L: _fit(x_train, y_train, L) for L in lags}
    best = max(lags, key=lambda L: abs(fits[L][2]))
    return best, fits


def side_cost(cm: CostModel, symbol: str, market: str, y_train: pd.Series, qv_train: pd.Series) -> float:
    """One-side cost per unit notional (fees + half-spread + sqrt impact at REF_NOTIONAL), from
    training-window liquidity/vol only."""
    adv = float(qv_train.dropna().tail(24 * 30).sum() / 30) if qv_train.notna().any() else None
    dvol = float(y_train.dropna().tail(24 * 30).std() * math.sqrt(24)) if y_train.notna().any() else None
    cb = cm.trade_cost(symbol, market, REF_NOTIONAL, 1.0, adv, dvol)  # type: ignore[arg-type]
    return float(cb.fees + cb.spread + cb.impact) / REF_NOTIONAL


def strategy_pnl(x: pd.Series, y: pd.Series, a: float, b: float, L: int, cost: float) -> pd.DataFrame:
    """Decision at close of bar t: forecast y_{t+1} = a + b x_{t+1-L} (known at t since L >= 1);
    position = sign(forecast) if |forecast| > round-trip cost else 0; held over bar t+1."""
    pred = a + b * x.shift(L - 1)
    pos = np.sign(pred).where(pred.abs() > 2 * cost, 0.0).fillna(0.0)
    fwd = y.shift(-1)
    gross = (pos * fwd).fillna(0.0)
    tc = cost * pos.diff().abs().fillna(pos.abs())
    return pd.DataFrame({"pred": pred, "pos": pos, "fwd": fwd, "gross": gross, "net": gross - tc})


def walk_forward(p: Pair, cm: CostModel, qv: pd.Series, lags: tuple[int, ...] = LAGS,
                 end: pd.Timestamp = H2_START) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Returns (selected-lag OOS pnl, per-fold log, per-lag OOS pnl for decay)."""
    idx = p.y.dropna().index
    if len(idx) < MIN_TRAIN + 24 * 30:
        return pd.DataFrame(), pd.DataFrame(), pd.DataFrame()
    starts = fold_starts(pd.DatetimeIndex(idx), end)
    sel_parts, lag_parts, folds = [], [], []
    for i, s in enumerate(starts):
        e = starts[i + 1] if i + 1 < len(starts) else end
        tr = slice(None, s - pd.Timedelta(hours=1))
        xt, yt = p.x.loc[tr], p.y.loc[tr]
        best, fits = select_lag(xt, yt, lags)
        cost = side_cost(cm, p.symbol, p.market, yt, qv.loc[tr])
        for L in lags:
            a, b, _ = fits[L]
            pnl = strategy_pnl(p.x.loc[:e], p.y.loc[:e], a, b, L, cost)
            pnl = pnl.loc[(pnl.index >= s) & (pnl.index < e - pd.Timedelta(hours=1))]
            lag_parts.append(pnl.assign(lag_h=L))
            if best == L:
                sel_parts.append(pnl.assign(lag_h=L))
        folds.append({"pair": p.pair_id, "test_start": s, "test_end": e, "selected_lag": best,
                      "train_t": fits[best][2], "cost_side_bps": cost * 1e4})
    fold_df = pd.DataFrame(folds)
    sel = pd.concat(sel_parts) if sel_parts else pd.DataFrame()
    per_lag = pd.concat(lag_parts) if lag_parts else pd.DataFrame()
    if len(fold_df):
        fold_df["oos_net"] = [sel.loc[(sel.index >= r.test_start) & (sel.index < r.test_end), "net"].sum()
                              for r in fold_df.itertuples()]
    return sel, fold_df, per_lag


def _hac_t(v: pd.Series) -> float:
    v = v.dropna()
    if len(v) < 50 or v.std() == 0:
        return math.nan
    res = sm.OLS(v.to_numpy(), np.ones(len(v))).fit(cov_type="HAC", cov_kwds={"maxlags": M.HAC_LAGS})
    return float(res.tvalues[0])


def _ic(df: pd.DataFrame) -> float:
    d = df[["pred", "fwd"]].dropna()
    return float(np.corrcoef(d["pred"], d["fwd"])[0, 1]) if len(d) > 2 else math.nan


def summarize_oos(sel: pd.DataFrame, regimes: pd.Series) -> dict[str, Any]:
    if sel.empty:
        return {"n_oos_bars": 0}
    act = sel[sel["pos"] != 0]
    n_tr = int((sel["pos"].diff().abs().fillna(0) > 0).sum())
    sd = sel["net"].std()
    out: dict[str, Any] = {
        "n_oos_bars": len(sel), "active_bars": len(act), "n_trades": n_tr,
        "oos_ic": _ic(sel) if len(sel) > 50 else math.nan,
        "hit_rate": float((np.sign(act["pos"]) == np.sign(act["fwd"])).mean()) if len(act) else math.nan,
        "expectancy_bps": float(act["net"].mean() * 1e4) if len(act) else math.nan,
        "gross_sharpe": float(sel["gross"].mean() / sel["gross"].std() * math.sqrt(HOURS_PER_YEAR))
        if sel["gross"].std() > 0 else math.nan,
        "net_sharpe": float(sel["net"].mean() / sd * math.sqrt(HOURS_PER_YEAR)) if sd > 0 else math.nan,
        "net_total": float(sel["net"].sum()), "net_hac_t": _hac_t(sel["net"]),
    }
    g = sel["net"].groupby(regimes.reindex(sel.index)).mean() * 1e4
    out["net_bps_by_trend"] = ", ".join(f"{k}:{v:+.2f}" for k, v in g.items())
    return out


def verdict(bh_sig: bool, s: dict[str, Any], n_folds: int, pos_frac: float) -> str:
    if s.get("active_bars", 0) < 200 or n_folds < 3:
        return INSUFF
    t, total = s.get("net_hac_t", math.nan), s.get("net_total", math.nan)
    if not (math.isfinite(total)) or total <= 0:
        return NO_EDGE
    if bh_sig and t > 2.0 and pos_frac >= 0.6:
        return EDGE
    if not bh_sig and not t > 2.0:
        return NO_EDGE
    return INSUFF


def run(root: str = "data/cleaned", n_surr: int = 199, out: Path = OUT) -> pd.DataFrame:
    out.mkdir(parents=True, exist_ok=True)
    syms = sorted(set(ALTS + SAME_ASSET + BASKET + SMALL + ["BTC"]))
    ds = load_dataset(root, symbols=syms, end=H2_START - pd.Timedelta(hours=1))
    assert ds.perp.close.index.max() < H2_START and ds.spot.close.index.max() < H2_START
    with open("config/experiment.yaml") as f:
        cm = CostModel.from_config(dict(yaml.safe_load(f))["costs"])
    regimes = trend(ds)
    pairs = build_pairs(ds)

    stat_rows: list[dict[str, Any]] = []
    summaries, fold_logs, decay_rows = [], [], []
    for p in pairs:
        print(f"[leadlag-engine] {p.pair_id}", flush=True)
        stat_rows += pair_statistics(p, LAGS, n_surr)
        qv = ds.market(p.market).quote_volume[p.symbol]  # type: ignore[arg-type]
        sel, folds, per_lag = walk_forward(p, cm, qv)
        s = summarize_oos(sel, regimes)
        s.update({"pair": p.pair_id, "group": p.group, "n_folds": len(folds),
                  "fold_pos_frac": float((folds["oos_net"] > 0).mean()) if len(folds) else math.nan,
                  "selected_lags": ",".join(map(str, folds["selected_lag"])) if len(folds) else ""})
        summaries.append(s)
        fold_logs.append(folds)
        if not per_lag.empty:
            for L, g in per_lag.groupby("lag_h"):
                decay_rows.append({"pair": p.pair_id, "lag_h": L,
                                   "oos_ic": _ic(g),
                                   "oos_gross_bps_per_bar": g["gross"].mean() * 1e4,
                                   "oos_net_bps_per_bar": g["net"].mean() * 1e4})

    stats_df = pd.DataFrame(stat_rows)
    rej, q = M.benjamini_hochberg(stats_df["p"].to_numpy(), ALPHA)
    stats_df["q_bh"], stats_df["bh_reject"] = q, rej
    stats_df.to_csv(out / "results.csv", index=False)
    pd.DataFrame(decay_rows).to_csv(out / "decay_by_lag.csv", index=False)
    pd.concat(fold_logs, ignore_index=True).to_csv(out / "walkforward_folds.csv", index=False)

    sig = stats_df.groupby("pair")["bh_reject"].agg(["sum", "count"])
    summ = pd.DataFrame(summaries).set_index("pair")
    summ["bh_sig_tests"] = sig["sum"].reindex(summ.index).fillna(0).astype(int)
    summ["n_tests"] = sig["count"].reindex(summ.index)
    verdicts = []
    for _, row in summ.iterrows():
        d: dict[str, Any] = {str(k): v for k, v in row.items()}
        pf = d.get("fold_pos_frac")
        verdicts.append(verdict(int(d["bh_sig_tests"]) > 0, d, int(d["n_folds"]),
                                float(pf) if pf is not None and pd.notna(pf) else 0.0))
    summ["verdict"] = verdicts
    summ.to_csv(out / "verdicts.csv")
    write_verdicts_md(summ, stats_df, pd.DataFrame(decay_rows), out)
    return summ


def write_verdicts_md(summ: pd.DataFrame, stats_df: pd.DataFrame, decay: pd.DataFrame, out: Path) -> None:
    from engine.regimes.report import md_table

    cols = ["group", "verdict", "bh_sig_tests", "n_tests", "selected_lags", "oos_ic", "hit_rate",
            "expectancy_bps", "gross_sharpe", "net_sharpe", "net_hac_t", "fold_pos_frac", "n_trades",
            "net_bps_by_trend"]
    counts = summ["verdict"].value_counts()
    by_method = stats_df.groupby("method")["bh_reject"].agg(["sum", "count"])
    by_lag = stats_df.groupby("lag_h")["bh_reject"].agg(["sum", "count"])
    dec = decay.groupby("lag_h")[["oos_ic", "oos_gross_bps_per_bar", "oos_net_bps_per_bar"]].median() \
        if not decay.empty else pd.DataFrame()
    lines = [
        "# Lead-lag engine verdicts (data < H2_START 2025-10-01; H2 sealed, not opened)", "",
        "Hourly bars are the finest resolution available: lags below 1h (where the literature locates the",
        "BTC->alt effect) cannot be tested. Lags tested: 1, 2, 4, 8, 24h.", "",
        f"Tests: {len(stats_df)} (pairs x lags x 7 methods), Benjamini-Hochberg at q <= {ALPHA}: "
        f"{int(stats_df['bh_reject'].sum())} rejections.",
        "Tradability: expanding walk-forward, 6-month test folds, lag + beta selected on the training window",
        "only, trade the follower 1h ahead when |forecast| > round-trip cost (engine.costs, fees+half-spread",
        "+impact at $10k).", "",
        "Verdict rule: EDGE EXISTS = >=1 BH-significant test AND OOS net HAC t > 2 AND >=60% folds net",
        "positive; EDGE DOES NOT SURVIVE = OOS net total <= 0, or no BH significance and t <= 2;",
        "INSUFFICIENT EVIDENCE = < 200 active OOS bars / < 3 folds, or mixed (significant but",
        "t <= 2, or t > 2 without BH significance).", "",
        "Verdict counts: " + ", ".join(f"{k}: {v}" for k, v in counts.items()), "",
        "## Per-pair verdicts", "", md_table(summ[cols]), "",
        "## BH rejections by method", "", md_table(by_method), "",
        "## BH rejections by lag", "", md_table(by_lag), "",
        "## Decay by lag (median across pairs, OOS, no lag selection)", "", md_table(dec), "",
    ]
    (out / "verdicts.md").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    print(run().to_string())
