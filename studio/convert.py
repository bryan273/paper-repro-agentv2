"""Unfoldia Studio pilot: a scanned or image-based PDF becomes a clean, editable Word file.

Pipeline (the same idea as veritask-ai's file-to-HTML, rebuilt on the Paperlit stack, RKAPI only):
  1. chunk   : every page is rendered to an image (the PDF's own text layer is not trusted: scans have none)
  2. read    : each page goes to a vision model that returns an HTML fragment (headings, alignment, bold, tables, colours); pages run in parallel
  3. repair  : a page that comes back empty or broken is asked again, then once more with the stronger model
  4. merge   : the fragments are joined into one HTML document (also delivered: it opens in any browser)
  5. export  : the HTML becomes .docx with real paragraphs, tables, bold/italic/underline, alignment, sizes and colours (python-docx, no pandoc needed)
  6. ledger  : every call's tokens and cost are written to a JSON report so the admin page can show what a job cost

usage: python convert.py input.pdf out_dir [--model claude-haiku-4-5-20251001] [--pages 1-5] [--keep-page-numbers]
"""
import argparse, base64, concurrent.futures, html, json, os, re, sys, time, urllib.request
from html.parser import HTMLParser

BASE = (os.environ.get("RKAPI_BASE_URL") or "https://rkapi.com") + "/v1"
KEY = os.environ.get("RKAPI_API_KEY", "")
FAST = os.environ.get("STUDIO_MODEL", "claude-haiku-4-5-20251001")
STRONG = os.environ.get("STUDIO_STRONG_MODEL", "claude-sonnet-4-6")
# RKAPI credits per 1M tokens (in, out); one credit = 0.196 RMB, 6.75 RMB per USD (same ledger as explainer/usage.py)
PRICE = {"claude-haiku-4-5": (1.0, 5.0), "claude-sonnet-4-6": (3.0, 15.0)}
CREDIT_USD = 0.196 / 6.75

PROMPT = """Convert this scanned document page into HTML that reproduces what the page shows. Output ONLY the HTML fragment: no <html>, <head>, <body>, no code fence, no comments.

CONTENT
- Reproduce EVERY word, number, date, name and symbol exactly as written, in its own language, with every diacritic. Never translate, summarise, correct or invent anything.
- Printed, typed and handwritten text all count. Write [unclear] for a word you cannot read. Stamps and signatures: write [signature] or [stamp: text if readable] where they are.
- Keep the order from top to bottom, and left to right inside a row.
{PAGE_RULE}

LAYOUT (use inline style attributes)
- Centered text: style="text-align:center". Right aligned: text-align:right. Justified paragraphs: text-align:justify.
- Titles and bold words: <strong>. Italic: <em>. Underline only where a line is really drawn under the letters: <u>.
- Font size when it differs from body text: style="font-size:Npt" (body 11pt, big titles 14 to 16pt, small notes 9pt). Colour only if the text is not black: style="color:#RRGGBB".
- Paragraphs are <p>. Line breaks inside a paragraph are <br>.
- Numbered or lettered items ("1.", "a.", "(1)") are separate <p> elements that keep their number as plain text, indented with style="margin-left:Npt". Never use <ol>, <ul> or <li>.
- Every table is a real <table> with <tr>, <th> or <td>, one cell per printed cell. Use colspan or rowspan where cells are merged. Keep numbers in the cell they are in. Add border="1" to a table that has visible lines.
- A photo or drawing with no text becomes <p><em>[image]</em></p>.
- Do not use <h1> to <h6> for titles: use a centered <p> with <strong>."""
PAGE_RULE_DROP = "- Leave out page numbers (\"Trang 1/3\", \"- 2 -\"), watermarks and running headers or footers that repeat on every page."
PAGE_RULE_KEEP = "- Keep page numbers and repeating headers and footers exactly where they are."

LEDGER = []


def price(model):
    for k, v in PRICE.items():
        if k in model: return v
    return (3.0, 15.0)


