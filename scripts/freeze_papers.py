"""Freezes steps 1 to 3 (claim contract, route, plan) of the selected papers and registers them in bench/papers.json.

  python scripts/freeze_papers.py [--parallel 4] [--limit N]

Uses the fixed judge model for all three steps, so every model later gets the same contract and plan. No code is written and no sandbox is used:
one paper costs a few tenths of a yuan. Papers that fail are written to bench/discover/freeze_failed.json and left out of the benchmark.
"""
import argparse
import json
import re
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ap = argparse.ArgumentParser()
ap.add_argument("--parallel", type=int, default=4)
ap.add_argument("--limit", type=int)
a = ap.parse_args()
sel = json.loads((ROOT / "bench" / "discover" / "selected.json").read_text(encoding="utf-8"))["papers"][: a.limit]
lock = threading.Lock()
failed = []


def slug(i: str) -> str:
    return "a" + re.sub(r"\W", "", i)


def one(p):
    s = slug(p["id"])
    fd = ROOT / "bench" / "frozen" / s
    if (fd / "plan.json").exists():
        return
    hint = (p["target"] or {}).get("statement") or ""
    run_id = "freeze-" + s
    r = subprocess.run([sys.executable, "-I", str(ROOT / "scripts" / "run.py"), "--paper", p["id"], "--hint", hint, "--judge-model", "DeepSeek-V4.1-Flash", "--judge-provider", "paratera",
                        "--max-minutes", "20", "--max-cost", "3", "--steps-only", "--run-id", run_id], capture_output=True, text=True, cwd=str(ROOT), timeout=1500)
    d = ROOT / "runs" / run_id
    need = ("claim_contract.json", "route.json", "plan.json")
    if not all((d / n).exists() for n in need):
        with lock:
            failed.append({"id": p["id"], "tail": (r.stdout + r.stderr)[-300:]})
        print("FAILED", p["id"], flush=True)
        return
    fd.mkdir(parents=True, exist_ok=True)
    for n in need + ("assumption_ledger.json",):
        if (d / n).exists():
            (fd / n).write_bytes((d / n).read_bytes())
    print("frozen", p["id"], flush=True)


with ThreadPoolExecutor(a.parallel) as ex:
    list(ex.map(one, sel))
pj = ROOT / "bench" / "papers.json"
papers = json.loads(pj.read_text(encoding="utf-8"))
have = {x["id"] for x in papers}
for p in sel:
    s = slug(p["id"])
    if s in have or not (ROOT / "bench" / "frozen" / s / "plan.json").exists():
        continue
    route = json.loads((ROOT / "bench" / "frozen" / s / "route.json").read_text(encoding="utf-8")).get("route")
    links = p.get("code_links") or []
    papers.append({"id": s, "paper": p["id"], "repo": links[0] if links and route != "paper_only" else None, "hint": (p["target"] or {}).get("statement"), "title": p["title"],
                   "route": route, "source_run": "freeze-" + s, "source_seconds": None, "source_verdict": None, "set": "v2"})
pj.write_text(json.dumps(papers, ensure_ascii=False, indent=1), encoding="utf-8")
(ROOT / "bench" / "discover" / "freeze_failed.json").write_text(json.dumps(failed, ensure_ascii=False, indent=1), encoding="utf-8")
print("frozen", len(sel) - len(failed), "failed", len(failed))
