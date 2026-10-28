"""Machine probe and time estimate. Standalone (standard library; numpy and torch are used when present).

  python probe.py                      # print what this machine is and how fast it is
  python probe.py compute.json 60      # ... and say whether a paper with these needs fits in 60 minutes

`compute` is the object the Router writes (see repro/prompts.py):
  difficulty 1..5, needs_gpu, vram_gb, ram_gb, disk_gb,
  ref_minutes  = command time (install, download, every run, the clean re-run) on a reference laptop
                 (8 CPU cores, 16 GB RAM, no GPU), not the time spent writing code,
  gpu_speedup  = how many times faster the same runs are on a mid GPU (RTX 3060 class), or null.

The estimate is rough on purpose. It adds the time the agent spends thinking and writing code (a measured
8 to 27 minutes on 10 recorded runs) to the command time scaled by how fast this machine is. web/fit.js
holds the same numbers for the viewer; tests/test_core.py checks the two agree.
"""
from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import sys
import time

# float32 matrix multiply under numpy, GFLOPS, of the reference laptop (8 CPU cores). Calibrated on the machine that
# produced our recorded runs: it reads about 175 on this probe and is about 2.5 times faster than the reference.
G_REF_CPU = 70.0
G_REF_GPU = 9.0     # same, TFLOPS, of a mid GPU (RTX 3060 class)


def overhead_minutes(difficulty: float) -> float:
    """Minutes the agent spends reading, writing code and fixing it, whatever the machine."""
    return 8.0 + 3.0 * float(difficulty or 3)


def estimate(compute: dict | None, cpu_gflops: float, gpu_tflops: float | None = None, vram_gb: float | None = None,
             ram_gb: float | None = None, disk_gb: float | None = None) -> dict:
    """Total minutes for one run on a machine with these measured speeds. Pure function, no I/O."""
    c = compute or {}
    ref = c.get("ref_minutes")
    if ref is None:
        return {"known": False, "reason": "the Router gave no compute estimate for this paper"}
    d = c.get("difficulty") or 3
    ov = overhead_minutes(d)
    paths = {}
    if not c.get("needs_gpu"):
        paths["cpu"] = ov + ref / max(cpu_gflops / G_REF_CPU, 0.05)
    need_vram = c.get("vram_gb")
    if gpu_tflops and c.get("gpu_speedup") and (need_vram is None or vram_gb is None or vram_gb >= need_vram):
        paths["gpu"] = ov + ref / max(float(c["gpu_speedup"]) * gpu_tflops / G_REF_GPU, 0.05)
    problems = []
    if c.get("needs_gpu") and "gpu" not in paths:
        problems.append("needs a GPU" + (f" with {need_vram} GB of memory" if need_vram else "") + " and this machine has none that qualifies")
    if c.get("ram_gb") and ram_gb and ram_gb < c["ram_gb"]:
        problems.append(f"needs {c['ram_gb']} GB RAM, this machine has {ram_gb}")
    if c.get("disk_gb") and disk_gb and disk_gb < c["disk_gb"]:
        problems.append(f"needs {c['disk_gb']} GB of disk, {disk_gb} free")
    if not paths or problems:
        return {"known": True, "feasible": False, "problems": problems or ["no way to run this on this machine"], "difficulty": d}
    path = min(paths, key=paths.get)
    m = paths[path]
    return {"known": True, "feasible": True, "path": path, "minutes": round(m, 1), "low": round(m * 0.6, 1), "high": round(m * 1.8, 1),
            "difficulty": d, "agent_overhead": round(ov, 1), "paths": {k: round(v, 1) for k, v in paths.items()}}


def tier(compute: dict | None) -> str | None:
    """Light / Medium / Heavy, judged on the reference laptop so it does not depend on who looks."""
    e = estimate(compute, G_REF_CPU)
    if not e.get("known"):
        return None
    if not e.get("feasible"):
        return "heavy"
    return "light" if e["minutes"] <= 30 else "medium" if e["minutes"] <= 90 else "heavy"


def decide(est: dict, limit_min: float) -> dict:
    """What the agent should do: go, go with checkpoints, scale down, or stop before downloading anything."""
    if not est.get("known"):
        return {"decision": "go_carefully", "why": "no estimate; keep every command short and watch the clock"}
    if not est.get("feasible"):
        return {"decision": "stop_too_big", "why": "; ".join(est["problems"])}
    if est["high"] <= limit_min:
        return {"decision": "go", "why": f"about {est['minutes']} min (up to {est['high']}) fits in {limit_min:g} min"}
    if est["minutes"] <= limit_min:
        return {"decision": "go_with_checkpoints", "why": f"about {est['minutes']} min but up to {est['high']}: save partial results early, stop starting new work at 90% of the limit"}
    if est["low"] <= limit_min:
        return {"decision": "scale_down", "why": f"about {est['minutes']} min is over the {limit_min:g} min limit: shrink seeds, data or epochs and say so (scaled_down=true)"}
    return {"decision": "stop_too_big", "why": f"about {est['minutes']} min (at best {est['low']}) is far over the {limit_min:g} min limit; post could_not_run with this reason before downloading anything big"}


