"""`uv run python -m engine.audit` -> reports/audit/*.csv + docs/AUDIT.md.

Backtests are re-run ONLY on DEVELOPMENT data (truncated at split.dev_end, exactly as a locked pipeline run);
the holdout lock is never touched. Holdout-era facts come from data files (prices/funding, not strategy
results) and from the already-existing reports/tables/{full,holdout}/ CSVs.
"""

from __future__ import annotations

import copy
from collections.abc import Iterator
from typing import Any

import numpy as np
import pandas as pd

from engine.audit import core
from engine.backtest.engine import FORCED_EXIT_COST_MULT, run_backtest
from engine.backtest.portfolio import combine
from engine.contracts import BacktestResult, Dataset
from engine.costs import CostModel
from engine.data.load import load_dataset
from engine.pipeline import ROOT, load_config
from engine.signals.carry import CarryStrategy
from engine.signals.trend import TrendStrategy, tradable_mask
from engine.validation.reconcile import reconcile

OUT = ROOT / "reports" / "audit"
DOC = ROOT / "docs" / "AUDIT.md"
Finding = dict[str, Any]

BUGS = [
    "DATA (FTT perp): after the 2022-11-14 halt Binance kept publishing flat zero-volume klines at 1.59 "
    "through 2026-09; clean.py marks them is_filled=False, so the engine's stale-fill guard and the "
    "strategies' tradable_mask treat a dead contract as tradable. Trend placed 13 fills on it "
    "(2022-11-30..12-15) and the position was exited there instead of via a forced exit. Suggested fix: "
    "treat volume==0 and o=h=l=c=prev close as is_filled (or cut the series at the halt).",
    "DATA (FTT funding): 2,845 funding events (0.0001 per 8h) exist for the halted perp up to 2025-06-19; "
    "trailing APR ~10.95% sits just above the 10% carry entry threshold. Carry was only kept out by the "
    "cost-aware entry rule (and stale spot until 2023-09-22); the basis guard alone passed while the perp "
    "was frozen in 622 hours (540 in dev). Latent, no P&L impact in this run.",
    "ENGINE (latent): forced exits are priced at cls_ff (forward-filled close). If the last bars before a "
    "delisting are is_filled, the forced exit uses that stale fill price, which equals the last real "
    "close only "
    "because clean.py forward-fills close. Correct today; fragile if fill logic changes. Funding marks "
    "also use "
    "cls_ff. No instance mispriced in this run.",
    "ENGINE (duplicate constant): FORCED_EXIT_COST_MULT is defined separately in backtest/engine.py and "
    "validation/reconcile.py; they agree (2.0) but are not linked.",
]


def _rows(df: Any) -> Iterator[Any]:
    """itertuples typed as Any (pandas-stubs types row attributes as a wide scalar union)."""
    return iter(df.itertuples())


def _utc(x: Any) -> pd.Timestamp:
    t = pd.Timestamp(x)
    return t.tz_localize("UTC") if t.tzinfo is None else t.tz_convert("UTC")


class Ctx:
    def __init__(self) -> None:
        self.uni = load_config("universe.yaml")
        self.exp = load_config("experiment.yaml")
        split = self.exp["split"]
        self.dev_end = _utc(split["dev_end"]) + pd.Timedelta(hours=23)
        self.holdout_start = _utc(split["holdout_start"])
        self.full = load_dataset(str(ROOT / "data" / "cleaned"), symbols=self.uni["symbols"])
        self.dev = self.full.truncate(self.dev_end)
        cfg = copy.deepcopy(self.exp["costs"])
        self.cm = CostModel.from_config(cfg, base_dir=ROOT)
        cap = float(self.exp["initial_capital"])
        alloc = self.exp["strategies"]["allocation"]
        self.cap = cap
        self.trend_s = TrendStrategy(self.exp["strategies"]["trend"])
        self.carry_s = CarryStrategy(self.exp["strategies"]["carry"])
        self.trend = run_backtest(self.trend_s, self.dev, self.cm, cap * alloc["trend"], name="trend")
        self.carry = run_backtest(self.carry_s, self.dev, self.cm, cap * alloc["carry"], name="carry")
        self.combined = combine({"trend": self.trend, "carry": self.carry}, alloc, cap)
        self.idx = core.bar_index(self.dev)
        self.findings: list[Finding] = []
        self.notes: dict[str, list[str]] = {}

    def add(self, item: str, check: str, verdict: str, numbers: str) -> None:
        self.findings.append({"item": item, "check": check, "verdict": verdict, "numbers": numbers})

    def note(self, item: str, text: str) -> None:
        self.notes.setdefault(item, []).append(text)


def _csv(df: pd.DataFrame | pd.Series, name: str, index: bool = False) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUT / name, index=index)


def _all_trades(c: Ctx) -> pd.DataFrame:
    return pd.concat([c.trend.trades.assign(sleeve="trend"), c.carry.trades.assign(sleeve="carry")],
                     ignore_index=True)


