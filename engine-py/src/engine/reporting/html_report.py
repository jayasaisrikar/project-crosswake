"""Self-contained, offline HTML backtest report.

`build_report(ctx, out_path)` renders a single HTML file (plotly.js embedded inline once, no
external network resources). Only ``ctx["results"]`` is required; every other section is derived
from the results when the corresponding ctx key is missing, or skipped when it cannot be derived.
"""

from __future__ import annotations

import html
import math
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import plotly.graph_objects as go

from engine.contracts import BacktestResult

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
PALETTE = ["#2563eb", "#d97706", "#059669", "#7c3aed", "#db2777", "#0891b2", "#65a30d", "#6b7280"]
PERIODS_PER_YEAR_HOURLY = 24 * 365
_YEAR_SECS = 365.25 * 86400.0


# --------------------------------------------------------------------------- local helpers
def result_returns(res: BacktestResult) -> pd.Series:
    """Hourly simple returns of a result (falls back to equity pct_change)."""
    r = res.returns
    if r is None or len(r) == 0:
        r = res.equity.pct_change()
    return r.fillna(0.0).astype(float)


def drawdown(equity: pd.Series) -> pd.Series:
    """Drawdown series (<= 0) relative to running peak."""
    eq = equity.astype(float)
    return eq / eq.cummax() - 1.0


def monthly_table(returns: pd.Series) -> pd.DataFrame:
    """Compounded monthly returns: rows = year, cols = Jan..Dec + 'Year'."""
    r = returns.fillna(0.0).astype(float)
    if len(r) == 0:
        return pd.DataFrame(columns=[*MONTHS, "Year"])
    idx = pd.DatetimeIndex(r.index)
    g = (1.0 + r).groupby([idx.year, idx.month]).prod() - 1.0
    tbl = g.unstack(level=1).reindex(columns=range(1, 13))
    tbl.columns = pd.Index(MONTHS)
    tbl["Year"] = (1.0 + r).groupby(idx.year).prod() - 1.0
    tbl.index.name = "year"
    return tbl


def yearly_returns(returns: pd.Series) -> pd.Series:
    """Compounded calendar-year returns."""
    r = returns.fillna(0.0).astype(float)
    idx = pd.DatetimeIndex(r.index)
    s = (1.0 + r).groupby(idx.year).prod() - 1.0
    s.index.name = "year"
    return s


def _periods_per_year(index: pd.Index) -> float:
    if len(index) < 3:
        return PERIODS_PER_YEAR_HOURLY
    dt = pd.Series(pd.DatetimeIndex(index)).diff().median()
    secs = dt.total_seconds() if pd.notna(dt) else 3600.0
    return _YEAR_SECS / secs if secs > 0 else PERIODS_PER_YEAR_HOURLY


def _years(index: pd.Index) -> float:
    return (index[-1] - index[0]).total_seconds() / _YEAR_SECS


def _sharpe(r: pd.Series) -> float:
    sd = float(r.std())
    return float(r.mean() / sd * math.sqrt(_periods_per_year(r.index))) if sd > 0 else float("nan")


def basic_summary(res: BacktestResult) -> dict[str, float]:
    """Minimal net-of-cost performance summary computed from equity/returns."""
    eq = res.equity.astype(float).dropna()
    r = result_returns(res)
    out: dict[str, float] = {}
    if len(eq) < 2:
        return out
    years = _years(eq.index)
    growth = float(eq.iloc[-1] / eq.iloc[0])
    ppy = _periods_per_year(eq.index)
    out["Total return"] = growth - 1.0
    out["CAGR"] = growth ** (1.0 / years) - 1.0 if years > 0 else float("nan")
    out["Ann. volatility"] = float(r.std()) * math.sqrt(ppy)
    out["Sharpe"] = _sharpe(r)
    dsd = float(np.sqrt((r.clip(upper=0.0) ** 2).mean()))
    out["Sortino"] = float(r.mean() / dsd * math.sqrt(ppy)) if dsd > 0 else float("nan")
    mdd = float(drawdown(eq).min())
    out["Max drawdown"] = mdd
    out["Calmar"] = out["CAGR"] / abs(mdd) if mdd < 0 else float("nan")
    m = monthly_table(r).drop(columns="Year").stack().dropna()
    out["% positive months"] = float(np.mean(m.to_numpy() > 0)) if len(m) else float("nan")
    out["Final equity"] = float(eq.iloc[-1])
    return out


def cost_totals(res: BacktestResult) -> dict[str, float]:
    """Total costs per component (USDT) plus gross P&L = net P&L + total costs."""
    c = res.costs if res.costs is not None else pd.DataFrame()
    tot = {k: float(c[k].sum()) if k in c.columns else 0.0 for k in ("fees", "spread", "impact", "funding")}
    total = sum(tot.values())
    eq = res.equity.astype(float).dropna()
    net = float(eq.iloc[-1] - eq.iloc[0]) if len(eq) else 0.0
    tot["total"] = total
    tot["net_pnl"] = net
    tot["gross_pnl"] = net + total
    return tot


