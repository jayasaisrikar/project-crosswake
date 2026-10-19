"""CSV export of report tables."""

from __future__ import annotations

import re
from pathlib import Path

import pandas as pd

from engine.contracts import BacktestResult
from engine.reporting.html_report import (
    basic_summary,
    cost_totals,
    monthly_table,
    result_returns,
    yearly_returns,
)


def _slug(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "_", name).strip("_").lower() or "result"


def export_tables(ctx: dict, out_dir: str) -> list[str]:
    """Write monthly/yearly/trades CSVs per result plus summary/stress/walk_forward. Returns paths."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    results: dict[str, BacktestResult] = dict(ctx.get("results") or {})
    summaries = ctx.get("summaries") or {}
    monthly = ctx.get("monthly") or {}
    yearly = ctx.get("yearly") or {}
    written: list[str] = []

    def w(df: pd.DataFrame | pd.Series, fname: str, index: bool = True) -> None:
        path = out / fname
        df.to_csv(path, index=index)
        written.append(str(path))

    summary_rows: dict[str, dict] = {}
    for name, res in results.items():
        slug = _slug(name)
        r = result_returns(res)
        w(monthly.get(name, monthly_table(r)), f"monthly_{slug}.csv")
        w(pd.Series(yearly.get(name, yearly_returns(r))).rename("return"), f"yearly_{slug}.csv")
        w(res.trades if res.trades is not None else pd.DataFrame(), f"trades_{slug}.csv", index=False)
        s = {**basic_summary(res), **dict(summaries.get(name, {}))}
        s.update({f"cost_{k}": v for k, v in cost_totals(res).items()})
        summary_rows[name] = s
    if summary_rows:
        sdf = pd.DataFrame(summary_rows).T
        sdf.index.name = "strategy"
        w(sdf, "summary.csv")
    stress = ctx.get("stress")
    if isinstance(stress, pd.DataFrame):
        w(stress, "stress.csv")
    wf = ctx.get("walk_forward")
    if isinstance(wf, pd.DataFrame):
        w(wf, "walk_forward.csv", index=False)
    return written


def export_period_tables(ctx: dict, out_dir: str) -> list[str]:
    """Write one folder per labelled period: <out_dir>/{dev,holdout,full}/... plus walk_forward.csv and
    holdout_log.csv at the top level. Every file in a period folder covers that period's dates only."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    written: list[str] = []

    def w(df: pd.DataFrame | pd.Series, path: Path, index: bool = True) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        df.to_csv(path, index=index)
        written.append(str(path))

    for p in ctx.get("periods") or []:
        d = out / str(p["key"])
        w(pd.Series({"label": p["label"], "start": str(p["start"]), "end": str(p["end"])}).rename("value"),
          d / "period.csv")
        for name in ("summary", "costs", "allocations", "stress"):
            df = p.get(name)
            if isinstance(df, pd.DataFrame):
                w(df, d / f"{name}.csv")
        raw = p.get("stats") or {}
        st = {k: (str(v) if isinstance(v, dict | list | tuple) else v) for k, v in raw.items()}
        w(pd.Series(st, dtype=object).rename("value"), d / "stats.csv")
        for name, res in (p.get("results") or {}).items():
            slug = _slug(name)
            r = result_returns(res)
            w(monthly_table(r), d / f"monthly_{slug}.csv")
            w(yearly_returns(r).rename("return"), d / f"yearly_{slug}.csv")
            w(res.trades if res.trades is not None else pd.DataFrame(), d / f"trades_{slug}.csv", index=False)
    wf = ctx.get("walk_forward")
    if isinstance(wf, pd.DataFrame):
        w(wf, out / "walk_forward.csv", index=False)
    hl = ctx.get("holdout_log")
    if isinstance(hl, pd.DataFrame):
        w(hl, out / "holdout_log.csv")
    return written
