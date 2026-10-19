"""Two-sided CUSUM change-point detector on daily variance (causal, online).

s_d = r_d^2 / sigma2_{d-1} - 1, where sigma2_{d-1} is the EXPANDING mean of past squared returns.
S+ = max(0, S+ + s - k) flags a vol increase, S- = max(0, S- - s - k) a vol decrease; on an alarm
(S > h) both sums reset. Every output at day d uses returns <= d only.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from engine.regimes.hmm import daily_returns

MIN_DAYS = 60


def cusum(r: pd.Series, k: float = 0.5, h: float = 5.0) -> pd.DataFrame:
    sq = r**2
    sigma2 = sq.expanding(min_periods=MIN_DAYS).mean().shift(1)
    s = (sq / sigma2 - 1).to_numpy(float)
    up = dn = 0.0
    flag = np.zeros(len(r), dtype=int)
    since = np.full(len(r), np.nan)
    last: int | None = None
    for i, v in enumerate(s):
        if np.isfinite(v):
            up, dn = max(0.0, up + v - k), max(0.0, dn - v - k)
            if up > h or dn > h:
                flag[i] = 1 if up > h else -1
                up = dn = 0.0
                last = i
        if last is not None:
            since[i] = i - last
    return pd.DataFrame({"cp_flag": flag, "days_since_cp": since}, index=r.index)


def daily_cusum(close: pd.Series) -> pd.DataFrame:
    return cusum(daily_returns(close))