# ---------------------------------------------------------------------------------------------- probing
def _ram_gb() -> float | None:
    try:
        import psutil
        return round(psutil.virtual_memory().total / 2**30, 1)
    except Exception:
        pass
    try:
        if os.name == "nt":
            import ctypes

            class MS(ctypes.Structure):
                _fields_ = [("l", ctypes.c_ulong), ("m", ctypes.c_ulong), ("total", ctypes.c_ulonglong)] + [(f"x{i}", ctypes.c_ulonglong) for i in range(5)]
            s = MS()
            s.l = ctypes.sizeof(MS)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(s))
            return round(s.total / 2**30, 1)
        if sys.platform == "darwin":
            return round(int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=5).stdout) / 2**30, 1)
        with open("/proc/meminfo") as f:
            return round(int(f.readline().split()[1]) / 2**20, 1)
    except Exception:
        return None


def _gpu() -> dict:
    out = {"name": None, "vram_gb": None, "kind": None}
    if shutil.which("nvidia-smi"):
        try:
            r = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10).stdout.strip().splitlines()
            if r:
                name, mem = [x.strip() for x in r[0].split(",")[:2]]
                out.update(name=name, vram_gb=round(float(mem) / 1024, 1), kind="cuda")
        except Exception:
            pass
    if not out["kind"] and sys.platform == "darwin" and platform.machine() == "arm64":
        out.update(name="Apple Silicon GPU (MPS)", vram_gb=None, kind="mps")
    return out


def _cpu_gflops() -> float:
    try:
        import numpy as np
        n = 1536
        a = np.random.rand(n, n).astype("float32")
        a @ a
        t = time.time()
        k = 0
        while time.time() - t < 2.0 or k < 3:
            a @ a
            k += 1
        return round(k * 2 * n**3 / (time.time() - t) / 1e9, 1)
    except Exception:
        # no numpy: a crude pure Python loop, scaled so that it is clearly "slow" rather than wrong
        t = time.time()
        s = 0.0
        for i in range(2_000_000):
            s += i * 0.5
        return round(2e6 * 2 / (time.time() - t) / 1e9 * 25, 2)


def _gpu_tflops(kind: str | None) -> float | None:
    if not kind:
        return None
    try:
        import torch
        dev = "cuda" if kind == "cuda" and torch.cuda.is_available() else "mps" if kind == "mps" and torch.backends.mps.is_available() else None
        if not dev:
            return None
        x = torch.rand(4096, 4096, device=dev)
        for _ in range(3):
            x @ x
        sync = torch.cuda.synchronize if dev == "cuda" else torch.mps.synchronize
        sync()
        t = time.time()
        for _ in range(10):
            x @ x
        sync()
        return round(10 * 2 * 4096**3 / (time.time() - t) / 1e12, 2)
    except Exception:
        return None


def probe() -> dict:
    g = _gpu()
    du = shutil.disk_usage(os.getcwd())
    gt = _gpu_tflops(g["kind"])
    return {"os": f"{platform.system()} {platform.release()}", "python": platform.python_version(), "cpu_cores": os.cpu_count(),
            "ram_gb": _ram_gb(), "disk_free_gb": round(du.free / 2**30, 1), "gpu": g["name"], "gpu_kind": g["kind"], "vram_gb": g["vram_gb"],
            "cpu_gflops": _cpu_gflops(), "gpu_tflops": gt, "gpu_usable": gt is not None}


if __name__ == "__main__":
    m = probe()
    out = {"machine": m}
    if len(sys.argv) > 1:
        compute = json.load(open(sys.argv[1], encoding="utf-8")) if os.path.exists(sys.argv[1]) else json.loads(sys.argv[1])
        compute = compute.get("compute", compute) if isinstance(compute, dict) else compute
        limit = float(sys.argv[2]) if len(sys.argv) > 2 else 60.0
        est = estimate(compute, m["cpu_gflops"], m["gpu_tflops"], m["vram_gb"], m["ram_gb"], m["disk_free_gb"])
        out.update(estimate=est, tier=tier(compute), limit_min=limit, **decide(est, limit))
    print(json.dumps(out, ensure_ascii=False))
