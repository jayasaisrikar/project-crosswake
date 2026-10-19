"""Families that need data this engine does not have. They raise DataUnavailable; no data is fabricated."""

from __future__ import annotations

from typing import Any

import pandas as pd

from engine.models.base import DataUnavailable
from engine.research.contract import Prediction


class UnavailableModel:
    model_id = "unavailable"
    family = ""
    needs = ""

    def __init__(self, **params: Any):
        self.params = dict(params)
        self.horizon_hours = int(params.get("horizon_hours", 24))

    def _raise(self) -> None:
        raise DataUnavailable(
            f"{self.model_id} ({self.family}) needs {self.needs}; engine.contracts.Dataset carries only "
            "OHLCV bars and funding. Add a cleaned source for it before enabling this model.")

    def fit(self, data: object, end: pd.Timestamp) -> None:
        self._raise()

    def predict(self, data: object, t: pd.Timestamp) -> list[Prediction]:
        self._raise()
        return []


class OpenInterestDivergence(UnavailableModel):
    model_id = "oi_divergence"
    family = "OPEN_INTEREST"
    needs = "historical open interest"


class LiquidationCascade(UnavailableModel):
    model_id = "liquidation_cascade"
    family = "LIQUIDATIONS"
    needs = "liquidation event data"


class OrderBookImbalance(UnavailableModel):
    model_id = "orderbook_imbalance"
    family = "ORDER_BOOK"
    needs = "L2 order book snapshots"
