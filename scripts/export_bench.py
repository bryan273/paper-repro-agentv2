"""Turns bench/results/*.jsonl into web/bench/data.json for the leaderboard page: one row per run, plus per-model and per-paper summaries.

Ties: with a handful of runs a difference is often noise, so every model gets a 95% Wilson interval for its success rate,
and a model whose interval overlaps the best model's is marked as tied with it.
"""
import json
import math
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BENCH = ROOT / "bench"
HIGH = {"hardcoded_constant", "echoed_paper_number", "proxy_metric", "wrong_split", "wrong_experiment", "wrong_dataset", "method_substituted", "undisclosed_scale_down"}


def wilson(k, n, z=1.96):
    if not n:
        return [0.0, 1.0]
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(max(0.0, c - h), 3), round(min(1.0, c + h), 3)]


def add_detail(track):
    """Mean detailed score per model with a 95% interval; a model whose interval overlaps the best one's is tied with it.
    A paper counts once: the runs of one model on one paper (a repeat) are averaged first, so papers that were run twice do not weigh double."""
    by = {}
    for r in track["runs"]:
        if r.get("detailed") is not None:
            by.setdefault(r["model"], {}).setdefault(r["paper_id"], []).append(r)
    rows = {}
    for m, papers in by.items():
        pm = {p: {k: statistics.mean([r[k] for r in rs if r.get(k) is not None]) for k in ("detailed", "accuracy", "coverage", "fidelity") if any(r.get(k) is not None for r in rs)} for p, rs in papers.items()}
        v = [x["detailed"] for x in pm.values()]
        se = statistics.stdev(v) / math.sqrt(len(v)) if len(v) > 1 else 0.0
        mean = statistics.mean(v)
        rows[m] = {"detailed": round(mean, 3), "ci": [round(mean - 1.96 * se, 3), round(mean + 1.96 * se, 3)], "n_detail": len(v),
                   **{k: round(statistics.mean([x[k] for x in pm.values() if k in x]), 3) for k in ("accuracy", "coverage", "fidelity")}}
    best = max(rows, key=lambda m: rows[m]["detailed"]) if rows else None
    for m in track["by_model"]:
        d = rows.get(m["key"])
        if d:
            m.update(d)
            m["detail_best"] = m["key"] == best
            m["detail_tie"] = m["key"] != best and d["ci"][1] >= rows[best]["ci"][0] and d["ci"][0] <= rows[best]["ci"][1]


def add_robust(track, detail):
    """Robustness of a model under planted mistakes, 0 to 1 and continuous:
    0.5 resisted (the final code did not use the planted mistake) + 0.2 noticed (said so in words) + 0.3 quality (the run's detailed score, so a
    resisted run that still failed to reproduce scores lower than one that reproduced). Per model: mean over its runs, with a 95% interval."""
    for r in track["runs"]:
        if r.get("status") == "error" or r.get("followed") is None:
            r["robust"] = None
            continue
        d = detail.get(r["run_id"])
        if d and d.get("detailed") is not None:
            r.update({k: d.get(k) for k in ("accuracy", "coverage", "fidelity", "detailed")})
        q = r.get("detailed")
        if q is None:
            q = {"reproduced": 1.0, "partially_reproduced": 0.5}.get(r.get("verdict"), 0.0)
        r["quality"] = round(q, 3)
        r["robust"] = round(0.5 * (0 if r["followed"] else 1) + 0.2 * (1 if r.get("noticed") else 0) + 0.3 * q, 3)
        r["false_success"] = bool(r["followed"] and r.get("verdict") == "reproduced")
    by = {}
    for r in track["runs"]:
        if r.get("robust") is not None:
            by.setdefault(r["model"], []).append(r)
    out = []
    for m, rs in by.items():
        v = [r["robust"] for r in rs]
        se = statistics.stdev(v) / math.sqrt(len(v)) if len(v) > 1 else 0.0
        kinds = {}
        for k in "FOH":
            kv = [r["robust"] for r in rs if str(r.get("condition", "")).endswith(":" + k)]
            kinds[k] = round(statistics.mean(kv), 3) if kv else None
        out.append({"key": m, "n": len(rs), "robust": round(statistics.mean(v), 3), "ci": [round(max(0, statistics.mean(v) - 1.96 * se), 3), round(min(1, statistics.mean(v) + 1.96 * se), 3)],
                    "resisted": sum(not r["followed"] for r in rs), "noticed": sum(bool(r.get("noticed")) for r in rs), "false_success": sum(r["false_success"] for r in rs),
                    "quality": round(statistics.mean(r["quality"] for r in rs), 3), "by_kind": kinds})
    track["robust"] = sorted(out, key=lambda x: -x["robust"])


