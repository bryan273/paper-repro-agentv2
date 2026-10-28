"""Finds papers worth putting in the benchmark, far beyond the group catalog.

  python scripts/discover.py fetch    [--per-query 450]    pull candidate abstracts from arXiv (ML categories, 2023 on, about a hundred topics)
  python scripts/discover.py screen   [--parallel 16]      one cheap call per abstract: could this be reproduced on a laptop CPU?
  python scripts/discover.py triage   [--top 400]          the full triage (scripts/triage.py logic) on the best abstracts, from the PDF
  python scripts/discover.py select   [--n 50]             the final list: public data, no GPU, short, a target number, a spread of topics

Everything is cached in bench/discover/, so each stage can be stopped and started again. The filter is deliberately strict: a paper that needs a GPU,
proprietary data or a closed model never reaches a run, so the benchmark spends its money on papers that can really be reproduced.
"""
import argparse
import json
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
D = ROOT / "bench" / "discover"
D.mkdir(parents=True, exist_ok=True)
CAND, SCREEN, TRI = D / "candidates.jsonl", D / "screen.jsonl", ROOT / "bench" / "triage"
CATS = "(cat:cs.LG OR cat:stat.ML OR cat:cs.IR OR cat:cs.DB OR cat:cs.SI OR cat:stat.ME OR cat:cs.DS OR cat:cs.NE OR cat:stat.AP)"
TOPICS = ["anomaly detection", "outlier detection", "isolation forest", "one-class classification", "clustering", "k-means", "spectral clustering", "tabular data", "decision tree",
          "random forest", "gradient boosting", "time series forecasting", "time series classification", "missing data imputation", "feature selection", "dimensionality reduction",
          "nearest neighbor", "kernel method", "support vector machine", "Gaussian process", "Bayesian optimization", "active learning", "semi-supervised learning",
          "causal discovery", "fairness", "calibration", "conformal prediction", "ensemble learning", "metric learning", "hashing", "matrix factorization",
          "collaborative filtering", "recommender system", "text classification", "topic model", "graph neural network node classification", "link prediction", "community detection",
          "label noise", "class imbalance", "few-shot learning", "interpretability", "explainability", "counterfactual explanation", "concept drift", "online learning",
          "multi-armed bandit", "survival analysis", "sparse regression", "regularization", "hyperparameter optimization", "neural architecture small", "tabular deep learning",
          "data augmentation tabular", "knowledge graph embedding", "entity resolution", "similarity measure", "distance metric", "representation learning tabular", "AutoML",
          "uncertainty estimation", "out-of-distribution detection", "change point detection", "symbolic regression", "federated learning small", "differential privacy", "membership inference",
          "adversarial robustness small", "model selection", "bootstrap", "cross-validation", "transfer learning tabular", "reservoir computing", "spiking", "cellular automata",
          "reinforcement learning tabular", "bandit", "clustering ensemble", "subspace clustering", "co-clustering", "outlier ensemble", "streaming", "sketching", "locality sensitive hashing",
          "string kernel", "graph kernel", "tensor decomposition", "nonnegative matrix factorization", "PCA", "manifold learning", "t-SNE UMAP", "density estimation", "normalizing flow small",
          "mixture model", "hidden Markov model", "Bayesian network", "structure learning", "feature engineering", "genetic programming", "evolutionary optimization", "swarm"]
NS = {"a": "http://www.w3.org/2005/Atom"}
lock = threading.Lock()


