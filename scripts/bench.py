"""Run a benchmark queue: every (paper, model, condition, repeat) once, a few at a time.

  python scripts/bench.py --track models --out bench/results/pilot.jsonl --parallel 3
  python scripts/bench.py --track models --condition inject:F --papers fasttext,svead --models step-3.7-flash,DeepSeek-V4.1-Flash

Track "models": the scaffold, the frozen steps 1 to 3 and the judge are the same for every run; only the
implementer model changes. Results are appended one JSON line per run, and finished jobs are skipped on a restart.
"""
import argparse
import json
import os
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BENCH = ROOT / "bench"
sys.path.insert(0, str(ROOT))

ap = argparse.ArgumentParser()
ap.add_argument("--track", default="models")
ap.add_argument("--condition", default="clean", help="clean | inject:F|O|H (a file bench/injections/<type>/<paper>.json)")
ap.add_argument("--papers", help="comma list of ids from bench/papers.json (default: all)")
ap.add_argument("--models", help="comma list (default: the pilot list in bench/models.json)")
ap.add_argument("--repeat", type=int, default=1)
ap.add_argument("--parallel", type=int, default=3)
ap.add_argument("--cores", type=int, default=7, help="CPU cores given to each run")
ap.add_argument("--max-cost", type=float, default=10.0, help="per-run cap, CNY")
ap.add_argument("--max-minutes", type=float, default=60.0)
ap.add_argument("--budget", type=float, default=150.0, help="stop starting new runs when this much CNY has been spent in this queue")
ap.add_argument("--judge", default="DeepSeek-V4.1-Flash")
ap.add_argument("--judge-provider", default="paratera")
ap.add_argument("--out", default=str(BENCH / "results" / "pilot.jsonl"))
ap.add_argument("--dry", action="store_true")
a = ap.parse_args()

papers = {p["id"]: p for p in json.loads((BENCH / "papers.json").read_text(encoding="utf-8"))}
registry = {m["id"]: m for m in json.loads((BENCH / "models.json").read_text(encoding="utf-8"))["pilot"]}
pids = a.papers.split(",") if a.papers else list(papers)
mids = a.models.split(",") if a.models else list(registry)
OUT = Path(a.out)
OUT.parent.mkdir(parents=True, exist_ok=True)
LOGS = BENCH / "logs"
LOGS.mkdir(exist_ok=True)
lock = threading.Lock()


def done_keys() -> set:
    if not OUT.exists():
        return set()
    return {json.loads(l)["key"] for l in OUT.read_text(encoding="utf-8").splitlines() if l.strip() and json.loads(l).get("status") in ("finished", "budget_exceeded")}


def spent() -> float:
    if not OUT.exists():
        return 0.0
    return sum(json.loads(l).get("cost_cny") or 0 for l in OUT.read_text(encoding="utf-8").splitlines() if l.strip())


def key_of(pid, mid, cond, rep):
    return f"{a.track}|{cond}|{pid}|{mid}|{rep}"


jobs = [(pid, mid, rep) for pid in pids for rep in range(1, a.repeat + 1) for mid in mids]
skip = done_keys()
jobs = [j for j in jobs if key_of(j[0], j[1], a.condition, j[2]) not in skip]
print(f"{len(jobs)} jobs to run ({len(skip)} already done), parallel {a.parallel}, {a.cores} cores each", flush=True)
if a.dry:
    for j in jobs:
        print(j)
    sys.exit(0)

PY = ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
PY = str(PY if PY.exists() else sys.executable)


