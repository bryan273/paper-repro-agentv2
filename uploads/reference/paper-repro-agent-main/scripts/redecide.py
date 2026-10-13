"""Recompute a finished run's verdict from its saved state (no model calls), e.g. after a rule fix."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from repro.config import RUNS_DIR  # noqa: E402
from repro.pipeline import Run  # noqa: E402

rid = sys.argv[1]
d = RUNS_DIR / rid
load = lambda n: json.loads((d / f"{n}.json").read_text(encoding="utf-8"))
c, r, impl, old = load("claim_contract"), load("route"), load("implementation"), load("verdict")
run = Run.__new__(Run)
new = run.decide(c, r, impl, old["rerun"], old["metrics"], old["audit"])
print(old["verdict"], "->", new["verdict"], "|", new["reason"])
if new["verdict"] != old["verdict"]:
    old.update({k: new[k] for k in ("verdict", "reason", "scaled_down", "flags", "gap", "measured")})
    old["redecided"] = True
    (d / "verdict.json").write_text(json.dumps(old, ensure_ascii=False, indent=1), encoding="utf-8")
    meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
    meta["verdict"] = new["verdict"]
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    # append a correction event so replays show it
    ev = [json.loads(l) for l in (d / "events.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    for e in ev:
        if e["type"] == "verdict":
            e.update(verdict=new["verdict"], reason=new["reason"] + " (recomputed after a rule fix)", scaled_down=new["scaled_down"])
        if e["type"] == "run_end":
            e["verdict"] = new["verdict"]
    (d / "events.jsonl").write_text("\n".join(json.dumps(e, ensure_ascii=False) for e in ev) + "\n", encoding="utf-8")
