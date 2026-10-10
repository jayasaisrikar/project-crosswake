"""Leakage-safe CV splits (Lopez de Prado 2018, AFML ch. 7), bounded by H2_START.

Observation i at time t_i has a label spanning [t_i, t_i + label_horizon].
* Purging: a training observation is dropped if its label interval overlaps the test span
  [test_start, test_end + label_horizon].
* Embargo: training observations in (test_end, test_end + label_horizon + embargo] are dropped.
Walk-forward (expanding): train = observations whose label ends strictly before
test_start - embargo.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from engine.research.holdout_guard import assert_research_window

_ZERO = pd.Timedelta(0)


@dataclass(frozen=True)
class Split:
    train: np.ndarray   # integer positions into the index
    test: np.ndarray
    train_end: pd.Timestamp
    test_start: pd.Timestamp
    test_end: pd.Timestamp


def _check(index: pd.DatetimeIndex) -> pd.DatetimeIndex:
    idx = pd.DatetimeIndex(index)
    assert_research_window(idx)
    if not idx.is_monotonic_increasing:
        raise ValueError("index must be sorted ascending")
    return idx


def purged_kfold(index: pd.DatetimeIndex, n_splits: int = 5,
                 label_horizon: pd.Timedelta = _ZERO,
                 embargo: pd.Timedelta = _ZERO) -> list[Split]:
    idx = _check(index)
    if n_splits < 2 or n_splits > len(idx):
        raise ValueError("bad n_splits")
    label_end = idx + label_horizon
    out = []
    for block in np.array_split(np.arange(len(idx)), n_splits):
        ts, te = idx[block[0]], idx[block[-1]]
        overlaps = (label_end >= ts) & (idx <= te + label_horizon)
        embargoed = (idx > te) & (idx <= te + label_horizon + embargo)
        bad = np.asarray(overlaps | embargoed)
        bad[block] = True
        train = np.flatnonzero(~bad)
        if not len(train):
            continue
        out.append(Split(train, block, idx[train[-1]], ts, te))
    return out


def walk_forward(index: pd.DatetimeIndex, n_splits: int = 5,
                 label_horizon: pd.Timedelta = _ZERO,
                 embargo: pd.Timedelta = _ZERO,
                 min_train: int | None = None) -> list[Split]:
    """Expanding walk-forward. Test blocks = n_splits equal chunks after `min_train` observations
    (default len/(n_splits+1))."""
    idx = _check(index)
    n = len(idx)
    start = min_train if min_train is not None else n // (n_splits + 1)
    if start <= 0 or start >= n:
        raise ValueError("bad min_train")
    label_end = idx + label_horizon
    out = []
    for block in np.array_split(np.arange(start, n), n_splits):
        if not len(block):
            continue
        ts, te = idx[block[0]], idx[block[-1]]
        train = np.flatnonzero(np.asarray(label_end < ts - embargo))
        if not len(train):
            continue
        out.append(Split(train, block, idx[train[-1]], ts, te))
    return out