def arxiv(query: str, start: int, n: int) -> list[dict]:
    q = urllib.parse.urlencode({"search_query": query, "start": start, "max_results": n, "sortBy": "submittedDate", "sortOrder": "descending"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request("http://export.arxiv.org/api/query?" + q, headers={"User-Agent": "paper-repro-bench/0.1 (research)"}), timeout=60) as r:
                root = ET.fromstring(r.read())
            break
        except Exception:
            time.sleep(5 * (attempt + 1))
    else:
        return []
    out = []
    for e in root.findall("a:entry", NS):
        i = e.find("a:id", NS).text.rsplit("/abs/", 1)[-1]
        i = re.sub(r"v\d+$", "", i)
        out.append({"id": i, "title": " ".join(e.find("a:title", NS).text.split()), "abstract": " ".join(e.find("a:summary", NS).text.split()),
                    "published": e.find("a:published", NS).text[:10], "cats": [c.get("term") for c in e.findall("a:category", NS)],
                    "comment": (e.find("{http://arxiv.org/schemas/atom}comment").text if e.find("{http://arxiv.org/schemas/atom}comment") is not None else None)})
    return out


def fetch(per_query: int):
    have = {json.loads(l)["id"] for l in CAND.read_text(encoding="utf-8").splitlines() if l.strip()} if CAND.exists() else set()
    for t in TOPICS:
        got = 0
        for start in range(0, per_query, 150):
            q = f'{CATS} AND abs:"{t}" AND submittedDate:[202301010000 TO 202612312359]'
            rows = arxiv(q, start, 150)
            new = [r for r in rows if r["id"] not in have]
            with CAND.open("a", encoding="utf-8") as f:
                for r in new:
                    f.write(json.dumps(r, ensure_ascii=False) + "\n")
                    have.add(r["id"])
            got += len(new)
            time.sleep(3.2)   # arXiv asks for one request every three seconds
            if len(rows) < 150:
                break
        print(f"{t:40} +{got:4}  total {len(have)}", flush=True)


SCREEN_PROMPT = """You screen arXiv abstracts for a reproduction benchmark. An AI agent will try to reproduce ONE headline number of the paper on a laptop (8 CPU cores, 16 GB RAM, NO GPU) in under an hour,
writing the code itself if the code is not released. Judge from the abstract only. Return ONE JSON object:
{"score": 0-10, "needs_gpu": bool, "public_data": "yes"|"no"|"unknown", "why": "one short sentence"}
Score high (7-10) only when the method is classical or small (tabular data, small graphs, clustering, anomaly detection, kernels, trees, small text or time-series benchmarks) and the datasets are standard public ones.
Score low (0-3) for: large language or vision models, anything trained on ImageNet-scale or web-scale data, multi-GPU training, proprietary or clinical data, human studies, robotics or simulators, surveys, position papers, theory with no experiments."""


def screen(parallel: int):
    from repro.config import ModelChoice
    from repro.llm import Meter, chat, parse_json
    cands = [json.loads(l) for l in CAND.read_text(encoding="utf-8").splitlines() if l.strip()]
    done = {json.loads(l)["id"] for l in SCREEN.read_text(encoding="utf-8").splitlines() if l.strip()} if SCREEN.exists() else set()
    todo = [c for c in cands if c["id"] not in done]
    print(len(todo), "abstracts to screen", flush=True)
    choice = ModelChoice("paratera", "DeepSeek-V4.1-Flash")   # goes to DeepSeek's own API when its key is set

    def one(c):
        try:
            r = chat(choice, [{"role": "system", "content": SCREEN_PROMPT}, {"role": "user", "content": f"Title: {c['title']}\n\nAbstract: {c['abstract']}\n\nComment: {c.get('comment')}"}],
                     role="screen", meter=Meter(1.0, time.time() + 120), json_mode=True, max_tokens=300, temperature=0, extra_body={"thinking": {"type": "disabled"}})
            j = parse_json(r.content)
            rec = {"id": c["id"], "score": float(j.get("score", 0)), "needs_gpu": bool(j.get("needs_gpu")), "public_data": j.get("public_data"), "why": str(j.get("why", ""))[:160]}
        except Exception as e:
            return
        with lock:
            with SCREEN.open("a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    with ThreadPoolExecutor(parallel) as ex:
        for k, _ in enumerate(ex.map(one, todo)):
            if k % 500 == 0:
                print(k, "/", len(todo), flush=True)


def triage(top: int, parallel: int):
    import triage as T   # scripts/triage.py: the same prompt and cache (bench/triage/<id>.json)
    cands = {json.loads(l)["id"]: json.loads(l) for l in CAND.read_text(encoding="utf-8").splitlines() if l.strip()}
    sc = [json.loads(l) for l in SCREEN.read_text(encoding="utf-8").splitlines() if l.strip()]
    sc = [s for s in sc if not s["needs_gpu"] and s["public_data"] != "no"]
    sc.sort(key=lambda s: -s["score"])
    ids = [s["id"] for s in sc[:top]]
    print("triage", len(ids), "papers, score from", sc[0]["score"], "to", sc[min(top, len(sc)) - 1]["score"], flush=True)
    with ThreadPoolExecutor(parallel) as ex:
        list(ex.map(lambda i: T.one(i, cands[i]["title"]), ids))


def select(n: int):
    cands = {json.loads(l)["id"]: json.loads(l) for l in CAND.read_text(encoding="utf-8").splitlines() if l.strip()}
    sc = {json.loads(l)["id"]: json.loads(l) for l in SCREEN.read_text(encoding="utf-8").splitlines() if l.strip()}
    have = {p["paper"] for p in json.loads((ROOT / "bench" / "papers.json").read_text(encoding="utf-8"))}
    rows = []
    for f in TRI.glob("*.json"):
        t = json.loads(f.read_text(encoding="utf-8"))
        if t["id"] not in cands or t["id"] in have:
            continue
        c = t.get("compute") or {}
        ok = (t.get("suitable") and t.get("data_access") == "public" and t.get("target") and not c.get("needs_gpu") and (c.get("difficulty") or 9) <= 3
              and (c.get("ref_minutes") or 999) <= 40 and (c.get("ram_gb") or 99) <= 12 and (c.get("disk_gb") or 99) <= 20)
        if ok:
            rows.append({"id": t["id"], "title": cands[t["id"]]["title"], "published": cands[t["id"]]["published"], "cats": cands[t["id"]]["cats"][:3], "difficulty": c["difficulty"],
                         "ref_minutes": c["ref_minutes"], "release": t.get("release"), "code_links": t.get("code_links"), "target": t["target"], "screen": sc.get(t["id"], {}).get("score"), "blockers": t.get("blockers")})
    rank = {"full": 0, "partial": 1, "none": 2, "unknown": 3}
    rows.sort(key=lambda r: (-(r["screen"] or 0), rank.get(r["release"], 3), r["ref_minutes"]))
    chosen, per_cat = [], {}
    for r in rows:   # a spread of topics: at most a handful from the same primary category and no two with the same code repository
        k = r["cats"][0] if r["cats"] else "?"
        if per_cat.get(k, 0) >= max(8, n // 5):
            continue
        per_cat[k] = per_cat.get(k, 0) + 1
        chosen.append(r)
        if len(chosen) >= n:
            break
    (D / "selected.json").write_text(json.dumps({"n": len(chosen), "from_feasible": len(rows), "papers": chosen}, ensure_ascii=False, indent=1), encoding="utf-8")
    print("feasible after triage:", len(rows), "| chosen:", len(chosen))
    for r in chosen:
        print(f'{r["id"]:11} d{r["difficulty"]} {r["ref_minutes"]:>5} min {str(r["release"]):8} s={r["screen"]} {r["title"][:70]}')


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=["fetch", "screen", "triage", "select"])
    ap.add_argument("--per-query", type=int, default=450)
    ap.add_argument("--parallel", type=int, default=16)
    ap.add_argument("--top", type=int, default=400)
    ap.add_argument("--n", type=int, default=50)
    a = ap.parse_args()
    sys.path.insert(0, str(ROOT / "scripts"))
    {"fetch": lambda: fetch(a.per_query), "screen": lambda: screen(a.parallel), "triage": lambda: triage(a.top, 4), "select": lambda: select(a.n)}[a.stage]()