def _sym_gross(res: BacktestResult, market: str, sym: str, lo: Any, hi: Any) -> float:
    p = res.positions[market]
    if sym not in p:
        return 0.0
    g = core.ledger_gross(p[[sym]], res.trades, market)[sym]
    return float(g.loc[lo:hi].sum())


def _sym_costs(res: BacktestResult, market: str, sym: str, lo: Any, hi: Any) -> float:
    t = res.trades
    if not len(t):
        return 0.0
    ts = pd.DatetimeIndex(t["ts"])
    m = (t["market"] == market) & (t["symbol"] == sym) & (ts >= _utc(lo)) & (ts <= _utc(hi))
    return float(t.loc[m, ["fee", "spread", "impact"]].sum().sum())


def _bars_window(data: Dataset, sym: str, lo: Any, hi: Any) -> pd.DataFrame:
    frames = []
    for m in ("spot", "perp"):
        md = data.market(m)  # type: ignore[arg-type]
        if sym not in md.close:
            continue
        d = pd.DataFrame({f: getattr(md, f)[sym] for f in ("open", "close", "volume", "is_filled")})
        d["frozen"] = core.frozen_mask(md.open[sym], md.high[sym], md.low[sym], md.close[sym], md.volume[sym])
        frames.append(d.add_prefix(f"{m}_"))
    return pd.concat(frames, axis=1).loc[lo:hi]


# --------------------------------------------------------------------------- 1. LUNA
def audit_luna(c: Ctx, flags: pd.DataFrame, fund_led: pd.DataFrame) -> None:
    lo, hi = "2022-05-01", "2022-06-05"
    w = _bars_window(c.full, "LUNA", lo, hi)
    for name, res in (("trend", c.trend), ("carry", c.carry)):
        for m in ("spot", "perp"):
            if "LUNA" in res.positions[m]:
                w[f"{name}_{m}_pos"] = res.positions[m]["LUNA"].reindex(w.index)
    _csv(w, "luna_window.csv", index=True)
    t = flags[(flags["symbol"] == "LUNA")]
    _csv(t, "luna_trades.csv")
    sp_last: Any = c.full.spot.close["LUNA"].last_valid_index()
    pp_last: Any = c.full.perp.close["LUNA"].last_valid_index()
    sp_real: Any = c.full.spot.close["LUNA"].where(~c.full.spot.is_filled["LUNA"]).last_valid_index()
    pp_real: Any = c.full.perp.close["LUNA"].where(~c.full.perp.is_filled["LUNA"]).last_valid_index()
    fe = t[t["side"] == "forced_exit"]
    bad = t[(t["stale_bar"] | t["frozen_bar"] | t["after_last_real_bar"] | t["price_mismatch"])]
    pnl = {}
    for name, res in (("trend", c.trend), ("carry", c.carry)):
        for m in ("spot", "perp"):
            g = _sym_gross(res, m, "LUNA", lo, hi)
            k = _sym_costs(res, m, "LUNA", lo, hi)
            f = 0.0
            if m == "perp" and len(fund_led):
                fl = fund_led[(fund_led["sleeve"] == name) & (fund_led["symbol"] == "LUNA")]
                f = float(fl.set_index("charge_bar").loc[lo:hi, "paid"].sum()) if len(fl) else 0.0
            pnl[f"{name}_{m}"] = (g, k, f)
    pnl_df = pd.DataFrame(pnl, index=["gross", "costs", "funding_paid"]).T
    pnl_df["net"] = pnl_df["gross"] - pnl_df["costs"] - pnl_df["funding_paid"]
    _csv(pnl_df, "luna_pnl.csv", index=True)
    # all-time LUNA P&L per sleeve
    tot = {}
    for name, res in (("trend", c.trend), ("carry", c.carry)):
        tot[name] = sum(_sym_gross(res, m, "LUNA", None, None) - _sym_costs(res, m, "LUNA", "2000", "2100")
                        for m in ("spot", "perp"))
    held_at_collapse = {f"{n}_{m}": float(res.positions[m]["LUNA"].loc["2022-05-07":"2022-05-14"].abs().max())
                        for n, res in (("trend", c.trend), ("carry", c.carry)) for m in ("spot", "perp")
                        if "LUNA" in res.positions[m]}
    c.note("1", f"LUNA spot last bar {sp_last} (last real {sp_real}); perp last bar {pp_last} "
                f"(last real {pp_real}). Raw spot series truncated by clean.py at ticker reuse 2022-05-31.")
    c.note("1", "Max |notional| held 2022-05-07..14: " + ", ".join(f"{k}={v:,.0f}"
                                                                  for k, v in held_at_collapse.items()))
    c.note("1", f"Forced exits on LUNA: {len(fe)}; window P&L (USDT): "
           + "; ".join(f"{i}: gross {r.gross:,.0f} costs {r.costs:,.0f} net {r.net:,.0f}"
                       for i, r in pnl_df.iterrows()))
    c.note("1", f"Whole-sample LUNA net (excl. funding): trend {tot['trend']:,.0f}, carry "
                f"{tot['carry']:,.0f}")
    listed = c.full.perp.close["LUNA"].notna()
    filled_tail = int((c.full.perp.is_filled["LUNA"] & listed).loc["2022-05-01":].sum())
    sp_listed = c.full.spot.close["LUNA"].notna()
    sp_tail = int((c.full.spot.is_filled["LUNA"] & sp_listed).loc["2022-05-01":].sum())
    c.note("1", f"Synthesized (is_filled) LUNA bars from 2022-05-01 to delisting: perp {filled_tail}, "
                f"spot {sp_tail}; LUNA trades on such bars: {int(t['stale_bar'].sum())}.")
    c.note("1", "Hourly LUNA moves of -87%..+383% on 11-13 May 2022 are real exchange prints (see "
                "implausible_bars.csv); the sleeves' exposure then was trend perp only (<= 2.9k USDT).")
    v = "PASS" if bad.empty else "FAIL"
    if v == "PASS" and len(fe) and (fe["price"] != fe["last_real_close"]).any():
        v = "WARN"
    c.add("1 LUNA", "no fills on stale/frozen/post-delisting bars; forced exit at last real close", v,
          f"{len(t)} LUNA trades, {len(bad)} flagged, {len(fe)} forced exits; max held "
          f"{max(held_at_collapse.values()):,.0f} USDT")


