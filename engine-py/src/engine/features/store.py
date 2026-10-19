"""Feature store: compute registered features, persist long records, recompute incrementally.

Record schema (one row per non-NaN value):
    feature_id, asset, timestamp (bar open t), availability_timestamp (t + 1h),
    value, source, calculation_version

Cache: data/features/{feature_id}/v{calculation_version}.parquet plus a sidecar
v{n}.meta.json = {feature_id, calculation_version, input_hash, last_ts, columns}.
input_hash is a sha256 over the feature's input panels. On compute():
  * same full input hash             -> cached records returned unchanged;
  * inputs truncated at the cached last_ts hash to the stored input_hash (history unchanged,
    only new bars appended)          -> only rows > last_ts are computed, from a slice that starts
                                        lookback_hours (+ margin) earlier, and appended;
  * anything else (revised history, new symbols, new version, edited code) -> full recompute.

input_hash also covers the feature function's source and its module's source (D5), so editing a
feature without bumping calculation_version can never serve a stale cache. Writes are atomic
(tmp file + os.replace, parquet first, meta last; the meta stores the parquet's sha256 and a cache
whose parquet does not match it is ignored), records are deduplicated on (asset, timestamp), and a
per-feature lock file serializes concurrent writers.
"""

from __future__ import annotations

import hashlib
import inspect
import json
import os
import time
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from pathlib import Path

import pandas as pd

from engine.contracts import Dataset, MarketData
from engine.features.registry import INPUTS, FeatureDef, get_feature, list_features

RECORD_COLUMNS = ("feature_id", "asset", "timestamp", "availability_timestamp", "value", "source",
                  "calculation_version")
AVAILABILITY_DELAY = pd.Timedelta(hours=1)
INCREMENTAL_MARGIN_HOURS = 24
LOCK_TIMEOUT_S = 600.0
LOCK_STALE_S = 3600.0


def code_hash(fd: FeatureDef) -> str:
    """sha256 of the feature function's source plus its module's source."""
    h = hashlib.sha256()
    for obj in (fd.function, inspect.getmodule(fd.function)):
        try:
            src = inspect.getsource(obj) if obj is not None else ""
        except (OSError, TypeError):
            src = getattr(obj, "__qualname__", repr(obj))
        h.update(src.encode("utf-8"))
    return h.hexdigest()


def _file_sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


@contextmanager
def _lock(path: Path, timeout: float = LOCK_TIMEOUT_S) -> Iterator[None]:
    """Exclusive O_EXCL lock file (no extra dependency); locks older than LOCK_STALE_S are broken."""
    path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + timeout
    while True:
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            break
        except FileExistsError:
            try:
                if time.time() - path.stat().st_mtime > LOCK_STALE_S:
                    path.unlink(missing_ok=True)
                    continue
            except FileNotFoundError:
                continue
            if time.monotonic() > deadline:
                raise TimeoutError(f"feature cache lock busy: {path}") from None
            time.sleep(0.05)
    try:
        yield
    finally:
        path.unlink(missing_ok=True)


def input_hash(fd: FeatureDef, data: Dataset) -> str:
    h = hashlib.sha256()
    h.update(f"{fd.feature_id}:{fd.calculation_version}:{code_hash(fd)}".encode())
    for name in fd.inputs:
        df = INPUTS[name](data)
        h.update(name.encode())
        h.update("|".join(map(str, df.columns)).encode())
        h.update(pd.util.hash_pandas_object(df, index=True).to_numpy().tobytes())
    return h.hexdigest()


def slice_dataset(data: Dataset, start: pd.Timestamp) -> Dataset:
    def m(md: MarketData) -> MarketData:
        return MarketData(**{k: getattr(md, k).loc[start:] for k in md.__dataclass_fields__})
    return Dataset(m(data.spot), m(data.perp), data.funding.loc[start:])


def compute_wide(fd: FeatureDef, data: Dataset) -> pd.DataFrame:
    out = fd.function(data)
    if not isinstance(out.index, pd.DatetimeIndex) or out.index.tz is None:
        raise ValueError(f"{fd.feature_id}: feature must return a tz-aware DatetimeIndex")
    return out.astype("float64")


def to_records(fd: FeatureDef, wide: pd.DataFrame) -> pd.DataFrame:
    long = wide.stack(future_stack=True).dropna()
    if long.empty:
        return empty_records()
    ts = pd.DatetimeIndex(long.index.get_level_values(0)).tz_convert("UTC").as_unit("ns")
    df = pd.DataFrame({
        "feature_id": fd.feature_id,
        "asset": long.index.get_level_values(1).astype(str),
        "timestamp": ts,
        "availability_timestamp": ts + AVAILABILITY_DELAY,
        "value": long.to_numpy(dtype="float64"),
        "source": fd.source,
        "calculation_version": fd.calculation_version,
    })
    return df.sort_values(["timestamp", "asset"], kind="mergesort").reset_index(drop=True)


