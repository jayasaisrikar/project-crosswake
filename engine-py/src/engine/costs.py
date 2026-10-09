"""Transaction cost model: fees + half-spread + square-root market impact.

Per-trade cost (quote currency) for a trade of absolute notional N:
  fees   = fee_bps[market] * 1e-4 * N                (taker: we cross the spread)
  spread = half_spread_bps(symbol, market) * 1e-4 * N
  impact = Y * sigma_daily * sqrt(min(N / ADV_daily, max_participation)) * N
  each multiplied by the stress multiplier.

Square-root law: Torre (1997, BARRA); Almgren, Thum, Hauptmann & Li (2005) "Direct estimation of
equity market impact", Risk 18(7); Toth, Lemperiere, Deremble, de Lataillade, Kockelkoren &
Bouchaud (2011) "Anomalous price impact and the critical nature of liquidity in financial
markets", Phys. Rev. X 1, 021006 (Y of order 1). Units must be consistent: participation is order
notional over DAILY quote volume (ADV in USDT/day) and sigma is DAILY return vol; both come from
`rolling_adv_and_vol` (hourly bars, trailing 30 days, shifted -> causal).

Half-spread resolution order (bps), for (symbol, market):
  1. half_spread_override_bps[market][symbol] / half_spread_override_bps[symbol]   (config)
  2. measured spreads.json [market][symbol][spread_stat]  (default stat p75 = conservative)
  3. half_spread_bps[market][symbol] / half_spread_bps[symbol]                     (config fallback)
  4. half_spread_bps["default"] (or [market]["default"])
"""

from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from engine.contracts import CostBreakdown, Market, MarketData

log = logging.getLogger(__name__)

MAX_PARTICIPATION = 1.0          # cap on notional / ADV used in the impact formula
DEFAULT_DAILY_VOL = 0.05         # conservative fallback when vol is unknown
DEFAULT_SPREAD_STAT = "p75"

SpreadTable = dict[str, Any]     # flat {sym: bps} and/or nested {market: {sym: bps}}


def _lookup(table: SpreadTable, symbol: str, market: str | None) -> float | None:
    if market is not None:
        sub = table.get(market)
        if isinstance(sub, dict) and symbol in sub:
            return float(sub[symbol])
    v = table.get(symbol)
    return float(v) if isinstance(v, int | float) else None


def load_measured_spreads(path: str | Path, stat: str = DEFAULT_SPREAD_STAT) -> dict[str, dict[str, float]]:
    """{market: {symbol: half_spread_bps}} from data/cleaned/spreads.json (empty if missing)."""
    p = Path(path)
    if not p.exists():
        log.warning("spreads file %s not found; using configured half-spread fallbacks", p)
        return {}
    raw = json.loads(p.read_text())
    out: dict[str, dict[str, float]] = {}
    for m in ("spot", "perp"):
        for sym, rec in (raw.get(m) or {}).items():
            if isinstance(rec, dict) and stat in rec and rec[stat] is not None and math.isfinite(rec[stat]):
                out.setdefault(m, {})[sym] = float(rec[stat])
    return out


@dataclass(frozen=True)
class CostModel:
    fee_bps: dict[str, float]
    half_spread_bps: SpreadTable
    impact_y: float
    multiplier: float = 1.0
    max_participation: float = MAX_PARTICIPATION
    default_daily_vol: float = DEFAULT_DAILY_VOL
    extra: dict[str, Any] = field(default_factory=dict)
    measured_spread_bps: dict[str, dict[str, float]] = field(default_factory=dict)
    override_spread_bps: SpreadTable = field(default_factory=dict)

    @classmethod
    def from_config(cls, costs_cfg: dict[str, Any], multiplier: float | None = None,
                    base_dir: str | Path | None = None) -> CostModel:
        mult = float(costs_cfg.get("stress_multiplier", 1.0)) if multiplier is None else float(multiplier)
        measured: dict[str, dict[str, float]] = {}
        sf = costs_cfg.get("spreads_file")
        if sf:
            p = Path(sf)
            if base_dir is not None and not p.is_absolute():
                p = Path(base_dir) / p
            measured = load_measured_spreads(p, str(costs_cfg.get("spread_stat", DEFAULT_SPREAD_STAT)))
        return cls(
            fee_bps={k: float(v) for k, v in costs_cfg["fee_bps"].items()},
            half_spread_bps=dict(costs_cfg.get("half_spread_bps", {})),
            impact_y=float(costs_cfg["impact_y"]),
            multiplier=mult,
            measured_spread_bps=measured,
            override_spread_bps=dict(costs_cfg.get("half_spread_override_bps") or {}),
        )

    def with_multiplier(self, multiplier: float) -> CostModel:
        return CostModel(self.fee_bps, self.half_spread_bps, self.impact_y, float(multiplier),
                         self.max_participation, self.default_daily_vol, self.extra,
                         self.measured_spread_bps, self.override_spread_bps)

    def half_spread(self, symbol: str, market: str | None = None) -> float:
        v = _lookup(self.override_spread_bps, symbol, market)
        if v is not None:
            return v
        if market is not None and symbol in self.measured_spread_bps.get(market, {}):
            return self.measured_spread_bps[market][symbol]
        v = _lookup(self.half_spread_bps, symbol, market)
        if v is not None:
            return v
        v = _lookup(self.half_spread_bps, "default", market)
        return v if v is not None else 0.0

    def trade_cost(
        self,
        symbol: str,
        market: Market,
        notional_abs: float,
        price: float,
        adv_quote: float | None,
        daily_vol: float | None,
    ) -> CostBreakdown:
        """Cost in quote currency (USDT) of trading `notional_abs`. `price` kept for API symmetry."""
        n = abs(float(notional_abs))
        if n == 0.0:
            return CostBreakdown()
        fees = self.fee_bps[market] * 1e-4 * n
        spread = self.half_spread(symbol, market) * 1e-4 * n
        vol = daily_vol if daily_vol is not None and math.isfinite(daily_vol) and daily_vol > 0 \
            else self.default_daily_vol
        participation = self.participation(n, adv_quote)
        impact = self.impact_y * vol * math.sqrt(participation) * n
        m = self.multiplier
        return CostBreakdown(fees=fees * m, spread=spread * m, impact=impact * m)

    def participation(self, notional_abs: float, adv_quote: float | None) -> float:
        """Order notional / DAILY quote volume, capped; unknown liquidity -> worst case (cap)."""
        if adv_quote is None or not math.isfinite(adv_quote) or adv_quote <= 0:
            return self.max_participation
        return min(abs(notional_abs) / adv_quote, self.max_participation)


def rolling_adv_and_vol(md: MarketData, days: int = 30) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Causal ADV (quote, per DAY) and DAILY vol. Value at t uses bars strictly before t."""
    window = days * 24
    minp = 24
    qv = md.quote_volume.where(~md.is_filled.fillna(False).astype(bool))
    adv = qv.rolling(window, min_periods=minp).mean() * 24
    rets = md.close.pct_change(fill_method=None).replace([np.inf, -np.inf], np.nan)
    vol = rets.rolling(window, min_periods=minp).std() * math.sqrt(24)
    return adv.shift(1), vol.shift(1)