# --------------------------------------------------------------------------- 2. FTT
def audit_ftt(c: Ctx, flags: pd.DataFrame, fund_led: pd.DataFrame) -> None:
    d = c.full
    rows = []
    for m in ("spot", "perp"):
        md = d.market(m)  # type: ignore[arg-type]
        for kind, mask in (("is_filled", md.is_filled["FTT"] & md.close["FTT"].notna()),
                           ("frozen_real_bar", core.frozen_mask(md.open["FTT"], md.high["FTT"], md.low["FTT"],
                                                                md.close["FTT"], md.volume["FTT"])
                            & ~md.is_filled["FTT"])):
            r = core.runs(mask, min_len=24)
            r.insert(0, "kind", kind)
            r.insert(0, "market", m)
            rows.append(r)
    stale = pd.concat(rows, ignore_index=True)
    _csv(stale, "ftt_stale_periods.csv")
    basis = (d.spot.close["FTT"] / d.perp.close["FTT"] - 1.0)
    okspot = tradable_mask(d.spot)["FTT"]
    okperp = tradable_mask(d.perp)["FTT"]
    both = okspot & okperp
    guard_ok = both & (basis.abs() <= c.carry_s.max_basis)
    fz_perp = core.frozen_mask(d.perp.open["FTT"], d.perp.high["FTT"], d.perp.low["FTT"], d.perp.close["FTT"],
                               d.perp.volume["FTT"])
    daily = pd.DataFrame({"basis": basis, "spot_tradable": okspot, "perp_tradable": okperp,
                          "basis_guard_pass": guard_ok, "perp_frozen": fz_perp,
                          "spot_close": d.spot.close["FTT"], "perp_close": d.perp.close["FTT"]})
    daily = daily.resample("D").agg({"basis": "median", "spot_tradable": "mean", "perp_tradable": "mean",
                                     "basis_guard_pass": "mean", "perp_frozen": "mean", "spot_close": "last",
                                     "perp_close": "last"})
    _csv(daily.loc["2022-10-01":], "ftt_basis_daily.csv", index=True)
    # carry would-be leaks: hours where the guard passes while the perp is frozen
    leak = guard_ok & fz_perp
    frz = core.runs(fz_perp, 24)
    frz_first = frz["first"].iloc[0] if len(frz) else None
    fu = d.funding["FTT"].dropna()
    fund_after_freeze = int((fu.index >= frz_first).sum()) if frz_first is not None else 0
    t = flags[flags["symbol"] == "FTT"]
    _csv(t, "ftt_trades_dev.csv")
    bad = t[t["stale_bar"] | t["frozen_bar"] | t["after_last_real_bar"] | t["price_mismatch"]]
    pnl = {}
    for name, res in (("trend", c.trend), ("carry", c.carry)):
        for m in ("spot", "perp"):
            g = _sym_gross(res, m, "FTT", "2022-11-01", "2022-11-30")
            k = _sym_costs(res, m, "FTT", "2022-11-01", "2022-11-30")
            gt = _sym_gross(res, m, "FTT", None, None)
            kt = _sym_costs(res, m, "FTT", "2000", "2100")
            pnl[f"{name}_{m}"] = {"nov2022_gross": g, "nov2022_costs": k, "all_gross": gt, "all_costs": kt}
    fl = fund_led[fund_led["symbol"] == "FTT"] if len(fund_led) else fund_led
    pnl_df = pd.DataFrame(pnl).T
    _csv(pnl_df, "ftt_pnl.csv", index=True)
    # holdout-era trades from the existing full report (read only)
    ho = []
    for sl in ("trend", "carry"):
        p = ROOT / "reports" / "tables" / "full" / f"trades_{sl}.csv"
        if p.exists():
            tt = pd.read_csv(p, parse_dates=["ts"])
            tt = tt[(tt["symbol"] == "FTT")]
            ho.append(tt.assign(sleeve=sl))
    ho_df = pd.concat(ho, ignore_index=True) if ho else pd.DataFrame()
    if len(ho_df):
        ho_df["ts"] = pd.to_datetime(ho_df["ts"], utc=True)
        ho_df["perp_frozen_at_fill"] = [bool(fz_perp.get(x, False)) if m == "perp" else False
                                        for x, m in zip(ho_df["ts"], ho_df["market"], strict=True)]
        _csv(ho_df, "ftt_trades_existing_full_report.csv")
    n_frozen_fills_full = int(ho_df["perp_frozen_at_fill"].sum()) if len(ho_df) else 0
    c.note("2", "FTT stale/frozen runs (>=24h): " + "; ".join(
        f"{r.market}/{r.kind} {r.first:%Y-%m-%d %H}h -> {r.last:%Y-%m-%d %H}h ({r.n}h)"
        for r in _rows(stale)))
    c.note("2", f"FTT perp: Binance kept publishing zero-volume flat bars at 1.59 (is_filled=False) "
                f"after the "
                f"halt from {frz_first}; funding events after freeze start: {fund_after_freeze} "
                f"(last funding {fu.index[-1]}).")
    c.note("2", f"Basis guard (|spot/perp-1|<=2%) passes in {int(guard_ok.sum())} hours overall; "
                f"{int(leak.sum())} of them with a frozen perp (dev: {int(leak.loc[:c.dev_end].sum())}).")
    if len(fl) and frz_first is not None:
        frz_paid = float(fl.loc[pd.DatetimeIndex(fl["charge_bar"]) >= frz_first, "paid"].sum())
        c.note("2", f"Funding paid on FTT positions (dev, all sleeves): {float(fl['paid'].sum()):,.2f}, "
                    f"of which "
                    f"{frz_paid:,.2f} on the frozen contract.")
    fz_tr = t[t["frozen_bar"]]
    if len(fz_tr):
        c.note("2", f"Trend kept re-sizing its FTT perp SHORT on frozen bars: {len(fz_tr)} fills "
                    f"{fz_tr['ts'].min():%Y-%m-%d} -> {fz_tr['ts'].max():%Y-%m-%d} at 1.59, |notional| "
                    f"{fz_tr['qty_notional'].abs().sum():,.0f}, costs "
                    f"{fz_tr[['fee', 'spread', 'impact']].sum().sum():,.2f}; final buy-back "
                    f"{fz_tr['qty_notional'].iloc[-1]:,.0f}. Gross P&L while frozen is 0 by "
                    f"construction; the "
                    f"residual short could not really be closed on a halted contract: the backtest "
                    f"assumes it was, "
                    f"at 1.59 (last real print 2022-11-14 04:00, 17.6k base volume).")
    c.note("2", "FTT P&L (USDT, dev): " + "; ".join(
        f"{i}: Nov-22 gross {r.nov2022_gross:,.0f} / all gross {r.all_gross:,.0f} costs {r.all_costs:,.0f}"
        for i, r in pnl_df.iterrows()))
    c.note("2", f"Existing full-period report: {len(ho_df)} FTT trades, {n_frozen_fills_full} filled on a "
                f"frozen perp bar.")
    v = "PASS"
    if len(bad) or n_frozen_fills_full:
        v = "FAIL"
    elif int(leak.sum()):
        v = "WARN"
    c.add("2 FTT", "stale/frozen handling, basis guard, fills", v,
          f"{len(t)} dev FTT trades ({len(bad)} flagged); {n_frozen_fills_full} frozen-bar fills in full "
          f"report; "
          f"guard-pass-while-frozen hours {int(leak.sum())}; perp frozen from {frz_first}")