def ask(model, b64, rule, label):
    body = json.dumps({"model": model, "max_tokens": 6000, "temperature": 0, "stream": True, "stream_options": {"include_usage": True},
                       "messages": [{"role": "user", "content": [{"type": "text", "text": PROMPT.replace("{PAGE_RULE}", rule)}, {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b64}}]}]}).encode()
    req = urllib.request.Request(BASE + "/chat/completions", body, {"Authorization": "Bearer " + KEY, "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (unfoldia-studio)"})
    t0 = time.time(); txt = ""; usage = {}
    with urllib.request.urlopen(req, timeout=180) as resp:
        for raw in resp:
            line = raw.decode("utf-8", "ignore").strip()
            if not line.startswith("data:") or line.endswith("[DONE]"): continue
            try: ch = json.loads(line[5:])
            except Exception: continue
            for c in ch.get("choices") or []: txt += (c.get("delta") or {}).get("content") or ""
            usage = ch.get("usage") or usage
    pin, pout = price(model)
    ti, to = int(usage.get("prompt_tokens") or 0), int(usage.get("completion_tokens") or 0)
    LEDGER.append({"page": label, "model": model, "in": ti, "out": to, "sec": round(time.time() - t0, 1), "usd": round((ti * pin + to * pout) / 1e6 * CREDIT_USD, 5)})
    return txt


def clean_fragment(t):
    t = re.sub(r"^```(?:html)?\s*|\s*```$", "", t.strip(), flags=re.I)
    return t.strip()


def usable(t):
    plain = re.sub(r"<[^>]+>", " ", t)
    return len(re.sub(r"\s+", "", html.unescape(plain))) >= 8


def read_page(i, b64, rule):
    """Fast model first; an empty or tiny answer is asked again, then once with the strong model."""
    last = ""
    for attempt, model in enumerate((FAST, FAST, STRONG)):
        try:
            t = clean_fragment(ask(model, b64, rule, i + 1))
        except Exception as e:
            print(f"page {i + 1}: {model} attempt {attempt}: {type(e).__name__} {str(e)[:100]}", flush=True); time.sleep(3 * (attempt + 1)); continue
        if usable(t): return t, model
        last = t
    return last, "failed"


