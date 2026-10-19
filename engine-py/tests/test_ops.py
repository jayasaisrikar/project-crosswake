"""Operations hardening (reports/review/03_operations.md, O1-O20). Mocked HTTP only; every ledger
lives in a tmp dir (engine.cli.ROOT is monkeypatched), nothing is sent, no orders exist."""

from __future__ import annotations

import dataclasses
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pytest
import requests

from engine import cli
from engine.live import feed as feed_mod
from engine.live import telegram
from engine.live.journal import LedgerCorrupt, LockBusy, StepLock, read_rows, repair_tail
from engine.live.paper import PaperLedger, effective_fills
from engine.live.risk import RiskLimits, check_risk, reconcile
from engine.pipeline import ROOT as REAL_ROOT

H = 3_600_000
NOW1 = pd.Timestamp("2026-10-09 12:30", tz="UTC")
NOW2 = NOW1 + pd.Timedelta(hours=1)


def _px(sym: str, open_ms: int) -> float:
    h = open_ms // H
    base = 100.0 if sym.startswith("BTC") else 50.0
    return base * math.exp(0.0004 * (h - 480_000) + 0.01 * math.sin(h / 7.0))


class Resp:
    def __init__(
        self, payload: Any, status: int = 200, headers: dict[str, str] | None = None, text: str | None = None
    ) -> None:
        self.payload, self.status_code = payload, status
        self.headers = headers or {}
        self.text = text if text is not None else str(payload)

    def json(self) -> Any:
        return self.payload

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code} Client Error for url: https://x/botSECRET:1/send")


