"""Persistent PAPER ledger (no real orders). Files under data/paper/ (gitignored):

  state.json      cash, qty per (market, symbol), pending targets, peak, kill flag, cursors
  fills.jsonl     append-only simulated fills (next-bar OPEN, CostModel fees+spread+impact)
  equity.jsonl    append-only equity marks (one per step / bar)
  signals.jsonl   append-only signal log with UTC timestamps -- the public track record

Accounting: equity = cash + sum(qty * price) over spot and perp (linear USDT-M perps marked the
same way; a perp buy debits notional and a sell credits it, so PnL is qty * price change).
Decisions made at bar t are filled at the OPEN of the first bar after t (never same bar).
Funding: for each perp funding event, cash -= qty * price * rate (longs pay positive rates).
"""

from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import pandas as pd

from engine.contracts import Dataset, Market
from engine.costs import CostModel, rolling_adv_and_vol
from engine.live.signals_live import Weights


def utcnow() -> pd.Timestamp:
    return pd.Timestamp.now(tz="UTC")


def _iso(t: pd.Timestamp | None) -> str | None:
    return None if t is None else pd.Timestamp(t).tz_convert("UTC").isoformat()


@dataclass
class LedgerState:
    cash: float
    initial_capital: float
    qty: dict[str, dict[str, float]] = field(default_factory=lambda: {"spot": {}, "perp": {}})
    pending: dict[str, Any] | None = None       # {"decision_ts": iso, "weights": Weights}
    peak: float = 0.0
    killed: bool = False
    last_bar: str | None = None
    last_funding_ts: str | None = None
    created_at: str | None = None