def turnover_exposure(res: BacktestResult) -> dict[str, float]:
    """Average/max exposure relative to equity, time invested, annual turnover, trade count."""
    out: dict[str, float] = {}
    eq = res.equity.astype(float)
    gross: pd.Series | None = None
    net: pd.Series | None = None
    for pos in (res.positions or {}).values():
        if pos is None or pos.empty:
            continue
        p = pos.fillna(0.0)
        g, n = p.abs().sum(axis=1), p.sum(axis=1)
        gross = g if gross is None else gross.add(g, fill_value=0.0)
        net = n if net is None else net.add(n, fill_value=0.0)
    if gross is not None and net is not None:
        e = eq.reindex(gross.index).ffill()
        out["Avg gross exposure (x equity)"] = float((gross / e).mean())
        out["Avg net exposure (x equity)"] = float((net / e).mean())
        out["Max gross exposure (x equity)"] = float((gross / e).max())
        out["% time invested"] = float((gross > 0).mean())
    tr = res.trades
    if tr is not None and not tr.empty and "qty_notional" in tr.columns and len(eq) > 1:
        years = _years(eq.index)
        if years > 0:
            traded = float(tr["qty_notional"].abs().sum())
            out["Annual turnover (x avg equity)"] = traded / float(eq.mean()) / years
        out["Number of trades"] = float(len(tr))
    return out


# --------------------------------------------------------------------------- formatting
_PCT_HINTS = ("return", "cagr", "drawdown", "max_dd", "vol", "%", "pct", "positive", "hit", "win")


def _is_pct_key(key: str) -> bool:
    k = key.lower()
    if "x equity" in k or "turnover" in k or "sharpe" in k:
        return False
    return any(h in k for h in _PCT_HINTS)


def _fmt(v: Any, pct: bool = False, digits: int = 2) -> str:
    if v is None:
        return "–"
    if isinstance(v, pd.Timestamp | datetime):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, bool | np.bool_):
        return "yes" if v else "no"
    if isinstance(v, int | np.integer):
        return f"{int(v):,}"
    if isinstance(v, float | np.floating):
        f = float(v)
        if math.isnan(f) or math.isinf(f):
            return "–"
        if pct:
            return f"{f * 100:.{digits}f}%"
        if abs(f) >= 10000:
            return f"{f:,.0f}"
        return f"{f:,.{digits}f}"
    return html.escape(str(v))


def _e(s: Any) -> str:
    return html.escape(str(s))


def _heat_style(v: float, scale: float) -> str:
    if math.isnan(v) or v == 0:
        return ""
    a = min(abs(v) / scale, 1.0) * 0.55 + 0.08
    var = "--pos-rgb" if v > 0 else "--neg-rgb"
    return f' style="background: rgba(var({var}), {a:.2f})"'


def _df_table(df: pd.DataFrame, pct_cols: set[str] | None = None, index: bool = True) -> str:
    if pct_cols is None:
        pct_cols = {c for c in map(str, df.columns) if _is_pct_key(c)}
    cols = ([df.index.name or ""] if index else []) + [str(c) for c in df.columns]
    head = "".join(f"<th>{_e(c)}</th>" for c in cols)
    rows = []
    for ix, row in df.iterrows():
        cells = [f"<th scope='row'>{_fmt(ix)}</th>"] if index else []
        cells += [f"<td>{_fmt(v, pct=str(c) in pct_cols)}</td>" for c, v in row.items()]
        rows.append("<tr>" + "".join(cells) + "</tr>")
    body = "".join(rows)
    return f"<div class='tw'><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>"


def _monthly_html(tbl: pd.DataFrame) -> str:
    vals = tbl[[c for c in tbl.columns if c != "Year"]].abs().stack().dropna()
    scale = float(np.quantile(vals.to_numpy(dtype=float), 0.9)) if len(vals) else 0.1
    scale = scale if scale > 0 else 0.1
    months = "".join(f"<th>{_e(c)}</th>" for c in tbl.columns if c != "Year")
    head = f"<th>Year</th>{months}<th>Total</th>"
    rows = []
    for yr, row in tbl.iterrows():
        cells = [f"<th scope='row'>{_e(yr)}</th>"]
        for c, v in row.items():
            fv = float(v) if pd.notna(v) else float("nan")
            sc = scale * 3 if c == "Year" else scale
            cls = " class='yr'" if c == "Year" else ""
            cells.append(f"<td{cls}{_heat_style(fv, sc)}>{_fmt(fv, pct=True, digits=1)}</td>")
        rows.append("<tr>" + "".join(cells) + "</tr>")
    return (
        f"<div class='tw'><table class='heat'><thead><tr>{head}</tr></thead>"
        f"<tbody>{''.join(rows)}</tbody></table></div>"
    )


# --------------------------------------------------------------------------- charts
class _FigEmitter:
    """Renders plotly figures as HTML fragments; embeds plotly.js inline only on the first call."""

    def __init__(self) -> None:
        self.first = True

    def __call__(self, fig: go.Figure, div_id: str) -> str:
        fig.update_layout(
            template="none",
            paper_bgcolor="rgba(0,0,0,0)",
            plot_bgcolor="rgba(0,0,0,0)",
            font={"family": "Inter, system-ui, -apple-system, Segoe UI, sans-serif", "size": 12,
                  "color": "#8a8f98"},
            margin={"l": 56, "r": 16, "t": 16, "b": 40},
            legend={"orientation": "h", "y": -0.15},
            hovermode="x unified",
            height=420,
        )
        fig.update_xaxes(gridcolor="rgba(128,128,128,0.18)", zeroline=False)
        fig.update_yaxes(gridcolor="rgba(128,128,128,0.18)", zeroline=False)
        out = fig.to_html(
            full_html=False,
            include_plotlyjs=self.first,
            include_mathjax=False,
            div_id=div_id,
            config={"displaylogo": False, "responsive": True},
        )
        self.first = False
        return str(out)


