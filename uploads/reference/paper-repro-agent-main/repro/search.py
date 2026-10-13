"""Find papers on arXiv by author or keywords, and mark the ones this runner has already reproduced."""
from __future__ import annotations

import json
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ARXIV_API = "https://export.arxiv.org/api/query"
NS = {"a": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}
ID_RE = re.compile(r"(\d{4}\.\d{4,5})(v\d+)?")
_cache: dict[tuple, tuple[float, list]] = {}


def arxiv_id(text: str | None) -> str | None:
    """'2510.13311v2', 'https://arxiv.org/abs/2510.13311' -> '2510.13311'."""
    m = ID_RE.search(text or "")
    return m.group(1) if m else None


def build_query(q: str, mode: str) -> str:
    q = " ".join(q.split())
    if arxiv_id(q) and len(q) <= 40:
        return f"id:{arxiv_id(q)}"
    if mode == "author":
        return f'au:"{q}"'
    words = [w for w in re.split(r"\s+", q) if w]
    return " AND ".join(f"all:{w}" for w in words)


def parse_feed(xml: str) -> list[dict]:
    root = ET.fromstring(xml)
    out = []
    for e in root.findall("a:entry", NS):
        rid = arxiv_id(e.findtext("a:id", "", NS))
        if not rid:
            continue
        cat = e.find("arxiv:primary_category", NS)
        out.append({
            "id": rid,
            "title": " ".join((e.findtext("a:title", "", NS)).split()),
            "authors": [a.findtext("a:name", "", NS) for a in e.findall("a:author", NS)],
            "published": (e.findtext("a:published", "", NS))[:10],
            "category": cat.get("term") if cat is not None else None,
            "comment": " ".join((e.findtext("arxiv:comment", "", NS) or "").split()) or None,
            "summary": " ".join((e.findtext("a:summary", "", NS)).split()),
            "links_code": bool(re.search(r"github\.com|code (is|are) available", e.findtext("a:summary", "", NS) or "", re.I)),
        })
    return out


def _fetch(params: dict) -> list[dict]:
    key = tuple(sorted(params.items()))
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < 600:
        return hit[1]
    # urllib picks up HTTP(S)_PROXY from the environment, which this network needs for arXiv.
    with urllib.request.urlopen(f"{ARXIV_API}?{urllib.parse.urlencode(params)}", timeout=45) as r:
        rows = parse_feed(r.read().decode("utf-8"))
    _cache[key] = (time.time(), rows)
    return rows


def search_arxiv(q: str, mode: str = "author", max_results: int = 40, start: int = 0) -> list[dict]:
    return _fetch({"search_query": build_query(q, mode), "start": start, "max_results": max_results,
                   "sortBy": "submittedDate", "sortOrder": "descending"})


def fetch_ids(ids: list[str]) -> list[dict]:
    return _fetch({"id_list": ",".join(sorted(ids)), "max_results": len(ids)}) if ids else []


def matches(paper: dict, q: str, mode: str) -> bool:
    """Would this paper be a hit for the query? Used to pin past runs that fall outside the current page."""
    words = [w.lower() for w in q.split() if w]
    if arxiv_id(q):
        return paper["id"] == arxiv_id(q)
    if mode == "author":
        return any(all(w in a.lower() for w in words) for a in paper["authors"])
    text = (paper["title"] + " " + paper["summary"]).lower()
    return all(w in text for w in words)


def past_runs(runs_dir: Path) -> dict[str, list[dict]]:
    """arXiv id -> runs of that paper on this runner, newest first."""
    by_id: dict[str, list[dict]] = {}
    if not runs_dir.exists():
        return by_id
    for d in sorted(runs_dir.iterdir(), reverse=True):
        m = d / "meta.json"
        if not m.exists():
            continue
        try:
            meta = json.loads(m.read_text(encoding="utf-8"))
        except Exception:
            continue
        pid = arxiv_id(str(meta.get("paper") or ""))
        if pid:
            by_id.setdefault(pid, []).append({k: meta.get(k) for k in ("id", "status", "verdict", "route", "seconds")})
    return by_id
