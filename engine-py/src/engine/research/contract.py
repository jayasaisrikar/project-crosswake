"""Shared research contract. ALL new signal models, regime, ensemble, edge, risk and live-feedback
code codes against this file. Do not change field names without updating every user.

HOLDOUT POLICY (pre-registered 2026-10-10, before any new research was run):
  * H1 (holdout_start 2024-07-01) was viewed 5 times (experiments/holdout_log.jsonl) -> CONSUMED, LOCKED.
    It may be used only as ordinary walk-forward OOS for NEW hypotheses, never as a final holdout.
  * H2 starts 2025-10-01 00:00 UTC and is SEALED. Research/selection may use only data < H2_START.
    Opening H2 requires `holdout_guard.open_h2(reason=...)`, which appends to experiments/holdout_log.jsonl.
  * CAVEAT (AUDIT_REPORT 7.1 / B7-B8): every earlier H1 unlock ran to the end of the data, and the
    lead-lag event study printed 2025/2026 segments, so the EXISTING baseline strategies (trend, carry,
    breakout, xsmom, leadlag, frozen versions v001/v002) have ALREADY SEEN H2. H2 is a clean holdout only
    for NEW hypotheses registered from now on; for the existing rules only live paper data after
    2026-10-09 is genuinely unseen.

PREDICTION SEMANTICS (2026-10-10, review 01 #1): for engine.models ScoreModels, `expected_return` is the
forecast IN EXCESS of the training-window drift (and, for cross-sectional models, of the cross-sectional
mean at t). `direction` is its sign, so the drift never decides direction. The raw `a + b*score` is in
`features["er_with_drift"]`. Models may also expose `predict_many(data, times)`, which must equal
`predict(truncate(data, t), t)` at every t. The research runner verifies this.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Literal, Protocol

import pandas as pd

H1_START = pd.Timestamp("2024-07-01", tz="UTC")
H2_START = pd.Timestamp("2025-10-01", tz="UTC")

Direction = Literal[-1, 0, 1]  # 0 == NO TRADE


@dataclass(frozen=True)
class Prediction:
    """One model's forecast for one asset at one decision time (bar close, executed next open)."""

    timestamp: pd.Timestamp          # decision time; only information available <= this may be used
    asset: str
    model_id: str
    horizon_hours: int
    expected_return: float           # gross, fraction over horizon
    direction: Direction
    confidence: float                # calibrated P(sign correct) in [0,1]; NaN if uncalibrated
    uncertainty: float               # stdev of forecast error (fraction)
    risk: float                      # forecast vol over horizon (fraction)
    expected_cost: float = 0.0       # fees+spread+slippage+impact+funding (fraction, round trip)
    expected_net_edge: float = 0.0   # |expected_return| - expected_cost (filled by edge engine)
    model_sources: tuple[str, ...] = ()
    features: dict[str, float] = field(default_factory=dict)
    regime: str = ""
    reason: str = ""                 # NO TRADE reason or explanation

    @property
    def expiry(self) -> pd.Timestamp:
        return self.timestamp + pd.Timedelta(hours=self.horizon_hours)

    def to_record(self) -> dict:
        d = asdict(self)
        d["timestamp"] = self.timestamp.isoformat()
        d["expiry"] = self.expiry.isoformat()
        d["model_sources"] = list(self.model_sources)
        return d


class SignalModel(Protocol):
    """Common interface. `fit` sees only training data; `predict` must be causal
    (predict(data.truncate(t)) at t == predict(data) at t)."""

    model_id: str
    horizon_hours: int

    def fit(self, data: object, end: pd.Timestamp) -> None: ...

    def predict(self, data: object, t: pd.Timestamp) -> list[Prediction]: ...