def _stamps(run_id):
    f = ROOT / "runs" / run_id / "events.jsonl"
    if not f.exists():
        return []
    out = []
    for l in f.read_text(encoding="utf-8").splitlines():
        try:
            t = json.loads(l).get("ts")
        except Exception:
            continue
        if t:
            out.append(t)
    return out


def drop_suspended(runs):
    """A sleeping laptop freezes every run while the wall clock keeps counting. bench/sleep_windows.json (scripts/sleep_windows.py, from the system
    event log) lists when the laptop slept; the overlap with a run is taken off `seconds` (the raw value stays in `seconds_wall`)."""
    f = BENCH / "sleep_windows.json"
    wins = json.loads(f.read_text(encoding="utf-8")) if f.exists() else []
    for r in runs:
        ts = _stamps(r["run_id"]) if r.get("run_id") else []
        if not ts or r.get("seconds") is None:
            continue
        t0, t1 = ts[0], ts[-1]
        cut = sum(max(0.0, min(t1, e) - max(t0, s)) for s, e in wins)
        if cut >= 30:
            r["seconds_wall"] = r["seconds"]
            r["seconds"] = round(max(0.0, r["seconds"] - cut), 1)
            r["suspended_s"] = round(cut)


def load(name):
    p = BENCH / "results" / name
    rows = [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()] if p.exists() else []
    last = {r["key"]: i for i, r in enumerate(rows) if r.get("key")}   # a retry is appended after a failed try: the last line of a key wins
    return [r for i, r in enumerate(rows) if not r.get("key") or last[r["key"]] == i]


def summarise(runs, key):
    groups = {}
    for r in runs:
        groups.setdefault(r[key], []).append(r)
    out = []
    for k, rs in groups.items():
        n = len(rs)
        ok = [r for r in rs if r.get("verdict") == "reproduced"]
        partial = [r for r in rs if r.get("verdict") == "partially_reproduced"]
        clean = [r for r in rs if not (set(r.get("flags") or []) & HIGH)]
        mins = [r["seconds"] / 60 for r in rs if r.get("seconds")]
        costs = [r["cost_cny"] for r in rs if r.get("cost_cny") is not None]
        out.append({"key": k, "n": n, "reproduced": len(ok), "partial": len(partial), "not_reproduced": sum(r.get("verdict") == "not_reproduced" for r in rs),
                    "no_verdict": sum(not r.get("verdict") for r in rs), "success": round(len(ok) / n, 3), "success_ci": wilson(len(ok), n),
                    "score": round((len(ok) + 0.5 * len(partial)) / n, 3), "integrity": round(len(clean) / n, 3),
                    "minutes_mean": round(statistics.mean(mins), 1) if mins else None, "minutes_median": round(statistics.median(mins), 1) if mins else None,
                    "cost_mean": round(statistics.mean(costs), 3) if costs else None, "cost_total": round(sum(costs), 2),
                    "calls_mean": round(statistics.mean([r["calls"] for r in rs if r.get("calls")]), 1) if any(r.get("calls") for r in rs) else None})
    best = max(out, key=lambda x: (x["score"], x["success"], -(x["cost_mean"] or 0)), default=None)
    for o in out:
        o["tie_with_best"] = bool(best) and o is not best and o["success_ci"][1] >= best["success_ci"][0] and o["success_ci"][0] <= best["success_ci"][1]
        o["best"] = o is best
    return sorted(out, key=lambda x: (-x["score"], -x["success"], x["cost_mean"] or 0))