def _downsample(s: pd.Series, max_points: int = 4000) -> pd.Series:
    if len(s) <= max_points or not isinstance(s.index, pd.DatetimeIndex):
        return s
    return s.resample("D").last().dropna()


def _shade(fig: go.Figure, oos: Mapping[str, Any], end: pd.Timestamp) -> None:
    starts = [pd.Timestamp(v["holdout_start"]) for v in oos.values()
              if isinstance(v, Mapping) and v.get("holdout_start") is not None]
    if not starts:
        return
    hs = min(starts)
    if hs.tzinfo is None and end.tzinfo is not None:
        hs = hs.tz_localize(end.tzinfo)
    fig.add_vrect(x0=hs, x1=end, fillcolor="rgba(217,119,6,0.10)", line_width=0, layer="below")
    fig.add_annotation(x=hs, y=1, yref="paper", text="Out-of-sample holdout →", showarrow=False,
                       xanchor="left", yanchor="top", font={"color": "#d97706"})


# --------------------------------------------------------------------------- stats
_STAT_TEXT: dict[str, str] = {
    "hac_t": "Newey-West (HAC) t-statistic of mean return; |t| > 2 suggests the mean is unlikely to be zero.",
    "psr": "Probabilistic Sharpe Ratio: probability the true Sharpe exceeds 0 given skew/kurtosis.",
    "dsr": "Deflated Sharpe Ratio: probability the Sharpe is real after correcting for the number of trials.",
    "pbo": "Probability of Backtest Overfitting. Lower is better; above 0.5 is a red flag.",
    "spa": "Hansen SPA test p-value: chance the best strategy beats the benchmark by luck.",
    "bootstrap": "Bootstrap confidence interval (block bootstrap).",
    "n_trials": "Number of configurations tried during research (used for deflation).",
}


def _stat_key(k: str) -> str | None:
    kl = k.lower().replace("-", "_").replace(" ", "_")
    if "hac" in kl or kl in ("t_stat", "tstat"):
        return "hac_t"
    for key in ("dsr", "psr", "pbo", "spa", "n_trials"):
        if key in kl:
            return key
    if "boot" in kl or "ci" in kl.split("_"):
        return "bootstrap"
    return None


def _interpret(k: str, v: Any, n_trials: Any) -> str:
    sk = _stat_key(k)
    try:
        f = float(v)
    except (TypeError, ValueError):
        f = float("nan")
    if sk == "dsr" and not math.isnan(f):
        nt = f" after {n_trials} trials" if n_trials is not None else ""
        verdict = "strong" if f >= 0.95 else ("moderate" if f >= 0.8 else "weak")
        return f"DSR {f:.2f} → {f * 100:.0f}% probability the Sharpe is real{nt} ({verdict} evidence)."
    if sk == "psr" and not math.isnan(f):
        return f"{f * 100:.0f}% probability the true Sharpe is above zero (no multiple-testing correction)."
    if sk == "pbo" and not math.isnan(f):
        flag = "acceptable" if f < 0.3 else ("caution" if f <= 0.5 else "likely overfit")
        return f"{f * 100:.0f}% estimated probability the selected configuration is overfit ({flag})."
    if sk == "spa" and not math.isnan(f):
        sig = "significant at 5%" if f < 0.05 else "not significant at 5%"
        return f"p = {f:.3f}: outperformance vs benchmark is {sig}."
    if sk == "hac_t" and not math.isnan(f):
        sig = "statistically distinguishable from zero" if abs(f) > 2 else "not clearly different from zero"
        return f"t = {f:.2f}: mean return is {sig}."
    if sk == "bootstrap" and isinstance(v, list | tuple) and len(v) == 2:
        lo, hi = float(v[0]), float(v[1])
        inc = "excludes zero" if lo > 0 or hi < 0 else "includes zero (edge not established)"
        return f"Interval [{lo:.2f}, {hi:.2f}] {inc}."
    return _STAT_TEXT.get(sk or "", "")


def _fmt_stat(v: Any) -> str:
    if isinstance(v, list | tuple):
        return "[" + ", ".join(_fmt(x) for x in v) + "]"
    if isinstance(v, Mapping):
        return ", ".join(f"{_e(a)}: {_fmt(b)}" for a, b in v.items())
    if isinstance(v, float | np.floating):
        return _fmt(float(v), digits=3)
    return _fmt(v)


