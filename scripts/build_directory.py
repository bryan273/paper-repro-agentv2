"""Build web/directory.json: papers grouped by research group, so the UI can browse them with no runner.

  python scripts/build_directory.py            # uses web/groups.json as the list of anchors
Each paper appears once, with all its authors. A group is an anchor author plus the co-authors who
appear on several of the anchor's papers (the institute of those is inferred from that co-authorship).
"""
import json
import sys
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from repro.search import search_arxiv  # noqa: E402

cfg = json.loads((ROOT / "web" / "groups.json").read_text(encoding="utf-8"))
papers: dict[str, dict] = {}
groups = []
for g in cfg:
    ids: set[str] = set()
    for q in g["queries"]:
        start = 0
        while start < 300:
            try:
                rows = search_arxiv(q, "author", 100, start)
            except Exception as e:  # arXiv rate limit or network
                print("retry", q, e)
                time.sleep(5)
                continue
            for p in rows:
                if any(q.lower() == a.lower() for a in p["authors"]):
                    ids.add(p["id"])
                    papers[p["id"]] = {k: p[k] for k in ("id", "title", "authors", "published", "category", "summary")}
            if len(rows) < 100:
                break
            start += 100
            time.sleep(3)
        time.sleep(3)
    co = Counter(a for i in ids for a in papers[i]["authors"])
    members = [{"name": n, "papers": c} for n, c in co.most_common() if c >= g.get("min_papers", 3)]
    groups.append({**{k: g[k] for k in ("id", "name", "name_zh", "institute", "institute_zh", "lead")},
                   "papers": sorted(ids, key=lambda i: papers[i]["published"], reverse=True), "members": members})
    print(g["id"], len(ids), "papers,", len(members), "members")
out = {"built": time.strftime("%Y-%m-%d"), "groups": groups, "papers": papers}
(ROOT / "web" / "directory.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
