"""Feature definition registry.

A FeatureDef is a pure, causal function Dataset -> wide DataFrame (index = hourly bar OPEN ts,
columns = assets). The value at row t may use only data in Dataset.truncate(t), i.e. bars with
open <= t (closed by t + 1h) and funding events with ts <= t. Hence the value's
availability_timestamp is t + 1h (bar close). Enforced by tests/test_features.py.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

import pandas as pd

from engine.contracts import Dataset

FeatureFn = Callable[[Dataset], pd.DataFrame]

# input name -> accessor on Dataset; "funding" is the wide event-time funding frame
INPUTS: dict[str, Callable[[Dataset], pd.DataFrame]] = {
    **{f"{m}.{f}": (lambda d, m=m, f=f: getattr(d.market(m), f))  # type: ignore[misc]
       for m in ("spot", "perp")
       for f in ("open", "high", "low", "close", "volume", "quote_volume", "is_filled")},
    "funding": lambda d: d.funding,
}


@dataclass(frozen=True)
class FeatureDef:
    feature_id: str
    calculation_version: int
    inputs: tuple[str, ...]
    function: FeatureFn
    lookback_hours: int            # rows of history needed for one value (incremental recompute)
    source: str = "binance"
    description: str = ""

    def __post_init__(self) -> None:
        unknown = [i for i in self.inputs if i not in INPUTS]
        if unknown:
            raise ValueError(f"{self.feature_id}: unknown inputs {unknown}")
        if self.calculation_version < 1 or self.lookback_hours < 1:
            raise ValueError(f"{self.feature_id}: version and lookback must be >= 1")


REGISTRY: dict[str, FeatureDef] = {}


def register(fd: FeatureDef) -> FeatureDef:
    if fd.feature_id in REGISTRY and REGISTRY[fd.feature_id] != fd:
        raise ValueError(f"feature {fd.feature_id!r} already registered")
    REGISTRY[fd.feature_id] = fd
    return fd


def feature(feature_id: str, *, version: int, inputs: tuple[str, ...], lookback_hours: int,
            source: str = "binance", description: str = "") -> Callable[[FeatureFn], FeatureFn]:
    """Decorator: register a function as a feature."""
    def deco(fn: FeatureFn) -> FeatureFn:
        register(FeatureDef(feature_id, version, inputs, fn, lookback_hours, source,
                            description or (fn.__doc__ or "").strip()))
        return fn
    return deco


def get_feature(feature_id: str) -> FeatureDef:
    import engine.features.base  # noqa: F401  (ensure base features are registered)
    return REGISTRY[feature_id]


def list_features() -> list[FeatureDef]:
    import engine.features.base  # noqa: F401
    return [REGISTRY[k] for k in sorted(REGISTRY)]