# --------------------------------------------------------------------------- css / text
CSS = """
:root{--bg:#f7f7f5;--card:#ffffff;--fg:#1b1d21;--muted:#646a73;--line:#e3e4e1;--accent:#2563eb;
--pos-rgb:22,163,74;--neg-rgb:220,38,38;--warn:#b45309;}
@media (prefers-color-scheme: dark){:root{--bg:#0f1115;--card:#171a20;--fg:#e7e9ec;--muted:#9aa1ab;
--line:#2a2f37;--accent:#60a5fa;--pos-rgb:34,197,94;--neg-rgb:248,113,113;--warn:#f59e0b;}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 Inter,system-ui,-apple-system,
"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:1180px;margin:0 auto;padding:40px 20px 80px}
header h1{font-size:30px;letter-spacing:-.02em;margin:0 0 6px}
header .meta{color:var(--muted);font-size:13px;display:flex;flex-wrap:wrap;gap:6px 18px}
.banner{margin:18px 0 0;padding:10px 14px;border:1px solid var(--line);border-left:3px solid var(--warn);
border-radius:6px;background:var(--card);font-size:13px;color:var(--muted)}
nav{margin:22px 0 8px;display:flex;flex-wrap:wrap;gap:6px 14px;font-size:13px}
nav a{color:var(--muted);text-decoration:none}nav a:hover{color:var(--accent)}
section{margin-top:40px}
h2{font-size:19px;letter-spacing:-.01em;margin:0 0 4px}
h3{font-size:15px;margin:22px 0 8px;color:var(--muted);font-weight:600}
.sub{color:var(--muted);font-size:13px;margin:0 0 14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-top:24px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.kpi .l{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.kpi .v{font-size:26px;font-weight:650;letter-spacing:-.02em;margin-top:4px;font-variant-numeric:tabular-nums}
.tw{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
thead th{color:var(--muted);font-weight:600;font-size:12px}
th:first-child,td:first-child{text-align:left}
table.heat td{border:1px solid var(--card);text-align:center;min-width:54px}
table.heat td.yr{font-weight:650}
td.interp{white-space:normal;text-align:left;color:var(--muted)}
td.wrap{white-space:normal;text-align:left}
ul.notes li{margin:4px 0}
footer{margin-top:60px;color:var(--muted);font-size:12px;border-top:1px solid var(--line);padding-top:14px}
@media (max-width:640px){main{padding:24px 16px}header h1{font-size:24px}.kpi .v{font-size:21px}}
"""

DEFAULT_METHOD = [
    "All results are net of modelled trading costs (exchange fees, half-spread, market impact) and "
    "perpetual funding payments, simulated on hourly bars.",
    "Signals use information available at bar t and are executed at the open of bar t+1; no same-bar fills.",
    "Out-of-sample periods (where shown) were not used to choose parameters. In-sample results are "
    "optimistic by construction.",
    "Stress tests re-run the backtest with all trading costs multiplied (e.g. 1.5x, 2x).",
]
DEFAULT_LIMITS = [
    "Backtested, hypothetical performance. It does not represent actual trading, and past "
    "performance does not guarantee future results.",
    "The cost model is an approximation; real slippage in fast markets, outages and liquidations "
    "can be worse.",
    "Exchange counterparty, custody and regulatory risks are not modelled.",
    "Crypto history is short and regime-dependent; the sample may not contain future market conditions.",
]


# --------------------------------------------------------------------------- sections
def _summary_section(names: list[str], summaries: dict[str, dict]) -> str:
    keys: list[str] = []
    for s in summaries.values():
        keys += [k for k in s if k not in keys]
    rows = "".join(
        f"<tr><th scope='row'>{_e(k)}</th>"
        + "".join(f"<td>{_fmt(summaries.get(n, {}).get(k), pct=_is_pct_key(k))}</td>" for n in names)
        + "</tr>"
        for k in keys
    )
    head = "".join(f"<th>{_e(n)}</th>" for n in names)
    return (f"<div class='card tw'><table><thead><tr><th>Metric</th>{head}</tr></thead>"
            f"<tbody>{rows}</tbody></table></div>")


def _oos_rows(results: dict[str, BacktestResult], oos: Mapping[str, Any]) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for n, lab in oos.items():
        if n not in results or not isinstance(lab, Mapping) or lab.get("holdout_start") is None:
            continue
        r = result_returns(results[n])
        tz = r.index.tz if isinstance(r.index, pd.DatetimeIndex) else None

        def ts(x: Any, tz: Any = tz) -> pd.Timestamp:
            t = pd.Timestamp(x)
            return t.tz_localize(tz) if t.tzinfo is None and tz is not None else t

        hs = ts(lab["holdout_start"])
        ise = ts(lab.get("in_sample_end") or lab["holdout_start"])
        for seg, rr in (("In-sample", r.loc[r.index <= ise]), ("Out-of-sample", r.loc[r.index >= hs])):
            if len(rr) < 2:
                continue
            yrs = _years(rr.index)
            tot = float(np.prod(1.0 + rr.to_numpy(dtype=float)) - 1.0)
            rows.append({
                "Strategy": n, "Segment": seg, "Start": rr.index[0], "End": rr.index[-1],
                "Total return": tot,
                "CAGR": (1 + tot) ** (1 / yrs) - 1 if yrs > 0 else float("nan"),
                "Sharpe": _sharpe(rr),
                "Max drawdown": float(drawdown((1 + rr).cumprod()).min()),
            })
    return pd.DataFrame(rows).set_index("Strategy") if rows else pd.DataFrame()


