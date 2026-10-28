"""Quick stage test: Reader + Router + Planner only (no implementation)."""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from repro.pipeline import Run, new_run_id
from repro.config import RunConfig
paper, repo, hint = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] != "-" else None), (sys.argv[3] if len(sys.argv) > 3 else None)
run = Run("stagetest-" + new_run_id(), paper, repo, hint, RunConfig())
c = run.read_paper()
print("TARGET", json.dumps(run.target(c), ensure_ascii=False)[:600])
print("TOL", c.get("tolerance"))
print("ASSUMPTIONS", len(run.ledger))
r = run.route(c)
print("ROUTE", r.get("route"), "|", r.get("why")[:300])
print("FEAS", json.dumps(r.get("feasibility"))[:500])
p = run.plan(c, r)
print("PLAN files", [f.get("path") for f in p.get("files", [])])
print("METER", run.meter.snapshot()["cost_cny"], run.timings)
