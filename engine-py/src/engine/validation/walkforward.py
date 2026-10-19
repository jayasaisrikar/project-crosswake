"""Walk-forward splitting, holdout lock and append-only experiment registry."""

from __future__ import annotations

import hashlib
import json
import subprocess
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, TypeVar

import numpy as np
import pandas as pd

Split = tuple[np.ndarray, np.ndarray]


def _ts(x: Any, tz: Any) -> pd.Timestamp:
    t = pd.Timestamp(x)
    if tz is not None and t.tzinfo is None:
        t = t.tz_localize(tz)
    elif tz is None and t.tzinfo is not None:
        t = t.tz_convert(None)
    return t


def walk_forward_splits(
    index: pd.DatetimeIndex,
    train_months: int,
    test_months: int,
    embargo_bars: int,
    end: Any = None,
) -> list[Split]:
    """Rolling walk-forward folds as positional index arrays (train_idx, test_idx).

    Test windows are consecutive calendar-month blocks after an initial train window. Train is the
    `train_months` before the test start, purged of: the `embargo_bars` bars immediately before the
    test (gap) and the `embargo_bars` bars after every earlier test window. Test never extends past `end`.
    """
    idx = pd.DatetimeIndex(index)
    if len(idx) == 0:
        return []
    if not idx.is_monotonic_increasing:
        raise ValueError("index must be sorted")
    last = idx[-1] if end is None else min(idx[-1], _ts(end, idx.tz))
    # calendar arithmetic on months (tz-aware safe: UTC has no DST)
    test_start = idx[0] + pd.DateOffset(months=train_months)
    pos = np.arange(len(idx))
    splits: list[Split] = []
    prev_test_ends: list[int] = []
    while test_start <= last:
        test_end = test_start + pd.DateOffset(months=test_months)  # exclusive
        te_mask = (idx >= test_start) & (idx < test_end) & (idx <= last)
        test_idx = pos[te_mask]
        if len(test_idx) == 0:
            break
        first_test = int(test_idx[0])
        tr_mask = (idx >= test_start - pd.DateOffset(months=train_months)) & (idx < test_start)
        tr_mask &= pos < first_test - embargo_bars
        for pe in prev_test_ends:
            tr_mask &= ~((pos > pe) & (pos <= pe + embargo_bars))
        train_idx = pos[tr_mask]
        if len(train_idx):
            splits.append((train_idx, test_idx))
        prev_test_ends.append(int(test_idx[-1]))
        test_start = test_end
    return splits


class HoldoutViolation(RuntimeError):
    pass


T = TypeVar("T", pd.DataFrame, pd.Series)