# --------------------------------------------------------------------------- 3. forced exits
def audit_forced(c: Ctx, flags: pd.DataFrame) -> None:
    fe = flags[flags["side"] == "forced_exit"].copy()
    rows = []
    for r in _rows(fe):
        ref = c.cm.trade_cost(r.symbol, r.market, abs(r.qty_notional), r.price, 0.0, 0.0)
        rows.append({"exp_fee": FORCED_EXIT_COST_MULT * ref.fees,
                     "exp_spread": FORCED_EXIT_COST_MULT * ref.spread})
    if rows:
        fe = pd.concat([fe.reset_index(drop=True), pd.DataFrame(rows)], axis=1)
        fe["fee_ok"] = np.isclose(fe["fee"], fe["exp_fee"], rtol=1e-9, atol=1e-9)
        fe["spread_ok"] = np.isclose(fe["spread"], fe["exp_spread"], rtol=1e-9, atol=1e-9)
        fe["total_cost"] = fe["fee"] + fe["spread"] + fe["impact"]
        fe["cost_bps"] = fe["total_cost"] / fe["qty_notional"].abs() * 1e4
    _csv(fe, "forced_exits.csv")
    full_fe = []
    for sl in ("trend", "carry"):
        p = ROOT / "reports" / "tables" / "full" / f"trades_{sl}.csv"
        if p.exists():
            tt = pd.read_csv(p)
            full_fe.append(tt[tt["side"] == "forced_exit"].assign(sleeve=sl))
    ff = pd.concat(full_fe, ignore_index=True) if full_fe else pd.DataFrame()
    _csv(ff, "forced_exits_existing_full_report.csv")
    ok = bool(len(fe) == 0 or (fe["fee_ok"].all() and fe["spread_ok"].all()))
    stale_px = int((fe["price_mismatch"]).sum()) if len(fe) else 0
    c.note("3", "Dev forced exits: " + ("; ".join(
        f"{r.sleeve} {r.market} {r.symbol} {r.ts} notional {r.qty_notional:,.0f} @ {r.price} "
        f"(last real close {r.last_real_close}) cost {r.total_cost:,.2f} ({r.cost_bps:.1f} bps)"
        for r in _rows(fe)) or "none"))
    c.note("3", f"Existing full-period report forced exits: {len(ff)}")
    v = "PASS" if ok and stale_px == 0 else ("WARN" if ok else "FAIL")
    c.add("3 Forced exits", "2x cost multiplier applied; priced at last real close", v,
          f"{len(fe)} dev forced exits (full report: {len(ff)}); cost check ok={ok}; "
          f"priced off a stale/filled close: {stale_px}")


