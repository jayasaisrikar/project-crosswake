"""Shared contracts. Every module codes against these; do not change without updating all users.

DATA LAYOUT (all timestamps UTC, tz-aware, bar OPEN time, 1h bars)
  data/raw/<source files as downloaded, never modified>  + data/raw/manifest.json
  data/cleaned/bars/{market}/{SYMBOL}.parquet   market in {"spot","perp"}, SYMBOL e.g. "BTC"
      columns: ts, open, high, low, close, volume, quote_volume, trades, is_filled(bool)
      one row per hour; gaps forward-filled with is_filled=True and volume=0
  data/cleaned/funding/{SYMBOL}.parquet
      columns: ts (funding settlement time, UTC; may carry ms jitter), rate (fraction per EVENT;
      interval is symbol- and period-specific: 8h, 4h, 2h or 1h)

PANELS: wide pandas DataFrames, index = DatetimeIndex (UTC, hourly), columns = symbols.

CAUSALITY RULE: any signal function f(panels) -> weights must satisfy
  f(panels.loc[:t]).loc[t] == f(panels).loc[t]   for every t      (tested in tests/test_no_lookahead.py)
The backtester executes weights decided at bar t at the OPEN of bar t+1. Never same-bar fills.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol

import pandas as pd

Market = Literal["spot", "perp"]
MARKETS: tuple[Market, ...] = ("spot", "perp")


@dataclass(frozen=True)
class MarketData:
    """Hourly panels for one market. Missing/unlisted = NaN (symbol not tradable at that bar)."""

    open: pd.DataFrame
    high: pd.DataFrame
    low: pd.DataFrame
    close: pd.DataFrame
    volume: pd.DataFrame        # base volume
    quote_volume: pd.DataFrame  # USDT volume
    is_filled: pd.DataFrame     # True where bar was synthesized (stale)

    def truncate(self, end: pd.Timestamp) -> MarketData:
        return MarketData(**{k: getattr(self, k).loc[:end] for k in self.__dataclass_fields__})


@dataclass(frozen=True)
class Dataset:
    spot: MarketData
    perp: MarketData
    funding: pd.DataFrame       # wide, index = funding event ts, columns = symbols, rate per event

    def truncate(self, end: pd.Timestamp) -> Dataset:
        return Dataset(self.spot.truncate(end), self.perp.truncate(end), self.funding.loc[:end])

    def market(self, m: Market) -> MarketData:
        return self.spot if m == "spot" else self.perp


@dataclass(frozen=True)
class TargetWeights:
    """Target portfolio weights (fraction of sleeve equity), decided at each index ts.

    Positive = long, negative = short. Rows only where a decision is made (rebalance times);
    the backtester holds positions between rows. Each frame: index ts, columns symbols, NaN -> 0.
    """

    spot: pd.DataFrame
    perp: pd.DataFrame


class Strategy(Protocol):
    name: str

    def target_weights(self, data: Dataset) -> TargetWeights:
        """Pure + causal. Same function used by backtest, paper and live (live takes the last row)."""
        ...


@dataclass
class CostBreakdown:
    fees: float = 0.0
    spread: float = 0.0
    impact: float = 0.0
    funding: float = 0.0        # positive = paid, negative = received

    @property
    def total(self) -> float:
        return self.fees + self.spread + self.impact + self.funding


@dataclass
class BacktestResult:
    name: str
    equity: pd.Series                    # hourly equity, UTC index
    returns: pd.Series                   # hourly simple returns of equity
    positions: dict[str, pd.DataFrame]   # market -> hourly notional positions (USDT)
    trades: pd.DataFrame                 # ts, symbol, market, side, qty_notional, price, fee, spread, impact
    costs: pd.DataFrame                  # hourly: fees, spread, impact, funding (USDT)
    meta: dict = field(default_factory=dict)  # params, data hash, git sha, cost multiplier