def empty_records() -> pd.DataFrame:
    return pd.DataFrame({
        "feature_id": pd.Series(dtype="object"), "asset": pd.Series(dtype="object"),
        "timestamp": pd.Series(dtype="datetime64[ns, UTC]"),
        "availability_timestamp": pd.Series(dtype="datetime64[ns, UTC]"),
        "value": pd.Series(dtype="float64"), "source": pd.Series(dtype="object"),
        "calculation_version": pd.Series(dtype="int64"),
    })


def to_wide(records: pd.DataFrame) -> pd.DataFrame:
    w = records.pivot(index="timestamp", columns="asset", values="value").sort_index()
    w.columns.name = None
    return w


class FeatureStore:
    def __init__(self, root: str | Path = "data/features") -> None:
        self.root = Path(root)

    def path(self, fd: FeatureDef) -> Path:
        return self.root / fd.feature_id / f"v{fd.calculation_version}.parquet"

    def _meta_path(self, fd: FeatureDef) -> Path:
        return self.path(fd).with_suffix(".meta.json")

    def _lock_path(self, fd: FeatureDef) -> Path:
        return self.path(fd).with_suffix(".lock")

    def load(self, feature_id: str | FeatureDef) -> pd.DataFrame | None:
        fd = get_feature(feature_id) if isinstance(feature_id, str) else feature_id
        p = self.path(fd)
        return pd.read_parquet(p) if p.exists() else None

    def _meta(self, fd: FeatureDef) -> dict | None:
        p = self._meta_path(fd)
        if not p.exists():
            return None
        try:
            meta = json.loads(p.read_text(encoding="utf-8"))
        except ValueError:
            return None
        pq = self.path(fd)
        # parquet and meta must belong together (crash between the two writes -> ignore cache)
        if not isinstance(meta, dict) or not pq.exists() or meta.get("parquet_sha256") != _file_sha(pq):
            return None
        return meta

    def _save(self, fd: FeatureDef, rec: pd.DataFrame, data: Dataset, ihash: str) -> None:
        p = self.path(fd)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + ".tmp")
        rec.to_parquet(tmp, index=False)
        os.replace(tmp, p)
        idx = data.perp.close.index
        meta = {"feature_id": fd.feature_id, "calculation_version": fd.calculation_version,
                "input_hash": ihash, "code_sha256": code_hash(fd), "parquet_sha256": _file_sha(p),
                "last_ts": str(idx[-1]) if len(idx) else None,
                "inputs": list(fd.inputs), "lookback_hours": fd.lookback_hours, "n_records": len(rec)}
        mp = self._meta_path(fd)
        mtmp = mp.with_name(mp.name + ".tmp")
        mtmp.write_text(json.dumps(meta, indent=1), encoding="utf-8")
        os.replace(mtmp, mp)

    def compute(self, feature_id: str | FeatureDef, data: Dataset, *, incremental: bool = True,
                persist: bool = True) -> pd.DataFrame:
        """Return long records for the feature over `data`, using / refreshing the cache."""
        fd = get_feature(feature_id) if isinstance(feature_id, str) else feature_id
        if not persist:
            return self._compute(fd, data, incremental, persist)
        with _lock(self._lock_path(fd)):
            return self._compute(fd, data, incremental, persist)

    def _compute(self, fd: FeatureDef, data: Dataset, incremental: bool, persist: bool) -> pd.DataFrame:
        full_hash = input_hash(fd, data)
        meta = self._meta(fd) if incremental else None
        cached = self.load(fd) if meta else None
        if meta is not None and cached is not None:
            if meta["input_hash"] == full_hash:
                return cached
            last = meta.get("last_ts")
            if last is not None:
                last_ts = pd.Timestamp(last)
                if input_hash(fd, data.truncate(last_ts)) == meta["input_hash"]:
                    start = last_ts - pd.Timedelta(hours=fd.lookback_hours + INCREMENTAL_MARGIN_HOURS)
                    wide = compute_wide(fd, slice_dataset(data, start))
                    new = to_records(fd, wide.loc[wide.index > last_ts])
                    rec = pd.concat([f for f in (cached, new) if len(f)] or [empty_records()],
                                    ignore_index=True)
                    rec = rec.drop_duplicates(["asset", "timestamp"], keep="last").sort_values(
                        ["timestamp", "asset"], kind="mergesort").reset_index(drop=True)
                    if persist:
                        self._save(fd, rec, data, full_hash)
                    return rec
        rec = to_records(fd, compute_wide(fd, data))
        if persist:
            self._save(fd, rec, data, full_hash)
        return rec

    def compute_all(self, data: Dataset, feature_ids: Iterable[str] | None = None,
                    **kw: bool) -> dict[str, pd.DataFrame]:
        fds = list_features() if feature_ids is None else [get_feature(f) for f in feature_ids]
        return {fd.feature_id: self.compute(fd, data, **kw) for fd in fds}