# --------------------------------------------------------------------------- main
def build_report(ctx: dict, out_path: str) -> str:
    """Render the HTML report to ``out_path`` and return the path written."""
    if ctx.get("periods"):
        return build_period_report(ctx, out_path)
    results: dict[str, BacktestResult] = dict(ctx["results"])
    if not results:
        raise ValueError("ctx['results'] must contain at least one BacktestResult")
    names = list(results)
    primary = "Combined" if "Combined" in results else names[0]
    color = {n: PALETTE[i % len(PALETTE)] for i, n in enumerate(names)}
    emit = _FigEmitter()

    summaries: dict[str, dict] = {n: basic_summary(r) for n, r in results.items()}
    for n, s in (ctx.get("summaries") or {}).items():
        summaries[n] = {**summaries.get(n, {}), **dict(s)}
    monthly = {n: monthly_table(result_returns(r)) for n, r in results.items()}
    monthly.update(ctx.get("monthly") or {})
    yearly = {n: yearly_returns(result_returns(r)) for n, r in results.items()}
    yearly.update(ctx.get("yearly") or {})
    oos: Mapping[str, Any] = ctx.get("oos_label") or {}

    title = ctx.get("title") or "Backtest Report"
    gen = ctx.get("generated_at") or datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC")
    eq0 = results[primary].equity
    data_range = ctx.get("data_range") or (
        f"{eq0.index[0]:%Y-%m-%d} → {eq0.index[-1]:%Y-%m-%d}" if len(eq0) else "–"
    )
    universe = ctx.get("universe")
    if isinstance(universe, list | tuple):
        universe = ", ".join(map(str, universe))
    git_sha = ctx.get("git_sha") or results[primary].meta.get("git_sha")
    end_ts = max(r.equity.index[-1] for r in results.values() if len(r.equity))

    parts: list[str] = []
    toc: list[tuple[str, str]] = []

    def sec(sid: str, h: str, sub: str, body: str) -> None:
        toc.append((sid, h))
        parts.append(f"<section id='{sid}'><h2>{_e(h)}</h2><p class='sub'>{sub}</p>{body}</section>")

    # KPI tiles (primary)
    s0 = {k.lower(): v for k, v in summaries[primary].items()}

    def pick(*keys: str) -> Any:
        return next((s0[k] for k in keys if k in s0), None)

    kpis = [
        ("CAGR", pick("cagr"), True),
        ("Sharpe", pick("sharpe"), False),
        ("Max drawdown", pick("max drawdown", "max_drawdown", "max_dd"), True),
        ("% positive months", pick("% positive months", "pct_positive_months"), True),
        ("Final equity", pick("final equity", "final_equity"), False),
    ]
    kpi_html = "".join(
        f"<div class='kpi'><div class='l'>{_e(lbl)}</div>"
        f"<div class='v'>{_fmt(v, pct=p, digits=1 if p else 2)}</div></div>"
        for lbl, v, p in kpis
    )

    sec("summary", "Performance summary", "All figures net of fees, spread, impact and funding.",
        _summary_section(names, summaries))

    # Equity curves
    fig = go.Figure()
    for n, r in results.items():
        eq = _downsample(r.equity.astype(float).dropna())
        if len(eq):
            fig.add_trace(go.Scatter(x=eq.index, y=eq / eq.iloc[0], name=n, mode="lines",
                                     line={"color": color[n], "width": 1.6}))
    fig.update_yaxes(type="log", title_text="Growth of 1 (log)")
    _shade(fig, oos, end_ts)
    shade_txt = " Shaded region = out-of-sample holdout (not used for parameter selection)." if oos else ""
    sec("equity", "Equity curves", "Normalised to 1, log scale, net of all costs." + shade_txt,
        "<div class='card'>" + emit(fig, "fig-equity") + "</div>")

    # Drawdowns
    fig = go.Figure()
    for n, r in results.items():
        dd = _downsample(drawdown(r.equity.dropna()))
        fig.add_trace(go.Scatter(x=dd.index, y=dd, name=n, mode="lines",
                                 line={"color": color[n], "width": 1.2},
                                 fill="tozeroy" if n == primary else None))
    fig.update_yaxes(tickformat=".0%", title_text="Drawdown from peak")
    _shade(fig, oos, end_ts)
    sec("drawdown", "Drawdowns", "Peak-to-trough decline of net equity.",
        "<div class='card'>" + emit(fig, "fig-dd") + "</div>")

    # In-sample vs out-of-sample
    if oos:
        odf = _oos_rows(results, oos)
        if not odf.empty:
            sec("oos", "In-sample vs out-of-sample",
                "Out-of-sample is the honest estimate; in-sample is where parameters were chosen.",
                "<div class='card'>" + _df_table(odf) + "</div>")

    # Monthly
    mb = "".join(f"<h3>{_e(n)}</h3><div class='card'>{_monthly_html(t)}</div>" for n, t in monthly.items())
    sec("monthly", "Monthly returns",
        "Compounded net monthly returns; 'Total' is the calendar-year return. Green = gain, red = loss.", mb)

    # Yearly
    fig = go.Figure()
    for n, ys in yearly.items():
        fig.add_trace(go.Bar(x=[str(i) for i in ys.index], y=ys.to_numpy(), name=n,
                             marker_color=color.get(n, PALETTE[-1])))
    fig.update_layout(barmode="group")
    fig.update_yaxes(tickformat=".0%")
    sec("yearly", "Calendar-year returns", "Net of all costs.",
        "<div class='card'>" + emit(fig, "fig-yr") + "</div>")

    # Costs
    crow = []
    for n, r in results.items():
        t = cost_totals(r)
        g = t["gross_pnl"]
        crow.append({
            "Strategy": n, "Fees": t["fees"], "Spread": t["spread"], "Impact": t["impact"],
            "Funding": t["funding"], "Total costs": t["total"], "Gross P&L": g, "Net P&L": t["net_pnl"],
            "Costs % of gross P&L": t["total"] / g if g > 0 else float("nan"),
        })
    cdf = pd.DataFrame(crow).set_index("Strategy")
    sec("costs", "Cost breakdown",
        "Totals in quote currency (USDT). Gross P&L = net P&L + costs. Funding: positive = paid, "
        "negative = received. Cost share is shown only where gross P&L is positive.",
        "<div class='card'>" + _df_table(cdf, pct_cols={"Costs % of gross P&L"}) + "</div>")

    # Stress
    stress = ctx.get("stress")
    if isinstance(stress, pd.DataFrame) and not stress.empty:
        st = stress.copy()
        st.index = pd.Index([f"{float(i):.1f}x costs" if isinstance(i, int | float) else str(i)
                             for i in st.index], name="Cost multiplier")
        sec("stress", "Cost stress test",
            "Same strategy re-run with all trading costs scaled up. A robust edge should survive 2x costs.",
            "<div class='card'>" + _df_table(st) + "</div>")

    # Walk-forward
    wf = ctx.get("walk_forward")
    if isinstance(wf, pd.DataFrame) and not wf.empty:
        body = "<div class='card'>" + _df_table(wf, index=False) + "</div>"
        tcol = next((c for c in wf.columns if "return" in str(c).lower()), None)
        if tcol is not None:
            v = pd.to_numeric(wf[tcol], errors="coerce").dropna()
            if len(v):
                body += (f"<p class='sub' style='margin-top:10px'>{int((v > 0).sum())} of {len(v)} "
                         "test folds "
                         f"positive; median fold return {_fmt(float(v.median()), pct=True)}.</p>")
        sec("walkforward", "Walk-forward validation",
            "Parameters re-fit on each training window, evaluated on the following unseen test window.", body)

    # Statistical robustness
    stats = ctx.get("stats")
    if stats:
        n_trials = next((v for k, v in stats.items() if _stat_key(k) == "n_trials"), None)
        rows_h = "".join(
            f"<tr><th scope='row'>{_e(k)}</th><td>{_fmt_stat(v)}</td>"
            f"<td class='interp'>{_e(_interpret(k, v, n_trials))}</td></tr>"
            for k, v in stats.items()
        )
        sec("stats", "Statistical robustness",
            "Tests of whether the result could be luck or overfitting, with a plain-English reading.",
            "<div class='card tw'><table><thead><tr><th>Test</th><th>Value</th><th>Interpretation</th></tr>"
            f"</thead><tbody>{rows_h}</tbody></table></div>")

    # Exposure / turnover
    ex = {n: turnover_exposure(r) for n, r in results.items()}
    ekeys: list[str] = []
    for d in ex.values():
        ekeys += [k for k in d if k not in ekeys]
    if ekeys:
        edf = pd.DataFrame({n: [ex[n].get(k) for k in ekeys] for n in names},
                           index=pd.Index(ekeys, name="Metric"))
        sec("exposure", "Exposure & turnover", "Position sizing relative to equity and trading intensity.",
            "<div class='card'>" + _df_table(edf, pct_cols=set()) + "</div>")

    # Methodology & limitations
    params = ctx.get("params") or {}
    p_html = ""
    if params:
        p_html = "<h3>Parameters</h3><div class='card tw'><table><tbody>" + "".join(
            f"<tr><th scope='row'>{_e(k)}</th><td class='wrap'>{_e(v)}</td></tr>" for k, v in params.items()
        ) + "</tbody></table></div>"
    notes = [str(x) for x in (ctx.get("notes") or [])]
    meth = (
        "<h3>Methodology</h3><ul class='notes'>" + "".join(f"<li>{_e(x)}</li>" for x in DEFAULT_METHOD)
        + "</ul><h3>Limitations</h3><ul class='notes'>"
        + "".join(f"<li>{_e(x)}</li>" for x in [*notes, *DEFAULT_LIMITS]) + "</ul>" + p_html
    )
    sec("method", "Methodology & limitations", "Read before drawing conclusions.", meth)

    meta_bits = [f"Generated {_e(gen)}", f"Data {_e(data_range)}"]
    if universe:
        meta_bits.append(f"Universe: {_e(universe)}")
    if git_sha:
        meta_bits.append(f"Commit {_e(str(git_sha)[:10])}")
    nav = "".join(f"<a href='#{sid}'>{_e(h)}</a>" for sid, h in toc)
    meta_html = "".join(f"<span>{b}</span>" for b in meta_bits)
    doc = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>{_e(title)}</title><style>{CSS}</style></head>