def one(job):
    pid, mid, rep = job
    if spent() >= a.budget:
        print("budget reached, skip", job, flush=True)
        return
    p, m = papers[pid], registry.get(mid, {"provider": "paratera"})
    rid = time.strftime("%Y%m%d-%H%M%S") + f"-{pid}-{mid.replace('.', '').lower()}-{rep}"
    labels = {"bench_version": "pilot-0", "track": a.track, "condition": a.condition, "paper_id": pid, "model": mid, "provider": m["provider"],
              "judge": a.judge, "repeat": rep, "time_limit_min": a.max_minutes, "cores": a.cores, "frozen_from": p["source_run"]}
    cmd = [PY, "scripts/run.py", "--paper", p["paper"], "--hint", p["hint"], "--frozen", str(BENCH / "frozen" / pid),
           "--judge-model", a.judge, "--judge-provider", a.judge_provider, "--executor-model", mid, "--executor-provider", m["provider"],
           "--max-cost", str(a.max_cost), "--max-minutes", str(a.max_minutes), "--run-id", rid]
    if p.get("repo"):
        cmd += ["--repo", p["repo"]]
    if a.condition.startswith("inject:"):
        cmd += ["--inject", str(BENCH / "injections" / a.condition.split(":", 1)[1] / f"{pid}.json")]
    for k, v in labels.items():
        cmd += ["--label", f"{k}={v}"]
    env = dict(os.environ, REPRO_CPU_CORES=str(a.cores), PYTHONIOENCODING="utf-8")
    t0 = time.time()
    print(time.strftime("%H:%M:%S"), "start", pid, mid, flush=True)
    err = None
    try:
        with open(LOGS / f"{rid}.log", "w", encoding="utf-8") as lf:
            subprocess.run(cmd, cwd=ROOT, env=env, stdout=lf, stderr=subprocess.STDOUT, timeout=int(a.max_minutes * 60 * 1.8))
    except subprocess.TimeoutExpired:
        err = "killed: wall limit"
    rec = {"key": key_of(pid, mid, a.condition, rep), "paper_id": pid, "model": mid, "provider": m["provider"], "condition": a.condition, "repeat": rep,
           "run_id": rid, "labels": labels, "wall_s": round(time.time() - t0, 1), "error": err}
    try:
        meta = json.loads((ROOT / "runs" / rid / "meta.json").read_text(encoding="utf-8"))
        rec.update(status=meta.get("status"), verdict=meta.get("verdict"), seconds=meta.get("seconds"), cost_cny=(meta.get("meter") or {}).get("cost_cny"),
                   calls=(meta.get("meter") or {}).get("calls"), prompt_tokens=(meta.get("meter") or {}).get("prompt_tokens"),
                   completion_tokens=(meta.get("meter") or {}).get("completion_tokens"), by_role=(meta.get("meter") or {}).get("by_role"),
                   timings=meta.get("timings"), machine=meta.get("machine"))
        vp = ROOT / "runs" / rid / "verdict.json"
        if vp.exists():
            v = json.loads(vp.read_text(encoding="utf-8"))
            g = v.get("gap") or {}
            rec.update(target=(v.get("target") or {}).get("value"), measured=v.get("measured"), diff=g.get("diff"), band=g.get("band"), within=g.get("within"),
                       flags=v.get("flags"), scaled_down=v.get("scaled_down"), reason=v.get("reason"))
        inj = []
        for line in (ROOT / "runs" / rid / "events.jsonl").read_text(encoding="utf-8").splitlines():
            if '"type": "handoff"' in line:
                inj += [x for x in (json.loads(line).get("injected") or []) if x.get("ok")]
        if inj:
            rec["injected"] = inj
    except Exception as e:  # the run died before it wrote a meta file
        rec.update(status="error", error=err or f"no meta: {e}")
    with lock:
        with OUT.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(time.strftime("%H:%M:%S"), "done ", pid, mid, rec.get("status"), rec.get("verdict"), rec.get("measured"), f"{(rec.get('seconds') or 0) / 60:.0f}min", rec.get("cost_cny"), flush=True)


with ThreadPoolExecutor(a.parallel) as ex:
    list(ex.map(one, jobs))
print("all done; spent", round(spent(), 2), flush=True)
