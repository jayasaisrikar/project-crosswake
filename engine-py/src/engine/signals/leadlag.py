"""BTC -> altcoin lead-lag strategy (impulse-following), wired to the common interface.

Two competing hypotheses are testable through the `direction` param:
  * "continuation" (default): when BTC prints a large return at the close of bar t (|r_btc[t]| >
    k * trailing vol), eligible altcoins continue in the SAME direction over the next `hold_hours`
    bars (delayed response / underreaction). This is the tradable form of the event study in
    engine.leadlag.events / docs/LEAD_LAG_RESEARCH_REVIEW.
  * "reversion": altcoins OVERREACTED to the BTC impulse and mean-revert, so the basket is taken in
    the OPPOSITE sign. Same machinery, sign flipped -- lets the scorecard price both sides fairly.

Positions: at each impulse bar the strategy targets an equal-weight basket of every eligible follower,
scaled so gross = `gross`, held for `hold_hours` decision bars, then flat. The backtester enters at the
OPEN of the bar after the decision bar, so nothing inside the impulse bar is traded (no intrabar
look-ahead). Causal by construction: impulse detection and the tradable mask use only data <= t. The
forward-return labels in events.py are NEVER used here.

BtcImpulseFollow is a single-asset §4.H baseline: trade only the LEADER in its own impulse direction
(no cross-asset lead-lag claim), to isolate how much of any basket result is just BTC autocorrelation."""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from engine.contracts import Dataset, Market, TargetWeights
from engine.leadlag.events import detect_impulses, log_returns
from engine.signals.trend import tradable_mask


class LeadLagStrategy:
    name = "leadlag"

    def __init__(self, params: dict[str, Any]):
        self.params = params
        self.market: Market = params.get("market", "perp")
        self.leader: str = params.get("leader", "BTC")
        self.k = float(params.get("k", 2.0))
        self.vol_lookback = int(params.get("vol_lookback_bars", 720))
        self.hold_hours = int(params.get("hold_hours", 1))
        self.gross = float(params.get("gross", 1.0))
        self.max_w = float(params.get("max_weight_per_asset", 0.25))
        self.allow_short = bool(params.get("allow_short", True))
        self.direction = str(params.get("direction", "continuation"))
        if self.direction not in ("continuation", "reversion"):
            raise ValueError(f"direction must be continuation|reversion, got {self.direction!r}")
        self._sign = 1.0 if self.direction == "continuation" else -1.0

    def target_weights(self, data: Dataset) -> TargetWeights:
        md = data.market(self.market)
        close = md.close
        other = pd.DataFrame(index=close.index, dtype=float)
        full = pd.DataFrame(0.0, index=close.index, columns=close.columns)
        if self.leader not in close.columns:
            return self._wrap(full, other)

        r_btc = log_returns(close[[self.leader]], md.is_filled[[self.leader]])[self.leader]
        imp = detect_impulses(r_btc, self.k, self.vol_lookback)            # signed +/-1 at impulse bars
        if self.hold_hours > 1:                                            # carry direction over the hold
            active = imp.replace(0.0, np.nan).ffill(limit=self.hold_hours - 1).fillna(0.0)
        else:
            active = imp

        followers = [c for c in close.columns if c != self.leader]
        elig = tradable_mask(md)[followers]
        n_elig = elig.sum(axis=1).clip(lower=1)
        w_each = (self.gross / n_elig).clip(upper=self.max_w)             # equal-weight, capped
        w = elig.mul(w_each, axis=0).mul(active * self._sign, axis=0)     # reversion flips the sign
        if not self.allow_short:
            w = w.clip(lower=0.0)
        full[followers] = w.clip(-self.max_w, self.max_w).fillna(0.0)
        return self._wrap(full, other)

    def _wrap(self, w: pd.DataFrame, other: pd.DataFrame) -> TargetWeights:
        if self.market == "perp":
            return TargetWeights(spot=other, perp=w)
        return TargetWeights(spot=w, perp=other)


class BtcImpulseFollow:
    """§4.H baseline: trade ONLY the leader in its own impulse direction, held `hold_hours` bars.

    No cross-asset claim -- this prices pure BTC return-continuation so the lead-lag basket can be
    judged against it (incremental value over a trivial single-asset rule). Causal by construction."""

    name = "btc_impulse"

    def __init__(self, params: dict[str, Any]):
        self.params = params
        self.market: Market = params.get("market", "perp")
        self.leader: str = params.get("leader", "BTC")
        self.k = float(params.get("k", 2.0))
        self.vol_lookback = int(params.get("vol_lookback_bars", 720))
        self.hold_hours = int(params.get("hold_hours", 1))
        self.gross = float(params.get("gross", 1.0))
        self.direction = str(params.get("direction", "continuation"))
        self._sign = 1.0 if self.direction == "continuation" else -1.0

    def target_weights(self, data: Dataset) -> TargetWeights:
        md = data.market(self.market)
        close = md.close
        other = pd.DataFrame(index=close.index, dtype=float)
        full = pd.DataFrame(0.0, index=close.index, columns=close.columns)
        if self.leader not in close.columns:
            return self._wrap(full, other)
        r_btc = log_returns(close[[self.leader]], md.is_filled[[self.leader]])[self.leader]
        imp = detect_impulses(r_btc, self.k, self.vol_lookback)
        if self.hold_hours > 1:
            active = imp.replace(0.0, np.nan).ffill(limit=self.hold_hours - 1).fillna(0.0)
        else:
            active = imp
        elig = tradable_mask(md)[self.leader]
        full[self.leader] = (active * self._sign * self.gross).where(elig, 0.0).fillna(0.0)
        return self._wrap(full, other)

    def _wrap(self, w: pd.DataFrame, other: pd.DataFrame) -> TargetWeights:
        if self.market == "perp":
            return TargetWeights(spot=other, perp=w)
        return TargetWeights(spot=w, perp=other)
