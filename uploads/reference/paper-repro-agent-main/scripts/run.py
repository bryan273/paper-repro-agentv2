"""Run one reproduction from the command line.

  python scripts/run.py --paper 1607.01759 --repo https://github.com/facebookresearch/fastText --hint "Table 1, AG News, bigram"
  python scripts/run.py --demo fasttext
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from repro.config import DEFAULT_PROVIDER, ROOT, RunConfig  # noqa: E402
from repro.pipeline import Run, new_run_id  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--paper")
ap.add_argument("--repo")
ap.add_argument("--hint")
ap.add_argument("--demo")
ap.add_argument("--model", help="one model for every role, e.g. DeepSeek-V4-Flash")
ap.add_argument("--max-cost", type=float)
ap.add_argument("--max-minutes", type=float)
ap.add_argument("--max-steps", type=int)
ap.add_argument("--run-id")
a = ap.parse_args()

if a.demo:
    demos = {d["id"]: d for d in json.loads((ROOT / "demos" / "demos.json").read_text(encoding="utf-8"))}
    d = demos[a.demo]
    a.paper, a.repo, a.hint = a.paper or d["paper"], a.repo or d.get("repo"), a.hint or d.get("target_hint")
cfg_d = {"max_cost_cny": a.max_cost, "max_wall_minutes": a.max_minutes, "max_executor_steps": a.max_steps}
if a.model:
    cfg_d["models"] = {r: {"provider": DEFAULT_PROVIDER, "model": a.model} for r in ("reader", "router", "planner", "executor", "verifier")}
run = Run(a.run_id or new_run_id(), a.paper, a.repo, a.hint, RunConfig.from_dict(cfg_d), demo_id=a.demo)
print("run", run.id, "->", run.dir)
meta = run.execute()
print(json.dumps({k: meta.get(k) for k in ("status", "verdict", "title", "route", "seconds")}, ensure_ascii=False))
print("cost ¥", meta["meter"]["cost_cny"])