# --------------------------------------------------------------------------- 4. funding
def funding_by_sleeve(c: Ctx) -> pd.DataFrame:
    led = []
    for name, res in (("trend", c.trend), ("carry", c.carry)):
        f = core.funding_ledger(res.positions["perp"], c.dev.funding, c.idx)
        led.append(f.assign(sleeve=name))
    return pd.concat(led, ignore_index=True)


def audit_funding(c: Ctx, led: pd.DataFrame) -> None:
    _csv(led, "funding_ledger_events.csv")
    rows = []
    for name, res in (("trend", c.trend), ("carry", c.carry), ("combined", c.combined)):
        sub = led if name == "combined" else led[led["sleeve"] == name]
        eng = float(res.costs["funding"].sum())
        mine = float(sub["paid"].sum())
        bar_mine = sub.groupby("charge_bar")["paid"].sum().reindex(res.costs.index).fillna(0.0)
        gap = float((bar_mine - res.costs["funding"]).abs().max())
        rows.append({"sleeve": name, "engine_total_paid": eng, "independent_total_paid": mine,
                     "diff": mine - eng, "max_bar_gap": gap,
                     "received": -float(sub.loc[sub["paid"] < 0, "paid"].sum()),
                     "paid": float(sub.loc[sub["paid"] > 0, "paid"].sum()), "n_events": len(sub)})
    tot = pd.DataFrame(rows)
    _csv(tot, "funding_reconcile.csv")
    per_sym = led.groupby(["sleeve", "symbol"]).agg(
        paid_net=("paid", "sum"), n_events=("paid", "size"),
        mean_notional=("notional", "mean"), mean_rate=("rate", "mean")).reset_index()
    _csv(per_sym, "funding_per_symbol.csv")
    iv = core.funding_intervals(c.full.funding)
    _csv(iv, "funding_intervals.csv")
    changes = iv.groupby("symbol").size()
    # sign convention: carry is short perp -> with positive rates it must RECEIVE
    cl = led[led["sleeve"] == "carry"]
    # every carry perp leg is short, and paid has the sign of notional*rate (positive rate -> received)
    sign_ok = True
    if len(cl):
        sign_ok = bool((cl["notional"] < 0).all()
                       and (np.sign(cl["paid"]) == np.sign(cl["notional"] * cl["rate"])).all())
    pos_rate_recv = float(-cl.loc[cl["rate"] > 0, "paid"].sum()) if len(cl) else 0.0
    c.note("4", f"Sign: carry perp legs all short = {bool((cl['notional'] < 0).all())}; funding received on "
                f"positive-rate events {pos_rate_recv:,.2f}; engine column 'funding' is + paid / - received "
                f"and is subtracted from cash (equity identity 7b).")
    # events charged in a non-8h interval regime
    nonstd = iv[(iv["interval_h"] != 8) & (iv["n_events"] >= 3)]
    max_diff = float(tot["diff"].abs().max())
    max_gap = float(tot["max_bar_gap"].max())
    c.note("4", "Totals (USDT, + paid / - received): " + "; ".join(
        f"{r.sleeve}: engine {r.engine_total_paid:,.2f} vs independent {r.independent_total_paid:,.2f} "
        f"(received {r.received:,.0f}, paid {r.paid:,.0f}, {r.n_events} events)" for r in _rows(tot)))
    c.note("4", "Non-8h funding stretches (>=3 events): " + ("; ".join(
        f"{r.symbol} {r.interval_h:.0f}h {r.start:%Y-%m-%d}->{r.end:%Y-%m-%d} ({r.n_events})"
        for r in _rows(nonstd)) or "none"))
    c.note("4", f"Interval segments per symbol: {changes.to_dict()}")
    v = "PASS" if max_diff < 1e-6 * c.cap and max_gap < 1e-6 * c.cap and sign_ok else "FAIL"
    c.add("4 Funding ledger", "independent recompute == engine; sign convention; interval changes", v,
          f"max |total diff| {max_diff:.2e}, max per-bar gap {max_gap:.2e}; carry received "
          f"{float(tot.loc[tot.sleeve == 'carry', 'received'].iloc[0]):,.0f}, trend net paid "
          f"{float(tot.loc[tot.sleeve == 'trend', 'engine_total_paid'].iloc[0]):,.0f}; sign ok={sign_ok}; "
          f"{len(nonstd)} non-8h stretches")


