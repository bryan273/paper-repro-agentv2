"""Picks the benchmark paper set from the triaged catalog: Easy, Medium and Hard papers that can really be reproduced.

  python scripts/build_paper_set.py [--per-tier 10]

Needs bench/triage/*.json (scripts/triage.py). Writes bench/paper_set_v0.1.json and prints a table.
Rules: the paper must be suitable (no proprietary data, no closed models), its data public, and a target result must exist.
  Easy   difficulty 1 or 2, CPU only, at most about 45 min of commands on the reference laptop
  Medium difficulty 3, CPU only, up to about 120 min
  Hard   difficulty 4 or 5 or needing a GPU; marked cpu_ok=false when it needs one, so it runs on a GPU server, not on a laptop
Within a tier papers with released code are preferred (full, then partial, then none), so every tier mixes the three release situations;
the five pilot papers are always kept.
"""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RANK = {"full": 0, "partial": 1, "none": 2, "unknown": 3}


def tier_of(c: dict) -> str:
    if c.get("needs_gpu") or (c.get("difficulty") or 3) >= 4 or (c.get("ref_minutes") or 0) > 120:
        return "hard"
    if (c.get("difficulty") or 3) >= 3 or (c.get("ref_minutes") or 0) > 45:
        return "medium"
    return "easy"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-tier", type=int, default=10)
    a = ap.parse_args()
    pilot = {p["paper"] for p in json.loads((ROOT / "bench" / "papers.json").read_text(encoding="utf-8"))}
    d = json.loads((ROOT / "web" / "directory.json").read_text(encoding="utf-8"))["papers"]
    merged = json.loads((ROOT / "web" / "compute.json").read_text(encoding="utf-8"))
    rows = []
    for f in sorted((ROOT / "bench" / "triage").glob("*.json")):
        t = json.loads(f.read_text(encoding="utf-8"))
        c = (merged.get(t["id"]) or {}).get("compute") or t.get("compute") or {}   # a measured number beats a triage guess
        if not c:
            continue
        ok = bool(t.get("suitable")) and t.get("data_access") != "restricted" and bool(t.get("target"))
        rows.append({"id": t["id"], "title": (d.get(t["id"]) or {}).get("title") or t["title"], "tier": tier_of(c), "difficulty": c.get("difficulty"), "ref_minutes": c.get("ref_minutes"),
                     "needs_gpu": bool(c.get("needs_gpu")), "gpu_speedup": c.get("gpu_speedup"), "release": t.get("release"), "data_access": t.get("data_access"),
                     "target": (t.get("target") or {}).get("statement"), "table_ref": (t.get("target") or {}).get("table_ref"), "blockers": t.get("blockers") or [],
                     "eligible": ok, "pilot": t["id"] in pilot, "cpu_ok": not c.get("needs_gpu")})
    chosen = []
    for tier in ("easy", "medium", "hard"):
        pool = [r for r in rows if r["tier"] == tier and (r["eligible"] or r["pilot"])]
        pool.sort(key=lambda r: (not r["pilot"], RANK.get(r["release"], 3), r["ref_minutes"] or 0))
        chosen += pool[: a.per_tier]
    out = {"version": "v0.1", "rule": "see scripts/build_paper_set.py", "counts": {t: sum(r["tier"] == t for r in chosen) for t in ("easy", "medium", "hard")},
           "triaged": len(rows), "eligible": sum(r["eligible"] for r in rows), "papers": chosen}
    (ROOT / "bench" / "paper_set_v0.1.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print("triaged", len(rows), "eligible", out["eligible"], "chosen", out["counts"])
    for r in chosen:
        print(f'{r["tier"]:7} d{r["difficulty"]} {str(r["ref_minutes"]):>7} min  {str(r["release"]):8} gpu={r["needs_gpu"]!s:5} {r["id"]:11} {r["title"][:60]}')


if __name__ == "__main__":
    main()
