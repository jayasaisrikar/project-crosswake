"""Crash-safe file primitives for the PAPER ledgers (no network, no notifications).

* `append_rows`   one `write()` per batch, then flush + fsync. Before appending, a torn final line
                  (a previous write cut off by a crash / power loss) is quarantined so new rows never
                  get glued onto a fragment.
* `read_rows`     JSONL reader that tolerates ONLY a malformed *final* line: with `repair=True` the
                  fragment is moved to `<file>.torn` (append-only quarantine) and the file truncated
                  to the last good line; with `repair=False` it is skipped and reported. A malformed
                  line in the middle is real corruption -> `LedgerCorrupt`.
* `tail_rows`     read only the last `max_bytes` of a file (bounded per-step cost on growing logs).
* `atomic_write_text` tmp file + fsync + `os.replace` (survives a crash at any point).
* `StepLock`      exclusive, non-blocking lock file per ledger directory (msvcrt / fcntl) so two
                  steps (scheduler + manual run) can never mutate the same ledger at once.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import socket
import sys
import time
from pathlib import Path
from types import TracebackType
from typing import IO, Any

log = logging.getLogger(__name__)


class LedgerCorrupt(RuntimeError):
    """A malformed line that is NOT the last line: needs a human (see docs/RUNBOOK.md)."""


class LockBusy(RuntimeError):
    """Another process holds the step lock for this ledger directory."""


def _fsync(f: IO[Any]) -> None:
    f.flush()
    with contextlib.suppress(OSError):
        os.fsync(f.fileno())


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
        _fsync(f)
    for attempt in range(5):        # OneDrive / AV can hold the target open for a moment on Windows
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(0.2 * (attempt + 1))


def repair_tail(path: Path) -> str | None:
    """Quarantine a torn final line (file not ending in a newline, or a last line that is not JSON).

    Returns the quarantined fragment (None when the file was clean). Never touches earlier lines."""
    if not path.exists():
        return None
    data = path.read_bytes()
    if not data:
        return None
    body = data[:-1] if data.endswith(b"\n") else data
    cut = body.rfind(b"\n") + 1               # start of the last line
    last = data[cut:]
    torn = not data.endswith(b"\n")
    if not torn:
        try:
            json.loads(last.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            torn = bool(last.strip())
    if not torn:
        return None
    frag = last.decode("utf-8", errors="replace")
    with open(path.with_name(path.name + ".torn"), "a", encoding="utf-8") as q:
        q.write(json.dumps({"quarantined_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                            "file": path.name, "fragment": frag}) + "\n")
        _fsync(q)
    with open(path, "r+b") as f:
        f.truncate(cut)
        _fsync(f)
    log.warning("quarantined torn last line of %s -> %s.torn", path, path.name)
    print(f"[ledger] WARNING: torn last line of {path.name} quarantined to {path.name}.torn")
    return frag


def append_rows(path: Path, rows: list[dict[str, Any]], sort_keys: bool = False) -> None:
    """Append rows with ONE write, then fsync. Repairs a torn tail first."""
    if not rows:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    repair_tail(path)
    blob = "".join(json.dumps(r, default=str, sort_keys=sort_keys) + "\n" for r in rows)
    with open(path, "a", encoding="utf-8") as f:
        f.write(blob)
        _fsync(f)


def _parse(lines: list[str], path: Path, repair: bool) -> tuple[list[dict[str, Any]], list[str]]:
    out: list[dict[str, Any]] = []
    issues: list[str] = []
    idx = [i for i, x in enumerate(lines) if x.strip()]
    for k, i in enumerate(idx):
        try:
            obj = json.loads(lines[i])
        except ValueError as e:
            if k == len(idx) - 1:
                issues.append(f"{path.name}: torn last line ({e.__class__.__name__})")
                if repair:
                    repair_tail(path)
                continue
            raise LedgerCorrupt(f"{path}: malformed line {i + 1} of {len(lines)} (not the last line): "
                                f"{lines[i][:80]!r}") from e
        if isinstance(obj, dict):
            out.append(obj)
    return out, issues


def read_rows(path: Path, repair: bool = True) -> tuple[list[dict[str, Any]], list[str]]:
    """(rows, issues). Missing file -> ([], [])."""
    if not path.exists():
        return [], []
    text = path.read_text(encoding="utf-8", errors="replace")
    rows, issues = _parse(text.splitlines(), path, repair)
    if repair and not issues and text and not text.endswith("\n"):
        repair_tail(path)       # complete JSON but no newline: still a torn write (newline missing)
        issues.append(f"{path.name}: last line had no newline (quarantined)")
        rows = rows[:-1]
    return rows, issues


def tail_rows(path: Path, max_bytes: int = 4_000_000) -> list[dict[str, Any]]:
    """Rows from the last `max_bytes` of the file (the first, possibly partial, line is dropped).
    Malformed lines are skipped; this is a read-only, best-effort view for bounded per-step work."""
    if not path.exists():
        return []
    size = path.stat().st_size
    with open(path, "rb") as f:
        if size > max_bytes:
            f.seek(size - max_bytes)
            f.readline()
        chunk = f.read().decode("utf-8", errors="replace")
    out: list[dict[str, Any]] = []
    for line in chunk.splitlines():
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if isinstance(obj, dict):
            out.append(obj)
    return out


def hostname() -> str:
    return socket.gethostname() or "unknown-host"


class StepLock:
    """Exclusive non-blocking lock on `<dir>/.step.lock` for the whole step.

    The lock is held by the OS on an open file handle, so a crashed process never leaves a stale lock."""

    def __init__(self, directory: Path, name: str = ".step.lock") -> None:
        self.path = Path(directory) / name
        self._f: IO[Any] | None = None

    def acquire(self) -> StepLock:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        f = open(self.path, "a+")  # noqa: SIM115  (held open for the lock's lifetime)
        try:
            if sys.platform == "win32":
                import msvcrt

                f.seek(0)
                msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as e:
            f.close()
            raise LockBusy(f"another engine step holds {self.path}") from e
        f.seek(0)
        f.truncate()
        f.write(f"{os.getpid()} {hostname()} {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\n")
        f.flush()
        self._f = f
        return self

    def release(self) -> None:
        if self._f is None:
            return
        try:
            if sys.platform == "win32":
                import msvcrt

                self._f.seek(0)
                with contextlib.suppress(OSError):
                    msvcrt.locking(self._f.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._f.fileno(), fcntl.LOCK_UN)
        finally:
            self._f.close()
            self._f = None

    def __enter__(self) -> StepLock:
        return self.acquire()

    def __exit__(self, et: type[BaseException] | None, e: BaseException | None,
                 tb: TracebackType | None) -> None:
        self.release()
