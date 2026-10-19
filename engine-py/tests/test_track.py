"""Forward-evidence tracking: versions, scorecard, gate, one-use holdout, frozen live bars,
plain-words actions, manual fills, market indicators, venue check, health, dashboard."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pytest

from engine.live.feed import parse_klines
from engine.live.telegram import action, format_actions, format_message
from engine.track import market, venue
from engine.track.dashboard import render_dashboard
from engine.track.health import run_health
from engine.track.manual import match_paper, read_manual, record_fill
from engine.track.scorecard import build_trades, equity_stats, evaluate_gate, scorecard, trade_stats
from engine.track.versions import (
    DEFAULT_GATE,
    VersionError,
    freeze_version,
    list_versions,
    load_version,
    running_versions,
    set_status,
)
from engine.validation.walkforward import HoldoutLock, HoldoutViolation

EXP = {"strategies": {"trend": {"enabled": True, "lookbacks_days": [20]},
                      "xsmom": {"enabled": False}, "allocation": {"trend": 1.0}}}


def _fill(ts: str, qty: float, price: float, cost: float = 0.0, sym: str = "BTC") -> dict[str, Any]:
    return {"ts": ts, "market": "perp", "symbol": sym, "side": "buy" if qty > 0 else "sell",
            "qty": qty, "price": price, "cost": cost}


# ---- versions ------------------------------------------------------------------------------------
def test_freeze_keeps_only_enabled_and_is_immutable(tmp_path: Path) -> None:
    v = freeze_version(tmp_path, "t", "trend works", EXP, ["BTC", "ETH"])
    assert v.id == "v001" and set(v.strategies) == {"trend", "allocation"}
    assert load_version(tmp_path, "v001").params_hash == v.params_hash
    with pytest.raises(VersionError):
        freeze_version(tmp_path, "t", "again", EXP, ["BTC"], vid="v001")
    p = tmp_path / "config" / "versions" / "v001.yaml"
    p.write_text(p.read_text().replace("- 20", "- 21"))
    with pytest.raises(VersionError, match="rules changed"):
        load_version(tmp_path, "v001")


def test_freeze_requires_hypothesis_and_numbers_sequentially(tmp_path: Path) -> None:
    with pytest.raises(VersionError):
        freeze_version(tmp_path, "t", "  ", EXP, ["BTC"])
    freeze_version(tmp_path, "a", "h", EXP, ["BTC"])
    assert freeze_version(tmp_path, "b", "h", EXP, ["ETH"]).id == "v002"


def test_status_change_keeps_hash_and_filters_running(tmp_path: Path) -> None:
    freeze_version(tmp_path, "a", "h", EXP, ["BTC"])
    freeze_version(tmp_path, "b", "h", EXP, ["ETH"], status="observe")
    set_status(tmp_path, "v001", "retired", "failed gate")
    assert [v.id for v in running_versions(tmp_path)] == ["v002"]
    assert [v.id for v in list_versions(tmp_path)] == ["v001", "v002"]
    v1 = load_version(tmp_path, "v001")
    assert v1.status == "retired" and "failed gate" in v1.notes
    assert "FROZEN" in (tmp_path / "config" / "versions" / "v001.yaml").read_text()


# ---- scorecard -----------------------------------------------------------------------------------
def test_round_trip_with_add_trim_costs_and_funding() -> None:
    fills = [_fill("2026-01-01T00", 1.0, 100, 1.0), _fill("2026-01-02T00", 1.0, 110, 1.0),
             {"ts": "2026-01-02T08", "market": "perp", "symbol": "BTC", "side": "funding", "qty": 0.0,
              "cost": 0.5},
             _fill("2026-01-03T00", -1.0, 120, 1.0), _fill("2026-01-04T00", -1.0, 90, 1.0)]
    closed, open_ = build_trades(fills)
    assert not open_ and len(closed) == 1
    t = closed[0]
    # avg entry 105; sold 1 @120 (+15) and 1 @90 (-15) -> 0 price PnL; costs 4, funding 0.5
    assert t.entry_price == pytest.approx(105.0) and t.realized == pytest.approx(0.0)
    assert t.pnl == pytest.approx(-4.5) and t.max_notional == pytest.approx(220.0)
    assert t.closed == "2026-01-04T00" and t.exit_price == 90


def test_flip_closes_and_opens_short() -> None:
    closed, open_ = build_trades([_fill("a", 2.0, 100, 2.0), _fill("b", -3.0, 110, 3.0)])
    assert len(closed) == 1 and closed[0].realized == pytest.approx(20.0)
    assert closed[0].costs == pytest.approx(2.0 + 2.0)        # 2/3 of the flip fill's cost
    assert len(open_) == 1 and open_[0].side == "short" and open_[0].qty == pytest.approx(-1.0)
    assert open_[0].costs == pytest.approx(1.0)


def test_trade_stats_profit_factor_and_win_rate() -> None:
    fills = [_fill("1", 1, 100, sym="A"), _fill("2", -1, 110, sym="A"),
             _fill("1", 1, 100, sym="B"), _fill("2", -1, 95, sym="B")]
    s = trade_stats(build_trades(fills)[0])
    assert s["n_closed"] == 2 and s["win_rate"] == 0.5 and s["profit_factor"] == pytest.approx(2.0)


def _equity(days: int, drift: float, seed: int = 0) -> list[dict[str, Any]]:
    rng = np.random.default_rng(seed)
    eq, out = 100_000.0, []
    for i, ts in enumerate(pd.date_range("2026-01-01", periods=days * 24, freq="h", tz="UTC")):
        if i % 24 == 0:
            eq *= 1 + drift + rng.normal(0, 0.001)
        out.append({"ts": ts.isoformat(), "equity": eq})
    return out


def test_gate_pending_until_sample_then_pass_or_fail() -> None:
    gate = {**DEFAULT_GATE, "min_days": 30, "min_closed_trades": 2}
    many = [f for i in range(3) for f in (_fill(f"{i}a", 1, 100, sym=f"S{i}"), _fill(f"{i}b", -1, 110,
                                                                                      sym=f"S{i}"))]
    tr = trade_stats(build_trades(many)[0])
    short = evaluate_gate(gate, equity_stats(_equity(5, 0.002), 100_000), tr)
    assert short.verdict == "PENDING" and "live days" in short.summary
    good = evaluate_gate(gate, equity_stats(_equity(60, 0.003), 100_000), tr)
    assert good.verdict == "PASS"
    flat = evaluate_gate(gate, equity_stats(_equity(60, 0.0, seed=3), 100_000), tr)
    assert flat.verdict == "FAIL"
    crash = [{"ts": "2026-01-01T00:00:00+00:00", "equity": 100_000}, {"ts": "2026-01-02T00:00:00+00:00",
                                                                     "equity": 60_000}]
    assert evaluate_gate(gate, equity_stats(crash, 100_000), tr).verdict == "FAIL"


def test_scorecard_empty_ledger_is_pending() -> None:
    sc = scorecard([], [], 100_000, DEFAULT_GATE)
    assert sc["gate"]["verdict"] == "PENDING" and sc["trades"]["n_closed"] == 0


# ---- one-use holdout -----------------------------------------------------------------------------
def test_holdout_reserve_blocks_reuse(tmp_path: Path) -> None:
    lock = HoldoutLock("2024-07-01", log_path=tmp_path / "h.jsonl")
    assert lock.reserve("aaa") == 0
    lock.unlock("first look", params_hash="aaa")
    with pytest.raises(HoldoutViolation, match="already evaluated"):
        lock.reserve("aaa", acknowledge_reuse=True)
    with pytest.raises(HoldoutViolation, match="acknowledge-reuse"):
        lock.reserve("bbb")
    assert lock.reserve("bbb", acknowledge_reuse=True) == 1
    lock.unlock("second", params_hash="bbb", prior_views=1)
    rows = [json.loads(x) for x in (tmp_path / "h.jsonl").read_text().splitlines()]
    assert rows[-1]["contaminated"] is True and rows[0]["contaminated"] is False
    other = HoldoutLock("2027-01-01", log_path=tmp_path / "h.jsonl")
    assert other.reserve("aaa") == 0                       # a NEW window is fresh again


# ---- live feed: frozen contract bars ----------------------------------------------------------------
def test_parse_klines_marks_frozen_contract_bars() -> None:
    def k(h: int, o: float, hi: float, lo: float, c: float, v: float) -> list[Any]:
        t = int(pd.Timestamp("2026-07-01", tz="UTC").value // 1_000_000) + h * 3_600_000
        return [t, str(o), str(hi), str(lo), str(c), str(v), t + 3_599_999, str(v * c), 5]

    rows = [k(0, 1.6, 1.62, 1.58, 1.59, 10), k(1, 1.59, 1.59, 1.59, 1.59, 0), k(2, 1.59, 1.59, 1.59, 1.59, 0),
            k(3, 1.59, 1.6, 1.58, 1.6, 0)]
    df = parse_klines(rows, pd.Timestamp("2026-07-02", tz="UTC"))
    assert df["is_filled"].tolist() == [False, True, True, False]


# ---- telegram actions ----------------------------------------------------------------------------
@pytest.mark.parametrize("cur,tgt,word", [(0, 0.1, "OPEN LONG"), (0, -0.1, "OPEN SHORT"),
                                          (0.1, 0, "CLOSE LONG"), (-0.1, 0, "CLOSE SHORT"),
                                          (0.1, -0.1, "FLIP TO SHORT"), (0.1, 0.2, "ADD TO"),
                                          (0.2, 0.1, "TRIM")])
def test_action_words(cur: float, tgt: float, word: str) -> None:
    assert action(cur, tgt) == word


def test_tiny_rebalances_hidden_but_closes_shown() -> None:
    ch = [{"market": "perp", "symbol": "DOT", "current": 0.0054, "target": 0.0053},
          {"market": "perp", "symbol": "BTC", "current": 0.04, "target": 0.0}]
    out = format_actions(ch)
    assert len(out) == 1 and "CLOSE LONG BTC" in out[0]
    msg = format_message("t", 1.0, {}, ch[:1], [], version="v001 x")
    assert "nothing - hold positions" in msg and msg.startswith("Signal update v001 x")


# ---- manual fills --------------------------------------------------------------------------------
def test_manual_fill_slippage_vs_paper(tmp_path: Path) -> None:
    record_fill(tmp_path, "perp", "btc", "buy", 0.1, 101.0, ts="2026-01-01T01:10:00Z")
    record_fill(tmp_path, "perp", "ETH", "sell", 1.0, 99.0, ts="2026-01-01T01:00:00Z")
    paper = [_fill("2026-01-01T01:00:00+00:00", 0.1, 100.0),
             _fill("2026-01-01T01:00:00+00:00", -1.0, 100.0, sym="ETH")]
    m = match_paper(read_manual(tmp_path), paper)
    assert m[0]["slippage_bps"] == pytest.approx(100.0)       # paid 1% more than paper
    assert m[1]["slippage_bps"] == pytest.approx(100.0)       # sold 1% lower than paper
    with pytest.raises(ValueError):
        record_fill(tmp_path, "perp", "BTC", "hold", 1, 1)


# ---- market update -------------------------------------------------------------------------------
def test_rsi_and_macd_directions() -> None:
    up = pd.Series(np.linspace(100, 200, 60) + np.sin(np.arange(60)))
    assert market.rsi(up).iloc[-1] > 60 and market.macd_hist(up**2).iloc[-1] > 0
    assert market.rsi(up[::-1].reset_index(drop=True)).iloc[-1] < 40


def test_update_text_is_facts_only_with_disclaimer() -> None:
    rows = [market.CoinRow("BTC", 82000.0, 0.01, 0.02, 62, 1.0, True),
            market.CoinRow("PEPE", 0.0000123, -0.02, -0.05, 30, -1.0, False)]
    txt = market.format_update(pd.Timestamp("2026-10-09 12:00", tz="UTC"), rows,
                               [market.holdings_line("v001", {"perp": {"BTC": 1.0, "ETH": -1.0}})], [])
    assert "1 strong, 1 weak" in txt and "not a buy or sell call" in txt and "Paper trading only" in txt
    assert "long BTC; short ETH" in txt and "0.0000123" in txt


# ---- venue check ---------------------------------------------------------------------------------
def test_venue_compare_flags_gaps() -> None:
    idx = pd.date_range("2026-10-01", periods=3, freq="D", tz="UTC")
    df = venue.compare(pd.Series([100.0, 100.0, 102.0], idx), pd.Series([100.0, 100.2, 100.0], idx), 50)
    assert df["flag"].tolist() == [False, False, True]
    assert venue.hl_coin("1000PEPE") == "kPEPE" and venue.hl_coin("BTC") == "BTC"


# ---- health + dashboard --------------------------------------------------------------------------
def _ledger(tmp: Path, vid: str, last_step: pd.Timestamp, killed: bool = False) -> None:
    d = tmp / "data" / "paper" / vid
    d.mkdir(parents=True)
    (d / "state.json").write_text(json.dumps({
        "cash": 99_000.0, "initial_capital": 100_000.0, "qty": {"spot": {}, "perp": {"BTC": 0.01}},
        "pending": None, "peak": 100_000.0, "killed": killed, "last_bar": (last_step - pd.Timedelta(hours=1))
        .isoformat(), "last_funding_ts": None, "created_at": "2026-10-01T00:00:00+00:00"}))
    (d / "fills.jsonl").write_text(json.dumps(_fill(last_step.isoformat(), 0.01, 100_000.0)) + "\n")
    (d / "equity.jsonl").write_text("".join(json.dumps({"ts": t.isoformat(), "equity": 100_000 + i})
                                            + "\n" for i, t in enumerate(pd.date_range(
                                                pd.Timestamp("2026-10-01", tz="UTC"), last_step, freq="h"))))
    (d / "signals.jsonl").write_text(json.dumps({
        "logged_at": last_step.isoformat(), "asof": "x", "halt": False, "reasons": [],
        "target": {"perp": {"BTC": 0.0}}, "current": {"perp": {"BTC": 0.01}}}) + "\n")


def test_health_flags_stopped_steps_and_kill(tmp_path: Path) -> None:
    now = pd.Timestamp("2026-10-09 12:00", tz="UTC")
    a = freeze_version(tmp_path, "a", "h", EXP, ["BTC"])
    b = freeze_version(tmp_path, "b", "h", EXP, ["BTC"])
    _ledger(tmp_path, "v001", now - pd.Timedelta(minutes=30))
    _ledger(tmp_path, "v002", now - pd.Timedelta(hours=10), killed=True)
    by = {c.name: c.status for c in run_health(tmp_path, [a, b], now)}
    assert by["v001 last step"] == "OK" and by["v001 reconciliation"] == "OK"
    assert by["v002 last step"] == "FAIL" and by["v002 kill switch"] == "FAIL"


def test_dashboard_renders_versions_and_actions(tmp_path: Path) -> None:
    now = pd.Timestamp("2026-10-09 12:00", tz="UTC")
    v = freeze_version(tmp_path, "core", "trend <works>", EXP, ["BTC"])
    freeze_version(tmp_path, "empty", "h", EXP, ["ETH"])
    _ledger(tmp_path, "v001", now)
    out = render_dashboard(tmp_path, list_versions(tmp_path), run_health(tmp_path, [v], now),
                           tmp_path / "reports" / "d.html")
    html = out.read_text(encoding="utf-8")
    assert "CLOSE LONG BTC" in html and "Gate:" in html and "PENDING" in html
    assert "trend &lt;works&gt;" in html and "No paper ledger yet" in html and "<svg" in html
