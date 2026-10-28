"""Triage the whole catalog: for every paper, how hard is it to reproduce and what does it need?

  python scripts/triage.py [--limit N] [--ids a,b] [--parallel 4]

One cheap model call per paper (about 15k tokens in, 1k out) writes the same `compute` object the Router writes, plus whether code is released
and what the cheapest headline result is. Results go to bench/triage/<id>.json (cached: a paper is never triaged twice); scripts/build_compute.py
merges them into web/compute.json, where the viewer reads the tier (Light, Medium, Heavy) and the time estimate.
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
from repro.config import ModelChoice  # noqa: E402
from repro.llm import Meter, chat, parse_json  # noqa: E402
from repro.paper import fetch_paper, pdf_to_text  # noqa: E402

OUT = ROOT / "bench" / "triage"
MODEL = ModelChoice("paratera", "DeepSeek-V4.1-Flash")
PROMPT = """You triage a research paper for a reproduction service. Nobody will run anything now: judge from the paper text how hard it would be for an AI agent
to reproduce ONE headline number on a normal laptop (8 CPU cores, 16 GB RAM, no GPU) within a few hours, writing code itself if needed.

Pick the CHEAPEST quantitative result that still shows the paper's main contribution (a single table cell on the smallest dataset is ideal).
Return ONE JSON object:
{
  "target": {"statement": str, "table_ref": str, "dataset": str},
  "release": "full" | "partial" | "none" | "unknown",    // does the paper link code that would run the target? (full = code, data and configs; partial = code but something missing or outdated)
  "code_links": [str],
  "data_access": "public" | "restricted" | "unknown",    // can the data for the target be downloaded freely?
  "compute": {
    "difficulty": 1|2|3|4|5,       // 1 small classic ML on a small table; 3 a real training run or several datasets or rebuilding missing code; 5 large data, many parts, or GPU-hours
    "needs_gpu": bool,             // true only if the target cannot reasonably finish on a CPU
    "vram_gb": number|null, "ram_gb": number, "disk_gb": number,
    "ref_minutes": number,         // minutes of COMMAND time (install, download, all runs of the target's protocol, the clean re-run) on that laptop; not time spent writing code
    "gpu_speedup": number|null,    // how many times faster on a mid GPU (RTX 3060 class); null if the code cannot use one
    "basis": str                   // one sentence: what the estimate rests on
  },
  "blockers": [str],               // e.g. "needs proprietary data", "needs 8 A100 GPUs", "closed-source model API"
  "suitable": bool                 // false if no target can be reproduced without proprietary data, huge compute or closed models
}
Be honest and conservative: when the paper trains large models or needs big datasets, say so.
"""
lock = threading.Lock()


def one(pid: str, title: str):
    out = OUT / f"{pid}.json"
    if out.exists():
        return
    d = ROOT / ".cache" / "triage_pdf"
    try:
        pdf, _ = fetch_paper(pid, d / pid)
        info = pdf_to_text(pdf)
        text = info["text"]
        text = text if len(text) <= 60000 else text[:42000] + "\n...[middle omitted]...\n" + text[-16000:]
        user = f"Title: {title}\nLinks in the PDF: {json.dumps(info['code_links'][:12])}\n\n=== PAPER TEXT ===\n{text}"
        r = None
        for attempt in range(3):
            reply = chat(MODEL, [{"role": "system", "content": PROMPT}, {"role": "user", "content": user}], role="triage", meter=Meter(2.0, time.time() + 600),
                         json_mode=True, max_tokens=4000, temperature=0.1, extra_body={"thinking": {"type": "disabled"}})   # thinking ate the budget and left an empty answer
            try:
                r = parse_json(reply.content)
                break
            except Exception:
                continue
        if r is None:
            raise RuntimeError("no valid JSON")
        r.update(id=pid, title=title, pages=info["pages"], model=MODEL.model)
        out.write_text(json.dumps(r, ensure_ascii=False, indent=1), encoding="utf-8")
        print(time.strftime("%H:%M:%S"), pid, "d", (r.get("compute") or {}).get("difficulty"), r.get("release"), (r.get("compute") or {}).get("ref_minutes"), flush=True)
    except Exception as e:
        with lock:
            (OUT / "errors.log").open("a", encoding="utf-8").write(f"{pid}\t{str(e)[:200]}\n")
        print(pid, "FAILED", str(e)[:100], flush=True)
    time.sleep(1.5)   # be polite to arXiv


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int)
    ap.add_argument("--ids")
    ap.add_argument("--parallel", type=int, default=4)
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    d = json.loads((ROOT / "web" / "directory.json").read_text(encoding="utf-8"))
    papers = {k: v["title"] for k, v in d["papers"].items()}
    ids = a.ids.split(",") if a.ids else list(papers)
    if a.limit:
        ids = ids[: a.limit]
    with ThreadPoolExecutor(a.parallel) as ex:
        list(ex.map(lambda i: one(i, papers.get(i, i)), ids))


if __name__ == "__main__":
    main()
