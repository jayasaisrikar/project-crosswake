"""Manual (real, hand-placed) fills, recorded next to a version's paper ledger.

They never change the paper ledger. Each one is matched to the nearest paper fill of the same
(market, symbol, side) so the slippage of a human following the signal can be measured.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pandas as pd

FILE = "manual_fills.jsonl"


def record_fill(paper_dir: Path, market: str, symbol: str, side: str, qty: float, price: float,
                ts: Any = None, fee: float = 0.0, note: str = "") -> dict[str, Any]:
    if side not in ("buy", "sell"):
        raise ValueError("side must be buy or sell")
    if market not in ("spot", "perp"):
        raise ValueError("market must be spot or perp")
    if qty <= 0 or price <= 0:
        raise ValueError("qty and price must be positive")
    t = pd.Timestamp(ts) if ts is not None else pd.Timestamp.now(tz="UTC")
    t = t.tz_localize("UTC") if t.tzinfo is None else t.tz_convert("UTC")
    rec = {"ts": t.isoformat(), "recorded_at": pd.Timestamp.now(tz="UTC").isoformat(), "market": market,
           "symbol": symbol.upper(), "side": side, "qty": float(qty), "price": float(price),
           "fee": float(fee), "note": note}
    paper_dir.mkdir(parents=True, exist_ok=True)
    with open(paper_dir / FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec) + "\n")
    return rec


def read_manual(paper_dir: Path) -> list[dict[str, Any]]:
    p = paper_dir / FILE
    if not p.exists():
        return []
    return [json.loads(x) for x in p.read_text(encoding="utf-8").splitlines() if x.strip()]


def match_paper(manual: list[dict[str, Any]], paper: list[dict[str, Any]],
                max_gap_hours: float = 6.0) -> list[dict[str, Any]]:
    """Attach nearest paper fill and slippage (bps, positive = worse than paper)."""
    out = []
    for m in manual:
        t = pd.Timestamp(m["ts"])
        cands = [p for p in paper if p.get("side") == m["side"] and p.get("symbol") == m["symbol"]
                 and p.get("market") == m["market"]]
        best = min(cands, key=lambda p: abs(pd.Timestamp(p["ts"]) - t), default=None)
        row = dict(m, paper_ts=None, paper_price=None, slippage_bps=None)
        if best is not None and abs(pd.Timestamp(best["ts"]) - t) <= pd.Timedelta(hours=max_gap_hours):
            sign = 1 if m["side"] == "buy" else -1
            row.update(paper_ts=best["ts"], paper_price=best["price"],
                       slippage_bps=sign * (m["price"] / best["price"] - 1) * 1e4)
        out.append(row)
    return out
