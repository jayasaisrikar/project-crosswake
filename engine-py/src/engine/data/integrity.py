"""Point-in-time integrity checks for assembled Dataset panels (engine.contracts.Dataset).

Ingestion (download.py) verifies every raw file by sha256; clean.py validates and flags each
per-symbol series. Neither validates the WIDE panels that actually feed the backtester. This module
does, asserting the invariants the event-driven engine and the causality rule (contracts.py) depend
on:

  * grid     one monotone, strictly-increasing, hour-aligned index shared by spot and perp, with no
             duplicate timestamps and no hole between the first and last bar (per-symbol gaps are a
             separate, expected thing handled by is_filled).
  * ohlc     every REAL (not is_filled) bar has finite o,h,l,c > 0 with low <= min(o,c) and
             high >= max(o,c) and volume >= 0.
  * filled   is_filled is boolean; a real bar (is_filled False) always carries a finite close, and a
             filled bar inside the listing window carries the forward-filled close. Reports the
             filled fraction and the longest stale run per symbol.
  * frozen   zero-volume o=h=l=c=prev-close "real" bars (the clean.py frozen-contract rule) must be
             flagged is_filled; any UNFLAGGED frozen bar is an executable-price trap -> critical.
  * basis    where both legs are live, |spot/perp - 1| must stay within a sane bound; a large basis
             flags a stale leg or a mis-paired contract. Reports worst and p99 basis per symbol.
  * funding  funding events sit within ms of an hour on the bar grid and inside the perp listing
             window, with no duplicate event timestamps.

check_dataset is pure and causal: because every test is per-bar (basis/ohlc/frozen use only shift(1)),
truncating the dataset never changes a verdict about an earlier bar. The report is therefore
reproducible and safe to run point-in-time. Run `python -m engine.data.integrity` to check
data/cleaned and write reports/data_integrity.json (exit code 1 if any critical/high issue).
"""

from __future__ import annotations

import argparse
import json
import logging
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from engine.contracts import MARKETS, Dataset, Market, MarketData

log = logging.getLogger(__name__)

SEVERITIES = ("critical", "high", "medium", "info")
BLOCKING = ("critical", "high")       # ok := no issue at these severities
DEFAULT_MAX_BASIS = 0.5               # |spot/perp - 1|: above this is a stale leg or wrong pairing
FUNDING_HOUR_TOL = pd.Timedelta("90s")  # Binance stamps 08:00:00.001 etc.; snap tolerance to the hour


@dataclass
class Issue:
    check: str
    severity: str
    detail: str
    market: str | None = None
    symbol: str | None = None
    n: int = 1


@dataclass
class IntegrityReport:
    ok: bool = True
    issues: list[Issue] = field(default_factory=list)
    stats: dict[str, Any] = field(default_factory=dict)

    def add(self, check: str, severity: str, detail: str, *, market: str | None = None,
            symbol: str | None = None, n: int = 1) -> None:
        if n <= 0:
            return
        if severity not in SEVERITIES:
            raise ValueError(f"unknown severity {severity!r}")
        self.issues.append(Issue(check, severity, detail, market, symbol, n))
        if severity in BLOCKING:
            self.ok = False

    def counts(self) -> dict[str, int]:
        c = {s: 0 for s in SEVERITIES}
        for i in self.issues:
            c[i.severity] += 1
        return c

    def to_dict(self) -> dict[str, Any]:
        return {"ok": self.ok, "counts": self.counts(),
                "issues": [asdict(i) for i in self.issues], "stats": self.stats}


def _frozen_mask(md: MarketData, sym: str) -> pd.Series:
    """Zero-volume o=h=l=c=prev-close 'real' bars (same rule as clean.py / audit.core.frozen_mask)."""
    o, h, low, c = md.open[sym], md.high[sym], md.low[sym], md.close[sym]
    flat = (o == h) & (h == low) & (low == c) & (c == c.shift(1))
    return (md.volume[sym].fillna(0.0) == 0) & flat.fillna(False)


