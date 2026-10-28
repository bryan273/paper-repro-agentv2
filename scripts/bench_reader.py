"""Step 1 on its own: how well does each model read a paper and write the claim contract?

  python scripts/bench_reader.py [--papers a,b] [--models x,y]

Only the Reader runs (no code, no sandbox work), so one cell costs a few cents and about two minutes. Each contract is compared with the
reference contract of the pilot (bench/frozen/<paper>): the same match target, the same paper value, a tolerance of the same size.
The reference contracts come from the recorded runs; the audit of those runs checked the paper value against the PDF.
"""
import argparse
import json
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from repro.config import ModelChoice, RunConfig  # noqa: E402
from repro.pipeline import Run  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--papers")
ap.add_argument("--models")
ap.add_argument("--parallel", type=int, default=3)
ap.add_argument("--out", default=str(ROOT / "bench" / "results" / "reader.jsonl"))
a = ap.parse_args()
BENCH = ROOT / "bench"
papers = {p["id"]: p for p in json.loads((BENCH / "papers.json").read_text(encoding="utf-8"))}
models = {m["id"]: m for m in json.loads((BENCH / "models.json").read_text(encoding="utf-8"))["pilot"]}
pids = a.papers.split(",") if a.papers else list(papers)
mids = a.models.split(",") if a.models else list(models)
OUT = Path(a.out)
lock = threading.Lock()
done = {json.loads(l)["key"] for l in OUT.read_text(encoding="utf-8").splitlines() if l.strip()} if OUT.exists() else set()


def target_of(c):
    mt = c.get("match_target") or {}
    cl = next((x for x in c.get("claims", []) if x.get("id") == mt.get("claim_id")), {})
    return mt.get("claim_id"), cl.get("value"), (c.get("tolerance") or {}).get("value")


def close(x, y, rel):
    try:
        return abs(float(x) - float(y)) <= rel * max(abs(float(y)), 1e-9)
    except (TypeError, ValueError):
        return False


def one(job):
    pid, mid = job
    p = papers[pid]
    key = f"reader|{pid}|{mid}"
    if key in done:
        return
    ref = json.loads((BENCH / "frozen" / pid / "claim_contract.json").read_text(encoding="utf-8"))
    rcid, rval, rtol = target_of(ref)
    rid = time.strftime("%Y%m%d-%H%M%S") + f"-reader-{pid}-{mid.replace('.', '').lower()}"
    cfg = RunConfig.from_dict({"models": {"reader": {"provider": models[mid]["provider"], "model": mid}}, "max_cost_cny": 3.0, "max_wall_minutes": 15})
    run = Run(rid, p["paper"], p.get("repo"), p["hint"], cfg)
    t0 = time.time()
    rec = {"key": key, "paper_id": pid, "model": mid, "run_id": rid}
    try:
        c = run.read_paper()
        cid, val, tol = target_of(c)
        (BENCH / "reader").mkdir(exist_ok=True)
        (BENCH / "reader" / f"{pid}-{mid}.json").write_text(json.dumps(c, ensure_ascii=False, indent=1), encoding="utf-8")
        rec.update(ok=True, same_claim=cid == rcid, value_ok=close(val, rval, 0.001), tolerance_ok=close(tol, rtol, 0.35) if rtol else None,
                   value=val, ref_value=rval, tolerance=tol, ref_tolerance=rtol, n_requirements=len(c.get("requirements") or []),
                   ref_requirements=len(ref.get("requirements") or []), n_claims=len(c.get("claims") or []), ref_claims=len(ref.get("claims") or []))
    except Exception as e:
        rec.update(ok=False, error=str(e)[:300])
    rec.update(seconds=round(time.time() - t0, 1), cost_cny=round(run.meter.cost_cny, 4), calls=run.meter.calls)
    with lock:
        with OUT.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(time.strftime("%H:%M:%S"), pid, mid, "ok" if rec.get("ok") else "FAIL", "value" if rec.get("value_ok") else "-", rec["seconds"], "s", rec["cost_cny"], flush=True)


OUT.parent.mkdir(parents=True, exist_ok=True)
with ThreadPoolExecutor(a.parallel) as ex:
    list(ex.map(one, [(p, m) for p in pids for m in mids]))
