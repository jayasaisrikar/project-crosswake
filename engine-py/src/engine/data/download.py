"""Download Binance public archive (data.binance.vision) monthly zips, verified by sha256.

Layout: data/raw/{spot|perp|funding}/{SYM}/<original zip name>, plus data/raw/manifest.json.
Monthly zips are preferred; daily zips are used only for the final month when its monthly file
is not yet published. A 404 means "not listed" (recorded, not an error).
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import threading
import time
import zipfile
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime
from pathlib import Path

import requests

log = logging.getLogger(__name__)

BASE_URL = "https://data.binance.vision"
KINDS = ("spot", "perp", "funding")
_MONTHLY_PATH = {
    "spot": "data/spot/monthly/klines/{pair}/{interval}/{pair}-{interval}-{period}.zip",
    "perp": "data/futures/um/monthly/klines/{pair}/{interval}/{pair}-{interval}-{period}.zip",
    "funding": "data/futures/um/monthly/fundingRate/{pair}/{pair}-fundingRate-{period}.zip",
}
_DAILY_PATH = {
    "spot": "data/spot/daily/klines/{pair}/{interval}/{pair}-{interval}-{period}.zip",
    "perp": "data/futures/um/daily/klines/{pair}/{interval}/{pair}-{interval}-{period}.zip",
}

_local = threading.local()


def _session() -> requests.Session:
    s = getattr(_local, "session", None)
    if s is None:
        s = requests.Session()
        s.headers["User-Agent"] = "engine-backtest-research/0.1"
        _local.session = s
    return s


@dataclass
class FileResult:
    kind: str
    symbol: str
    period: str
    url: str
    path: str | None
    status: str  # "ok" | "cached" | "missing" | "error"
    sha256: str | None = None
    rows: int | None = None
    ts_unit: str | None = None
    downloaded_at: str | None = None
    error: str | None = None


def month_range(start: str, end: str | None, today: date | None = None) -> list[str]:
    """Inclusive list of YYYY-MM. end=None -> last complete month."""
    today = today or datetime.now(UTC).date()
    if end is None:
        y, m = today.year, today.month - 1
        if m == 0:
            y, m = y - 1, 12
        end = f"{y:04d}-{m:02d}"
    sy, sm = map(int, start.split("-"))
    ey, em = map(int, end.split("-"))
    out: list[str] = []
    while (sy, sm) <= (ey, em):
        out.append(f"{sy:04d}-{sm:02d}")
        sm += 1
        if sm == 13:
            sy, sm = sy + 1, 1
    return out


def _get(url: str, retries: int = 5, timeout: float = 60.0) -> requests.Response | None:
    """GET with retries/backoff. Returns None on 404."""
    delay = 1.0
    for attempt in range(retries):
        try:
            r = _session().get(url, timeout=timeout)
            if r.status_code == 404:
                return None
            if r.status_code in (429, 418) or r.status_code >= 500:
                raise requests.HTTPError(f"HTTP {r.status_code}")
            r.raise_for_status()
            return r
        except (requests.RequestException, OSError) as exc:
            if attempt == retries - 1:
                raise
            log.debug("retry %s after %s", url, exc)
            time.sleep(delay)
            delay = min(delay * 2, 30.0)
    return None


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def inspect_zip(data: bytes) -> tuple[int, str | None]:
    """Count data rows and detect timestamp unit (ms/us) from the first data row."""
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        name = zf.namelist()[0]
        text = zf.read(name).decode("utf-8", errors="replace")
    rows = 0
    unit: str | None = None
    for line in text.splitlines():
        if not line.strip():
            continue
        first = line.split(",", 1)[0].strip()
        if not first.isdigit():
            continue  # header
        rows += 1
        if unit is None:
            unit = "us" if int(first) >= 10**15 else "ms"
    return rows, unit


def _fetch_one(kind: str, symbol: str, period: str, url: str, dest: Path) -> FileResult:
    res = FileResult(kind=kind, symbol=symbol, period=period, url=url, path=None, status="error")
    sidecar = dest.with_suffix(dest.suffix + ".sha256")
    if dest.exists() and sidecar.exists():
        data = dest.read_bytes()
        digest = sidecar.read_text().split()[0]
        if sha256_bytes(data) == digest:
            res.status, res.path, res.sha256 = "cached", str(dest), digest
            res.rows, res.ts_unit = inspect_zip(data)
            return res
    try:
        chk = _get(url + ".CHECKSUM")
        if chk is None:
            res.status = "missing"
            return res
        expected = chk.text.split()[0].strip().lower()
        r = _get(url)
        if r is None:
            res.status = "missing"
            return res
        data = r.content
        digest = sha256_bytes(data)
        if digest != expected:
            res.error = f"checksum mismatch {digest} != {expected}"
            return res
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(".part")
        tmp.write_bytes(data)
        tmp.replace(dest)
        sidecar.write_text(f"{digest}  {dest.name}\n")
        res.status, res.path, res.sha256 = "ok", str(dest), digest
        res.rows, res.ts_unit = inspect_zip(data)
        res.downloaded_at = datetime.now(UTC).isoformat()
    except Exception as exc:  # noqa: BLE001 - recorded in manifest
        res.error = repr(exc)
    return res


def _days_in_month(period: str) -> list[str]:
    y, m = map(int, period.split("-"))
    today = datetime.now(UTC).date()
    out = []
    for d in range(1, 32):
        try:
            day = date(y, m, d)
        except ValueError:
            break
        if day < today:
            out.append(day.isoformat())
    return out


def download_all(
    symbols: Iterable[str],
    months: list[str],
    kinds: Iterable[str] = KINDS,
    raw_root: str | Path = "data/raw",
    quote: str = "USDT",
    interval: str = "1h",
    workers: int = 8,
) -> list[FileResult]:
    raw = Path(raw_root)
    tasks: list[tuple[str, str, str, str, Path]] = []
    for kind in kinds:
        for sym in symbols:
            pair = f"{sym}{quote}"
            for period in months:
                rel = _MONTHLY_PATH[kind].format(pair=pair, interval=interval, period=period)
                tasks.append((kind, sym, period, f"{BASE_URL}/{rel}", raw / kind / sym / Path(rel).name))

    results: list[FileResult] = []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(_fetch_one, *t) for t in tasks]
        for f in as_completed(futs):
            results.append(f.result())

        # Daily fallback for the final month only, when its monthly file is missing.
        last = months[-1] if months else None
        fallback = [
            r for r in results
            if r.period == last and r.status == "missing" and r.kind in _DAILY_PATH
            and _has_earlier(results, r)
        ]
        dfuts = []
        for r in fallback:
            pair = f"{r.symbol}{quote}"
            for day in _days_in_month(r.period):
                rel = _DAILY_PATH[r.kind].format(pair=pair, interval=interval, period=day)
                dest = raw / r.kind / r.symbol / "daily" / Path(rel).name
                dfuts.append(ex.submit(_fetch_one, r.kind, r.symbol, day, f"{BASE_URL}/{rel}", dest))
        for f in as_completed(dfuts):
            results.append(f.result())

    results.sort(key=lambda r: (r.kind, r.symbol, r.period))
    write_manifest(results, raw / "manifest.json")
    return results


def _has_earlier(results: list[FileResult], r: FileResult) -> bool:
    """Only fall back to daily if the series existed in the previous month (still listed)."""
    return any(
        x.kind == r.kind and x.symbol == r.symbol and x.period < r.period and x.status in ("ok", "cached")
        for x in results
    )


def write_manifest(results: list[FileResult], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    summary: dict[str, dict[str, int]] = {}
    for r in results:
        key = f"{r.kind}/{r.symbol}"
        summary.setdefault(key, {"ok": 0, "cached": 0, "missing": 0, "error": 0})[r.status] += 1
    payload = {
        "source": BASE_URL,
        "generated_at": datetime.now(UTC).isoformat(),
        "summary": summary,
        "files": [asdict(r) for r in results if r.status != "missing"],
        "missing": [f"{r.kind}/{r.symbol}/{r.period}" for r in results if r.status == "missing"],
    }
    path.write_text(json.dumps(payload, indent=1))
