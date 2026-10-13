"""Re-run only the verifier's audit (one model call) on a finished run, reusing its clean re-run result.
Use after changing the verifier prompt; the code is not executed again. The change is logged as events."""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from repro.config import RUNS_DIR, RunConfig  # noqa: E402
from repro.events import EventLog  # noqa: E402
from repro.llm import Meter  # noqa: E402
from repro.pipeline import Run  # noqa: E402
from repro.config import WORKSPACES_DIR  # noqa: E402

rid = sys.argv[1]
d = RUNS_DIR / rid
load = lambda n: json.loads((d / f"{n}.json").read_text(encoding="utf-8"))
meta = load("meta")
run = Run.__new__(Run)
run.id, run.dir, run.ws = rid, d, WORKSPACES_DIR / rid
run.cfg = RunConfig.from_dict(meta.get("config"))
run.log = EventLog(d / "events.jsonl")
run.log.t0 = time.time() - (meta.get("seconds") or 0)
run.meter = Meter(5, time.time() + 900)
run.ledger = load("assumption_ledger")
c, r, impl, old = load("claim_contract"), load("route"), load("implementation"), load("verdict")
run.log.emit("stage_start", stage="verifier", title="Verifier: re-audit with the revised prompt (no re-execution)")
audit, echoes = run.audit(c, impl, r, old["rerun"], old["metrics"])
new = run.decide(c, r, impl, old["rerun"], old["metrics"], audit)
print(old["verdict"], "->", new["verdict"], "|", new["reason"])
old.update({k: new[k] for k in ("verdict", "reason", "scaled_down", "flags", "gap", "measured")}, audit=audit, reaudited=True)
(d / "verdict.json").write_text(json.dumps(old, ensure_ascii=False, indent=1), encoding="utf-8")
run.log.emit("stage_end", stage="verifier", status="ok", seconds=0, meter=run.meter.snapshot())
run.log.emit("verdict", **{k: old.get(k) for k in ("verdict", "target", "measured", "gap", "flags", "scaled_down")},
             reason=new["reason"] + " (re-audit)", audit_summary=audit.get("audit_summary"),
             requirement_check=audit.get("requirement_check"), divergence_causes=audit.get("divergence_causes"))
m = meta.get("meter") or {}
m["cost_cny"] = round((m.get("cost_cny") or 0) + run.meter.cost_cny, 4)
meta.update(verdict=new["verdict"], meter=m)
(d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
run.log.emit("run_end", status=meta.get("status"), verdict=new["verdict"], seconds=meta.get("seconds"), meter=m, timings=meta.get("timings"))
print("re-audit cost ¥", round(run.meter.cost_cny, 4))