class HoldoutLock:
    """Guards data at/after holdout_start. Each unlock is permanently logged to a JSONL file."""

    def __init__(self, holdout_start: Any, log_path: str | Path = "experiments/holdout_log.jsonl") -> None:
        self.holdout_start = pd.Timestamp(holdout_start)
        if self.holdout_start.tzinfo is None:
            self.holdout_start = self.holdout_start.tz_localize("UTC")
        self.log_path = Path(log_path)
        self._unlocked = False

    @property
    def unlocked(self) -> bool:
        return self._unlocked

    def prior_views(self) -> list[dict[str, Any]]:
        """Earlier unlocks of THIS holdout window (same holdout_start)."""
        if not self.log_path.exists():
            return []
        rows = [json.loads(x) for x in self.log_path.read_text(encoding="utf-8").splitlines() if x.strip()]
        return [r for r in rows if pd.Timestamp(r.get("holdout_start")) == self.holdout_start]

    def reserve(self, params_hash: str, acknowledge_reuse: bool = False) -> int:
        """One-use rule. The same rules (params_hash) may never be scored on the same window twice;
        a window already viewed by other rules needs acknowledge_reuse and is then labelled
        contaminated. Returns the number of earlier views."""
        prior = self.prior_views()
        if any(r.get("params_hash") == params_hash for r in prior):
            raise HoldoutViolation(f"rules {params_hash} were already evaluated on the holdout starting "
                                   f"{self.holdout_start:%Y-%m-%d}; a second look is not out-of-sample")
        if prior and not acknowledge_reuse:
            raise HoldoutViolation(
                f"holdout starting {self.holdout_start:%Y-%m-%d} was already viewed {len(prior)} time(s). "
                "It is no longer unseen data. Pass --acknowledge-reuse to run anyway (the report is "
                "stamped CONTAMINATED), or judge new rules on live paper data instead.")
        return len(prior)

    def unlock(self, reason: str, params_hash: str = "", prior_views: int = 0) -> None:
        if not reason or not reason.strip():
            raise ValueError("an unlock reason is required")
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        rec = {
            "timestamp": datetime.now(UTC).isoformat(),
            "reason": reason,
            "holdout_start": self.holdout_start.isoformat(),
            "params_hash": params_hash,
            "contaminated": prior_views > 0,
        }
        with self.log_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
        self._unlocked = True

    def lock(self) -> None:
        self._unlocked = False

    def _cut(self, tz: Any) -> pd.Timestamp:
        return _ts(self.holdout_start, tz) if tz is not None else self.holdout_start.tz_convert(None)

    def check(self, obj: pd.DataFrame | pd.Series | pd.DatetimeIndex) -> None:
        """Raise HoldoutViolation if obj touches the holdout while locked."""
        if self._unlocked:
            return
        idx = obj if isinstance(obj, pd.DatetimeIndex) else pd.DatetimeIndex(obj.index)
        if len(idx) and idx.max() >= self._cut(idx.tz):
            raise HoldoutViolation(
                f"data reaches {idx.max()} >= holdout_start {self.holdout_start}; unlock() explicitly"
            )

    def read(self, obj: T) -> T:
        """Return obj after enforcing the lock (raises if it contains holdout data while locked)."""
        self.check(obj)
        return obj

    def dev_only(self, obj: T) -> T:
        """Slice obj to strictly before holdout_start (always allowed)."""
        cut = self._cut(pd.DatetimeIndex(obj.index).tz)
        return obj.loc[obj.index < cut]


def _git_sha() -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True, timeout=5, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    return out.stdout.strip() or None


def params_hash(params: dict[str, Any]) -> str:
    blob = json.dumps(params, sort_keys=True, default=str).encode()
    return hashlib.sha256(blob).hexdigest()[:16]


def _jsonable(v: Any) -> Any:
    if isinstance(v, (np.floating, np.integer)):
        return v.item()
    if isinstance(v, (pd.Timestamp, pd.Timedelta, datetime)):
        return str(v)
    if isinstance(v, float) and not np.isfinite(v):
        return None
    return v


class ExperimentRegistry:
    """Append-only JSONL log of every backtest run (used for the DSR trial count)."""

    def __init__(self, path: str | Path = "experiments/registry.jsonl") -> None:
        self.path = Path(path)

    def log(
        self,
        strategy: str,
        params: dict[str, Any],
        metrics: dict[str, Any],
        data_hash: str | None = None,
        run_id: str | None = None,
    ) -> dict[str, Any]:
        rec = {
            "id": run_id or uuid.uuid4().hex[:12],
            "timestamp": datetime.now(UTC).isoformat(),
            "strategy": strategy,
            "params_hash": params_hash(params),
            "params": params,
            "data_hash": data_hash,
            "git_sha": _git_sha(),
            "metrics": {k: _jsonable(v) for k, v in metrics.items()},
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, default=str) + "\n")
        return rec

    def records(self, strategy: str | None = None) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        out = []
        with self.path.open(encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    rec = json.loads(line)
                    if strategy is None or rec.get("strategy") == strategy:
                        out.append(rec)
        return out

    def all_trial_sharpes(self, strategy: str, key: str = "sharpe") -> list[float]:
        vals = [r["metrics"].get(key) for r in self.records(strategy)]
        return [float(v) for v in vals if v is not None]
