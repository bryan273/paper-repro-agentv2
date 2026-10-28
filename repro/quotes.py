"""Check the Reader's quotes against the paper text and find the page each one is on.
A quote that is not in the paper is dropped rather than shown as a false highlight."""
from __future__ import annotations

import re

_PAGE = re.compile(r"=== page (\d+) ===")


def _norm(s: str) -> str:
    s = s.lower().replace("­", "")
    s = re.sub(r"-\s*\n\s*", "", s)          # words hyphenated across lines
    s = re.sub(r"[^a-z0-9%.,;:()=+\-/ ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def page_texts(text: str) -> list[tuple[int, str]]:
    parts = _PAGE.split(text)
    out = []
    for i in range(1, len(parts) - 1, 2):
        out.append((int(parts[i]), _norm(parts[i + 1])))
    return out or [(1, _norm(text))]


def locate(quote: str | None, pages: list[tuple[int, str]]) -> tuple[str | None, int | None]:
    if not quote or len(quote) < 12:
        return None, None
    q = _norm(quote)
    for probe in (q, q[:80], q[-80:]):
        if len(probe) < 20:
            continue
        for n, t in pages:
            if probe in t:
                return quote, n
    return None, None


def page_of_line(text: str, line_no: int) -> int | None:
    page = None
    for i, line in enumerate(text.splitlines(), 1):
        m = _PAGE.search(line)
        if m:
            page = int(m.group(1))
        if i >= line_no:
            break
    return page


def annotate(contract: dict, ledger: list[dict], paper_text: str) -> dict:
    """Validate quotes in place and return a compact view for the UI."""
    pages = page_texts(paper_text)
    stats = {"kept": 0, "dropped": 0}

    def fix(item: dict):
        q, n = locate(item.get("quote"), pages)
        if item.get("quote") and not q:
            stats["dropped"] += 1
        elif q:
            stats["kept"] += 1
        item["quote"], item["page"] = q, n

    for c in contract.get("claims", []):
        fix(c)
    for r in contract.get("requirements", []):
        fix(r)
    for a in ledger:
        fix(a)
    target_id = (contract.get("match_target") or {}).get("claim_id")
    return {
        "claims": [{k: c.get(k) for k in ("id", "statement", "value", "unit", "table_ref", "quote", "page")} | {"target": c.get("id") == target_id}
                   for c in contract.get("claims", [])],
        "requirements": [{k: r.get(k) for k in ("id", "stmt", "cite", "quote", "page")} for r in contract.get("requirements", [])],
        "assumptions": [{k: a.get(k) for k in ("id", "gap", "chosen", "risk", "quote", "page")} for a in ledger],
        "quote_check": stats,
    }
