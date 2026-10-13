"""Get a paper into plain text: arXiv id/URL, a direct PDF URL, or a local PDF file."""
from __future__ import annotations

import re
import unicodedata
import urllib.request
from pathlib import Path

import pymupdf

ARXIV_RE = re.compile(r"(?:arxiv\.org/(?:abs|pdf|html)/)?(\d{4}\.\d{4,5})(v\d+)?", re.I)
UA = {"User-Agent": "paper-repro-agent/0.1 (research reproduction tool)"}


def _download(url: str, dest: Path) -> Path:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r:
        dest.write_bytes(r.read())
    return dest


def fetch_paper(source: str, dest_dir: Path) -> tuple[Path, dict]:
    """Return (pdf_path, meta). `source` may be an arXiv id, arXiv URL, PDF URL or local path."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    meta: dict = {"source": source}
    p = Path(source)
    if p.exists() and p.suffix.lower() == ".pdf":
        target = dest_dir / "paper.pdf"
        target.write_bytes(p.read_bytes())
        meta["kind"] = "local"
        return target, meta
    m = ARXIV_RE.search(source)
    if m and ("arxiv" in source.lower() or re.fullmatch(r"\d{4}\.\d{4,5}(v\d+)?", source.strip())):
        aid = m.group(1) + (m.group(2) or "")
        meta.update(kind="arxiv", arxiv_id=aid, url=f"https://arxiv.org/abs/{aid}")
        return _download(f"https://arxiv.org/pdf/{aid}", dest_dir / "paper.pdf"), meta
    if source.lower().startswith("http"):
        meta.update(kind="url", url=source)
        return _download(source, dest_dir / "paper.pdf"), meta
    raise ValueError(f"cannot interpret paper source: {source!r}")


def pdf_to_text(pdf: Path) -> dict:
    doc = pymupdf.open(pdf)
    pages = []
    links: set[str] = set()
    for i, page in enumerate(doc):
        pages.append(f"\n\n=== page {i + 1} ===\n" + page.get_text("text"))
        for ln in page.get_links():
            if ln.get("uri"):
                links.add(ln["uri"])
    text = unicodedata.normalize("NFKC", "".join(pages))  # fold ligatures such as "fi"
    for u in re.findall(r"https?://[^\s)\]}>,]+", text):
        links.add(u.rstrip("."))
    title = (doc.metadata or {}).get("title") or ""
    if not title.strip() or title.lower().startswith(("arxiv", "microsoft word")):
        first = [l.strip() for l in doc[0].get_text("text").splitlines() if len(l.strip()) > 8 and not l.strip().lower().startswith("arxiv")] if len(doc) else []
        title = first[0] if first else "Untitled"
    code_links = sorted(u for u in links if re.search(r"github\.com|gitlab\.com|huggingface\.co|zenodo\.org|bitbucket\.org", u, re.I))
    return {"title": unicodedata.normalize("NFKC", title).strip(), "pages": len(doc), "text": text, "chars": len(text),
            "links": sorted(links)[:200], "code_links": code_links}
