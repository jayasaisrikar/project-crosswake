"""Delta-neutral funding carry: long spot / short perp when trailing funding APR is high.

Turnover controls (carry earns a few bps/day, so churn kills it):
  * fixed per-asset weight w = min(max_weight_per_asset, max_gross / 2 / max_positions) - weights are
    NOT renormalised across active coins, so one coin entering/exiting does not trade the others;
  * decisions only every `rebalance_hours`;
  * no-trade band: a held weight is only changed if |new - old| > no_trade_band * w;
  * cost-aware entry: enter only if trailing APR * min_hold_days / 365 exceeds the round-trip cost of
    both legs (2 * (fee_spot + fee_perp + half_spread_spot + half_spread_perp)) times entry_cost_margin.
"""

from __future__ import annotations

from typing import Any

import pandas as pd

from engine.contracts import Dataset, TargetWeights
from engine.signals.trend import decision_times, tradable_mask


class CarryStrategy:
    name = "carry"

    def __init__(self, params: dict[str, Any]):
        self.params = params
        self.entry = float(params["entry_funding_annual"])
        self.exit = float(params["exit_funding_annual"])
        self.lookback_h = int(params["funding_lookback_hours"])
        self.max_w = float(params["max_weight_per_asset"])
        self.max_gross = float(params["max_gross"])
        self.rebalance_hours = int(params.get("rebalance_hours", 8))
        self.max_positions = int(params.get("max_positions", 2))
        self.band = float(params.get("no_trade_band", 0.25))
        # Spot and perp must be the SAME asset: skip if basis exceeds this (e.g. relaunched tickers).
        self.max_basis = float(params.get("max_basis", 0.02))
        # Cost-aware entry (bps; defaults conservative = config costs block, taker, fallback spreads).
        self.min_hold_days = float(params.get("min_hold_days", 14.0))
        self.cost_margin = float(params.get("entry_cost_margin", 2.0))
        fee = params.get("entry_fee_bps", {}) or {}
        hs = params.get("entry_half_spread_bps", {}) or {}
        one_way_bps = (
            float(fee.get("spot", 10.0)) + float(fee.get("perp", 5.0))
            + float(hs.get("spot", 2.0)) + float(hs.get("perp", 2.0))
        )
        self.round_trip_cost = 2.0 * one_way_bps * 1e-4
        self.weight = min(self.max_w, self.max_gross / 2 / max(self.max_positions, 1))

    def trailing_apr(self, funding: pd.DataFrame, t: pd.Timestamp) -> pd.Series:
        """Sum of funding over events in (t - L, t], annualised by 8760 / L hours.

        Interval-agnostic: correct for 8h, 4h, 2h and 1h settlement (Binance moves symbols between
        intervals; SOL/FTT have 2h stretches). Symbols without a funding event at or before t - L
        (insufficient history) get NaN. Causal: only events with ts <= t are used."""
        lo = t - pd.Timedelta(hours=self.lookback_h)
        win = funding.loc[(funding.index > lo) & (funding.index <= t)]
        seen = funding.loc[funding.index <= lo].notna().any()
        apr = win.sum(min_count=1) * (24 * 365 / self.lookback_h)
        return apr.where(seen.reindex(apr.index, fill_value=False))

    def entry_ok(self, apr: float) -> bool:
        if apr <= self.entry:
            return False
        expected = apr * self.min_hold_days / 365.0
        return expected > self.round_trip_cost * self.cost_margin

    def target_weights(self, data: Dataset) -> TargetWeights:
        idx = data.perp.close.index.union(data.spot.close.index)
        symbols = sorted(set(data.spot.close.columns) & set(data.perp.close.columns))
        times = decision_times(pd.DatetimeIndex(idx), self.rebalance_hours)
        ok = (
            tradable_mask(data.spot).reindex(index=idx, columns=symbols).fillna(False).astype(bool)
            & tradable_mask(data.perp).reindex(index=idx, columns=symbols).fillna(False).astype(bool)
        )
        basis = (
            data.spot.close.reindex(index=idx, columns=symbols)
            / data.perp.close.reindex(index=idx, columns=symbols)
            - 1.0
        ).abs()
        ok = ok & (basis <= self.max_basis).fillna(False)
        funding = data.funding.reindex(columns=symbols)
        held = dict.fromkeys(symbols, 0.0)
        rows = []
        for t in times:
            apr = self.trailing_apr(funding, t)
            keep: list[str] = []
            cands: list[tuple[float, str]] = []
            for s in symbols:
                a = apr.get(s)
                if not bool(ok.at[t, s]) or a is None or pd.isna(a):
                    continue
                if held[s] != 0.0:
                    if a >= self.exit:
                        keep.append(s)
                elif self.entry_ok(float(a)):
                    cands.append((float(a), s))
            free = max(self.max_positions - len(keep), 0)
            new = [s for _, s in sorted(cands, key=lambda x: (-x[0], x[1]))[:free]]
            target = {s: (self.weight if s in keep or s in new else 0.0) for s in symbols}
            for s in symbols:
                tgt = target[s]
                if tgt == 0.0 or held[s] == 0.0 or abs(tgt - held[s]) > self.band * self.weight:
                    held[s] = tgt
            rows.append(dict(held))
        spot = pd.DataFrame(rows, index=times, columns=symbols, dtype=float)
        return TargetWeights(spot=spot, perp=-spot)