<body><main>
<header><h1>{_e(title)}</h1><div class="meta">{meta_html}</div>
<div class="banner">Hypothetical backtest. All numbers are net of modelled costs. Headline figures refer to
<strong>{_e(primary)}</strong> over the full sample (in-sample and out-of-sample combined).</div>
<div class="kpis">{kpi_html}</div></header>
<nav>{nav}</nav>
{''.join(parts)}
<footer>Self-contained report; no external resources are loaded.</footer>
</main></body></html>
"""
    p = Path(out_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(doc, encoding="utf-8")
    return str(p)


# --------------------------------------------------------------------------- period-labelled report
_SUMMARY_LABELS = {
    "total_return": "Total return", "cagr": "CAGR", "ann_vol": "Ann. volatility", "sharpe": "Sharpe",
    "sortino": "Sortino", "calmar": "Calmar", "max_drawdown": "Max drawdown", "worst_month": "Worst month",
    "best_month": "Best month", "pct_positive_months": "% positive months", "final_equity": "Final equity",
}
_PCT_SUMMARY = {"Total return", "CAGR", "Ann. volatility", "Max drawdown", "Worst month", "Best month",
                "% positive months"}
PERIOD_CSS = """
.kpi .kv{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-top:6px}
.kpi .kl{font-size:11px;color:var(--muted);line-height:1.3}
.kpi .kv .v{font-size:21px;margin-top:0}
"""


def _period_summary_html(summary: pd.DataFrame) -> str:
    t = summary.rename(columns=_SUMMARY_LABELS).T
    rows = []
    for k, row in t.iterrows():
        cells = "".join(f"<td>{_fmt(v, pct=str(k) in _PCT_SUMMARY)}</td>" for v in row)
        rows.append(f"<tr><th scope='row'>{_e(k)}</th>{cells}</tr>")
    head = "".join(f"<th>{_e(c)}</th>" for c in t.columns)
    return (f"<div class='card tw'><table><thead><tr><th>Metric</th>{head}</tr></thead>"
            f"<tbody>{''.join(rows)}</tbody></table></div>")


def _stats_html(st: Mapping[str, Any]) -> str:
    skip = {"period", "label", "start", "end"}
    n_trials = st.get("n_trials")
    rows = []
    for k, v in st.items():
        if k in skip:
            continue
        iv = v.get("pvalue") if isinstance(v, Mapping) else v
        rows.append(f"<tr><th scope='row'>{_e(k)}</th><td>{_fmt_stat(v)}</td>"
                    f"<td class='interp'>{_e(_interpret(k, iv, n_trials))}</td></tr>")
    return ("<div class='card tw'><table><thead><tr><th>Test</th><th>Value</th><th>Interpretation</th>"
            f"</tr></thead><tbody>{''.join(rows)}</tbody></table></div>")


def _kpi_val(p: Mapping[str, Any], key: str) -> Any:
    s = p.get("summary")
    if not isinstance(s, pd.DataFrame) or "Combined" not in s.index or key not in s.columns:
        return None
    return s.loc["Combined", key]


_PERIOD_SUB = {
    "dev": "Parameters were chosen on this period; in-sample results are optimistic by construction.",
    "holdout": "Out-of-sample. Returns inside this window only, equity rebased to initial capital at its "
               "start. This is the honest estimate.",
    "full": "Development + holdout combined. Descriptive only; do not read as out-of-sample evidence.",
}


def _period_body(p: Mapping[str, Any]) -> str:
    rng, lab = _e(p["range"]), _e(p["label"])
    body = f"<h3>Performance summary — {lab} ({rng})</h3>" + _period_summary_html(p["summary"])
    body += (f"<h3>Cost transparency — {lab} ({rng})</h3><div class='card'>"
             + _df_table(p["costs"], pct_cols=set()) + "</div><p class='sub'>USDT per initial capital "
             "invested at period start. Gross P&amp;L = net P&amp;L + fees + spread + impact + funding. "
             "Funding: positive = paid, negative = received (shown separately for every sleeve, "
             "including Trend).</p>")
    body += (f"<h3>Allocation comparison — {lab} ({rng})</h3><div class='card'>"
             + _df_table(p["allocations"], pct_cols={"CAGR", "Max drawdown", "Worst month",
                                                     "% positive months"})
             + "</div><p class='sub'>Same dates and cost model for every row. Sleeves re-run at the exact "
             "capital of each allocation (no linear rescale); cash earns 0; no inter-sleeve "
             "rebalancing.</p>")
    body += f"<h3>Statistical tests — {lab} ({rng})</h3>" + _stats_html(p["stats"])
    if p["key"] == "dev":
        body += ("<p class='sub'>DSR and PBO here are the selection-relevant figures (trial grid "
                 "evaluated on the development period).</p>")
    st = p.get("stress")
    if isinstance(st, pd.DataFrame) and not st.empty:
        body += f"<h3>Cost stress, Combined — {lab} ({rng})</h3><div class='card'>" + _df_table(st) + "</div>"
    if "Combined" in p["results"]:
        mt = monthly_table(result_returns(p["results"]["Combined"]))
        body += (f"<h3>Monthly returns, Combined — {lab} ({rng})</h3>"
                 f"<div class='card'>{_monthly_html(mt)}</div>")
    return body


def build_period_report(ctx: dict, out_path: str) -> str:
    """Single report with clearly labelled DEVELOPMENT / HOLDOUT ONLY / FULL PERIOD / walk-forward sections.
    Every period's numbers come from returns inside that period only (prepared by the pipeline)."""
    results: dict[str, BacktestResult] = dict(ctx["results"])
    periods: list[dict[str, Any]] = list(ctx["periods"])
    by_key = {p["key"]: p for p in periods}
    color = {n: PALETTE[i % len(PALETTE)] for i, n in enumerate(results)}
    emit = _FigEmitter()
    title = ctx.get("title") or "Backtest Report"
    gen = ctx.get("generated_at") or datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC")
    views = ctx.get("holdout_views", 0)
    unlocked = bool(ctx.get("holdout_unlocked"))
    oos: Mapping[str, Any] = ctx.get("oos_label") or {}
    start_ts = min(r.equity.index[0] for r in results.values() if len(r.equity))
    end_ts = max(r.equity.index[-1] for r in results.values() if len(r.equity))
    full_range = f"{start_ts:%Y-%m-%d} → {end_ts:%Y-%m-%d}"

    parts: list[str] = []
    toc: list[tuple[str, str]] = []

    def sec(sid: str, h: str, sub: str, body: str) -> None:
        toc.append((sid, h))
        parts.append(f"<section id='{sid}'><h2>{_e(h)}</h2><p class='sub'>{sub}</p>{body}</section>")

    # KPI tiles: holdout-only and full period side by side (development only when locked)
    tile_periods = [by_key[k] for k in ("holdout", "full") if k in by_key] or periods
    kdefs = [("CAGR", "cagr", True), ("Sharpe", "sharpe", False), ("Max drawdown", "max_drawdown", True),
             ("% positive months", "pct_positive_months", True)]
    kpi_html = ""
    for lbl, key, pct in kdefs:
        vals = "".join(
            f"<div class='kv'><span class='kl'>{_e(p['label'].split(' (')[0])}<br>{_e(p['range'])}</span>"
            f"<span class='v'>{_fmt(_kpi_val(p, key), pct=pct, digits=1 if pct else 2)}</span></div>"
            for p in tile_periods
        )
        kpi_html += f"<div class='kpi'><div class='l'>{_e(lbl)} — Combined</div>{vals}</div>"

    hlog = ctx.get("holdout_log")
    if isinstance(hlog, pd.DataFrame):
        body = ("<div class='card'>" + _df_table(hlog, pct_cols=set()) + "</div>") if len(hlog) else \
            "<p class='sub'>No holdout unlocks recorded.</p>"
        sec("holdout-log", f"Holdout access log ({views} views)",
            "Every unlock of the holdout, from experiments/holdout_log.jsonl (append-only).", body)

    fig = go.Figure()
    for n, r in results.items():
        eq = _downsample(r.equity.astype(float).dropna())
        if len(eq):
            fig.add_trace(go.Scatter(x=eq.index, y=eq / eq.iloc[0], name=n, mode="lines",
                                     line={"color": color[n], "width": 1.6}))
    fig.update_yaxes(type="log", title_text="Growth of 1 (log)")
    _shade(fig, oos, end_ts)
    sec("equity", f"Equity curves ({full_range})",
        "Whole run, normalised to 1, log scale, net of all costs."
        + (" Shaded = HOLDOUT (not used for parameter selection)." if oos else ""),
        "<div class='card'>" + emit(fig, "fig-equity") + "</div>")

    for p in periods:
        sec(f"period-{p['key']}", f"{p['label']}: {p['range']}", _PERIOD_SUB.get(p["key"], ""),
            _period_body(p))

    wf = ctx.get("walk_forward")
    if isinstance(wf, pd.DataFrame) and not wf.empty:
        body = "<div class='card'>" + _df_table(wf, index=False) + "</div>"
        if "test_return" in wf.columns:
            v = pd.to_numeric(wf["test_return"], errors="coerce").dropna()
            if len(v):
                body += (f"<p class='sub' style='margin-top:10px'>{int((v > 0).sum())} of {len(v)} test "
                         f"folds positive; median fold return {_fmt(float(v.median()), pct=True)}.</p>")
        wf_rng = full_range
        if "test" in wf.columns:
            first, last = str(wf["test"].iloc[0]), str(wf["test"].iloc[-1])
            wf_rng = f"{first.split(' → ')[0]} → {last.split(' → ')[-1]}"
        sec("walkforward", f"WALK-FORWARD folds (tests {wf_rng})",
            "Parameters are FIXED (not re-fit per fold): this measures per-fold stability only. Each fold is "
            "labelled with the period its test window falls in.", body)

    notes = [str(x) for x in (ctx.get("notes") or [])]
    params = ctx.get("params") or {}
    p_html = ""
    if params:
        p_html = "<h3>Parameters</h3><div class='card tw'><table><tbody>" + "".join(
            f"<tr><th scope='row'>{_e(k)}</th><td class='wrap'>{_e(v)}</td></tr>" for k, v in params.items()
        ) + "</tbody></table></div>"
    meth = ("<h3>Methodology</h3><ul class='notes'>" + "".join(f"<li>{_e(x)}</li>" for x in DEFAULT_METHOD)
            + "</ul><h3>Limitations</h3><ul class='notes'>"
            + "".join(f"<li>{_e(x)}</li>" for x in [*notes, *DEFAULT_LIMITS]) + "</ul>" + p_html)
    sec("method", "Methodology & limitations", "Read before drawing conclusions.", meth)

    meta_bits = [f"Generated {_e(gen)}", f"Data {_e(ctx.get('data_range') or full_range)}"]
    universe = ctx.get("universe")
    if isinstance(universe, list | tuple):
        meta_bits.append("Universe: " + _e(", ".join(map(str, universe))))
    if ctx.get("git_sha"):
        meta_bits.append(f"Commit {_e(str(ctx['git_sha'])[:10])}")
    lock_txt = ("Holdout UNLOCKED for this run." if unlocked
                else "Holdout LOCKED: this report contains DEVELOPMENT-period results only.")
    period_list = "; ".join(f"{p['label']}: {p['range']}" for p in periods)
    nav = "".join(f"<a href='#{sid}'>{_e(h)}</a>" for sid, h in toc)
    meta_html = "".join(f"<span>{b}</span>" for b in meta_bits)
    doc = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>{_e(title)}</title><style>{CSS}{PERIOD_CSS}</style></head>
<body><main>
<header><h1>{_e(title)}</h1><div class="meta">{meta_html}</div>
<div class="banner"><strong>Hypothetical backtest. Holdout viewed {views} times (from
experiments/holdout_log.jsonl).</strong> {_e(lock_txt)} All numbers are net of modelled costs.
Periods: {_e(period_list)}.</div>
<div class="kpis">{kpi_html}</div></header>
<nav>{nav}</nav>
{''.join(parts)}
<footer>Self-contained report; no external resources are loaded.</footer>
</main></body></html>
"""
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(doc, encoding="utf-8")
    return str(out)
