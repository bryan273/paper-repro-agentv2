"""Writes web/compute.json: time and hardware needs for the papers we have already run, measured from the recorded runs.

For each paper: command time = seconds spent inside `run` tool calls on the machine that made the recordings,
scaled by SPEEDUP to the reference laptop (see repro/probe.py); agent time = everything else in the run.
Papers nobody has run get their numbers from the Router (the `compute` object) once steps 1 to 3 are done.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEEDUP = 2.5   # the recording machine (22 threads) vs the reference 8-core laptop
# what the recorded code could use beyond the CPU, and rough memory and disk, judged from the recorded runs
HAND = {
    "1607.01759": dict(difficulty=2, ram_gb=4, disk_gb=2, gpu_speedup=None),
    "2601.03664": dict(difficulty=1, ram_gb=2, disk_gb=1, gpu_speedup=None),
    "2510.13311": dict(difficulty=3, ram_gb=4, disk_gb=2, gpu_speedup=None),
    "1506.02142": dict(difficulty=3, ram_gb=4, disk_gb=1, gpu_speedup=1.5),
    "2305.06142": dict(difficulty=3, ram_gb=6, disk_gb=2, gpu_speedup=4),
    "2303.13763": dict(difficulty=4, ram_gb=8, disk_gb=3, gpu_speedup=3),
    "2510.13197": dict(difficulty=5, ram_gb=8, disk_gb=6, gpu_speedup=1.5),
    "isolation-forest": dict(difficulty=2, ram_gb=2, disk_gb=1, gpu_speedup=None),
}
out = {}
for r in json.loads((ROOT / "web" / "demo-runs" / "index.json").read_text(encoding="utf-8")):
    key = r["paper"] if r["paper"] in HAND else "isolation-forest" if "icdm08b" in r["paper"] or "isolation-forest" in r["paper"] else None
    if not key:
        continue
    tool = 0.0
    for line in (ROOT / "web" / "demo-runs" / r["file"]).read_text(encoding="utf-8").splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("type") == "tool_result" and e.get("name") == "run":
            tool += e.get("seconds") or 0
    rec = out.setdefault(key, {"runs": []})
    rec["runs"].append({"total_min": round(r["seconds"] / 60, 1), "tool_min": round(tool / 60, 1), "verdict": r["verdict"]})
for key, rec in out.items():
    n = len(rec["runs"])
    tool = sum(x["tool_min"] for x in rec["runs"]) / n
    rec["compute"] = {**HAND[key], "needs_gpu": False, "vram_gb": None, "ref_minutes": round(tool * SPEEDUP, 1),
                      "basis": f"measured: {n} recorded run{'s' if n > 1 else ''}, {tool:.1f} min of commands on a fast desktop, scaled x{SPEEDUP} to the reference laptop",
                      "source": "measured"}
# papers nobody has run: the cheap triage pass of scripts/triage.py; a measured number always wins over a triage guess
for f in sorted((ROOT / "bench" / "triage").glob("*.json")) if (ROOT / "bench" / "triage").exists() else []:
    t = json.loads(f.read_text(encoding="utf-8"))
    if t["id"] in out or not t.get("compute"):
        if t["id"] in out:
            out[t["id"]].update(release=t.get("release"), suitable=t.get("suitable"))
        continue
    out[t["id"]] = {"compute": {**t["compute"], "source": "triage"}, "release": t.get("release"), "suitable": t.get("suitable"),
                    "blockers": t.get("blockers") or [], "target": (t.get("target") or {}).get("statement")}
(ROOT / "web" / "compute.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
for k, v in out.items():
    print(k, v["compute"]["difficulty"], v["compute"]["ref_minutes"])
