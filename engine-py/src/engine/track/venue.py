"""Daily Binance-vs-Hyperliquid close cross-check (catches a bad or frozen Binance print).

Both venues' daily candles open at 00:00 UTC. For each symbol and day, the gap in basis points
between the two perp closes is computed; days above the threshold are flagged. Read-only public
endpoints: Binance fapi klines and Hyperliquid POST /info candleSnapshot.
"""

from __future__ import annotations

import time
from typing import Any

import pandas as pd
import requests

from engine.live.feed import KLINE_URL, FeedError, get_json

HL_URL = "https://api.hyperliquid.xyz/info"
DAY = pd.Timedelta(days=1)


def hl_coin(symbol: str) -> str:
    """Binance 1000X perps are kX on Hyperliquid (1000PEPE -> kPEPE)."""
    return "k" + symbol[4:] if symbol.startswith("1000") else symbol


def binance_daily(session: requests.Session, symbol: str, days: int, now: pd.Timestamp) -> pd.Series:
    rows = get_json(session, KLINE_URL["perp"], {"symbol": f"{symbol}USDT", "interval": "1d",
                                                 "limit": days + 1})
    s = pd.Series([float(r[4]) for r in rows], dtype="float64",
                  index=pd.to_datetime([int(r[0]) for r in rows], unit="ms", utc=True))
    return s[s.index + DAY <= now]


def hl_daily(session: requests.Session, symbol: str, days: int, now: pd.Timestamp,
             retries: int = 3, timeout: float = 15.0) -> pd.Series:
    start = int((now.floor("D") - days * DAY).value // 1_000_000)
    body = {"type": "candleSnapshot", "req": {"coin": hl_coin(symbol), "interval": "1d",
                                              "startTime": start, "endTime": int(now.value // 1_000_000)}}
    last = ""
    for attempt in range(retries):
        try:
            r = session.post(HL_URL, json=body, timeout=timeout)
            r.raise_for_status()
            rows: list[dict[str, Any]] = r.json() or []
            s = pd.Series([float(c["c"]) for c in rows], dtype="float64",
                          index=pd.to_datetime([int(c["t"]) for c in rows], unit="ms", utc=True))
            return s[s.index + DAY <= now]
        except (requests.RequestException, ValueError, KeyError) as e:
            last = f"{type(e).__name__}: {e}"
            if attempt < retries - 1:
                time.sleep(2.0 ** attempt)
    raise FeedError(f"hyperliquid {symbol}: {last}")


def compare(bn: pd.Series, hl: pd.Series, threshold_bps: float) -> pd.DataFrame:
    df = pd.concat({"binance": bn, "hyperliquid": hl}, axis=1).dropna()
    df["gap_bps"] = (df["binance"] / df["hyperliquid"] - 1) * 1e4
    df["flag"] = df["gap_bps"].abs() > threshold_bps
    return df


def venue_check(session: requests.Session, symbols: list[str], now: pd.Timestamp, days: int = 30,
                threshold_bps: float = 50.0) -> dict[str, Any]:
    out: dict[str, Any] = {"asof": now.isoformat(), "days": days, "threshold_bps": threshold_bps,
                           "symbols": {}, "skipped": {}}
    for s in symbols:
        try:
            df = compare(binance_daily(session, s, days, now), hl_daily(session, s, days, now),
                         threshold_bps)
        except FeedError as e:
            out["skipped"][s] = str(e)
            continue
        if df.empty:
            out["skipped"][s] = "no overlapping days (not listed on one venue)"
            continue
        out["symbols"][s] = {
            "n_days": len(df), "median_abs_bps": float(df["gap_bps"].abs().median()),
            "max_abs_bps": float(df["gap_bps"].abs().max()),
            "flagged": [{"day": f"{d:%Y-%m-%d}", "gap_bps": round(float(g), 1)}
                        for d, g in df.loc[df["flag"], "gap_bps"].items()],
        }
    return out


def format_check(res: dict[str, Any]) -> str:
    lines = [f"Binance vs Hyperliquid daily closes, last {res['days']} days "
             f"(flag > {res['threshold_bps']:.0f} bps)"]
    for s, r in res["symbols"].items():
        flag = f"  FLAGGED {len(r['flagged'])}: " + ", ".join(f"{f['day']} {f['gap_bps']:+.0f}bps"
                                                          for f in r["flagged"][:5]) if r["flagged"] else ""
        lines.append(f"  {s:9s} days {r['n_days']:3d}  median {r['median_abs_bps']:5.1f}bps  "
                     f"max {r['max_abs_bps']:6.1f}bps{flag}")
    for s, why in res["skipped"].items():
        lines.append(f"  {s:9s} skipped: {why}")
    return "\n".join(lines)
