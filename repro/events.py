"""Append-only event log per run. The UI tails this file, so live runs and replays use the same path."""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path


class EventLog:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self.t0 = time.time()
        self.seq = 0

    def emit(self, type_: str, **data) -> dict:
        with self._lock:
            self.seq += 1
            ev = {"seq": self.seq, "t": round(time.time() - self.t0, 3), "ts": time.time(), "type": type_, **data}
            with self.path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(ev, ensure_ascii=False, default=str) + "\n")
            return ev


def read_events(path: Path, offset: int = 0) -> tuple[list[dict], int]:
    """Read complete lines from byte offset; return events and the new offset."""
    if not path.exists():
        return [], offset
    with path.open("rb") as f:
        f.seek(offset)
        chunk = f.read()
    if not chunk:
        return [], offset
    end = chunk.rfind(b"\n")
    if end < 0:
        return [], offset
    out = []
    for line in chunk[: end + 1].splitlines():
        if line.strip():
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return out, offset + end + 1


def read_events_with_offsets(path: Path, offset: int = 0) -> list[tuple[dict, int]]:
    """Like read_events, but each event comes with the byte offset just after it (for SSE ids)."""
    if not path.exists():
        return []
    with path.open("rb") as f:
        f.seek(offset)
        chunk = f.read()
    out, pos = [], offset
    for line in chunk.splitlines(keepends=True):
        if not line.endswith(b"\n"):
            break  # partial line still being written
        pos += len(line)
        if line.strip():
            try:
                out.append((json.loads(line), pos))
            except json.JSONDecodeError:
                pass
    return out
