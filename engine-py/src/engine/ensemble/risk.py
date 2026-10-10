"""Portfolio risk engine, separate from prediction.

Turns desired signed exposures (alpha scores) into target weights (fraction of equity) under, in
order: vol targeting -> per-asset cap -> liquidity cap (fraction of ADV) -> correlation-aware
cluster cap -> sector / exchange caps -> CVaR cap -> drawdown throttle -> net & gross leverage caps.
Every constraint that changed the weights is reported in `binding`.

Defaults for gross leverage and the drawdown kill level come from `engine.live.risk.RiskLimits`
(config/live.yaml `risk:`), and `engine.live.risk.check_risk` remains the live kill/halt switch: a
halt passed in here flattens the book.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from engine.live.risk import RiskLimits


@dataclass(frozen=True)
class RiskConfig:
    target_vol_annual: float = 0.20
    periods_per_year: float = 365.0          # vol inputs are per-period (e.g. daily) stdevs
    max_asset_weight: float = 0.25
    max_gross_leverage: float = RiskLimits().max_gross_leverage
    max_net_leverage: float = 1.0
    max_adv_fraction: float = 0.01           # |position notional| <= x * ADV
    cluster_corr: float = 0.7                # assets with |corr| >= this form a cluster
    max_cluster_gross: float = 0.5
    dd_soft: float = 0.10                    # throttle starts
    dd_hard: float = RiskLimits().max_drawdown   # flat at/after this (matches live kill switch)
    cvar_alpha: float = 0.95
    max_cvar: float = 0.05                   # per-period portfolio CVaR (fraction of equity)
    max_sector_gross: dict[str, float] = field(default_factory=dict)
    max_exchange_gross: dict[str, float] = field(default_factory=dict)

    @classmethod
    def from_limits(cls, limits: RiskLimits, **kw: object) -> RiskConfig:
        return cls(max_gross_leverage=limits.max_gross_leverage, dd_hard=limits.max_drawdown, **kw)  # type: ignore[arg-type]


@dataclass(frozen=True)
class RiskInputs:
    alpha: pd.Series                         # signed desired exposure per asset (any scale)
    vol: pd.Series                           # per-period forecast vol per asset
    equity: float = 1.0
    cov: pd.DataFrame | None = None          # per-period covariance; diag(vol^2) if None
    adv_quote: pd.Series | None = None
    scenarios: pd.DataFrame | None = None    # historical per-period returns (rows) x assets for CVaR
    drawdown: float = 0.0                    # current drawdown from peak
    sector: dict[str, str] = field(default_factory=dict)
    exchange: dict[str, str] = field(default_factory=dict)
    halt: bool = False                       # engine.live.risk.check_risk(...).halt


@dataclass
class RiskResult:
    weights: pd.Series
    binding: list[str] = field(default_factory=list)
    stats: dict[str, float] = field(default_factory=dict)


def portfolio_cvar(w: pd.Series, scenarios: pd.DataFrame, alpha: float) -> float:
    pnl = scenarios.reindex(columns=w.index).fillna(0.0).to_numpy() @ w.to_numpy()
    if len(pnl) == 0:
        return float("nan")
    q = np.quantile(pnl, 1 - alpha)
    tail = pnl[pnl <= q]
    return float(-tail.mean()) if len(tail) else 0.0


def _changed(a: pd.Series, b: pd.Series) -> bool:
    return bool((a - b).abs().max() > 1e-12)


def _group_cap(w: pd.Series, groups: dict[str, str], caps: dict[str, float], label: str,
               binding: list[str]) -> pd.Series:
    w = w.copy()
    g = pd.Series({a: groups.get(a, "") for a in w.index})
    for name, cap in caps.items():
        m = g == name
        gross = float(w[m].abs().sum())
        if gross > cap > 0 or (cap == 0 and gross > 0):
            w[m] *= cap / gross if gross else 0.0
            binding.append(f"{label}_cap[{name}]: gross {gross:.3f} -> {cap:.3f}")
    return w


def target_weights(inp: RiskInputs, cfg: RiskConfig | None = None) -> RiskResult:
    cfg = cfg or RiskConfig()
    assets = inp.alpha.index
    binding: list[str] = []
    zero = pd.Series(0.0, index=assets)
    if inp.halt:
        return RiskResult(zero, ["risk_halt: live risk check halted trading -> flat"])
    if inp.drawdown >= cfg.dd_hard:
        msg = f"drawdown_throttle: dd {inp.drawdown:.1%} >= hard {cfg.dd_hard:.1%} -> flat"
        return RiskResult(zero, [msg])

    vol = inp.vol.reindex(assets).astype(float)
    valid = vol.gt(0) & np.isfinite(vol) & np.isfinite(inp.alpha.astype(float))
    raw = (inp.alpha.astype(float) / vol).where(valid, 0.0)
    cov = inp.cov.reindex(index=assets, columns=assets).fillna(0.0) if inp.cov is not None \
        else pd.DataFrame(np.diag(vol.fillna(0.0) ** 2), index=assets, columns=assets)

    # 1. vol targeting
    target = cfg.target_vol_annual / math.sqrt(cfg.periods_per_year)
    c = cov.to_numpy()
    pv = math.sqrt(max(float(raw.to_numpy() @ c @ raw.to_numpy()), 0.0))
    w = raw * (target / pv) if pv > 0 else zero.copy()
    # 2. per-asset cap
    w2 = w.clip(-cfg.max_asset_weight, cfg.max_asset_weight)
    if _changed(w, w2):
        binding.append(f"asset_cap: |w| <= {cfg.max_asset_weight} on "
                       + ",".join(a for a in assets if abs(w[a]) > cfg.max_asset_weight + 1e-12))
    w = w2
    # 3. liquidity cap
    if inp.adv_quote is not None:
        lim = (cfg.max_adv_fraction * inp.adv_quote.reindex(assets) / inp.equity).fillna(0.0)
        w2 = w.clip(-lim, lim)
        if _changed(w, w2):
            binding.append(f"liquidity_cap: notional <= {cfg.max_adv_fraction:.2%} ADV on "
                           + ",".join(a for a in assets if abs(w[a]) > lim[a] + 1e-12))
        w = w2
    # 4. correlation-aware concentration
    sd = np.sqrt(np.diag(cov.to_numpy()))
    with np.errstate(invalid="ignore", divide="ignore"):
        corr = pd.DataFrame(cov.to_numpy() / np.outer(sd, sd), index=assets, columns=assets).fillna(0.0)
    for a in assets:
        members = corr.index[corr[a].abs() >= cfg.cluster_corr]
        gross = float(w[members].abs().sum())
        if gross > cfg.max_cluster_gross:
            w[members] *= cfg.max_cluster_gross / gross
            binding.append(f"cluster_cap[{a}]: gross {gross:.3f} -> {cfg.max_cluster_gross}")
    # 5. sector / exchange
    w = _group_cap(w, inp.sector, cfg.max_sector_gross, "sector", binding)
    w = _group_cap(w, inp.exchange, cfg.max_exchange_gross, "exchange", binding)
    # 6. CVaR (positively homogeneous -> scale)
    cvar = float("nan")
    if inp.scenarios is not None and len(inp.scenarios):
        cvar = portfolio_cvar(w, inp.scenarios, cfg.cvar_alpha)
        if cvar > cfg.max_cvar:
            w *= cfg.max_cvar / cvar
            binding.append(f"cvar_cap: CVaR{cfg.cvar_alpha:.0%} {cvar:.4f} -> {cfg.max_cvar}")
            cvar = cfg.max_cvar
    # 7. drawdown throttle (linear from soft to hard)
    if inp.drawdown > cfg.dd_soft:
        f = max(0.0, (cfg.dd_hard - inp.drawdown) / (cfg.dd_hard - cfg.dd_soft))
        w *= f
        binding.append(f"drawdown_throttle: dd {inp.drawdown:.1%} -> scale {f:.2f}")
    # 8. net and gross leverage
    net = float(w.sum())
    if abs(net) > cfg.max_net_leverage:
        # remove excess net by shrinking the dominant side only
        side = w > 0 if net > 0 else w < 0
        dom = float(w[side].sum())
        w[side] *= (dom - (net - math.copysign(cfg.max_net_leverage, net))) / dom
        binding.append(f"net_leverage_cap: {net:.3f} -> {math.copysign(cfg.max_net_leverage, net):.3f}")
    gross = float(w.abs().sum())
    if gross > cfg.max_gross_leverage:
        w *= cfg.max_gross_leverage / gross
        binding.append(f"gross_leverage_cap: {gross:.3f} -> {cfg.max_gross_leverage}")

    stats = {"gross": float(w.abs().sum()), "net": float(w.sum()),
             "vol_per_period": math.sqrt(max(float(w.to_numpy() @ c @ w.to_numpy()), 0.0)), "cvar": cvar}
    return RiskResult(w, binding, stats)
