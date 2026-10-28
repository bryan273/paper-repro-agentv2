"""Writes bench/sleep_windows.json: the stretches when this laptop was asleep (Windows Modern Standby), from the system event log.

  python scripts/sleep_windows.py [--since 2026-10-19]

A sleeping laptop freezes every run but the wall clock keeps counting, so a run's `seconds` would include the sleep. export_bench.py subtracts the overlap.
"""
import argparse
import json
import subprocess
from datetime import datetime
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--since", default="2026-10-19")
a = ap.parse_args()
ps = ("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-Power'; Id=506,507,42,107; StartTime=[datetime]'%s'} -ErrorAction SilentlyContinue | "
      "Sort-Object TimeCreated | ForEach-Object { '{0}|{1}' -f $_.Id, ([DateTimeOffset]$_.TimeCreated).ToUnixTimeSeconds() }" % a.since)
out = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True).stdout.split()
ev = [(int(x.split("|")[0]), int(x.split("|")[1])) for x in out if "|" in x]
wins, start = [], None
for i, t in ev:
    if i in (506, 42) and start is None:
        start = t
    elif i in (507, 107) and start is not None:
        wins.append([start, t])
        start = None
merged = []
for w in wins:   # a wake and an immediate sleep again are one stretch
    if merged and w[0] - merged[-1][1] <= 30:
        merged[-1][1] = w[1]
    else:
        merged.append(w)
merged = [w for w in merged if w[1] - w[0] >= 60]
Path(__file__).resolve().parent.parent.joinpath("bench", "sleep_windows.json").write_text(json.dumps(merged), encoding="utf-8")
for s, e in merged:
    print(datetime.fromtimestamp(s).strftime("%m-%d %H:%M"), "->", datetime.fromtimestamp(e).strftime("%H:%M"), round((e - s) / 60), "min")