# --------------------------------------------------------------------------- 5. reconcile
def audit_reconcile(c: Ctx) -> None:
    tabs = []
    summary = []
    for name, res in (("trend", c.trend), ("carry", c.carry), ("combined", c.combined)):
        r = reconcile(res, c.cm, c.dev)
        tabs.append(r["table"].assign(sleeve=name))
        summary.append({"sleeve": name, "ok": r["ok"], "n_discrepancies": r["n_discrepancies"],
                        **r["totals"]})
    tab = pd.concat(tabs, ignore_index=True)
    _csv(tab, "reconcile_checks.csv")
    sm = pd.DataFrame(summary)
    _csv(sm, "reconcile_totals.csv")
    bad = tab[~tab["ok"]]
    # compare with the existing dev report
    p = ROOT / "reports" / "tables" / "dev" / "costs.csv"
    rep_note = "reports/tables/dev/costs.csv missing"
    rep_ok = True
    if p.exists():
        rep = pd.read_csv(p, index_col=0)
        net_rep = {"trend": rep.loc["Trend", "Net P&L"], "carry": rep.loc["Carry", "Net P&L"],
                   "combined": rep.loc["Combined", "Net P&L"]}
        mine = sm.set_index("sleeve")["net_pnl"].astype(float)
        diffs = {k: float(mine[k]) - float(str(v)) for k, v in net_rep.items()}
        rep_ok = all(abs(x) < 1.0 for x in diffs.values())
        rep_note = "net P&L vs existing dev report (USDT diff): " + ", ".join(f"{k} {v:+.4f}"
                                                                           for k, v in diffs.items())
    c.note("5", rep_note)
    c.note("5", "Totals: " + "; ".join(
        f"{r.sleeve}: gross {r.gross_pnl:,.0f} fees {r.fees:,.0f} spread {r.spread:,.0f} impact "
        f"{r.impact:,.0f} "
        f"funding {r.funding_paid:,.0f} net {r.net_pnl:,.0f}" for r in _rows(sm)))
    if len(bad):
        c.note("5", "Failing checks: " + "; ".join(f"{r.sleeve}:{r.check} diff {r.abs_diff:.3g}"
                                                   for r in _rows(bad)))
    v = "PASS" if bad.empty and rep_ok else ("WARN" if bad.empty else "FAIL")
    c.add("5 Fees/spread/impact", "validation.reconcile on trend, carry, combined", v,
          f"{len(tab)} checks, {len(bad)} failing; reproduces dev report: {rep_ok}")


# --------------------------------------------------------------------------- 6. attribution
def audit_attribution(c: Ctx, led: pd.DataFrame) -> pd.DataFrame:
    res = c.trend
    pos = res.positions["perp"]
    close_ff = c.dev.perp.close.reindex(index=c.idx, columns=pos.columns).ffill().reindex(pos.index)
    tl = led[led["sleeve"] == "trend"]
    fbs = (tl.pivot_table(index="charge_bar", columns="symbol", values="paid", aggfunc="sum")
           if len(tl) else None)
    tab = core.attribution_table(pos, c.dev.perp.open, close_ff, res.trades, fbs, "perp")
    tab = tab[(tab.drop(columns=["residual_vs_ledger"]).abs() > 1e-9).any(axis=1)]
    _csv(tab, "trend_attribution_year_symbol.csv", index=True)
    yr = tab.groupby(level="year").sum()
    eq = res.equity
    ey = pd.DatetimeIndex(eq.index).year
    prev_end = eq.groupby(ey).last().shift(1)
    base = prev_end.fillna(float(res.meta["initial_capital"]))
    for col in ("gross_long", "gross_short", "gross", "costs", "funding", "net"):
        yr[f"{col}_pct"] = yr[col] / base.reindex(yr.index)
    yr["equity_return"] = eq.groupby(ey).last() / base - 1.0
    _csv(yr, "trend_attribution_year.csv", index=True)
    btc = c.dev.spot.close["BTC"]
    by = pd.DatetimeIndex(btc.index).year
    btc_y = btc.groupby(by).last() / btc.groupby(by).first() - 1.0
    resid = float(tab["residual_vs_ledger"].abs().max())
    net_vs_eq = float((yr["net"] / base.reindex(yr.index) - yr["equity_return"]).abs().max())
    y22 = yr.loc[2022] if 2022 in yr.index else None
    if y22 is not None:
        top = pd.DataFrame(tab.xs(2022, level="year")).sort_values(by="net")
        c.note("6", f"2022: equity {y22.equity_return:+.2%}; gross long {y22.gross_long_pct:+.2%}, gross "
                    f"short "
                    f"{y22.gross_short_pct:+.2%}, costs {-y22.costs_pct:+.2%}, funding "
                    f"{-y22.funding_pct:+.2%} "
                    f"(BTC spot {btc_y.get(2022, np.nan):+.2%}).")
        c.note("6", "2022 best symbols (net USDT): " + ", ".join(
            f"{s} {r.net:,.0f} (L {r.gross_long:,.0f} / S {r.gross_short:,.0f})"
            for s, r in top.iloc[::-1].head(5).iterrows()))
        c.note("6", "2022 worst symbols: " + ", ".join(f"{s} {r.net:,.0f}"
                                                      for s, r in top.head(3).iterrows()))
    c.note("6", "Per year (% of start equity): " + "; ".join(
        f"{y}: L {r.gross_long_pct:+.1%} S {r.gross_short_pct:+.1%} costs {-r.costs_pct:+.1%} "
        f"fund {-r.funding_pct:+.1%} = {r.net_pct:+.1%} (equity {r.equity_return:+.1%})"
        for y, r in yr.iterrows()))
    v = "PASS" if resid < 1e-4 * c.cap and net_vs_eq < 1e-6 else "FAIL"
    c.add("6 Trend attribution", "long/short split sums to ledger gross; net == equity change", v,
          f"max |price-split - ledger| {resid:.2e}; max |net% - equity%| {net_vs_eq:.2e}"
          + (f"; 2022 L {y22.gross_long_pct:+.1%} S {y22.gross_short_pct:+.1%} net {y22.net_pct:+.1%}"
             if y22 is not None else ""))
    return yr


