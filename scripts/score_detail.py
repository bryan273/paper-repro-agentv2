"""A finer score than "reproduced or not": a second, independent judge checks every requirement of the claim contract against the code.

  python scripts/score_detail.py [bench/results/pilot.jsonl]

Why: a yes/no verdict puts four models of very different quality on the same line. The detailed score has three parts, each from 0 to 1:
  accuracy  = 1 - min(1, |measured - paper| / (2 x tolerance))            how close the number is, not only whether it is inside the band
  coverage  = share of the contract's requirements the code really meets  (met = 1, partial = 0.5, missing = 0), mean of two judges
  fidelity  = 1, minus 0.5 for a serious flag (e.g. a swapped method), 0.2 for a scaled-down run, 0.3 if it did not run the right experiment
  detailed  = 0.40 accuracy + 0.35 coverage + 0.25 fidelity            (cost and time stay separate, never mixed into quality)

Judge 1 is the verifier of the run (always DeepSeek-V4.1-Flash). Judge 2 is run here, blind to the model name and to the first judge's answer, and
is never from the same lab as the model under test: GLM-5.3 normally, Kimi-K3 for runs of GLM models. Both answers are kept, so the page can show how
often they agree and whether a judge favours its own family.
"""
import json
import statistics
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from repro.config import ModelChoice  # noqa: E402
from repro.llm import Meter, chat, parse_json  # noqa: E402

PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "bench" / "results" / "pilot.jsonl"
OUT = PATH.with_name(PATH.stem + "_detail.jsonl")
SC = {"met": 1.0, "partial": 0.5, "missing": 0.0}
HIGH = {"hardcoded_constant", "echoed_paper_number", "proxy_metric", "wrong_split", "wrong_experiment", "wrong_dataset", "method_substituted", "undisclosed_scale_down"}
PROMPT = """You review the code of an AI agent that tried to reproduce a research paper. Judge ONLY what the code and its output show, not what the agent claims.

For every requirement below, decide whether the code meets it:
- "met": implemented as the requirement says;
- "partial": implemented in a different or simplified way, or only for part of the setting;
- "missing": not implemented.
Also answer "right_experiment": does the code run the experiment the target claim is about (right dataset, split, metric, protocol)?
Return ONE JSON object: {"requirements": [{"id": "R1", "status": "met|partial|missing", "why": "a short fact from the code"}], "right_experiment": bool}
"""


def judge2_for(model: str) -> ModelChoice:
    return ModelChoice("paratera", "Kimi-K3" if model.lower().startswith("glm") else "GLM-5.3")


def code_of(run_id: str, limit: int = 40000) -> str:
    ws = ROOT / "workspaces" / run_id
    parts, total = [], 0
    files = sorted(p for p in ws.glob("*.py")) + sorted(ws.glob("*/*.py"))
    skip = {"paper", "repo", ".venv", "state", "__pycache__", ".tmp", "data"}
    for p in files:
        if set(p.relative_to(ws).parts[:-1]) & skip:
            continue
        txt = p.read_text(encoding="utf-8", errors="replace")
        txt = txt if len(txt) <= 14000 else txt[:9000] + "\n...[cut]...\n" + txt[-4000:]
        if total + len(txt) > limit:
            break
        parts.append(f"=== {p.relative_to(ws).as_posix()} ===\n{txt}")
        total += len(txt)
    m = ws / "results" / "metrics.json"
    if m.exists():
        parts.append("=== results/metrics.json ===\n" + m.read_text(encoding="utf-8", errors="replace")[:4000])
    return "\n\n".join(parts)


def components(run: dict, v: dict) -> dict:
    g = v.get("gap") or {}
    band = g.get("band") or 0
    acc = None if g.get("diff") is None or not band else round(1 - min(1.0, abs(g["diff"]) / (2 * band)), 3)
    a = v.get("audit") or {}
    rc = a.get("requirement_check") or []
    cov1 = round(sum(SC.get(x.get("status"), 0) for x in rc) / len(rc), 3) if rc else None
    return {"accuracy": acc, "coverage_j1": cov1, "right_experiment_j1": a.get("right_experiment"), "flags": v.get("flags") or [], "scaled_down": bool(v.get("scaled_down"))}


