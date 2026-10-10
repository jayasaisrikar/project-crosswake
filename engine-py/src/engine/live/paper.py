"""Persistent PAPER ledger (no real orders). Files under data/paper/ (gitignored):

  state.json      cash, qty per (market, symbol), pending targets, peak, kill flag, cursors
  fills.jsonl     append-only simulated fills (next-bar OPEN, CostModel fees+spread+impact)
  equity.jsonl    append-only equity marks (one per step / bar)
  signals.jsonl   append-only signal log with UTC timestamps -- the public track record
  journal.json    write-ahead journal of the step being committed (exists only mid-commit)
  audit.jsonl     append-only log of human recovery actions (recover / reset-kill)

Accounting: equity = cash + sum(qty * price) over spot and perp (linear USDT-M perps marked the
same way; a perp buy debits notional and a sell credits it, so PnL is qty * price change).
Decisions made at bar t are filled at the OPEN of the first bar after t (never same bar).
Funding: for each perp funding event, cash -= qty * price * rate (longs pay positive rates).

Crash safety (one step = one transaction). In transaction mode (`begin()` ... `commit()`), rows are
buffered in memory and state is mutated in memory only. `commit` then
  1. writes journal.json atomically: {step_id, new state, every buffered row tagged step_id + seq};
  2. appends each file's rows (fsync), skipping (step_id, seq) pairs already on disk;
  3. writes state.json atomically (carrying step_id);
  4. deletes journal.json.
A crash before 1 leaves disk untouched (the step is simply re-run). A crash after 1 is rolled forward
by `recover()` (idempotent), which every step runs under the step lock before doing anything else.
Outside a transaction (`autocommit`, used by tests and tools) rows are appended immediately.

Fill identity: a trade fill is unique per (decision_ts, market, symbol), a funding row per
(ts, symbol). `effective_fills` drops repeats of those keys, which also heals logs that were
duplicated by the pre-journal code (AUDIT O1), so reconciliation recovers instead of halting forever.
"""

from __future__ import annotations

import json
import math
import uuid
from collections.abc import Callable
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any

import pandas as pd

from engine.contracts import Dataset, Market
from engine.costs import CostModel, rolling_adv_and_vol
from engine.live.journal import append_rows, atomic_write_text, read_rows, tail_rows
from engine.live.signals_live import Weights

LOGS = ("fills.jsonl", "equity.jsonl", "signals.jsonl")
JOURNAL = "journal.json"


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
    # --- added by the operations hardening (absent in older state.json files -> defaults) -------
    step_id: str | None = None                  # last committed step (journal id)
    host: str | None = None                     # machine that owns this ledger (single writer)
    last_prices: dict[str, dict[str, Any]] = field(default_factory=dict)  # m -> s -> {px, ts}
    day_start: dict[str, Any] | None = None     # {"day": iso date, "equity": float} running cache

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> LedgerState:
        names = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in raw.items() if k in names})


def fill_key(f: dict[str, Any]) -> tuple[str, ...]:
    if f.get("side") == "funding":
        return ("funding", str(f.get("ts")), str(f.get("market")), str(f.get("symbol")))
    if f.get("side") in ("buy", "sell") and f.get("decision_ts"):
        return ("trade", str(f.get("decision_ts")), str(f.get("market")), str(f.get("symbol")))
    return ("row", json.dumps(f, sort_keys=True, default=str))