def _longest_run(mask: np.ndarray) -> int:
    best = run = 0
    for x in mask:
        run = run + 1 if x else 0
        best = max(best, run)
    return best


def _check_grid(rep: IntegrityReport, data: Dataset) -> pd.DatetimeIndex:
    idx = data.spot.close.index.union(data.perp.close.index)
    idx = pd.DatetimeIndex(idx)
    rep.stats["n_bars"] = int(len(idx))
    if len(idx) == 0:
        rep.add("grid", "high", "empty dataset: no bars in either market")
        return idx
    rep.stats["first_ts"], rep.stats["last_ts"] = str(idx[0]), str(idx[-1])
    if not idx.is_monotonic_increasing:
        rep.add("grid", "critical", "index is not monotonically increasing")
    n_dupes = int(len(idx) - len(idx.unique()))
    if n_dupes:
        rep.add("grid", "critical", f"{n_dupes} duplicate timestamps in the shared index", n=n_dupes)
    misaligned = int((idx != idx.floor("h")).sum())
    if misaligned:
        rep.add("grid", "critical", f"{misaligned} timestamps are not hour-aligned", n=misaligned)
    full = pd.date_range(idx[0], idx[-1], freq="h")
    holes = int(len(full) - len(idx.intersection(full)))
    if holes:
        rep.add("grid", "high", f"{holes} missing hours between first and last bar", n=holes)
    return idx


def _check_market(rep: IntegrityReport, md: MarketData, market: Market) -> None:
    syms = [s for s in md.close.columns]
    filled_frac: dict[str, float] = {}
    for sym in syms:
        c = md.close[sym]
        fil = md.is_filled[sym].fillna(True).astype(bool)
        real = (~fil) & c.notna()
        n_real = int(real.sum())
        if n_real == 0:
            continue
        o, h, low = md.open[sym], md.high[sym], md.low[sym]
        bad_px = real & (~np.isfinite(c) | (c <= 0) | ~np.isfinite(o) | (o <= 0)
                         | ~np.isfinite(h) | (h <= 0) | ~np.isfinite(low) | (low <= 0))
        rep.add("ohlc", "critical", "real bars with non-finite or non-positive OHLC",
                market=market, symbol=sym, n=int(bad_px.sum()))
        order = real & ~bad_px & ((h < np.maximum(o, c)) | (low > np.minimum(o, c)) | (h < low))
        rep.add("ohlc", "critical", "real bars violating low<=min(o,c)<=max(o,c)<=high",
                market=market, symbol=sym, n=int(order.sum()))
        neg_vol = real & (md.volume[sym] < 0)
        rep.add("ohlc", "high", "real bars with negative volume",
                market=market, symbol=sym, n=int(neg_vol.sum()))

        # a filled bar inside the listing window must carry a forward-filled close
        window = (c.index >= c[real].index[0]) & (c.index <= c[real].index[-1])
        carried_gap = int((fil & window & c.isna()).sum())
        rep.add("filled", "high", "filled bars inside listing window with no carried close",
                market=market, symbol=sym, n=carried_gap)

        # frozen contract bars that were NOT flagged stale: executable-price trap
        unflagged = int((_frozen_mask(md, sym) & window & ~fil).sum())
        rep.add("frozen", "critical", "zero-volume flat 'real' bars not flagged is_filled",
                market=market, symbol=sym, n=unflagged)

        fmask = (fil & window).to_numpy()
        filled_frac[sym] = float(fmask.mean())
        rep.stats.setdefault(f"{market}_longest_stale_run", {})[sym] = _longest_run(fmask)
    rep.stats[f"{market}_filled_fraction"] = filled_frac