lock = threading.Lock()


def one(run: dict, done: set):
    if run["run_id"] in done or not (ROOT / "runs" / run["run_id"] / "verdict.json").exists():
        return
    v = json.loads((ROOT / "runs" / run["run_id"] / "verdict.json").read_text(encoding="utf-8"))
    c = json.loads((ROOT / "runs" / run["run_id"] / "claim_contract.json").read_text(encoding="utf-8"))
    comp = components(run, v)
    reqs = [{"id": r.get("id"), "requirement": r.get("stmt")} for r in c.get("requirements", [])]
    jm = judge2_for(run["model"])
    rec = {"run_id": run["run_id"], "model": run["model"], "paper_id": run["paper_id"], "judge2": jm.model, **comp}
    try:
        user = "TARGET CLAIM: " + json.dumps((v.get("target") or {}).get("statement"), ensure_ascii=False) + "\n\nREQUIREMENTS:\n" + json.dumps(reqs, ensure_ascii=False) + "\n\nCODE:\n" + code_of(run["run_id"])
        j, last = None, None
        for attempt in range(4):   # a reasoning model now and then returns an empty or cut-off answer
            reply = chat(jm, [{"role": "system", "content": PROMPT}, {"role": "user", "content": user}], role="judge2", meter=Meter(4.0, time.time() + 900),
                         json_mode=True, max_tokens=8000, temperature=0.0 if attempt == 0 else 0.3,
                         extra_body={"thinking": {"type": "disabled"}})   # a reasoning judge spent its whole budget thinking and answered nothing
            try:
                j = parse_json(reply.content)
                break
            except Exception as e:
                last = e
        if j is None:
            raise RuntimeError(f"no valid JSON after 4 attempts: {last}")
        st = {x.get("id"): x.get("status") for x in j.get("requirements", [])}
        vals = [SC.get(st.get(r["id"]), None) for r in reqs]
        vals = [x for x in vals if x is not None]
        rec.update(coverage_j2=round(sum(vals) / len(vals), 3) if vals else None, right_experiment_j2=j.get("right_experiment"), n_scored_j2=len(vals), n_req=len(reqs))
        j1 = {x.get("id"): x.get("status") for x in (v.get("audit") or {}).get("requirement_check", [])}
        both = [(j1[i], st[i]) for i in st if i in j1]
        rec["agree"] = round(sum(a == b for a, b in both) / len(both), 3) if both else None
    except Exception as e:
        rec["judge2_error"] = str(e)[:200]
    # the parts that need no judge
    cov = [x for x in (rec.get("coverage_j1"), rec.get("coverage_j2")) if x is not None]
    rec["coverage"] = round(statistics.mean(cov), 3) if cov else None
    fid = 1.0
    if set(rec["flags"]) & HIGH:
        fid -= 0.5
    if rec["scaled_down"]:
        fid -= 0.2
    if rec.get("right_experiment_j1") is False or rec.get("right_experiment_j2") is False:
        fid -= 0.3
    rec["fidelity"] = round(max(0.0, fid), 3)
    if rec["accuracy"] is not None and rec["coverage"] is not None:
        rec["detailed"] = round(0.40 * rec["accuracy"] + 0.35 * rec["coverage"] + 0.25 * rec["fidelity"], 3)
    with lock:
        with OUT.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(rec["paper_id"], rec["model"], "acc", rec["accuracy"], "cov", rec.get("coverage_j1"), rec.get("coverage_j2"), "fid", rec["fidelity"], "=>", rec.get("detailed"), flush=True)


def main():
    runs = [json.loads(l) for l in PATH.read_text(encoding="utf-8").splitlines() if l.strip()]
    done = {r["run_id"] for r in (json.loads(l) for l in OUT.read_text(encoding="utf-8").splitlines() if l.strip()) if not r.get("judge2_error")} if OUT.exists() else set()
    with ThreadPoolExecutor(3) as ex:
        list(ex.map(lambda r: one(r, done), runs))


if __name__ == "__main__":
    main()