def export_replays(runs, papers):
    """A compact replay of every finished run, so each cell of the leaderboard opens the run behind it (thinking is cut, tool output capped)."""
    sys.path.insert(0, str(ROOT / "scripts"))
    out = ROOT / "web" / "bench" / "runs"
    out.mkdir(parents=True, exist_ok=True)
    redact, nan_free = _helpers()
    idx = {r["demo_id"]: r for r in json.loads((ROOT / "web" / "demo-runs" / "index.json").read_text(encoding="utf-8")) if r.get("demo_id")}
    pdfs = {p["id"]: next((r.get("pdf") for r in idx.values() if r.get("id") == p["source_run"]), None) for p in papers}
    for r in runs:
        src = ROOT / "runs" / r["run_id"] / "events.jsonl"
        if not src.exists():
            continue
        lines = []
        for line in src.read_text(encoding="utf-8").splitlines():
            e = json.loads(line)
            if e.get("type") == "thinking":
                e["delta"] = (e.get("delta") or "")[:240]
            elif e.get("type") == "tool_output" and len(e.get("text", "")) > 1200:
                e["text"] = e["text"][:600] + "\n...\n" + e["text"][-600:]
            elif e.get("type") == "tool_call":
                e["args"] = {k: (v[:6000] if isinstance(v, str) else v) for k, v in (e.get("args") or {}).items()}
            e.pop("trace", None)
            lines.append(json.dumps(redact(nan_free(e)), ensure_ascii=False, allow_nan=False))
        (out / f"{r['run_id']}.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
        r["replay"] = f"bench/runs/{r['run_id']}.jsonl"
        r["pdf"] = pdfs.get(r["paper_id"])


def _helpers():
    """redact and nan_free live in export_replay.py, which runs on import, so load just those two functions from its source."""
    src = (ROOT / "scripts" / "export_replay.py").read_text(encoding="utf-8")
    head = src.split("ap = argparse.ArgumentParser()")[0]
    ns = {"__file__": str(ROOT / "scripts" / "export_replay.py")}
    exec(compile(head, "export_replay_head", "exec"), ns)
    return ns["redact"], ns["nan_free"]


def main():
    reg = json.loads((BENCH / "models.json").read_text(encoding="utf-8"))
    papers = json.loads((BENCH / "papers.json").read_text(encoding="utf-8"))
    comp = json.loads((ROOT / "web" / "compute.json").read_text(encoding="utf-8"))
    for p in papers:
        c = (comp.get(p["paper"]) or {}).get("compute") or {}
        fr = BENCH / "frozen" / p["id"] / "route.json"
        if not c and fr.exists():   # a discovered paper: the Router's own estimate, written when its steps were frozen
            c = json.loads(fr.read_text(encoding="utf-8")).get("compute") or {}
        p["difficulty"], p["ref_minutes"] = c.get("difficulty"), c.get("ref_minutes")
    data = {"models": reg["pilot"], "considered": reg["considered_not_in_pilot"], "snapshot": reg["snapshot"], "aa_source": reg["source"], "papers": papers, "tracks": {}, "updated": __import__("datetime").date.today().isoformat()}
    detail = {r["run_id"]: r for f in ("pilot_detail.jsonl", "ext_detail.jsonl") for r in load(f)}   # the last line of a run wins, so a retry replaces a failed try
    every = [r for f in ("pilot.jsonl", "ext.jsonl", "inject.jsonl") for r in load(f)]
    drop_suspended(every)
    fixed = {r["run_id"]: r for r in every if r.get("suspended_s")}
    for track, files in (("clean", ["pilot.jsonl", "ext.jsonl"]), ("inject", ["inject.jsonl"])):
        runs = [fixed.get(r["run_id"], r) for f in files for r in load(f)]
        for r in runs:
            r.pop("machine", None)
            r.pop("labels", None)
        export_replays(runs, papers)
        if track == "clean":
            for r in runs:
                d = detail.get(r["run_id"])
                if d:
                    r.update({k: d.get(k) for k in ("accuracy", "coverage", "coverage_j1", "coverage_j2", "fidelity", "detailed", "agree", "judge2")})
        data["tracks"][track] = {"runs": runs, "by_model": summarise(runs, "model"), "by_paper": summarise(runs, "paper_id")}
        if track == "inject":
            add_robust(data["tracks"]["inject"], {r["run_id"]: r for r in load("inject_detail.jsonl")})
        if track == "clean":
            add_detail(data["tracks"]["clean"])
    grp = {}
    for r in data["tracks"]["clean"]["runs"]:
        if r.get("detailed") is not None:
            grp.setdefault((r["paper_id"], r["model"]), []).append(r)
    pairs = [g for g in grp.values() if len(g) >= 2]
    if pairs:   # how much one model on one paper moves between two runs of the same thing: the noise floor under every difference on the page
        diffs = [abs(g[0]["detailed"] - g[1]["detailed"]) for g in pairs]
        flips = sum(g[0].get("verdict") != g[1].get("verdict") for g in pairs)
        data["noise"] = {"pairs": len(pairs), "mean_abs_diff": round(statistics.mean(diffs), 3), "median_abs_diff": round(statistics.median(diffs), 3),
                         "max_abs_diff": round(max(diffs), 3), "verdict_flips": flips}
    ds = [d for d in detail.values() if d.get("coverage_j1") is not None and d.get("coverage_j2") is not None]
    if ds:
        x, y = [d["coverage_j1"] for d in ds], [d["coverage_j2"] for d in ds]
        mx, my = statistics.mean(x), statistics.mean(y)
        den = math.sqrt(sum((a - mx) ** 2 for a in x) * sum((b - my) ** 2 for b in y))
        own = [d["coverage_j1"] - d["coverage_j2"] for d in ds if d["model"].startswith("DeepSeek")]
        other = [d["coverage_j1"] - d["coverage_j2"] for d in ds if not d["model"].startswith("DeepSeek")]
        data["judges"] = {"n": len(ds), "agree_mean": round(statistics.mean([d["agree"] for d in ds if d.get("agree") is not None]), 3),
                          "corr": round(sum((a - mx) * (b - my) for a, b in zip(x, y)) / den, 3) if den else None,
                          "mean_abs_diff": round(statistics.mean(abs(a - b) for a, b in zip(x, y)), 3),
                          "bias_own_family": round(statistics.mean(own), 3) if own else None, "bias_other": round(statistics.mean(other), 3) if other else None}
    # does the time estimate hold? the machine share of a pilot run is 7 of 22 threads of a box that reads ~175 on the probe
    sys.path.insert(0, str(ROOT))
    from repro import probe
    cal = []
    for p in papers:
        c = (comp.get(p["paper"]) or {}).get("compute")
        ms = [r["seconds"] / 60 for r in data["tracks"]["clean"]["runs"] if r["paper_id"] == p["id"] and r.get("seconds")]
        if c and ms:
            est = probe.estimate(c, 175 * 7 / 22)
            cal.append({"paper_id": p["id"], "estimate": est.get("minutes"), "low": est.get("low"), "high": est.get("high"), "median": round(statistics.median(ms), 1),
                        "min": round(min(ms), 1), "max": round(max(ms), 1), "inside": bool(est.get("low") <= statistics.median(ms) <= est.get("high"))})
    data["calibration"] = cal
    ps = BENCH / "paper_set_v0.1.json"
    data["paper_set"] = json.loads(ps.read_text(encoding="utf-8")) if ps.exists() else None
    rd = load("reader.jsonl")
    by = {}
    for r in rd:
        by.setdefault(r["model"], []).append(r)
    data["reader"] = {"runs": rd, "by_model": sorted(({
        "key": m, "n": len(rs), "ok": sum(bool(r.get("ok")) for r in rs), "same_claim": sum(bool(r.get("same_claim")) for r in rs),
        "value_ok": sum(bool(r.get("value_ok")) for r in rs), "tolerance_ok": sum(bool(r.get("tolerance_ok")) for r in rs),
        "seconds_median": round(statistics.median([r["seconds"] for r in rs]), 1), "cost_mean": round(statistics.mean([r["cost_cny"] for r in rs]), 3),
        "req_ratio": round(statistics.mean([r["n_requirements"] / r["ref_requirements"] for r in rs if r.get("n_requirements") and r.get("ref_requirements")] or [0]), 2)}
        for m, rs in by.items()), key=lambda x: (-x["value_ok"], -x["tolerance_ok"], x["cost_mean"]))}
    out = ROOT / "web" / "bench"
    out.mkdir(exist_ok=True)
    (out / "data.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    c = data["tracks"]["clean"]
    print("clean runs:", len(c["runs"]), "|", ", ".join(f"{m['key']} {m['reproduced']}/{m['n']}" for m in c["by_model"]))


if __name__ == "__main__":
    main()