# ---------------------------------------------------------------- HTML -> DOCX
class Builder(HTMLParser):
    """Turns the page fragments into Word: paragraphs (alignment, indent, size, colour), runs (bold, italic, underline), tables (merged cells)."""
    def __init__(self, doc):
        super().__init__(convert_charrefs=True)
        from docx.shared import Pt
        self.doc, self.Pt = doc, Pt
        self.par = None; self.fmt = [{}]; self.table = None; self.row = None; self.cell = None; self.cellfmt = None; self.rowspans = {}; self.pstyle = [None]

    # style helpers
    @staticmethod
    def css(attrs):
        d = {}
        for k, v in attrs:
            if k == "style" and v:
                for part in v.split(";"):
                    if ":" in part:
                        a, b = part.split(":", 1); d[a.strip().lower()] = b.strip().lower()
        return d

    def new_par(self, css):
        from docx.enum.text import WD_ALIGN_PARAGRAPH
        from docx.shared import Pt
        target = self.cell if self.cell is not None else self.doc
        p = target.add_paragraph()
        al = css.get("text-align")
        p.alignment = {"center": WD_ALIGN_PARAGRAPH.CENTER, "right": WD_ALIGN_PARAGRAPH.RIGHT, "justify": WD_ALIGN_PARAGRAPH.JUSTIFY}.get(al)
        m = re.match(r"(\d+(?:\.\d+)?)", css.get("margin-left", ""))
        if m: p.paragraph_format.left_indent = Pt(min(float(m.group(1)), 120))
        p.paragraph_format.space_after = Pt(4)
        self.par = p
        return p

    def run_fmt(self):
        f = {}
        for x in self.fmt: f.update(x)
        return f

    def handle_starttag(self, tag, attrs):
        css = self.css(attrs); a = dict(attrs)
        if tag in ("p", "div"):
            self.pstyle.append(css); self.new_par(css); self.fmt.append({k: v for k, v in css.items() if k in ("font-size", "color", "font-weight", "font-style")})
        elif tag in ("strong", "b"): self.fmt.append({"bold": True})
        elif tag in ("em", "i"): self.fmt.append({"italic": True})
        elif tag == "u": self.fmt.append({"underline": True})
        elif tag in ("span", "font"): self.fmt.append({k: v for k, v in css.items() if k in ("font-size", "color", "font-weight", "font-style")})
        elif tag == "br":
            if self.par is None: self.new_par({})
            self.par.add_run().add_break()
        elif tag == "table":
            self.table = {"rows": [], "border": "border" in a}; self.par = None
        elif tag == "tr" and self.table is not None: self.row = []
        elif tag in ("td", "th") and self.row is not None:
            self.cellfmt = {"colspan": int(re.sub(r"\D", "", a.get("colspan", "1")) or 1), "rowspan": int(re.sub(r"\D", "", a.get("rowspan", "1")) or 1), "th": tag == "th", "css": css, "runs": [[]]}
            if tag == "th": self.fmt.append({"bold": True})
            else: self.fmt.append({})
        elif tag in ("h1", "h2", "h3", "h4"):
            self.new_par(css); self.fmt.append({"bold": True})

    def handle_endtag(self, tag):
        if tag in ("p", "div"):
            if len(self.pstyle) > 1: self.pstyle.pop()
            if len(self.fmt) > 1: self.fmt.pop()
            if self.cellfmt is None: self.par = None
            else: self.cellfmt["runs"].append([])
        elif tag in ("strong", "b", "em", "i", "u", "span", "font", "h1", "h2", "h3", "h4"):
            if len(self.fmt) > 1: self.fmt.pop()
            if tag in ("h1", "h2", "h3", "h4"): self.par = None
        elif tag in ("td", "th") and self.cellfmt is not None:
            if len(self.fmt) > 1: self.fmt.pop()
            self.row.append(self.cellfmt); self.cellfmt = None
        elif tag == "tr" and self.table is not None and self.row is not None:
            self.table["rows"].append(self.row); self.row = None
        elif tag == "table" and self.table is not None:
            self.flush_table(); self.table = None

    def handle_data(self, data):
        if not data.strip() and self.cellfmt is None and self.par is None: return
        text = re.sub(r"\s+", " ", data)
        if self.cellfmt is not None:
            if text.strip(): self.cellfmt["runs"][-1].append((text, self.run_fmt()))
            return
        if self.par is None: self.new_par(self.pstyle[-1] or {})
        if text.strip() or self.par.runs: self.add_run(self.par, text, self.run_fmt())

    def add_run(self, par, text, f):
        from docx.shared import Pt, RGBColor
        r = par.add_run(text)
        if f.get("bold") or "bold" in f.get("font-weight", "") or f.get("font-weight", "").isdigit() and int(f["font-weight"]) >= 600: r.bold = True
        if f.get("italic") or f.get("font-style") == "italic": r.italic = True
        if f.get("underline"): r.underline = True
        m = re.match(r"(\d+(?:\.\d+)?)pt", f.get("font-size", ""))
        if m: r.font.size = Pt(max(6, min(float(m.group(1)), 40)))
        m = re.match(r"#([0-9a-f]{6})$", f.get("color", ""))
        if m and m.group(1) not in ("000000",): r.font.color.rgb = RGBColor.from_string(m.group(1).upper())

    def flush_table(self):
        from docx.enum.text import WD_ALIGN_PARAGRAPH
        rows = self.table["rows"]
        if not rows: return
        ncols = max(sum(c["colspan"] for c in r) for r in rows)
        t = self.doc.add_table(rows=len(rows), cols=ncols)
        if self.table["border"]: t.style = "Table Grid"
        taken = set()
        for ri, r in enumerate(rows):
            ci = 0
            for c in r:
                while (ri, ci) in taken: ci += 1
                if ci >= ncols: break
                cell = t.cell(ri, ci)
                end_r, end_c = min(ri + c["rowspan"] - 1, len(rows) - 1), min(ci + c["colspan"] - 1, ncols - 1)
                if end_r > ri or end_c > ci: cell = cell.merge(t.cell(end_r, end_c))
                for rr in range(ri, end_r + 1):
                    for cc in range(ci, end_c + 1): taken.add((rr, cc))
                first = True
                for runs in c["runs"]:
                    if not any(x[0].strip() for x in runs): continue
                    p = cell.paragraphs[0] if first else cell.add_paragraph(); first = False
                    al = c["css"].get("text-align")
                    p.alignment = {"center": WD_ALIGN_PARAGRAPH.CENTER, "right": WD_ALIGN_PARAGRAPH.RIGHT}.get(al)
                    for text, f in runs: self.add_run(p, text, f)
                ci = end_c + 1
        self.par = None
        self.doc.add_paragraph()