def effective_fills(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop repeated fills (same fill_key); first occurrence wins. See module docstring."""
    seen: set[tuple[str, ...]] = set()
    out: list[dict[str, Any]] = []
    for r in rows:
        k = fill_key(r)
        if k[0] != "row" and k in seen:
            continue
        seen.add(k)
        out.append(r)
    return out


def duplicate_fills(rows: list[dict[str, Any]]) -> int:
    return len(rows) - len(effective_fills(rows))


class PaperLedger:
    def __init__(self, root: str | Path, initial_capital: float = 100_000.0):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        p = self.root / "state.json"
        if p.exists():
            self.state = LedgerState.from_dict(json.loads(p.read_text(encoding="utf-8")))
        else:
            self.state = LedgerState(cash=initial_capital, initial_capital=initial_capital,
                                     peak=initial_capital, created_at=_iso(utcnow()))
        self._buf: dict[str, list[dict[str, Any]]] | None = None
        self.issues: list[str] = []
        self.missed: dict[str, Any] | None = None       # pending order cancelled as too old (O11)
        # test hook: called with a crash-point name during commit / roll-forward
        self.fault: Callable[[str], None] | None = None

    # ---- persistence ---------------------------------------------------------------------------
    def _hit(self, point: str) -> None:
        if self.fault is not None:
            self.fault(point)

    def save(self) -> None:
        atomic_write_text(self.root / "state.json", json.dumps(asdict(self.state), indent=2))

    def begin(self) -> None:
        """Start buffering: nothing reaches disk until commit()."""
        self._buf = {}

    @property
    def in_transaction(self) -> bool:
        return self._buf is not None

    def _append(self, name: str, rec: dict[str, Any]) -> None:
        if self._buf is not None:
            self._buf.setdefault(name, []).append(rec)
        else:
            append_rows(self.root / name, [rec])

    def read_log(self, name: str) -> list[dict[str, Any]]:
        """All rows (torn last line repaired + reported in `issues`) plus rows buffered this step."""
        rows, issues = read_rows(self.root / name, repair=True)
        self.issues += issues
        return rows + list((self._buf or {}).get(name, []))

    def log_signal(self, rec: dict[str, Any]) -> None:
        self._append("signals.jsonl", {"logged_at": _iso(utcnow()), **rec})

    def commit(self, step_id: str | None = None) -> str:
        """Write-ahead journal -> appends -> state.json -> drop journal. Returns the step_id."""
        sid = step_id or f"{_iso(utcnow())}#{uuid.uuid4().hex[:8]}"
        buf = self._buf or {}
        self.state.step_id = sid
        rows = {name: [{**r, "step_id": sid, "seq": i} for i, r in enumerate(recs)]
                for name, recs in buf.items() if recs}
        self._hit("before_journal")
        atomic_write_text(self.root / JOURNAL, json.dumps(
            {"step_id": sid, "state": asdict(self.state), "rows": rows}, default=str))
        self._hit("after_journal")
        self._apply(sid, rows, asdict(self.state))
        self._buf = None
        return sid

    def _apply(self, sid: str, rows: dict[str, list[dict[str, Any]]], state: dict[str, Any]) -> None:
        for name in sorted(rows):
            p = self.root / name
            have = {r.get("seq") for r in tail_rows(p, 2_000_000) if r.get("step_id") == sid}
            todo = [r for r in rows[name] if r["seq"] not in have]
            if todo:
                append_rows(p, todo)
            self._hit(f"after_append:{name}")
        atomic_write_text(self.root / "state.json", json.dumps(state, indent=2, default=str))
        self._hit("after_state")
        (self.root / JOURNAL).unlink(missing_ok=True)

    def recover(self) -> list[str]:
        """Roll a pending journal forward and repair torn tails. Idempotent. Returns notes."""
        notes: list[str] = []
        for name in LOGS:
            _, iss = read_rows(self.root / name, repair=True)
            notes += iss
        jp = self.root / JOURNAL
        if jp.exists():
            try:
                j = json.loads(jp.read_text(encoding="utf-8"))
            except ValueError:
                j = None
            if j is None:   # journal written via tmp+replace, so a bad one was never committed
                jp.unlink(missing_ok=True)
                notes.append("discarded unreadable journal.json (step was never committed)")
            else:
                self._apply(str(j["step_id"]), j.get("rows", {}), j["state"])
                notes.append(f"rolled forward interrupted step {j['step_id']}")
            self.state = LedgerState.from_dict(json.loads((self.root / "state.json").read_text("utf-8")))
        (self.root / "state.json.tmp").unlink(missing_ok=True)
        self.issues += notes
        return notes

    def audit(self, action: str, **kw: Any) -> dict[str, Any]:
        rec = {"ts": _iso(utcnow()), "action": action, **kw}
        append_rows(self.root / "audit.jsonl", [rec])
        return rec

    # ---- valuation -----------------------------------------------------------------------------
    def equity(self, prices: dict[str, dict[str, float]]) -> float:
        eq = self.state.cash
        for m, pos in self.state.qty.items():
            for s, q in pos.items():
                px = prices.get(m, {}).get(s)
                if q and px is not None and math.isfinite(px):
                    eq += q * px
        return eq

    def unpriced(self, prices: dict[str, dict[str, float]]) -> list[str]:
        """Held positions with no usable price in `prices`."""
        out = []
        for m, pos in self.state.qty.items():
            for s, q in pos.items():
                px = prices.get(m, {}).get(s)
                if q and (px is None or not math.isfinite(px)):
                    out.append(f"{m} {s}")
        return out

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

    def valuation_prices(self, fresh: dict[str, dict[str, tuple[float, pd.Timestamp]]],
                         t: pd.Timestamp | None, max_age_h: float) -> tuple[dict[str, dict[str, float]],
                                                                            list[str]]:
        """Mark-to-market prices for every held position (O3).

        `fresh` = {m: {s: (last real close, its bar ts)}} from the feed. A held position whose price is
        missing or older than `max_age_h` before `t` is marked at its last-known price from
        state.last_prices (or the stale feed price) and reported in the returned `stale` list.
        Positions with no price at all are reported too (valued at 0 by `equity`)."""
        out: dict[str, dict[str, float]] = {m: {} for m in ("spot", "perp")}
        stale: list[str] = []
        for m, fpos in fresh.items():
            for s, (px, ts) in fpos.items():
                out.setdefault(m, {})[s] = px
                if t is not None and (t - ts) / pd.Timedelta(hours=1) <= max_age_h:
                    self.state.last_prices.setdefault(m, {})[s] = {"px": px, "ts": _iso(ts)}
        for m, pos in self.state.qty.items():
            for s, q in pos.items():
                if not q:
                    continue
                f = fresh.get(m, {}).get(s)
                ok = f is not None and t is not None and (t - f[1]) / pd.Timedelta(hours=1) <= max_age_h
                if ok:
                    continue
                lk = self.state.last_prices.get(m, {}).get(s)
                if f is None and lk is not None:
                    out.setdefault(m, {})[s] = float(lk["px"])
                age = "no price" if (f is None and lk is None) else \
                    f"last known {(f[1] if f else pd.Timestamp(lk['ts']))}"  # type: ignore[index]
                stale.append(f"{m} {s} ({age})")
        return out, stale

    def stale_fraction(self, prices: dict[str, dict[str, float]], stale: list[str]) -> float:
        """|notional| of the stale-marked positions / equity (inf if any has no price at all)."""
        if not stale:
            return 0.0
        keys = {tuple(x.split(" (")[0].split(" ", 1)) for x in stale}
        tot = 0.0
        for m, s in keys:
            px = prices.get(m, {}).get(s)
            if px is None or not math.isfinite(px):
                return math.inf
            tot += abs(self.state.qty.get(m, {}).get(s, 0.0) * px)
        eq = self.equity(prices)
        return tot / eq if eq > 0 else math.inf

    # ---- simulation ----------------------------------------------------------------------------
    def fill_pending(self, data: Dataset, cost_model: CostModel, min_trade_frac: float = 0.001,
                     max_lag_bars: int | None = None) -> list[dict[str, Any]]:
        """Fill pending targets at the OPEN of the first bar strictly after the decision bar.

        Stale-order rule (O11): with `max_lag_bars=N`, if the fill bar is more than N bars older than
        the latest closed bar (the engine was down), the order is CANCELLED, not filled at a price the
        bot could never have traded. `self.missed` records it; the caller decides afresh this step."""
        pend = self.state.pending
        self.missed = None
        if not pend:
            return []
        dec = pd.Timestamp(pend["decision_ts"])
        idx = data.perp.open.index.union(data.spot.open.index)
        after = idx[idx > dec]
        if len(after) == 0:
            return []      # next bar not closed yet; keep pending
        t = after[0]
        if max_lag_bars is not None and len(after) > max_lag_bars:
            self.missed = {"decision_ts": _iso(dec), "fill_bar": _iso(t), "latest_bar": _iso(after[-1]),
                           "bars_late": len(after) - 1, "rule": f"cancel if > {max_lag_bars} bar(s) late"}
            self.state.pending = None
            return []
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
            filled = md.is_filled.loc[t] if t in md.is_filled.index else None
            for s in sorted(set(target.get(m, {})) | set(cur)):
                px = prices[m].get(s)
                if px is None or not math.isfinite(px) or px <= 0:
                    continue    # not tradable at this bar
                if filled is not None and s in filled.index and pd.notna(filled[s]) and bool(filled[s]):
                    continue    # stale (forward-filled) bar: no fill, same rule as the backtest (B5)
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

    def mark(self, t: pd.Timestamp, prices: dict[str, dict[str, float]], stale: bool = False,
             ) -> float:
        """Equity at bar t. Appends a mark only if t is newer than state.last_bar (never backwards,
        never twice for one bar). A `stale` valuation is logged but never raises the peak."""
        eq = self.equity(prices)
        last = pd.Timestamp(self.state.last_bar) if self.state.last_bar else None
        if last is not None and pd.Timestamp(t) <= last:
            return eq
        self._roll_day(pd.Timestamp(t), eq, self._latest_mark())
        if not stale:
            self.state.peak = max(self.state.peak, eq)
        self.state.last_bar = _iso(t)
        rec: dict[str, Any] = {"ts": _iso(t), "equity": eq, "cash": self.state.cash}
        if stale:
            rec["stale"] = True
        self._append("equity.jsonl", rec)
        return eq

    def _roll_day(self, t: pd.Timestamp, eq: float, prev: dict[str, Any] | None) -> None:
        """Running start-of-day equity (= last mark at or before UTC midnight) kept in state, so the
        daily-loss check never re-reads the whole equity log (O19)."""
        day = t.tz_convert("UTC").normalize()
        ds = self.state.day_start
        if t <= day:
            self.state.day_start = {"day": _iso(day), "equity": float(eq)}
        elif (ds is None or ds.get("day") != _iso(day)) and prev is not None \
                and pd.Timestamp(prev["ts"]) <= day:
            self.state.day_start = {"day": _iso(day), "equity": float(prev["equity"])}

    def _latest_mark(self) -> dict[str, Any] | None:
        buf = (self._buf or {}).get("equity.jsonl", [])
        if buf:
            return buf[-1]
        rows = tail_rows(self.root / "equity.jsonl", 64_000)
        return rows[-1] if rows else None

    def day_start_equity(self, t: pd.Timestamp) -> float | None:
        day = pd.Timestamp(t).tz_convert("UTC").normalize()
        ds = self.state.day_start
        if ds is not None and ds.get("day") == _iso(day):
            return float(ds["equity"])
        hist = tail_rows(self.root / "equity.jsonl", 2_000_000) \
            + list((self._buf or {}).get("equity.jsonl", []))
        before = [h["equity"] for h in hist if pd.Timestamp(h["ts"]) <= day]
        if before:
            return float(before[-1])
        today = [h["equity"] for h in hist if pd.Timestamp(h["ts"]) > day]
        return float(today[0]) if today else None

    def set_pending(self, decision_ts: pd.Timestamp, weights: Weights) -> None:
        self.state.pending = {"decision_ts": _iso(decision_ts), "weights": weights}

    def rebuild_from_fills(self) -> dict[str, Any]:
        """qty and cash recomputed from the effective (deduplicated) fill log. Returns the diff."""
        fills = effective_fills(self.read_log("fills.jsonl"))
        qty: dict[str, dict[str, float]] = {"spot": {}, "perp": {}}
        cash = self.state.initial_capital
        for f in fills:
            if f.get("side") == "funding":
                cash -= float(f.get("cost", 0.0))
                continue
            m = qty.setdefault(str(f["market"]), {})
            m[str(f["symbol"])] = m.get(str(f["symbol"]), 0.0) + float(f["qty"])
            cash -= float(f.get("notional", 0.0)) + float(f.get("cost", 0.0))
        qty = {m: {s: q for s, q in p.items() if abs(q) > 1e-12} for m, p in qty.items()}
        diff = {"cash_before": self.state.cash, "cash_after": cash, "qty_before": self.state.qty,
                "qty_after": qty}
        self.state.qty, self.state.cash = qty, cash
        return diff


def close_prices(data: Dataset, t: pd.Timestamp) -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, float]] = {}
    for m in ("spot", "perp"):
        c = data.market(m).close.loc[:t].ffill()  # type: ignore[arg-type]
        row = c.iloc[-1] if len(c) else pd.Series(dtype="float64")
        out[m] = {str(s): float(v) for s, v in row.dropna().items()}
    return out


def fresh_prices(data: Dataset, t: pd.Timestamp | None) -> dict[str, dict[str, tuple[float, pd.Timestamp]]]:
    """Last REAL (not forward-filled) close per symbol at or before t, with its bar time."""
    out: dict[str, dict[str, tuple[float, pd.Timestamp]]] = {"spot": {}, "perp": {}}
    if t is None:
        return out
    for m in ("spot", "perp"):
        md = data.market(m)  # type: ignore[arg-type]
        c = md.close.loc[:t]
        real = c.where(~md.is_filled.reindex_like(c).fillna(True).astype(bool))
        for s in real.columns:
            col = real[s].dropna()
            if len(col):
                out[m][str(s)] = (float(col.iloc[-1]), pd.Timestamp(col.index[-1]))
    return out
