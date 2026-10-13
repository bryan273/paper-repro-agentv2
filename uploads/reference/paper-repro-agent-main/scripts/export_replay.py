"""Copy a finished run into web/demo-runs/ so the static UI can replay it without a runner.

  python scripts/export_replay.py <run_id> [--demo fasttext]
Thinking deltas are kept (they are what makes a replay informative) but tool output is capped.
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ap = argparse.ArgumentParser()
ap.add_argument("run_id")
ap.add_argument("--demo")
a = ap.parse_args()

src = ROOT / "runs" / a.run_id
meta = json.loads((src / "meta.json").read_text(encoding="utf-8"))
out_dir = ROOT / "web" / "demo-runs"
out_dir.mkdir(parents=True, exist_ok=True)
name = f"{a.demo or meta.get('demo_id') or 'run'}-{a.run_id}.jsonl"
lines = []
for line in (src / "events.jsonl").read_text(encoding="utf-8").splitlines():
    e = json.loads(line)
    if e.get("type") == "tool_output" and len(e.get("text", "")) > 3000:
        e["text"] = e["text"][:1500] + "\n...\n" + e["text"][-1500:]
    e.pop("trace", None)
    lines.append(json.dumps(e, ensure_ascii=False))
(out_dir / name).write_text("\n".join(lines) + "\n", encoding="utf-8")
pdf_src = ROOT / "workspaces" / a.run_id / "paper" / "paper.pdf"
pdf_name = name.replace(".jsonl", ".pdf")
if pdf_src.exists():
    (out_dir / pdf_name).write_bytes(pdf_src.read_bytes())
else:
    pdf_name = None

idx_path = out_dir / "index.json"
idx = json.loads(idx_path.read_text(encoding="utf-8")) if idx_path.exists() else []
idx = [r for r in idx if r.get("id") != a.run_id]
idx.insert(0, {"id": a.run_id, "file": name, "title": meta.get("title"), "paper": meta.get("paper"), "status": meta.get("status"),
               "verdict": meta.get("verdict"), "route": meta.get("route"), "seconds": meta.get("seconds"),
               "cost_cny": (meta.get("meter") or {}).get("cost_cny"), "demo_id": a.demo or meta.get("demo_id"), "pdf": pdf_name})
idx_path.write_text(json.dumps(idx, ensure_ascii=False, indent=1), encoding="utf-8")

demo_id = a.demo or meta.get("demo_id")
if demo_id:
    dpath = ROOT / "demos" / "demos.json"
    demos = json.loads(dpath.read_text(encoding="utf-8"))
    for d in demos:
        if d["id"] == demo_id:
            d["replay"] = name
            d["pdf"] = pdf_name
    dpath.write_text(json.dumps(demos, ensure_ascii=False, indent=1), encoding="utf-8")
    (ROOT / "web" / "demos.json").write_text(json.dumps(demos, ensure_ascii=False, indent=1), encoding="utf-8")
print("exported", name, f"({len(lines)} events)")
