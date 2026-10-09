"""Point-in-time symbol discovery for Binance USDT-M perpetuals (survivorship-bias control).

Source: the public S3 bucket behind data.binance.vision (ListObjects XML API, the same endpoint
the data.binance.vision web index uses):
  https://s3-ap-northeast-1.amazonaws.com/data.binance.vision?delimiter=/&prefix=<prefix>
Delisted contracts keep their archive folders, so this lists every perp EVER listed, not only
the ones alive today.

Steps (run `uv run python -m engine.data.listings`):
  1. discover_perp_symbols(): all USDT-quoted perps, minus stablecoin bases and leveraged tokens,
     with first/last available monthly 1d-kline file  -> data/cleaned/listings.json
  2. download monthly 1d perp klines for every listed symbol (small) -> data/raw/universe_1d/
  3. select_candidates(): union over month ends 2020-01..end of the top-K symbols by trailing
     30-day perp quote volume (using only data <= that month end)
  4. download 1h spot + perp + funding for the candidates via engine.data.download.download_all
     and clean them via engine.data.clean.clean_all into data/cleaned/ (contracts.py layout).
"""

from __future__ import annotations

import argparse
import io
import json
import logging
import re
import xml.etree.ElementTree as ET
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import pandas as pd

from engine.data import clean as clean_mod
from engine.data import download as dl

log = logging.getLogger(__name__)

S3_LIST_URL = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision"
PERP_KLINE_PREFIX = "data/futures/um/monthly/klines/"
_NS = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}

QUOTE = "USDT"
STABLE_BASES = frozenset({
    "USDC", "BUSD", "TUSD", "FDUSD", "DAI", "USDP", "PAX", "UST", "USTC", "SUSD", "GUSD", "EUR",
    "USDE", "USD1", "PYUSD", "AEUR", "EURI", "XUSD", "BFUSD", "USDS", "RLUSD",
})
_LEVERAGED = re.compile(r".+(UP|DOWN|BULL|BEAR)$")
_MONTH_RE = re.compile(r"-(\d{4}-\d{2})\.zip$")


def _list(prefix: str) -> tuple[list[str], list[str]]:
    """All (common_prefixes, keys) under prefix, following S3 pagination."""
    prefixes: list[str] = []
    keys: list[str] = []
    marker = ""
    while True:
        url = f"{S3_LIST_URL}?delimiter=/&prefix={prefix}&marker={marker}"
        r = dl._get(url)
        if r is None:
            break
        root = ET.fromstring(r.content)
        prefixes += [e.text or "" for e in root.findall("s3:CommonPrefixes/s3:Prefix", _NS)]
        keys += [e.text or "" for e in root.findall("s3:Contents/s3:Key", _NS)]
        if (root.findtext("s3:IsTruncated", default="false", namespaces=_NS)) != "true":
            break
        nxt = root.findtext("s3:NextMarker", default="", namespaces=_NS) or (keys or prefixes)[-1]
        if nxt == marker:
            break
        marker = nxt
    return prefixes, keys


def classify_pair(pair: str) -> str | None:
    """Return the base symbol if pair is an eligible USDT-M perp, else None.

    Excludes: non-USDT quote, dated (delivery) contracts, stablecoin bases, leveraged tokens.
    """
    if "_" in pair or not pair.endswith(QUOTE):
        return None
    base = pair[: -len(QUOTE)]
    if not base or base in STABLE_BASES or _LEVERAGED.fullmatch(base):
        return None
    return base


def discover_perp_symbols(workers: int = 16) -> dict[str, dict[str, Any]]:
    """{base: {pair, first_month, last_month, n_months}} for every eligible perp ever listed."""
    prefixes, _ = _list(PERP_KLINE_PREFIX)
    pairs = sorted({p[len(PERP_KLINE_PREFIX):].strip("/") for p in prefixes})
    eligible = {pair: base for pair in pairs if (base := classify_pair(pair))}
    log.info("%d pairs listed, %d eligible", len(pairs), len(eligible))

    def months_of(pair: str) -> list[str]:
        _, keys = _list(f"{PERP_KLINE_PREFIX}{pair}/1d/")
        return sorted({m.group(1) for k in keys if (m := _MONTH_RE.search(k))})

    with ThreadPoolExecutor(max_workers=workers) as ex:
        months = dict(zip(eligible, ex.map(months_of, list(eligible)), strict=True))
    out: dict[str, dict[str, Any]] = {}
    for pair, base in eligible.items():
        ms = months[pair]
        if not ms:
            continue
        out[base] = {"pair": pair, "first_month": ms[0], "last_month": ms[-1], "n_months": len(ms),
                     "months": ms}
    return out


def download_daily(listings: dict[str, dict[str, Any]], raw_root: Path, workers: int = 16
                   ) -> list[dl.FileResult]:
    """Monthly 1d perp klines for every listed month of every symbol (checksum-verified)."""
    tasks = []
    for base, info in listings.items():
        for period in info["months"]:
            rel = dl._MONTHLY_PATH["perp"].format(pair=info["pair"], interval="1d", period=period)
            tasks.append(("perp", base, period, f"{dl.BASE_URL}/{rel}", raw_root / base / Path(rel).name))
    with ThreadPoolExecutor(max_workers=workers) as ex:
        return list(ex.map(lambda t: dl._fetch_one(*t), tasks))


