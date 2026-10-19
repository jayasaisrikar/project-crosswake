"""Lead-lag experiment: event detection + causality (truncation invariance)."""

from __future__ import annotations

import numpy as np
import pandas as pd

from engine.leadlag.events import (
    detect_impulses,
    event_panel,
    forward_sum,
    log_returns,
    rolling_beta,
    trailing_vol,
)


def _rets(n: int = 1500, seed: int = 0) -> tuple[pd.Series, pd.DataFrame]:
    rng = np.random.default_rng(seed)
    idx = pd.date_range("2022-01-01", periods=n, freq="h", tz="UTC")
    b = pd.Series(rng.normal(0, 0.01, n), index=idx)
    a = pd.DataFrame({"A": 0.8 * b + rng.normal(0, 0.005, n), "B": 1.2 * b + rng.normal(0, 0.01, n)},
                     index=idx)
    return b, a


def test_impulse_detected_and_signed() -> None:
    b, _ = _rets()
    b.iloc[1000] = 0.10
    b.iloc[1200] = -0.10
    imp = detect_impulses(b, 3.0, 720)
    assert imp.iloc[1000] == 1.0 and imp.iloc[1200] == -1.0
    assert imp.iloc[:360].eq(0).all()  # warm-up: no vol yet -> no events


def test_threshold_excludes_current_bar() -> None:
    b, _ = _rets()
    v = trailing_vol(b, 720)
    assert np.isclose(v.iloc[900], b.iloc[180:900].std())


def test_no_impulse_on_constant_vol_noise_at_high_k() -> None:
    b, _ = _rets()
    assert detect_impulses(b, 10.0, 720).eq(0).all()


def test_truncation_invariance() -> None:
    b, a = _rets()
    full_imp = detect_impulses(b, 2.0, 720)
    full_beta = rolling_beta(a, b, 720)
    for t in [800, 1000, 1499]:
        ts = b.index[t]
        imp_t = detect_impulses(b.loc[:ts], 2.0, 720)
        beta_t = rolling_beta(a.loc[:ts], b.loc[:ts], 720)
        assert imp_t.iloc[-1] == full_imp.loc[ts]
        np.testing.assert_allclose(beta_t.iloc[-1].to_numpy(), full_beta.loc[ts].to_numpy())


def test_beta_recovers_truth() -> None:
    b, a = _rets()
    beta = rolling_beta(a, b, 720).iloc[-1]
    assert abs(beta["A"] - 0.8) < 0.05 and abs(beta["B"] - 1.2) < 0.1


def test_forward_sum_and_event_panel_signs() -> None:
    b, a = _rets()
    fs = forward_sum(a, 2)
    assert np.isclose(fs["A"].iloc[10], a["A"].iloc[11] + a["A"].iloc[12])
    b.iloc[1000] = -0.10
    a.loc[a.index[1000], "A"] = 0.0          # alt did not move -> gap = beta*BTC - 0, signed by -1 > 0
    imp = detect_impulses(b, 3.0, 720)
    beta = rolling_beta(a, b, 720)
    p = event_panel(a, b, imp, beta, [1])
    g = p.loc[(b.index[1000], "A"), "gap"]
    assert g > 0.05


def test_log_returns_masks_filled() -> None:
    idx = pd.date_range("2022-01-01", periods=4, freq="h", tz="UTC")
    c = pd.DataFrame({"X": [1.0, 1.1, 1.1, 1.2]}, index=idx)
    f = pd.DataFrame({"X": [False, False, True, False]}, index=idx)
    r = log_returns(c, f)["X"]
    assert np.isnan(r.iloc[2]) and np.isnan(r.iloc[3]) and np.isclose(r.iloc[1], np.log(1.1))