class PaperLedger:
    def __init__(self, root: str | Path, initial_capital: float = 100_000.0):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        p = self.root / "state.json"
        if p.exists():
            self.state = LedgerState(**json.loads(p.read_text(encoding="utf-8")))
        else:
            self.state = LedgerState(cash=initial_capital, initial_capital=initial_capital,
                                     peak=initial_capital, created_at=_iso(utcnow()))

    # ---- persistence ---------------------------------------------------------------------------
    def save(self) -> None:
        tmp = self.root / "state.json.tmp"
        tmp.write_text(json.dumps(asdict(self.state), indent=2), encoding="utf-8")
        tmp.replace(self.root / "state.json")

    def _append(self, name: str, rec: dict[str, Any]) -> None:
        with open(self.root / name, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, default=str) + "\n")

    def read_log(self, name: str) -> list[dict[str, Any]]:
        p = self.root / name
        if not p.exists():
            return []
        return [json.loads(line) for line in p.read_text(encoding="utf-8").splitlines() if line.strip()]

    def log_signal(self, rec: dict[str, Any]) -> None:
        self._append("signals.jsonl", {"logged_at": _iso(utcnow()), **rec})

    # ---- valuation -----------------------------------------------------------------------------
    def equity(self, prices: dict[str, dict[str, float]]) -> float:
        eq = self.state.cash
        for m, pos in self.state.qty.items():
            for s, q in pos.items():
                px = prices.get(m, {}).get(s)
                if q and px is not None and math.isfinite(px):
                    eq += q * px
        return eq

    def weights(self, prices: dict[str, dict[str, float]]) -> Weights:
        eq = self.equity(prices)
        out: Weights = {"spot": {}, "perp": {}}
        if eq <= 0:
            return out
        for m, pos in self.state.qty.items():
            for s, q in pos.items():
                px = prices.get(m, {}).get(s)
                if q and px is not None and math.isfinite(px):
                    out.setdefault(m, {})[s] = q * px / eq
        return out

    # ---- simulation ----------------------------------------------------------------------------
    def fill_pending(self, data: Dataset, cost_model: CostModel, min_trade_frac: float = 0.001,
                     ) -> list[dict[str, Any]]:
        """Fill pending targets at the OPEN of the first bar strictly after the decision bar."""
        pend = self.state.pending
        if not pend:
            return []
        dec = pd.Timestamp(pend["decision_ts"])
        idx = data.perp.open.index.union(data.spot.open.index)
        after = idx[idx > dec]
        if len(after) == 0:
            return []      # next bar not closed yet; keep pending
        t = after[0]
        opens = {m: data.market(m).open.loc[t] for m in ("spot", "perp")}  # type: ignore[arg-type]
        prices = {m: {str(s): float(v) for s, v in row.dropna().items()} for m, row in opens.items()}
        eq = self.equity(prices)
        target: Weights = pend["weights"]
        fills: list[dict[str, Any]] = []
        for m in ("spot", "perp"):
            mk: Market = m  # type: ignore[assignment]
            md = data.market(mk)
            adv, vol = rolling_adv_and_vol(md)
            cur = self.state.qty.setdefault(m, {})
            for s in sorted(set(target.get(m, {})) | set(cur)):
                px = prices[m].get(s)
                if px is None or not math.isfinite(px) or px <= 0:
                    continue    # not tradable at this bar
                tgt_notional = target.get(m, {}).get(s, 0.0) * eq
                delta = tgt_notional - cur.get(s, 0.0) * px
                if abs(delta) < min_trade_frac * eq and target.get(m, {}).get(s, 0.0) != 0.0:
                    continue
                if abs(delta) < 1e-9:
                    continue
                a = adv[s].get(t) if s in adv.columns else None
                v = vol[s].get(t) if s in vol.columns else None
                c = cost_model.trade_cost(s, mk, abs(delta), px,
                                          None if a is None or pd.isna(a) else float(a),
                                          None if v is None or pd.isna(v) else float(v))
                q = delta / px
                cur[s] = cur.get(s, 0.0) + q
                if abs(cur[s] * px) < 1e-9:
                    cur.pop(s)
                self.state.cash -= delta + c.total
                rec = {"ts": _iso(t), "decision_ts": _iso(dec), "market": m, "symbol": s,
                       "side": "buy" if q > 0 else "sell", "qty": q, "price": px, "notional": delta,
                       "fee": c.fees, "spread": c.spread, "impact": c.impact, "cost": c.total}
                self._append("fills.jsonl", rec)
                fills.append(rec)
        self.state.pending = None
        return fills

    def accrue_funding(self, data: Dataset) -> float:
        """Apply funding events in (last_funding_ts, last bar]. Returns cash paid (+) / received (-)."""
        f = data.funding
        if f.empty:
            return 0.0
        last = self.state.last_funding_ts
        start = pd.Timestamp(last) if last else pd.Timestamp(self.state.created_at or f.index[0])
        ev = f[f.index > start]
        paid = 0.0
        closes = data.perp.close
        for ts, row in ev.iterrows():
            for s, rate in row.dropna().items():
                q = self.state.qty.get("perp", {}).get(str(s), 0.0)
                if not q or s not in closes.columns:
                    continue
                px_s = closes[s].loc[:ts].dropna()
                if px_s.empty:
                    continue
                amt = q * float(px_s.iloc[-1]) * float(rate)
                paid += amt
                self._append("fills.jsonl", {"ts": _iso(pd.Timestamp(str(ts))), "market": "perp",
                                             "symbol": str(s), "side": "funding", "qty": 0.0,
                                             "rate": float(rate), "cost": amt})
        self.state.cash -= paid
        if len(ev):
            self.state.last_funding_ts = _iso(pd.Timestamp(ev.index[-1]))
        elif not last:
            self.state.last_funding_ts = _iso(start)
        return paid

    def mark(self, t: pd.Timestamp, prices: dict[str, dict[str, float]]) -> float:
        eq = self.equity(prices)
        self.state.peak = max(self.state.peak, eq)
        self.state.last_bar = _iso(t)
        self._append("equity.jsonl", {"ts": _iso(t), "equity": eq, "cash": self.state.cash})
        return eq

    def day_start_equity(self, t: pd.Timestamp) -> float | None:
        day = pd.Timestamp(t).tz_convert("UTC").normalize()
        hist = self.read_log("equity.jsonl")
        before = [h["equity"] for h in hist if pd.Timestamp(h["ts"]) <= day]
        if before:
            return float(before[-1])
        today = [h["equity"] for h in hist if pd.Timestamp(h["ts"]) > day]
        return float(today[0]) if today else None

    def set_pending(self, decision_ts: pd.Timestamp, weights: Weights) -> None:
        self.state.pending = {"decision_ts": _iso(decision_ts), "weights": weights}


def close_prices(data: Dataset, t: pd.Timestamp) -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, float]] = {}
    for m in ("spot", "perp"):
        c = data.market(m).close.loc[:t].ffill()  # type: ignore[arg-type]
        row = c.iloc[-1] if len(c) else pd.Series(dtype="float64")
        out[m] = {str(s): float(v) for s, v in row.dropna().items()}
    return out
