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
# benchmark runs: one fixed judge, one frozen set of steps 1 to 3, only the implementer model changes
ap.add_argument("--provider", help="provider of --model (default: the first provider with a key)")
ap.add_argument("--executor-model", help="model for the implementer only; the other roles keep --judge-model")
ap.add_argument("--executor-provider")
ap.add_argument("--judge-model", help="model for the verifier (and steps 1 to 3 when not frozen)")
ap.add_argument("--judge-provider")
ap.add_argument("--frozen", help="folder with claim_contract.json, route.json, plan.json to reuse instead of calling steps 1 to 3")
ap.add_argument("--steps-only", action="store_true", help="stop after steps 1 to 3 (reader, router, planner): used to freeze them for the benchmark")
ap.add_argument("--inject", help="path to a JSON list of injections (see repro/injections.py)")
ap.add_argument("--label", action="append", default=[], help="key=value, stored with the run (repeatable)")
a = ap.parse_args()

if a.demo:
    demos = {d["id"]: d for d in json.loads((ROOT / "demos" / "demos.json").read_text(encoding="utf-8"))}
    d = demos[a.demo]
    a.paper, a.repo, a.hint = a.paper or d["paper"], a.repo or d.get("repo"), a.hint or d.get("target_hint")
cfg_d = {"max_cost_cny": a.max_cost, "max_wall_minutes": a.max_minutes, "max_executor_steps": a.max_steps}
if a.model:
    cfg_d["models"] = {r: {"provider": a.provider or DEFAULT_PROVIDER, "model": a.model} for r in ("reader", "router", "planner", "executor", "verifier")}
if a.judge_model:
    jp = a.judge_provider or a.provider or DEFAULT_PROVIDER
    cfg_d["models"] = {r: {"provider": jp, "model": a.judge_model} for r in ("reader", "router", "planner", "executor", "verifier")}
if a.executor_model:
    cfg_d.setdefault("models", {})["executor"] = {"provider": a.executor_provider or a.provider or DEFAULT_PROVIDER, "model": a.executor_model}
labels = dict(x.split("=", 1) for x in a.label)
spec = json.loads(Path(a.inject).read_text(encoding="utf-8")) if a.inject else None
run = Run(a.run_id or new_run_id(), a.paper, a.repo, a.hint, RunConfig.from_dict(cfg_d), demo_id=a.demo,
          injection_spec=spec, frozen_dir=a.frozen, labels=labels)
run.steps_only = a.steps_only
print("run", run.id, "->", run.dir)
meta = run.execute()
print(json.dumps({k: meta.get(k) for k in ("status", "verdict", "title", "route", "seconds")}, ensure_ascii=False))
print("cost ¥", meta["meter"]["cost_cny"])