def daily_quote_volume(raw_root: Path) -> pd.DataFrame:
    """Wide daily perp quote volume (index = UTC day open, columns = base symbols)."""
    cols: dict[str, pd.Series] = {}
    for d in sorted(p for p in raw_root.iterdir() if p.is_dir()):
        frames = []
        for z in sorted(d.glob("*.zip")):
            with zipfile.ZipFile(io.BytesIO(z.read_bytes())) as zf:
                frames.append(clean_mod.parse_kline_csv(zf.read(zf.namelist()[0]).decode()))
        frames = [f for f in frames if not f.empty]
        if not frames:
            continue
        df = pd.concat(frames).drop_duplicates("ts").set_index("ts").sort_index()
        cols[d.name] = df["quote_volume"].astype(float)
    return pd.DataFrame(cols).sort_index()


def select_candidates(qv_daily: pd.DataFrame, top_k: int = 30, start: str = "2020-01",
                      end: str | None = None, adv_days: int = 30, min_history_days: int = 0,
                      ) -> tuple[list[str], dict[str, list[str]]]:
    """Union of top_k by trailing adv_days quote volume at every month end (data <= month end).

    With min_history_days > 0 only symbols first traded >= that many days before the month end
    are ranked. That makes the union an exact superset of what pit_universe_mask can select for
    top_n <= top_k and min_history_days >= this value (monthly rebalance, same ADV window).
    """
    first_seen = qv_daily.notna().idxmax().where(qv_daily.notna().any())
    roll = qv_daily.rolling(adv_days, min_periods=1).sum()
    last = (pd.Period(end, "M").end_time.normalize().tz_localize("UTC") if end
            else qv_daily.index[-1])
    ends = pd.date_range(pd.Timestamp(start + "-01", tz="UTC"), last, freq="ME")
    per_month: dict[str, list[str]] = {}
    for me in ends:
        hist = roll.loc[:me]
        if hist.empty:
            continue
        row = hist.iloc[-1]
        # stale guard: symbol must have traded within the last 3 days of the window
        alive = qv_daily.loc[me - pd.Timedelta(days=3):me].notna().any()
        seasoned = first_seen <= me - pd.Timedelta(days=min_history_days)
        row = row[alive.reindex(row.index, fill_value=False) & seasoned.reindex(row.index, fill_value=False)
                  & (row > 0)]
        per_month[me.strftime("%Y-%m")] = list(row.nlargest(top_k).index)
    cands = sorted({s for v in per_month.values() for s in v})
    return cands, per_month


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--raw", default="data/raw")
    ap.add_argument("--out", default="data/cleaned")
    ap.add_argument("--start", default="2020-01")
    ap.add_argument("--end", default=None)
    ap.add_argument("--top-k", type=int, default=30)
    ap.add_argument("--min-history-days", type=int, default=60)
    ap.add_argument("--skip-hourly", action="store_true")
    ap.add_argument("--skip-discovery", action="store_true", help="reuse data/raw/universe_1d")
    ap.add_argument("--extra", nargs="*", default=[], help="symbols always included (e.g. legacy universe)")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    raw, out = Path(a.raw), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    d1 = raw / "universe_1d"
    if a.skip_discovery:
        prev = json.loads((out / "listings.json").read_text(encoding="utf-8"))
        listings = prev["symbols"]
    else:
        listings = discover_perp_symbols()
        res = download_daily(listings, d1)
        log.info("1d files: %s", pd.Series([r.status for r in res]).value_counts().to_dict())
    qv = daily_quote_volume(d1)
    cands, per_month = select_candidates(qv, a.top_k, a.start, a.end,
                                         min_history_days=a.min_history_days)
    payload = {
        "source": S3_LIST_URL + "?prefix=" + PERP_KLINE_PREFIX,
        "generated_at": pd.Timestamp.now(tz="UTC").isoformat(),
        "n_symbols": len(listings),
        "n_active_last_month": sum(1 for v in listings.values()
                                   if v["last_month"] == max(x["last_month"] for x in listings.values())),
        "symbols": {k: {kk: vv for kk, vv in v.items() if kk != "months"} for k, v in listings.items()},
        "candidate_rule": f"top {a.top_k} by trailing-30d perp quote volume at any month end "
                          f"{a.start}..{a.end or 'latest'}, among symbols listed >= "
                          f"{a.min_history_days} days",
        "candidates": cands,
        "top_by_month": per_month,
    }
    (out / "listings.json").write_text(json.dumps(payload, indent=1), encoding="utf-8")
    log.info("listed=%d candidates=%d", len(listings), len(cands))
    if a.skip_hourly:
        return
    syms = sorted(set(cands) | set(a.extra))
    months = dl.month_range(a.start, a.end)
    results = dl.download_all(syms, months, raw_root=raw)
    log.info("1h files: %s", pd.Series([r.status for r in results]).value_counts().to_dict())
    clean_mod.clean_all(syms, raw_root=raw, out_root=out)


if __name__ == "__main__":
    main()