class Market:
    """Fake Binance: klines (incl. the in-progress bar, which must be dropped) + 8h funding."""

    def __init__(self, now: pd.Timestamp, status: int = 200) -> None:
        self.now, self.status = now, status
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def get(self, url: str, params: dict[str, Any], timeout: float) -> Resp:
        self.calls.append((url, dict(params)))
        if self.status != 200:
            return Resp({}, self.status)
        cur = int(self.now.floor("h").value // 1_000_000)
        start = int(params["startTime"])
        if url == feed_mod.FUNDING_URL:
            t0 = start - start % (8 * H) + 8 * H
            return Resp(
                [
                    {"symbol": params["symbol"], "fundingTime": t, "fundingRate": "0.0001"}
                    for t in range(t0, cur, 8 * H)
                ][:1000]
            )
        start -= start % H
        rows = [
            [
                t,
                str(_px(params["symbol"], t)),
                str(_px(params["symbol"], t) * 1.01),
                str(_px(params["symbol"], t) * 0.99),
                str(_px(params["symbol"], t)),
                "1000",
                t + H - 1,
                "1e9",
                100,
                "0",
                "0",
                "0",
            ]
            for t in range(start, cur + H, H)
        ]
        return Resp(rows[: params["limit"]])

    def post(self, *a: Any, **k: Any) -> Resp:
        raise AssertionError("tests never post")


@pytest.fixture()
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    from engine.track.versions import load_version

    v = load_version(REAL_ROOT, "v001")
    v = dataclasses.replace(v, paper_dir=str(tmp_path / "paper"), symbols=["BTC", "ETH"])
    monkeypatch.setattr(cli, "ROOT", tmp_path)
    monkeypatch.setattr(feed_mod.time, "sleep", lambda s: None)
    return {"v": v, "dir": tmp_path / "paper", "root": tmp_path}


def _step(e: dict[str, Any], now: pd.Timestamp) -> int:
    return cli.live_step(version=e["v"], now=now, session=Market(now))


def _rows(d: Path, name: str) -> list[dict[str, Any]]:
    return read_rows(d / name, repair=False)[0]


# --------------------------------------------------------------------------- O1 crash safety
class Crash(RuntimeError):
    pass


POINTS = [
    "before_journal",
    "after_journal",
    "after_append:equity.jsonl",
    "after_append:fills.jsonl",
    "after_append:signals.jsonl",
    "after_state",
]


def _assert_consistent(d: Path, t1: pd.Timestamp) -> None:
    fills = _rows(d, "fills.jsonl")
    trades = [f for f in fills if f["side"] != "funding" and pd.Timestamp(f["decision_ts"]) == t1]
    keys = [(f["market"], f["symbol"]) for f in trades]
    assert trades and len(keys) == len(set(keys)), "every order filled exactly once (raw log)"
    st = json.loads((d / "state.json").read_text())
    assert reconcile(st["qty"], fills) == []
    assert not (d / "journal.json").exists()
    eq = [r["ts"] for r in _rows(d, "equity.jsonl")]
    assert len(eq) == len(set(eq))
    fund = [(f["ts"], f["symbol"]) for f in fills if f["side"] == "funding"]
    assert len(fund) == len(set(fund))


@pytest.mark.parametrize("point", POINTS)
def test_crash_at_every_write_point_never_duplicates(
    env: dict[str, Any], monkeypatch: pytest.MonkeyPatch, point: str
) -> None:
    assert _step(env, NOW1) in (0, 1)
    t1 = NOW1.floor("h") - pd.Timedelta(hours=1)

    def boom(self: PaperLedger, p: str) -> None:
        if p == point:
            raise Crash(p)

    with monkeypatch.context() as m:
        m.setattr(PaperLedger, "_hit", boom)
        with pytest.raises(Crash):
            _step(env, NOW2)
    assert _step(env, NOW2) in (0, 1)  # restart: roll forward / redo, never double-fill
    _assert_consistent(env["dir"], t1)
    assert (
        json.loads((env["dir"] / "state.json").read_text())["pending"]["decision_ts"]
        == (NOW2.floor("h") - pd.Timedelta(hours=1)).isoformat()
    )


def test_crash_before_commit_leaves_disk_untouched(
    env: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    _step(env, NOW1)
    before = {p.name: p.read_bytes() for p in env["dir"].glob("*.json*") if p.is_file()}
    import engine.live.signals_live as sl

    with monkeypatch.context() as m:
        m.setattr(sl, "latest_signal", lambda *a, **k: (_ for _ in ()).throw(Crash("signal")))
        with pytest.raises(Crash):
            _step(env, NOW2)
    after = {p.name: p.read_bytes() for p in env["dir"].glob("*.json*") if p.is_file()}
    assert {k: v for k, v in after.items() if k != ".step.lock"} == {
        k: v for k, v in before.items() if k != ".step.lock"
    }
    _step(env, NOW2)
    _assert_consistent(env["dir"], NOW1.floor("h") - pd.Timedelta(hours=1))


def test_torn_append_during_crash_is_quarantined_and_rolled_forward(
    env: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    _step(env, NOW1)

    def boom(self: PaperLedger, p: str) -> None:
        if p == "after_journal":
            with open(self.root / "fills.jsonl", "a", encoding="utf-8") as f:
                f.write('{"ts": "2026-10-09T1')  # power loss mid-write
            raise Crash(p)

    with monkeypatch.context() as m:
        m.setattr(PaperLedger, "_hit", boom)
        with pytest.raises(Crash):
            _step(env, NOW2)
    _step(env, NOW2)
    _assert_consistent(env["dir"], NOW1.floor("h") - pd.Timedelta(hours=1))
    assert (env["dir"] / "fills.jsonl.torn").exists()


def test_legacy_duplicate_fills_heal_and_recover_command(env: dict[str, Any]) -> None:
    _step(env, NOW1)
    _step(env, NOW2)
    d = env["dir"]
    fills = _rows(d, "fills.jsonl")
    trade = next(f for f in fills if f["side"] != "funding")
    with open(d / "fills.jsonl", "a", encoding="utf-8") as f:  # what the pre-journal crash produced
        f.write(json.dumps({k: v for k, v in trade.items() if k not in ("step_id", "seq")}) + "\n")
    st = json.loads((d / "state.json").read_text())
    assert reconcile(st["qty"], _rows(d, "fills.jsonl")) == []  # dedup by fill identity
    assert len(effective_fills(_rows(d, "fills.jsonl"))) == len(fills)
    from engine.track.scorecard import build_trades

    assert len(build_trades(effective_fills(_rows(d, "fills.jsonl")))[1]) == len(build_trades(fills)[1])
    # explicit recovery: breaks qty on purpose, then --rebuild restores it from the deduplicated log
    st["qty"]["perp"][trade["symbol"]] = 999.0
    (d / "state.json").write_text(json.dumps(st))
    import engine.track.commands as tc

    orig = tc.selected_versions
    try:
        tc.selected_versions = lambda root, vid: [env["v"]]  # type: ignore[assignment]
        assert cli.live_recover(None, "unit test", rebuild=False) == 1
        assert cli.live_recover(None, "unit test", rebuild=True) == 0
    finally:
        tc.selected_versions = orig  # type: ignore[assignment]
    audit = _rows(d, "audit.jsonl")
    assert audit[-1]["action"] == "recover" and audit[-1]["mismatch_after"] == []


# --------------------------------------------------------------------------- O2 torn JSONL
def test_torn_last_line_quarantined_middle_corruption_raises(tmp_path: Path) -> None:
    p = tmp_path / "x.jsonl"
    p.write_text('{"a": 1}\n{"a": 2}\n{"a": 3', encoding="utf-8")
    rows, issues = read_rows(p, repair=False)
    assert [r["a"] for r in rows] == [1, 2] and issues
    assert p.read_text().endswith('{"a": 3')  # repair=False never mutates
    rows, issues = read_rows(p, repair=True)
    assert [r["a"] for r in rows] == [1, 2] and p.read_text() == '{"a": 1}\n{"a": 2}\n'
    assert "fragment" in (tmp_path / "x.jsonl.torn").read_text()
    assert repair_tail(p) is None
    p.write_text('{"a": 1}\nGARBAGE\n{"a": 3}\n', encoding="utf-8")
    with pytest.raises(LedgerCorrupt):
        read_rows(p)


def test_health_reports_fail_on_torn_and_corrupt_ledgers(env: dict[str, Any]) -> None:
    from engine.track.health import run_health

    _step(env, NOW1)
    d, v = env["dir"], env["v"]
    with open(d / "fills.jsonl", "a", encoding="utf-8") as f:
        f.write('{"broken')
    checks = run_health(env["root"], [v], now=NOW1)
    assert any(c.status == "FAIL" and "fills.jsonl" in c.name for c in checks)
    (d / "equity.jsonl").write_text('{"ts": 1}\nnope\n{"ts": 2}\n')
    checks = run_health(env["root"], [v], now=NOW1)
    assert any(c.status == "FAIL" and "corrupt" in c.detail for c in checks)
    # a step repairs the torn tail itself (and logs it), then health is clean again for fills
    (d / "equity.jsonl").write_text("")
    _step(env, NOW2)
    assert (d / "fills.jsonl.torn").exists()


# --------------------------------------------------------------------------- O3 kill switch on stale marks
def test_check_risk_never_kills_on_stale_marks() -> None:
    lim = RiskLimits()
    last = NOW1.floor("h") - pd.Timedelta(hours=1)
    rep = check_risk(lim, 5_000.0, 100_000.0, 100_000.0, NOW1, None, [], stale_marks=["perp BTC (no price)"])
    assert not rep.kill and rep.halt and any("cannot value book" in r for r in rep.reasons)
    assert check_risk(lim, 5_000.0, 100_000.0, 100_000.0, NOW1, last, []).kill  # fresh prices: kill


def test_feed_outage_with_long_book_holds_not_kills(env: dict[str, Any]) -> None:
    _step(env, NOW1)
    _step(env, NOW2)
    d = env["dir"]
    st0 = json.loads((d / "state.json").read_text())
    assert any(st0["qty"]["perp"].values()) or any(st0["qty"]["spot"].values())
    now3 = NOW2 + pd.Timedelta(hours=3)

    class Down(Market):
        def get(self, url: str, params: dict[str, Any], timeout: float) -> Resp:
            raise requests.ConnectionError("network down")

    import shutil

    shutil.rmtree(env["root"] / "data" / "paper" / "live_cache", ignore_errors=True)
    rc = cli.live_step(version=env["v"], now=now3, session=Down(now3))
    st = json.loads((d / "state.json").read_text())
    sig = _rows(d, "signals.jsonl")[-1]
    assert rc == 1 and not st["killed"] and not sig["kill"]
    assert st["pending"] is None or st["pending"]["weights"] != {"spot": {}, "perp": {}}
    assert sig["stale_marks"] and st["peak"] == st0["peak"]


# --------------------------------------------------------------------------- O4 heartbeat / alerting
def test_live_step_all_writes_heartbeat_and_propagates_codes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(cli, "ROOT", tmp_path)
    import engine.track.commands as tc

    monkeypatch.setattr(tc, "selected_versions", lambda root, vid: [])
    monkeypatch.setattr(requests, "Session", lambda: Market(NOW1, status=451))
    assert cli.live_step_all() == 2  # 451 aborts, nothing written
    hb = json.loads((tmp_path / "logs" / "heartbeat.json").read_text())
    assert hb["rc"] == 2 and "ALERT" in (tmp_path / "logs" / "alerts.log").read_text()
    assert not (tmp_path / "data" / "paper" / "state.json").exists()
    with StepLock(tmp_path / "data" / "paper"):
        assert cli.live_step_all() == 3  # lock busy -> rc 3


def test_health_heartbeat_halt_duration_and_alert(
    env: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    from engine.track import commands as tc
    from engine.track.health import heartbeat_check, ledger_checks

    root = env["root"]
    (root / "logs").mkdir()
    (root / "logs" / "heartbeat.json").write_text(json.dumps({"ts": NOW1.isoformat(), "rc": 0}))
    assert heartbeat_check(root, NOW1 + pd.Timedelta(hours=5))[0].status == "FAIL"
    assert heartbeat_check(root, NOW1 + pd.Timedelta(minutes=30))[0].status == "OK"
    d = env["dir"]
    d.mkdir(parents=True)
    (d / "state.json").write_text(json.dumps({"qty": {}, "killed": False}))
    rows = [
        {"logged_at": (NOW1 + pd.Timedelta(hours=i)).isoformat(), "halt": True, "reasons": ["x"]}
        for i in range(8)
    ]
    (d / "signals.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    checks = ledger_checks(root, env["v"], NOW1 + pd.Timedelta(hours=8))
    assert any(c.name.endswith("halted") and c.status == "FAIL" for c in checks)
    monkeypatch.setattr(tc, "running_versions", lambda r: [env["v"]])
    assert tc.health_cmd(root, alert=True, send=False) == 1
    assert (root / "logs" / "health.json").exists() and (root / "logs" / "alerts.log").exists()


def test_run_step_script_propagates_exit_code_and_logs_utc() -> None:
    ps = (REAL_ROOT / "deploy" / "run_step.ps1").read_text(encoding="utf-8")
    assert "exit $rc" in ps and "$LASTEXITCODE" in ps and "ToUniversalTime" in ps
    assert "--frozen --no-sync" in ps and "Get-Date -Format u" not in ps


# --------------------------------------------------------------------------- O5 crontab install
def test_oracle_crontab_line_survives_empty_crontab(tmp_path: Path) -> None:
    import shutil
    import subprocess

    bash = shutil.which("bash")
    if not bash:
        pytest.skip("bash not available")
    sh = (REAL_ROOT / "deploy" / "oracle_setup.sh").read_text(encoding="utf-8")
    line = next(x for x in sh.splitlines() if x.startswith("{ crontab -l"))
    assert "|| true" in line and "flock -n" in sh and "timeout 50m" in sh and "--frozen" in sh

    def posix(p: Path) -> str:  # git-bash on Windows wants /c/... (a "C:" breaks PATH)
        x = p.as_posix()
        return f"/{x[0].lower()}{x[2:]}" if len(x) > 1 and x[1] == ":" else x

    stub = tmp_path / "crontab"
    store = tmp_path / "table"
    stub.write_text(
        f'#!/usr/bin/env bash\nif [ "$1" = "-l" ]; then [ -f "{store.as_posix()}" ] && '
        f'cat "{store.as_posix()}" || exit 1; else cat > "{store.as_posix()}"; fi\n',
        newline="\n",
    )
    stub.chmod(0o755)
    script = (
        f'set -euo pipefail\nexport PATH="{posix(tmp_path)}:$PATH"\nSTEP="2 * * * * step engine live step"\n'
        f'HEALTH="20 * * * * engine health"\n{line}\n'
    )
    r = subprocess.run([bash, "-c", script], capture_output=True, text=True, timeout=60)
    if r.returncode != 0 and "crontab" in r.stderr:
        pytest.skip(f"stub crontab not runnable here: {r.stderr[:200]}")
    assert r.returncode == 0, r.stderr
    assert "engine live step" in store.read_text() and "engine health" in store.read_text()


# --------------------------------------------------------------------------- O7 / O18 feed failure policy
@pytest.mark.parametrize("status", [451, 403, 418])
def test_fatal_status_not_retried(status: int) -> None:
    m = Market(NOW1, status=status)
    with pytest.raises(feed_mod.FatalFeedError):
        feed_mod.get_json(m, feed_mod.KLINE_URL["spot"], {"symbol": "BTCUSDT"}, retries=4)  # type: ignore[arg-type]
    assert len(m.calls) == 1


def test_retry_after_400_codes_and_deadline(monkeypatch: pytest.MonkeyPatch) -> None:
    waits: list[float] = []
    monkeypatch.setattr(feed_mod.time, "sleep", waits.append)

    class S:
        def __init__(self, resps: list[Resp]) -> None:
            self.resps = resps

        def get(self, url: str, params: dict[str, Any], timeout: float) -> Resp:
            return self.resps.pop(0)

    ok = feed_mod.get_json(S([Resp({}, 429, {"Retry-After": "3"}), Resp([1])]), "u", {})  # type: ignore[arg-type]
    assert ok == [1] and waits == [3.0]
    with pytest.raises(feed_mod.SymbolNotFound):
        feed_mod.get_json(S([Resp({}, 400, text='{"code":-1121,"msg":"Invalid symbol."}')]), "u", {})  # type: ignore[arg-type]
    with pytest.raises(feed_mod.FeedError) as e:
        feed_mod.get_json(S([Resp({}, 400, text='{"code":-1100,"msg":"Illegal characters"}')]), "u", {})  # type: ignore[arg-type]
    assert not isinstance(e.value, feed_mod.SymbolNotFound)
    with pytest.raises(feed_mod.DeadlineExceeded):
        feed_mod.get_json(S([Resp({}, 500)] * 4), "u", {}, deadline=feed_mod.Deadline(1.0))  # type: ignore[arg-type]
    with pytest.raises(feed_mod.DeadlineExceeded):
        feed_mod.get_json(S([Resp([1])]), "u", {}, deadline=feed_mod.Deadline(-1))  # type: ignore[arg-type]


def test_fatal_feed_aborts_before_any_mutation(env: dict[str, Any]) -> None:
    _step(env, NOW1)
    d = env["dir"]
    before = (
        (d / "state.json").read_bytes(),
        (d / "fills.jsonl").read_bytes() if (d / "fills.jsonl").exists() else b"",
    )
    with pytest.raises(feed_mod.FatalFeedError):
        cli.live_step(version=env["v"], now=NOW2, session=Market(NOW2, status=451))
    assert (d / "state.json").read_bytes() == before[0]


# --------------------------------------------------------------------------- O8 ensemble
def _toy(n: int = 60) -> Any:
    from engine.contracts import Dataset, MarketData

    idx = pd.date_range("2026-01-01", periods=n, freq="h", tz="UTC", name="ts")
    px = pd.DataFrame({"BTC": np.linspace(100, 110, n), "ETH": np.linspace(50, 52, n)}, index=idx)

    def md() -> MarketData:
        return MarketData(
            open=px,
            high=px * 1.01,
            low=px * 0.99,
            close=px,
            volume=px * 0 + 1e6,
            quote_volume=px * 0 + 1e10,
            is_filled=px < 0,
        )

    return Dataset(spot=md(), perp=md(), funding=pd.DataFrame(columns=["BTC", "ETH"], dtype=float))


def _cost() -> Any:
    from engine.costs import CostModel

    return CostModel(fee_bps={"spot": 10.0, "perp": 5.0}, half_spread_bps={"default": 2.0}, impact_y=0.0)


def _sig(t: pd.Timestamp, btc: float = 0.4) -> Any:
    from engine.live.signals_live import LiveSignal

    return LiveSignal(
        asof=t,
        sleeves={"trend": {"spot": {}, "perp": {"BTC": btc, "ETH": -0.2}}},
        decided_at={"trend": str(t)},
        combined={"spot": {}, "perp": {"BTC": btc / 2, "ETH": -0.1}},
        allocation={"trend": 0.5},
    )


def _calibrate(paper: Path, t_end: pd.Timestamp, beta: float, n: int = 60, vid: str | None = None) -> None:
    from engine.monitor._io import append_jsonl

    preds, res = [], []
    for i in range(n):
        ts = t_end - pd.Timedelta(hours=n + 2 - i)
        w = 0.4 if i % 2 else -0.3
        sid = f"s{i}"
        preds.append(
            {
                "signal_id": sid,
                "model_id": f"{vid}/sleeve.trend" if vid else "sleeve.trend",
                "asset": "BTC",
                "timestamp": ts.isoformat(),
                "expiry": (ts + pd.Timedelta(hours=1)).isoformat(),
                "features": {"weight": w},
                "direction": 1 if w > 0 else -1,
                "expected_return": 0.0,
                "confidence": float("nan"),
            }
        )
        res.append({"signal_id": sid, "realized_return": beta * w})
    append_jsonl(paper / "predictions.jsonl", preds)
    append_jsonl(paper / "resolutions.jsonl", res)


def test_ensemble_uncalibrated_holds_current_book(tmp_path: Path) -> None:
    from engine.live.ensemble_hook import apply_ensemble

    d = _toy()
    t = d.perp.close.index[-1]
    cur = {"spot": {}, "perp": {"BTC": 0.1}}
    tgt, rec = apply_ensemble(
        {},
        _sig(t),
        d,
        t,
        t + pd.Timedelta(hours=1),
        10_000.0,
        10_000.0,
        False,
        [],
        RiskLimits(),
        _cost(),
        tmp_path,
        current=cur,
    )
    assert tgt == cur and rec["mode"] == "shadow" and rec["no_trade"]


def test_ensemble_calibrated_unchanged_target_never_vetoed_and_edge_passes(tmp_path: Path) -> None:
    from engine.live.ensemble_hook import apply_ensemble

    d = _toy()
    t = d.perp.close.index[-1]
    _calibrate(tmp_path, t, beta=0.01)
    cur = {"spot": {}, "perp": {"BTC": 0.2, "ETH": -0.1}}
    cfg = {"no_trade": {"min_adv_quote": 0.0}}
    tgt, rec = apply_ensemble(
        cfg,
        _sig(t),
        d,
        t,
        t + pd.Timedelta(hours=1),
        10_000.0,
        10_000.0,
        False,
        [],
        RiskLimits(),
        _cost(),
        tmp_path,
        current=cur,
    )
    assert rec["mode"] == "active" and rec["no_trade"] == {} and tgt == cur
    # a weight increase in the forecast direction with a big expected return over 24h passes the gate
    tgt2, rec2 = apply_ensemble(
        cfg,
        _sig(t, btc=0.8),
        d,
        t,
        t + pd.Timedelta(hours=1),
        10_000.0,
        10_000.0,
        False,
        [],
        RiskLimits(),
        _cost(),
        tmp_path,
        current=cur,
    )
    assert tgt2["perp"]["BTC"] == pytest.approx(0.4) and "BTC" not in rec2["no_trade"]
    # negative beta: the same change is vetoed -> HOLD at the current weight, never flat
    p2 = tmp_path / "neg"
    _calibrate(p2, t, beta=-0.01)
    tgt3, rec3 = apply_ensemble(
        cfg,
        _sig(t, btc=0.8),
        d,
        t,
        t + pd.Timedelta(hours=1),
        10_000.0,
        10_000.0,
        False,
        [],
        RiskLimits(),
        _cost(),
        p2,
        current=cur,
    )
    assert tgt3["perp"]["BTC"] == pytest.approx(0.2) and "BTC" in rec3["no_trade"]


def test_ensemble_stale_age_measured_from_bar_close(tmp_path: Path) -> None:
    from engine.live.ensemble_hook import apply_ensemble

    d = _toy()
    t = d.perp.close.index[-1]
    _calibrate(tmp_path, t, beta=0.01)
    now = t + pd.Timedelta(hours=2.5)  # 1.5h after the bar CLOSE: fresh (limit 2h)
    tgt, rec = apply_ensemble(
        {"no_trade": {"min_adv_quote": 0.0}},
        _sig(t, btc=0.8),
        d,
        t,
        now,
        10_000.0,
        10_000.0,
        False,
        [],
        RiskLimits(),
        _cost(),
        tmp_path,
        current={"spot": {}, "perp": {"BTC": 0.2, "ETH": -0.1}},
    )
    assert "stale_data" not in json.dumps(rec["no_trade"])


def test_marginal_edge_continuation_costs_nothing() -> None:
    from engine.ensemble.edge import MarketState, marginal_edge

    ms = MarketState(cost_model=_cost(), market="perp", price=100.0, adv_quote=1e12)
    assert marginal_edge(0.0, 0.3, 0.3, 1e5, ms, "BTC", 24) == (0.0, 0.0)
    net, cost = marginal_edge(0.01, 0.0, 0.1, 1e5, ms, "BTC", 24)
    assert cost == pytest.approx((5 + 2) * 1e-4) and net == pytest.approx(0.01 - cost)


def test_ensemble_ignored_for_legacy_versions_and_live_hash_pinning(tmp_path: Path) -> None:
    from engine.track.versions import VersionError, freeze_version, live_params_hash, load_version

    for vid in ("v001", "v002"):  # legacy hashes unchanged by the new fields
        v = load_version(REAL_ROOT, vid)
        assert v.live_hash == ""
    live = {
        "risk": {"max_drawdown": 0.2},
        "paper": {"dir": "x", "min_trade_frac": 0.001},
        "ensemble": {"enabled": True},
    }
    assert live_params_hash(live) == live_params_hash(
        {**live, "paper": {"dir": "y", "min_trade_frac": 0.001}}
    )
    v3 = freeze_version(
        tmp_path,
        "t",
        "h",
        {"strategies": {"trend": {"enabled": True}}},
        ["BTC"],
        vid="v003",
        live_cfg=live,
        now=NOW1,
    )
    assert v3.live_hash == live_params_hash(live)
    assert load_version(tmp_path, "v003").check_live(live) == v3.live_hash
    with pytest.raises(VersionError):
        v3.check_live({**live, "ensemble": {"enabled": False}})
    raw = (tmp_path / "config" / "versions" / "v003.yaml").read_text().replace(v3.live_hash, "0" * 16)
    (tmp_path / "config" / "versions" / "v003.yaml").write_text(raw)
    with pytest.raises(VersionError):
        load_version(tmp_path, "v003")


def test_live_step_stamps_live_hash_and_rev(env: dict[str, Any]) -> None:
    _step(env, NOW1)
    sig = _rows(env["dir"], "signals.jsonl")[-1]
    assert len(sig["live_hash"]) == 16 and sig["code_rev"] and sig["step_id"]


# --------------------------------------------------------------------------- O9 resolve
def test_resolve_refuses_stale_exit_prices(tmp_path: Path) -> None:
    from engine.monitor.ledger import Ledger, resolve
    from engine.research.contract import Prediction

    led = Ledger(tmp_path)
    t = pd.Timestamp("2026-10-10 09:00", tz="UTC")
    led.append(
        [
            Prediction(
                timestamp=t,
                asset="BTC",
                model_id="m",
                horizon_hours=1,
                expected_return=0.0,
                direction=1,
                confidence=math.nan,
                uncertainty=0.0,
                risk=0.0,
            )
        ],
        {"BTC": 60_000.0},
    )
    stale = pd.Series([50_000.0], index=pd.DatetimeIndex([pd.Timestamp("2026-08-31", tz="UTC")]))
    assert resolve(led, {"BTC": stale}, t + pd.Timedelta(days=1)) == []
    fresh = pd.Series([61_000.0], index=pd.DatetimeIndex([t + pd.Timedelta(hours=1)]))
    rows = resolve(led, {"BTC": fresh}, t + pd.Timedelta(days=1))
    assert len(rows) == 1 and rows[0]["exit_price"] == 61_000.0


# --------------------------------------------------------------------------- O10 leaderboard keys
def test_leaderboard_reads_registry_schema_and_namespaced_live_ids(tmp_path: Path) -> None:
    from engine.monitor import leaderboard as lb

    reg = tmp_path / "r.jsonl"
    reg.write_text(
        json.dumps(
            {
                "id": "EXP-000001",
                "model_version": "tsmom",
                "hypothesis_id": "H-0001",
                "results": {"oos_sharpe": 0.8},
                "decision": "WATCH",
            }
        )
        + "\n"
    )
    rows = lb.load_registry(reg)
    assert list(rows) == ["tsmom|H-0001"] and rows["tsmom|H-0001"]["exp_id"] == "EXP-000001"
    assert lb.live_model_id("v002", "trend") == "v002/sleeve.trend"
    df = lb.build(
        rows,
        pd.DataFrame(columns=["model_id"]),
        {"v001/sleeve.trend": {"state": "ACTIVE"}},
        links={"v001/sleeve.trend": ["tsmom|H-0001"]},
    )
    live = df[df["model_id"] == "v001/sleeve.trend"].iloc[0]
    assert live["exp_id"] == "EXP-000001" and live["oos_sharpe"] == pytest.approx(0.8)
    assert len(df) == 2


# --------------------------------------------------------------------------- O11 stale pending order
def test_stale_pending_order_is_cancelled_not_filled(tmp_path: Path) -> None:
    d = _toy()
    lg = PaperLedger(tmp_path, 10_000.0)
    lg.set_pending(d.perp.close.index[10], {"spot": {}, "perp": {"BTC": 0.5}})
    assert lg.fill_pending(d, _cost(), max_lag_bars=1) == []
    assert lg.missed and lg.missed["bars_late"] == 48 and lg.state.pending is None
    lg.set_pending(d.perp.close.index[-2], {"spot": {}, "perp": {"BTC": 0.5}})
    assert len(lg.fill_pending(d, _cost(), max_lag_bars=1)) == 1  # normal next-bar fill


# --------------------------------------------------------------------------- O12 secrets
def test_telegram_errors_are_redacted_and_long_messages_split() -> None:
    class S:
        def __init__(self) -> None:
            self.n = 0

        def post(self, url: str, **k: Any) -> Resp:
            self.n += 1
            return Resp({}, 400)

    env_ = {"TELEGRAM_BOT_TOKEN": "123:SECRET", "TELEGRAM_CHAT_ID": "1"}
    with pytest.raises(telegram.SendError) as e:
        telegram.maybe_send("hi", True, env=env_, session=S())  # type: ignore[arg-type]
    assert "SECRET" not in str(e.value)
    assert "SECRET" not in telegram.redact("https://api.telegram.org/bot123:SECRET/sendMessage", env_)
    parts = telegram.split_message("\n".join(["x" * 100] * 100))
    assert len(parts) == 3 and all(len(p) <= 4000 for p in parts)
    assert "\n".join(parts) == "\n".join(["x" * 100] * 100)


# --------------------------------------------------------------------------- O13 lock + host
def test_lock_prevents_overlapping_steps(env: dict[str, Any]) -> None:
    env["dir"].mkdir(parents=True)
    with StepLock(env["dir"]), pytest.raises(LockBusy):
        _step(env, NOW1)
    _step(env, NOW1)  # released -> runs


def test_host_mismatch_refused_until_adopted(env: dict[str, Any]) -> None:
    _step(env, NOW1)
    st = json.loads((env["dir"] / "state.json").read_text())
    st["host"] = "some-other-machine"
    (env["dir"] / "state.json").write_text(json.dumps(st))
    with pytest.raises(cli.HostMismatch):
        _step(env, NOW2)


# --------------------------------------------------------------------------- O14 health book
def test_reinstate_restores_multiplier_atomic_save_and_fail_closed(tmp_path: Path) -> None:
    from engine.live.ensemble_hook import HealthUnreadable, apply_ensemble, health_multipliers
    from engine.monitor.health import HealthBook, load_rules

    hb = HealthBook(tmp_path, load_rules(REAL_ROOT / "config" / "health_rules.yaml"))
    hb._save({"sleeve.trend": {"state": "RESEARCH", "size_multiplier": 0.0}})
    hb.reinstate("sleeve.trend", NOW1, "reviewed")
    assert hb.states()["sleeve.trend"]["size_multiplier"] == pytest.approx(0.4)
    assert not (tmp_path / "model_health.json.tmp").exists()
    (tmp_path / "model_health.json").write_text("{torn")
    with pytest.raises(HealthUnreadable):
        health_multipliers(tmp_path, ["trend"])
    d = _toy()
    t = d.perp.close.index[-1]
    cur = {"spot": {}, "perp": {"BTC": 0.3}}
    tgt, rec = apply_ensemble(
        {}, _sig(t), d, t, t, 1e4, 1e4, False, [], RiskLimits(), _cost(), tmp_path, current=cur
    )
    assert tgt == cur and "unreadable" in rec["reason"]


# --------------------------------------------------------------------------- O15 bar cache
def test_bar_cache_avoids_refetching_history(tmp_path: Path) -> None:
    m1 = Market(NOW1)
    r1 = feed_mod.build_live_dataset(
        m1,
        ["BTC"],
        NOW1,
        root=tmp_path / "none",
        history_days=60,  # type: ignore[arg-type]
        cache_dir=tmp_path / "cache",
    )
    m2 = Market(NOW2)
    r2 = feed_mod.build_live_dataset(
        m2,
        ["BTC"],
        NOW2,
        root=tmp_path / "none",
        history_days=60,  # type: ignore[arg-type]
        cache_dir=tmp_path / "cache",
    )
    kl = [c for c in m2.calls if c[0] != feed_mod.FUNDING_URL]
    assert len(kl) == 2 and all(
        p["startTime"] == int((NOW2.floor("h") - pd.Timedelta(hours=1)).value // 10**6) for _, p in kl
    )
    assert r2.last_bar == r1.last_bar + pd.Timedelta(hours=1)
    assert (
        r2.data.perp.close["BTC"].notna().sum() == r1.data.perp.close["BTC"].notna().sum() + 1 - 1
        or r2.data.perp.close["BTC"].notna().sum() >= r1.data.perp.close["BTC"].notna().sum()
    )


def test_parse_klines_checks_close_time() -> None:
    cur = int(NOW1.floor("h").value // 1_000_000)
    row = [cur - H, "1", "1", "1", "1", "1", int(NOW1.value // 1_000_000) + 5, "1", 1]  # close in future
    assert feed_mod.parse_klines([row], NOW1).empty


# --------------------------------------------------------------------------- O19 bounded reads
def test_day_start_equity_kept_in_state(tmp_path: Path) -> None:
    lg = PaperLedger(tmp_path, 100.0)
    day = pd.Timestamp("2026-10-09", tz="UTC")
    lg.mark(day - pd.Timedelta(hours=1), {})
    lg.state.cash = 90.0
    lg.mark(day + pd.Timedelta(hours=1), {})
    assert lg.state.day_start == {"day": day.isoformat(), "equity": 100.0}
    assert lg.day_start_equity(day + pd.Timedelta(hours=5)) == 100.0
    lg.mark(day + pd.Timedelta(hours=1), {})  # same bar again: no duplicate row
    assert len(_rows(tmp_path, "equity.jsonl")) == 2


def test_immaterial_stale_mark_does_not_disable_kill_switch() -> None:
    lim = RiskLimits()
    last = NOW1.floor("h") - pd.Timedelta(hours=1)
    rep = check_risk(
        lim, 70_000.0, 100_000.0, None, NOW1, last, [], stale_marks=["perp TON (x)"], stale_frac=0.01
    )
    assert rep.kill and not rep.valuation_stale
    rep = check_risk(
        lim, 70_000.0, 100_000.0, None, NOW1, last, [], stale_marks=["perp TON (x)"], stale_frac=0.5
    )
    assert not rep.kill and rep.valuation_stale and rep.halt