# --------------------------------------------------------------------------- 7. sanity
def audit_sanity(c: Ctx) -> None:
    imp = core.implausible_bars(c.full, 0.5)
    _csv(imp, "implausible_bars.csv")
    # strategy-level big hourly moves
    big = []
    for name, res in (("trend", c.trend), ("carry", c.carry), ("combined", c.combined)):
        r = res.returns
        for ts, x in r[r.abs() > 0.05].items():
            big.append({"sleeve": name, "ts": ts, "return": x})
    _csv(pd.DataFrame(big), "large_strategy_hourly_returns.csv")
    ids = {}
    for name, res in (("trend", c.trend), ("carry", c.carry), ("combined", c.combined)):
        ids[name] = float(core.equity_identity(res).abs().max())
    _csv(pd.Series(ids, name="max_abs_residual").to_frame(), "equity_identity.csv", index=True)
    held_imp = 0
    for r in _rows(imp):
        for res in (c.trend, c.carry):
            p = res.positions[r.market]
            if r.symbol in p and r.ts in p.index:
                i = int(p.index.searchsorted(r.ts))
                if i > 0 and p[r.symbol].iloc[i - 1] != 0:
                    held_imp += 1
    c.note("7", f"Real bars with |ret|>50% (close or open gap): {len(imp)} "
                + ("; ".join(f"{r.market} {r.symbol} {r.ts:%Y-%m-%d %H}h {r.ret_close:+.0%}"
                             for r in _rows(imp.head(12)))) + f"; held into by a sleeve: {held_imp}")
    c.note("7", f"Strategy hourly returns |r|>5%: {len(big)}")
    c.add("7a Implausible bars", "|bar return|>50% on real bars", "PASS" if len(imp) == 0 else "WARN",
          f"{len(imp)} bars, {held_imp} with a position held into them")
    mx = max(ids.values())
    c.add("7b Equity identity", "cash + positions == equity from flows only", "PASS" if mx < 1e-6 * c.cap
          else "FAIL", ", ".join(f"{k} {v:.2e}" for k, v in ids.items()))
    leakage(c)