def html_to_docx(fragments, path, title=""):
    from docx import Document
    from docx.shared import Pt, Cm
    doc = Document()
    st = doc.styles["Normal"]; st.font.name = "Times New Roman"; st.font.size = Pt(11)
    for s in doc.sections: s.left_margin = s.right_margin = Cm(2.2); s.top_margin = s.bottom_margin = Cm(2)
    if title: doc.core_properties.title = title
    for n, frag in enumerate(fragments):
        if n: doc.add_page_break()
        b = Builder(doc); b.feed(frag); b.close()
    doc.save(path)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("pdf"); ap.add_argument("out"); ap.add_argument("--pages", default=""); ap.add_argument("--keep-page-numbers", action="store_true")
    ap.add_argument("--dpi", type=int, default=140); ap.add_argument("--workers", type=int, default=6)
    a = ap.parse_args()
    if not KEY: sys.exit("RKAPI_API_KEY is not set")
    import fitz
    os.makedirs(a.out, exist_ok=True)
    doc = fitz.open(a.pdf)
    idx = list(range(len(doc)))
    if a.pages:
        idx = []
        for part in a.pages.split(","):
            lo, _, hi = part.partition("-"); idx += list(range(int(lo) - 1, int(hi or lo)))
        idx = [i for i in idx if 0 <= i < len(doc)]
    t0 = time.time()
    imgs = {i: base64.b64encode(doc[i].get_pixmap(dpi=a.dpi).tobytes("jpeg")).decode() for i in idx}
    rule = PAGE_RULE_KEEP if a.keep_page_numbers else PAGE_RULE_DROP
    done = [0]
    def job(i):
        t, m = read_page(i, imgs[i], rule); done[0] += 1; print(f"page {i + 1} ({done[0]}/{len(idx)}) via {m}", flush=True); return i, t, m
    with concurrent.futures.ThreadPoolExecutor(a.workers) as ex: res = sorted(ex.map(job, idx))
    frags = [t for _, t, _ in res]
    failed = [i + 1 for i, t, m in res if m == "failed"]
    full = "<!doctype html><html><head><meta charset='utf-8'><title>%s</title><style>body{font-family:'Times New Roman',serif;max-width:820px;margin:24px auto;padding:0 16px;line-height:1.5}table{border-collapse:collapse}td,th{padding:3px 6px;vertical-align:top}section{border-bottom:1px dashed #bbb;padding-bottom:12px;margin-bottom:12px}</style></head><body>%s</body></html>" % (
        html.escape(os.path.basename(a.pdf)), "\n".join(f"<section data-page='{i + 1}'>{t}</section>" for (i, t, _) in res))
    open(os.path.join(a.out, "document.html"), "w", encoding="utf-8").write(full)
    html_to_docx(frags, os.path.join(a.out, "document.docx"), os.path.basename(a.pdf))
    tin, tout = sum(x["in"] for x in LEDGER), sum(x["out"] for x in LEDGER)
    rep = {"file": os.path.basename(a.pdf), "pages": len(idx), "failed_pages": failed, "calls": len(LEDGER), "tokens_in": tin, "tokens_out": tout,
           "usd": round(sum(x["usd"] for x in LEDGER), 4), "usd_per_page": round(sum(x["usd"] for x in LEDGER) / max(1, len(idx)), 5),
           "seconds": round(time.time() - t0, 1), "by_model": {m: round(sum(x["usd"] for x in LEDGER if x["model"] == m), 4) for m in {x["model"] for x in LEDGER}},
           "retried_pages": sorted({x["page"] for x in LEDGER if sum(1 for y in LEDGER if y["page"] == x["page"]) > 1}), "ledger": LEDGER}
    json.dump(rep, open(os.path.join(a.out, "report.json"), "w"), indent=1)
    print(json.dumps({k: v for k, v in rep.items() if k != "ledger"}))


if __name__ == "__main__":
    main()