def _check_basis(rep: IntegrityReport, data: Dataset, max_basis: float) -> None:
    common = [s for s in data.spot.close.columns if s in data.perp.close.columns]
    worst: dict[str, float] = {}
    for sym in common:
        sp = data.spot.close[sym].where(~data.spot.is_filled[sym].fillna(True).astype(bool))
        pp = data.perp.close[sym].where(~data.perp.is_filled[sym].fillna(True).astype(bool))
        both = pd.concat([sp, pp], axis=1).dropna()
        if both.empty or (both.iloc[:, 1] <= 0).all():
            continue
        basis = (both.iloc[:, 0] / both.iloc[:, 1] - 1.0).abs().replace([np.inf, -np.inf], np.nan).dropna()
        if basis.empty:
            continue
        worst[sym] = float(basis.max())
        rep.add("basis", "medium",
                f"|spot/perp-1| peaks at {basis.max():.2f} (p99 {basis.quantile(0.99):.3f}) > {max_basis}",
                symbol=sym, n=int((basis > max_basis).sum()))
    rep.stats["worst_basis"] = worst


def _check_funding(rep: IntegrityReport, data: Dataset) -> None:
    f = data.funding
    if f is None or not len(f):
        rep.stats["n_funding_events"] = 0
        return
    fidx = pd.DatetimeIndex(f.index)
    rep.stats["n_funding_events"] = int(len(fidx))
    dupes = int(len(fidx) - len(fidx.unique()))
    if dupes:
        rep.add("funding", "high", f"{dupes} duplicate funding event timestamps", n=dupes)
    off = (fidx - fidx.round("h")).to_series().abs()
    misaligned = int((off > FUNDING_HOUR_TOL).sum())
    if misaligned:
        rep.add("funding", "medium", f"{misaligned} funding events >90s off the hour grid", n=misaligned)
    # funding must fall inside the perp listing window of its symbol
    for sym in f.columns:
        ev = fidx[f[sym].notna().to_numpy()]
        if not len(ev):
            continue
        real = data.perp.close[sym].where(~data.perp.is_filled[sym].fillna(True).astype(bool)) \
            if sym in data.perp.close.columns else pd.Series(dtype=float)
        rc = real.dropna()
        if rc.empty:
            rep.add("funding", "medium", "funding events for a symbol with no real perp bars",
                    symbol=sym, n=int(len(ev)))
            continue
        outside = int(((ev < rc.index[0]) | (ev > rc.index[-1] + pd.Timedelta(hours=1))).sum())
        rep.add("funding", "medium", "funding events outside the perp listing window",
                symbol=sym, n=outside)


def check_dataset(data: Dataset, max_basis: float = DEFAULT_MAX_BASIS) -> IntegrityReport:
    """Validate assembled panels against the point-in-time invariants the backtester relies on."""
    rep = IntegrityReport()
    _check_grid(rep, data)
    for m in MARKETS:
        _check_market(rep, data.market(m), m)
    _check_basis(rep, data, max_basis)
    _check_funding(rep, data)
    rep.stats["max_basis_bound"] = max_basis
    return rep


def main(argv: list[str] | None = None) -> int:
    from engine.data.load import load_dataset

    ap = argparse.ArgumentParser(description="Integrity check for cleaned Dataset panels.")
    ap.add_argument("--root", default="data/cleaned", help="cleaned data root")
    ap.add_argument("--out", default="reports/data_integrity.json", help="JSON report path")
    ap.add_argument("--max-basis", type=float, default=DEFAULT_MAX_BASIS)
    ap.add_argument("--symbols", nargs="*", default=None, help="restrict to these symbols")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")

    data = load_dataset(a.root, symbols=a.symbols)
    rep = check_dataset(data, max_basis=a.max_basis)
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rep.to_dict(), indent=1), encoding="utf-8")
    counts = rep.counts()
    log.info("integrity: ok=%s counts=%s bars=%s -> %s", rep.ok, counts, rep.stats.get("n_bars"), out)
    for i in rep.issues:
        if i.severity in BLOCKING:
            log.warning("[%s] %s %s/%s: %s (n=%d)", i.severity, i.check, i.market, i.symbol, i.detail, i.n)
    return 0 if rep.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
