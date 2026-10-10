"""Level 1 rule families: causal hourly scores; the base class calibrates them to a return forecast.

All windows are trailing (rolling / shift >= 0) on data <= t, so every score is causal by construction.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

from engine.contracts import Dataset
from engine.models.base import (
    DataUnavailable,
    ScoreModel,
    funding_apr,
    hourly_returns,
    log_mom,
    npf,
    ols,
    trailing_vol,
    zscore,
)

# ------------------------------------------------------------------------------------------------ momentum


class TSMomentum(ScoreModel):
    """mean_L [ log(P_t / P_{t-L}) / (sigma_h * sqrt(L)) ]  (multi-horizon, vol-adjusted t-stat)."""

    model_id = "tsmom"
    family = "TS_MOMENTUM"
    default_params = {"lookbacks_days": [7, 30, 90]}

    @property
    def warmup_hours(self) -> int:
        return max(self.params["lookbacks_days"]) * 24 + 2 * int(self.params["vol_hours"])

    def score_panel(self, data: Dataset) -> pd.DataFrame:
        md = self._md(data)
        vol = trailing_vol(hourly_returns(md), int(self.params["vol_hours"]))
        parts = [log_mom(md.close, L * 24) / (vol * math.sqrt(L * 24)) for L in self.params["lookbacks_days"]]
        return sum(parts[1:], parts[0]) / len(parts)


class TrendAcceleration(ScoreModel):
    """[ r(t-L, t) - r(t-2L, t-L) ] / (sigma_h * sqrt(L)): momentum now minus momentum one window ago."""

    model_id = "trend_accel"
    family = "TREND_ACCELERATION"
    default_params = {"window_days": 7}

    @property
    def warmup_hours(self) -> int:
        return 2 * int(self.params["window_days"]) * 24 + 2 * int(self.params["vol_hours"])

    def score_panel(self, data: Dataset) -> pd.DataFrame:
        md = self._md(data)
        L = int(self.params["window_days"]) * 24
        vol = trailing_vol(hourly_returns(md), int(self.params["vol_hours"]))
        return (log_mom(md.close, L) - log_mom(md.close, L, skip=L)) / (vol * math.sqrt(L))


class DonchianPosition(ScoreModel):
    """mean_L [ 2 * (P_t - mid_L) / (hi_L - lo_L) ]  in [-1, 1]; channel over closes in [t-L, t]."""

    model_id = "donchian"
    family = "DONCHIAN_BREAKOUT"
    default_params = {"lookbacks_days": [20, 55]}

    @property
    def warmup_hours(self) -> int:
        return max(self.params["lookbacks_days"]) * 24 + 2 * int(self.params["vol_hours"])

    def score_panel(self, data: Dataset) -> pd.DataFrame:
        c = self._md(data).close
        parts = []
        for L in self.params["lookbacks_days"]:
            w = int(L) * 24
            hi = c.rolling(w, min_periods=w).max()
            lo = c.rolling(w, min_periods=w).min()
            rng = (hi - lo).where(hi > lo)
            parts.append(2.0 * (c - (hi + lo) / 2.0) / rng)
        return sum(parts[1:], parts[0]) / len(parts)


class XSMomentum(ScoreModel):
    """Demeaned cross-sectional rank of log(P_{t-skip} / P_{t-skip-F})."""

    model_id = "xs_mom"
    family = "XS_MOMENTUM"
    xs = True
    default_params = {"formation_days": 30, "skip_days": 1}

    @property
    def warmup_hours(self) -> int:
        return (int(self.params["formation_days"]) + int(self.params["skip_days"])) * 24 + 2 * int(
            self.params["vol_hours"])

    def score_panel(self, data: Dataset) -> pd.DataFrame:
        c = self._md(data).close
        m = log_mom(c, int(self.params["formation_days"]) * 24, skip=int(self.params["skip_days"]) * 24)
        return self._xs_rank(m)


class ResidualMomentum(ScoreModel):
    """Cross-sectional rank of the summed residual return r_i - beta_i * r_BTC over the formation window.

    beta_i = trailing cov(r_i, r_BTC) / var(r_BTC) over beta_days (hourly). BTC itself gets NaN."""

    model_id = "residual_mom"
    family = "RESIDUAL_MOMENTUM"
    xs = True
    default_params = {"formation_days": 30, "beta_days": 60, "btc_symbol": "BTC"}

    @property
    def warmup_hours(self) -> int:
        return (int(self.params["formation_days"]) + int(self.params["beta_days"])) * 24 + 48

    def score_panel(self, data: Dataset) -> pd.DataFrame:
        md = self._md(data)
        btc = str(self.params["btc_symbol"])
        if btc not in md.close.columns:
            raise DataUnavailable(f"residual_mom needs {btc} in the universe")
        r = hourly_returns(md)
        rb = r[btc]
        bw = int(self.params["beta_days"]) * 24
        mp = bw // 2
        cov = r.rolling(bw, min_periods=mp).cov(rb)
        var = rb.rolling(bw, min_periods=mp).var()
        beta = cov.div(var.where(var > 0), axis=0)
        resid = r - beta.mul(rb, axis=0)
        F = int(self.params["formation_days"]) * 24
        cum = resid.rolling(F, min_periods=F // 2).sum()
        cum[btc] = np.nan
        return self._xs_rank(cum)


# ------------------------------------------------------------------------------------------------ reversal


class ShortTermReversal(ScoreModel):
    """- demeaned cross-sectional rank of the last L-hour return (losers up, winners down)."""

    model_id = "st_reversal"
    family = "SHORT_TERM_REVERSAL"
    xs = True
    default_params = {"horizon_hours": 24, "lookback_hours": 24}

    def score_panel(self, data: Dataset) -> pd.DataFrame:
        c = self._md(data).close
        return -self._xs_rank(log_mom(c, int(self.params["lookback_hours"])))


class ZScoreReversal(ScoreModel):
    """- (P_t - mean_N(P)) / std_N(P): time-series price z-score against its N-hour mean."""

    model_id = "zscore_reversal"
    family = "ZSCORE_REVERSAL"
    default_params = {"window_hours": 72}

    def score_panel(self, data: Dataset) -> pd.DataFrame:
        return -zscore(npf(np.log, self._md(data).close), int(self.params["window_hours"]))


class VolAdjReversal(ScoreModel):
    """- r(t-L, t) / (sigma_short * sqrt(L)) * clip(sigma_short / sigma_long, 0, 3).

    Fades moves, harder when short-term vol is elevated vs long-term (capitulation / overreaction)."""

    model_id = "voladj_reversal"
    family = "VOL_ADJUSTED_REVERSAL"
    default_params = {"lookback_hours": 24, "short_vol_hours": 72}

    def score_panel(self, data: Dataset) -> pd.DataFrame:
        md = self._md(data)
        r = hourly_returns(md)
        L = int(self.params["lookback_hours"])
        vs = trailing_vol(r, int(self.params["short_vol_hours"]))
        vl = trailing_vol(r, int(self.params["vol_hours"]))
        ratio = (vs / vl.where(vl > 0)).clip(0.0, 3.0)
        return -log_mom(md.close, L) / (vs.where(vs > 0) * math.sqrt(L)) * ratio


# ------------------------------------------------------------------------------------------ funding / basis


class FundingReversion(ScoreModel):
    """- z * 1{|z| > threshold}, z = z-score of trailing funding APR vs its own z_days history.

    Hypothesis: crowded longs (extreme positive funding) mean-revert in price."""

    model_id = "funding_reversion"
    family = "FUNDING_EXTREME_REVERSION"
    default_params = {"apr_hours": 72, "z_days": 30, "threshold": 1.5}

    @property
    def warmup_hours(self) -> int:
        return int(self.params["apr_hours"]) + 2 * int(self.params["z_days"]) * 24

    def score_panel(self, data: Dataset) -> pd.DataFrame:
        c = data.perp.close
        z = zscore(funding_apr(data, c, int(self.params["apr_hours"])), int(self.params["z_days"]) * 24)
        return -z.where(z.abs() > float(self.params["threshold"]), 0.0).where(z.notna())


class FundingAcceleration(ScoreModel):
    """(APR_short - APR_long) / std_N(APR_short - APR_long): the change in funding pressure."""

    model_id = "funding_accel"
    family = "FUNDING_ACCELERATION"
    default_params = {"short_hours": 24, "long_hours": 168, "z_days": 30}

    @property
    def warmup_hours(self) -> int:
        return int(self.params["long_hours"]) + 2 * int(self.params["z_days"]) * 24

    def score_panel(self, data: Dataset) -> pd.DataFrame:
        c = data.perp.close
        d = funding_apr(data, c, int(self.params["short_hours"])) - funding_apr(
            data, c, int(self.params["long_hours"]))
        n = int(self.params["z_days"]) * 24
        sd = d.rolling(n, min_periods=n // 2).std()
        return d / sd.where(sd > 0)


class BasisReversion(ScoreModel):
    """z-score of basis = P_spot / P_perp - 1 over z_hours. Positive (perp cheap) -> perp expected to rise."""

    model_id = "basis_reversion"
    family = "BASIS_REVERSION"
    default_params = {"z_hours": 168, "max_abs_basis": 0.02}

    def score_panel(self, data: Dataset) -> pd.DataFrame:
        perp = data.perp.close
        spot = data.spot.close.reindex_like(perp)
        basis = spot / perp - 1.0
        basis = basis.where(basis.abs() <= float(self.params["max_abs_basis"]))
        return zscore(basis, int(self.params["z_hours"]))


# ---------------------------------------------------------------------------------------------- volatility


def har_features(rets: pd.DataFrame) -> dict[str, pd.DataFrame]:
    """Daily-scale realized variance: RV_d (24h), RV_w (7d mean), RV_m (30d mean). Trailing only."""
    r2 = rets.pow(2)
    rv_d = r2.rolling(24, min_periods=20).sum()
    return {"d": rv_d, "w": r2.rolling(168, min_periods=140).sum() / 7.0,
            "m": r2.rolling(720, min_periods=600).sum() / 30.0}


class HARVolMixin(ScoreModel):
    """HAR-RV (Corsi 2009): RV_{t+1d} = c + b_d RV_d + b_w RV_w + b_m RV_m, pooled OLS on the train window."""

    har_: np.ndarray | None = None

    @property
    def warmup_hours(self) -> int:
        return 720 + 2 * int(self.params["vol_hours"]) + 24 * 30

    def _fit_inner(self, train: Dataset) -> None:
        r = hourly_returns(self._md(train))
        f = har_features(r)
        target = r.pow(2).rolling(24, min_periods=20).sum().shift(-24)
        cols = [f[k].to_numpy(dtype=float)[::24].ravel() for k in ("d", "w", "m")]
        y = target.to_numpy(dtype=float)[::24].ravel()
        x = np.column_stack([np.ones_like(y), *cols])
        m = np.isfinite(x).all(axis=1) & np.isfinite(y)
        if m.sum() < 30:
            self.har_ = np.array([0.0, 0.0, 0.0, 1.0])  # fallback: RV_m persistence
        else:
            self.har_ = ols(x[m], y[m])

    def har_vol(self, data: Dataset) -> pd.DataFrame:
        """Forecast daily vol (sqrt of HAR variance forecast, floored at 1e-10 variance)."""
        if self.har_ is None:
            raise RuntimeError("HAR not fitted")
        f = har_features(hourly_returns(self._md(data)))
        c = self.har_
        var = c[0] + c[1] * f["d"] + c[2] * f["w"] + c[3] * f["m"]
        return npf(np.sqrt, var.clip(lower=1e-10))


class VolRegime(HARVolMixin):
    """sign(7d mom) * (sigma_HAR / sigma_m - 1): continuation when vol expands, fade when it contracts."""

    model_id = "vol_regime"
    family = "VOLATILITY_EXPANSION_CONTRACTION"
    default_params = {"mom_days": 7}

    def score_panel(self, data: Dataset) -> pd.DataFrame:
        md = self._md(data)
        sig_m = npf(np.sqrt, har_features(hourly_returns(md))["m"])
        ratio = self.har_vol(data) / sig_m.where(sig_m > 0) - 1.0
        return npf(np.sign, log_mom(md.close, int(self.params["mom_days"]) * 24)) * ratio


class VolManagedMomentum(HARVolMixin):
    """TS-momentum sign score * clip(target_daily_vol / sigma_HAR, 0, max_scale)  (Moreira-Muir scaling)."""

    model_id = "vol_managed_tsmom"
    family = "VOL_MANAGED_SCALING"
    default_params = {"lookbacks_days": [7, 30], "target_daily_vol": 0.03, "max_scale": 2.0}

    @property
    def warmup_hours(self) -> int:
        return max(max(self.params["lookbacks_days"]) * 24, 720) + 2 * int(self.params["vol_hours"]) + 24 * 30

    def score_panel(self, data: Dataset) -> pd.DataFrame:
        c = self._md(data).close
        parts = [npf(np.sign, log_mom(c, int(L) * 24)) for L in self.params["lookbacks_days"]]
        mom = sum(parts[1:], parts[0]) / len(parts)
        scale = (float(self.params["target_daily_vol"]) / self.har_vol(data)).clip(
            0.0, float(self.params["max_scale"]))
        return mom * scale