def leakage(c: Ctx) -> None:
    rows = []
    # (a) causality across the dev/holdout boundary: weights computed on data ending at dev_end must equal
    #     the weights computed on data ending 90 days earlier, on the overlap.
    early = c.dev_end - pd.Timedelta(days=90)
    d_early = c.full.truncate(early)
    for name, s in (("trend", c.trend_s), ("carry", c.carry_s)):
        a = s.target_weights(c.dev)
        b = s.target_weights(d_early)
        for m in ("spot", "perp"):
            wa, wb = getattr(a, m), getattr(b, m)
            if not len(wb):
                continue
            wa = wa.reindex(index=wb.index, columns=wb.columns).fillna(0.0)
            rows.append({"check": f"prefix_weights_{name}_{m}", "max_abs_diff":
                         float((wa - wb.fillna(0.0)).abs().max().max())})
    # (b) dev-locked re-run vs the dev slice of the existing full-period trades (holdout data present there)
    for sl, res in (("trend", c.trend), ("carry", c.carry)):
        p = ROOT / "reports" / "tables" / "full" / f"trades_{sl}.csv"
        if not p.exists():
            continue
        ft = pd.read_csv(p)
        ft["ts"] = pd.to_datetime(ft["ts"], utc=True)
        ft = ft[ft["ts"] <= c.dev_end].reset_index(drop=True)
        mt = res.trades.reset_index(drop=True)
        same_n = len(ft) == len(mt)
        diff = float((ft["qty_notional"] - mt["qty_notional"]).abs().max()) if same_n else float("nan")
        rows.append({"check": f"full_report_dev_slice_vs_locked_rerun_{sl}", "max_abs_diff": diff,
                     "n_full": len(ft), "n_locked": len(mt)})
    # (c) period boundaries in the existing tables
    for per in ("dev", "holdout"):
        p = ROOT / "reports" / "tables" / per / "period.csv"
        if p.exists():
            pr = pd.read_csv(p, index_col=0)["value"]
            rows.append({"check": f"period_{per}", "start": pr.get("start"), "end": pr.get("end")})
    lk = pd.DataFrame(rows)
    _csv(lk, "leakage_checks.csv")
    num = lk["max_abs_diff"].dropna()
    ok = bool(len(num) and (num < 1e-6).all() and lk["max_abs_diff"].notna().sum() == len(num))
    nan_rows = lk[lk["check"].str.startswith("full_report") & lk["max_abs_diff"].isna()]
    pdev = lk[lk["check"] == "period_dev"]
    pho = lk[lk["check"] == "period_holdout"]
    gap_ok = True
    if len(pdev) and len(pho):
        gap_ok = _utc(pho["start"].iloc[0]) - _utc(pdev["end"].iloc[0]) == pd.Timedelta(hours=1)
    c.note("7", "Leakage: " + "; ".join(
        f"{r.check}: {r.max_abs_diff if pd.notna(r.max_abs_diff) else ''}"
        + (f" (n full {int(r.n_full)} / locked {int(r.n_locked)})" if "n_full" in lk and pd.notna(r.n_full)
           else "") + (f" {r.start} -> {r.end}" if "start" in lk and pd.notna(r.start) else "")
        for r in _rows(lk)))
    v = "PASS" if ok and gap_ok and nan_rows.empty else ("WARN" if gap_ok else "FAIL")
    c.add("7c Dev/holdout leakage", "prefix-causal weights at boundary; full-run dev slice == locked run; "
          "contiguous split", v, f"max weight/trade diff "
                                 f"{float(num.max()) if len(num) else float('nan'):.2e}; "
          f"trade-count mismatches {len(nan_rows)}; boundary contiguous {gap_ok}")


# --------------------------------------------------------------------------- doc
def write_doc(c: Ctx) -> None:
    f = pd.DataFrame(c.findings)
    _csv(f, "findings.csv")
    lines = [
        "# Data + accounting audit",
        "",
        "Generated by `uv run python -m engine.audit` (verification only: no parameter changes, holdout lock "
        "untouched). Backtests are re-run on DEVELOPMENT data only (truncated at split.dev_end, 1.0x costs, "
        "trend and carry each at 50% of initial capital, as in the pipeline). Holdout-era statements use raw "
        "data files and the already-existing `reports/tables/full/` CSVs. Evidence CSVs: `reports/audit/`.",
        "",
        "## Findings",
        "",
        "| # | Check | Verdict | Key numbers |",
        "|---|---|---|---|",
    ]
    for r in _rows(f):
        num = str(r.numbers).replace("|", "")
        lines.append(f"| {r.item} | {str(r.check).replace('|', '')} | **{r.verdict}** | {num} |")
    titles = {"1": "LUNA collapse (May 2022)", "2": "FTT (Nov 2022 and spot/perp relisting mismatch)",
              "3": "Forced exits", "4": "Funding ledger", "5": "Fees / spread / impact reconciliation",
              "6": "Trend return attribution", "7": "Sanity"}
    for k, t in titles.items():
        lines += ["", f"## {k}. {t}", ""]
        lines += [f"- {x}" for x in c.notes.get(k, [])]
    lines += ["", "## Bugs / data defects found (described, not fixed: HEAD is frozen)", ""]
    lines += [f"- {x}" for x in BUGS]
    DOC.parent.mkdir(parents=True, exist_ok=True)
    DOC.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    c = Ctx()
    flags = core.trade_flags(_all_trades(c), c.full)
    _csv(flags[flags[["stale_bar", "frozen_bar", "after_last_real_bar", "price_mismatch"]].any(axis=1)],
         "flagged_trades.csv")
    led = funding_by_sleeve(c)
    audit_luna(c, flags, led)
    audit_ftt(c, flags, led)
    audit_forced(c, flags)
    audit_funding(c, led)
    audit_reconcile(c)
    audit_attribution(c, led)
    audit_sanity(c)
    extra_flags(c, flags)
    write_doc(c)
    print(pd.DataFrame(c.findings).to_string(index=False))


def extra_flags(c: Ctx, flags: pd.DataFrame) -> None:
    n = {k: int(flags[k].sum()) for k in ("stale_bar", "frozen_bar", "after_last_real_bar", "price_mismatch")}
    c.note("7", f"All dev trades ({len(flags)}): flagged counts {n} (price_mismatch for forced exits = "
                f"priced "
                f"off a filled close rather than the last real close).")
