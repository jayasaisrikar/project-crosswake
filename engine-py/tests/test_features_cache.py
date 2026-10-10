"""D5: feature cache invalidates on code changes, survives partial writes, dedupes, locks."""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path

import pandas as pd

from engine.features import FeatureStore, get_feature
from engine.features.store import _lock, code_hash
from test_features import DATA, N  # type: ignore[import-not-found]


def test_code_change_invalidates_cache(tmp_path: Path) -> None:
    fd = get_feature("ret_24h")
    store = FeatureStore(tmp_path)
    a = store.compute(fd, DATA)

    def edited(d):  # type: ignore[no-untyped-def]
        return fd.function(d) * 2.0

    fd2 = dataclasses.replace(fd, function=edited)               # same id + version, new code
    assert code_hash(fd2) != code_hash(fd)
    b = store.compute(fd2, DATA)
    pd.testing.assert_series_equal(b["value"], a["value"] * 2.0, check_names=False)


def test_torn_write_ignored_and_no_duplicates(tmp_path: Path) -> None:
    fd = get_feature("rv_7d")
    store = FeatureStore(tmp_path)
    cut = DATA.perp.close.index[N - 100]
    store.compute(fd, DATA.truncate(cut))
    meta_p = store.path(fd).with_suffix(".meta.json")
    # simulate a crash after the parquet write of a later run: parquet replaced, meta stale
    full = FeatureStore(tmp_path / "x").compute(fd, DATA)
    full.to_parquet(store.path(fd), index=False)
    assert store._meta(fd) is None                                # sha mismatch -> cache ignored
    rec = store.compute(fd, DATA)
    assert not rec.duplicated(["asset", "timestamp"]).any()
    pd.testing.assert_frame_equal(rec.reset_index(drop=True), full.reset_index(drop=True))
    assert json.loads(meta_p.read_text(encoding="utf-8"))["parquet_sha256"]
    assert not store.path(fd).with_suffix(".lock").exists()


def test_lock_is_exclusive(tmp_path: Path) -> None:
    p = tmp_path / "f.lock"
    with _lock(p):
        assert p.exists()
        try:
            with _lock(p, timeout=0.2):
                raise AssertionError("second lock acquired")
        except TimeoutError:
            pass
    assert not p.exists()
