"""Live paper layer: mocked HTTP only, never touches the network."""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd
import pytest

from engine.contracts import Dataset, MarketData
from engine.costs import CostModel
from engine.live import telegram
from engine.live.feed import FUNDING_URL, build_live_dataset, parse_klines
from engine.live.paper import PaperLedger
from engine.live.risk import RiskLimits, check_risk, reconcile
from engine.live.signals_live import diff_weights, scale_to_gross

H = 3_600_000
NOW = pd.Timestamp("2026-10-09 12:30", tz="UTC")


def _kline(open_ms: int, px: float) -> list[Any]:
    return [open_ms, str(px), str(px + 1), str(px - 1), str(px), "10", open_ms + H - 1, "1000", 5,
            "0", "0", "0"]


class FakeResp:
    def __init__(self, payload: Any, status: int = 200):
        self.payload, self.status_code, self.text = payload, status, str(payload)

    def json(self) -> Any:
        return self.payload

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(self.status_code)


class FakeSession:
    """Serves klines up to and INCLUDING the current (in-progress) hour, to prove it gets dropped."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.posts: list[Any] = []

    def get(self, url: str, params: dict[str, Any], timeout: float) -> FakeResp:
        self.calls.append((url, params))
        if url == FUNDING_URL:
            t0 = int(NOW.floor("8h").value // 1_000_000) - 8 * H
            return FakeResp([{"symbol": params["symbol"], "fundingTime": t0, "fundingRate": "0.0001"}])
        start = int(params["startTime"])
        start -= start % H
        cur = int(NOW.floor("h").value // 1_000_000)
        rows = [_kline(t, 100.0 + i) for i, t in enumerate(range(start, cur + H, H))][: params["limit"]]
        return FakeResp(rows)

    def post(self, *a: Any, **k: Any) -> FakeResp:
        self.posts.append((a, k))
        return FakeResp({"ok": True})


def test_parse_klines_drops_open_bar() -> None:
    cur = int(NOW.floor("h").value // 1_000_000)
    df = parse_klines([_kline(cur - H, 1.0), _kline(cur, 2.0)], NOW)
    assert list(df["ts"]) == [NOW.floor("h") - pd.Timedelta(hours=1)]


def test_dataset_assembly_drops_open_bar(tmp_path: Any) -> None:
    sess = FakeSession()
    res = build_live_dataset(sess, ["BTC", "ETH"], NOW, root=tmp_path, history_days=5)  # type: ignore[arg-type]
    d = res.data
    last_closed = NOW.floor("h") - pd.Timedelta(hours=1)
    assert res.errors == []
    assert res.last_bar == last_closed
    for md in (d.spot, d.perp):
        assert md.close.index[-1] == last_closed
        assert NOW.floor("h") not in md.close.index
        assert list(md.close.columns) == ["BTC", "ETH"]
        assert str(md.close.index.tz) == "UTC"
        assert not md.is_filled.iloc[-1].any()
        assert md.close.notna().all().all()
    assert d.funding.notna().any().all()
    assert all(u.startswith(("https://api.binance.com", "https://fapi.binance.com")) for u, _ in sess.calls)


def _toy(n: int = 50) -> Dataset:
    idx = pd.date_range("2026-01-01", periods=n, freq="h", tz="UTC", name="ts")
    px = pd.DataFrame({"BTC": np.linspace(100, 149, n)}, index=idx)

    def md() -> MarketData:
        return MarketData(open=px - 0.5, high=px + 1, low=px - 1, close=px, volume=px * 0 + 1e6,
                          quote_volume=px * 0 + 1e8, is_filled=px < 0)

    fund = pd.DataFrame({"BTC": [0.001]}, index=pd.DatetimeIndex([idx[20]], name="ts"))
    return Dataset(spot=md(), perp=md(), funding=fund)


def _cost() -> CostModel:
    return CostModel(fee_bps={"spot": 10.0, "perp": 5.0}, half_spread_bps={"default": 2.0}, impact_y=0.0)


def test_ledger_fills_at_next_open_with_costs(tmp_path: Any) -> None:
    d = _toy()
    lg = PaperLedger(tmp_path, 10_000.0)
    lg.state.created_at = str(d.perp.close.index[0])
    dec = d.perp.close.index[10]
    lg.set_pending(dec, {"spot": {}, "perp": {"BTC": 0.5}})
    assert lg.fill_pending(d.truncate(dec), _cost()) == []      # next bar not available yet
    assert lg.state.pending is not None
    fills = lg.fill_pending(d, _cost())
    assert len(fills) == 1
    f = fills[0]
    nxt = d.perp.close.index[11]
    assert pd.Timestamp(f["ts"]) == nxt
    assert f["price"] == pytest.approx(float(d.perp.open.loc[nxt, "BTC"]))
    assert f["notional"] == pytest.approx(5_000.0)
    assert f["fee"] == pytest.approx(5_000 * 5e-4)
    assert f["spread"] == pytest.approx(5_000 * 2e-4)
    assert lg.state.cash == pytest.approx(10_000 - 5_000 - f["cost"])
    # funding event at idx[20]: long pays qty * price * rate
    paid = lg.accrue_funding(d)
    q = lg.state.qty["perp"]["BTC"]
    assert paid == pytest.approx(q * float(d.perp.close.iloc[20, 0]) * 0.001)
    assert lg.accrue_funding(d) == 0.0                           # never double counted
    trades = [x for x in lg.read_log("fills.jsonl") if x["side"] != "funding"]
    assert reconcile(lg.state.qty, trades) == []
    lg.save()
    assert PaperLedger(tmp_path).state.qty == lg.state.qty


def test_kill_switch_triggers() -> None:
    lim = RiskLimits(max_drawdown=0.2, daily_loss_limit=0.05, stale_data_hours=2)
    last = NOW.floor("h") - pd.Timedelta(hours=1)
    ok = check_risk(lim, 100.0, 100.0, 100.0, NOW, last, [])
    assert not ok.halt and not ok.kill
    dd = check_risk(lim, 79.0, 100.0, 79.5, NOW, last, [])
    assert dd.kill and dd.halt
    assert check_risk(lim, 94.0, 100.0, 100.0, NOW, last, []).halt          # daily loss
    stale = check_risk(lim, 100.0, 100.0, 100.0, NOW, last - pd.Timedelta(hours=3), [])
    assert stale.halt and not stale.kill
    assert check_risk(lim, 100.0, 100.0, 100.0, NOW, last, ["perp BTC: HTTP 500"]).halt
    assert check_risk(lim, 100.0, 100.0, 100.0, NOW, last, [], already_killed=True).kill
    w, k = scale_to_gross({"spot": {"BTC": 1.0}, "perp": {"BTC": -1.0, "ETH": 2.0}}, 2.0)
    assert k == pytest.approx(0.5)
    assert sum(abs(v) for m in w.values() for v in m.values()) == pytest.approx(2.0)
    assert reconcile({"perp": {"BTC": 1.0}}, [{"market": "perp", "symbol": "BTC", "qty": 0.5}])


def test_message_has_disclaimer() -> None:
    ch = diff_weights({"spot": {}, "perp": {"BTC": 0.2}}, {"spot": {}, "perp": {}})
    msg = telegram.format_message("2026-10-09 11:00", 1e5, {"spot": {}, "perp": {"BTC": 0.2}}, ch,
                                  ["drawdown 0%"])
    assert "not financial advice" in msg and "past performance" in msg
    assert "BTC" in msg


@pytest.mark.parametrize("send,env", [
    (False, {"TELEGRAM_BOT_TOKEN": "x", "TELEGRAM_CHAT_ID": "1"}),
    (True, {}),
    (True, {"TELEGRAM_BOT_TOKEN": "x"}),
])
def test_no_send_without_env_and_flag(send: bool, env: dict[str, str], capsys: Any) -> None:
    s = FakeSession()
    assert telegram.maybe_send("hello", send, env=env, session=s) is False  # type: ignore[arg-type]
    assert s.posts == [] and "hello" in capsys.readouterr().out


def test_send_with_env_and_flag() -> None:
    s = FakeSession()
    env = {"TELEGRAM_BOT_TOKEN": "x", "TELEGRAM_CHAT_ID": "1"}
    assert telegram.maybe_send("hello", True, env=env, session=s) is True  # type: ignore[arg-type]
    assert len(s.posts) == 1
