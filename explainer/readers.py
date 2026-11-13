"""Readers for sources that are not a PDF: Word and PowerPoint files, and news or blog pages.
No side effects on import, so they can be tested on their own. gen.py calls them."""
import re, io, json, html, zipfile
import xml.etree.ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"


def is_office(data):
    """A .docx or .pptx is a zip file whose members say which one it is."""
    if data[:4] != b"PK\x03\x04": return ""
    try:
        names = zipfile.ZipFile(io.BytesIO(data)).namelist()
    except Exception:
        return ""
    if "word/document.xml" in names: return "docx"
    if any(n.startswith("ppt/slides/slide") for n in names): return "pptx"
    return ""


def _para_text(p):
    out = []
    for el in p.iter():
        if el.tag in (W + "t", A + "t") and el.text: out.append(el.text)
        elif el.tag in (W + "tab", W + "br", A + "br"): out.append(" ")
    return "".join(out).strip()


def office_text(data):
    """Returns (title, text) of a Word or PowerPoint file. Headings keep their own line, a table row is one line with ' | ' between cells,
    a slide starts with 'Slide n' so the script can say where an idea comes from, and speaker notes are kept."""
    kind = is_office(data)
    if not kind: raise RuntimeError("That file could not be opened as a Word or PowerPoint document.")
    z = zipfile.ZipFile(io.BytesIO(data))
    lines, title = [], ""
    try:
        core = ET.fromstring(z.read("docProps/core.xml"))
        for el in core.iter():
            if el.tag.endswith("}title") and el.text: title = el.text.strip()
    except Exception: pass
    if kind == "docx":
        root = ET.fromstring(z.read("word/document.xml")); body = root.find(W + "body")
        def table(tbl):
            for tr in tbl.iter(W + "tr"):
                cells = []
                for tc in tr.findall(W + "tc"):
                    cells.append(" ".join(t for t in (_para_text(p) for p in tc.iter(W + "p")) if t))
                if any(cells): lines.append(" | ".join(cells))
        for ch in (body if body is not None else []):
            if ch.tag == W + "p":
                t = _para_text(ch)
                if t: lines.append(t)
            elif ch.tag == W + "tbl": table(ch)
        for extra in ("word/footnotes.xml",):
            if extra in z.namelist():
                for p in ET.fromstring(z.read(extra)).iter(W + "p"):
                    t = _para_text(p)
                    if len(t) > 20: lines.append(t)
    else:
        def num(n): return int(re.search(r"(\d+)\.xml$", n).group(1))
        slides = sorted([n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)], key=num)
        for n in slides:
            root = ET.fromstring(z.read(n)); k = num(n)
            ps = [t for t in (_para_text(p) for p in root.iter(A + "p")) if t]
            if ps: lines.append(f"Slide {k}"); lines.extend(ps)
            nn = f"ppt/notesSlides/notesSlide{k}.xml"
            if nn in z.namelist():
                notes = [t for t in (_para_text(p) for p in ET.fromstring(z.read(nn)).iter(A + "p")) if t and not t.isdigit()]
                if notes: lines.append("Notes: " + " ".join(notes))
    text = re.sub(r"[ \t]+", " ", "\n".join(lines)).strip()
    if not title or len(title) < 6:
        title = next((l for l in lines if len(l) > 6 and not l.startswith("Slide ")), "Document")
    return title[:200], text


# ---------------------------------------------------------------- web pages

_DROP = r"script|style|noscript|svg|iframe|form|nav|header|footer|aside|button|select|template|figcaption"


def _txt(h):
    h = re.sub(r"<[^>]+>", " ", h)
    return re.sub(r"\s+", " ", html.unescape(h)).strip()


def _jsonld_body(h):
    best = ""
    for m in re.finditer(r"<script[^>]+application/ld\+json[^>]*>(.*?)</script>", h, re.S | re.I):
        try: data = json.loads(m.group(1).strip())
        except Exception: continue
        stack = [data]
        while stack:
            o = stack.pop()
            if isinstance(o, list): stack.extend(o)
            elif isinstance(o, dict):
                b = o.get("articleBody")
                if isinstance(b, str) and len(b) > len(best): best = b
                stack.extend(v for v in o.values() if isinstance(v, (dict, list)))
    return _txt(best) if best else ""


def page_title(h):
    for rx in (r"<meta[^>]+property=[\"']og:title[\"'][^>]+content=[\"']([^\"']+)", r"<meta[^>]+content=[\"']([^\"']+)[\"'][^>]+property=[\"']og:title[\"']",
               r"<meta[^>]+name=[\"']citation_title[\"'][^>]+content=[\"']([^\"']+)", r"<h1[^>]*>(.*?)</h1>", r"<title[^>]*>(.*?)</title>"):
        m = re.search(rx, h, re.S | re.I)
        if m:
            t = _txt(m.group(1))
            if len(t) > 3: return t[:200]
    return "Article"


def article_text(h):
    """The readable text of a news article, blog post or web page: the article's own paragraphs and headings, without menus, share buttons,
    related-story lists and comment forms. Uses the structured article body when the page has one."""
    ld = _jsonld_body(h)
    h2 = re.sub(r"<!--.*?-->", " ", h, flags=re.S)
    h2 = re.sub(r"<(%s)\b[^>]*>.*?</\1>" % _DROP, " ", h2, flags=re.S | re.I)
    cands = []
    for tag in ("article", "main"):
        for m in re.finditer(r"<%s\b[^>]*>(.*?)</%s>" % (tag, tag), h2, re.S | re.I): cands.append(m.group(1))
    for m in re.finditer(r"<(?:div|section)\b[^>]+(?:id|class)=[\"'][^\"']*(?:article[-_ ]?(?:body|content|text)|post[-_ ]?content|entry[-_ ]?content|story[-_ ]?body|detail[-_ ]?content|fck_detail|content[-_ ]?detail)[^\"']*[\"'][^>]*>(.*?)</(?:div|section)>", h2, re.S | re.I):
        cands.append(m.group(1))
    cands.append(h2)

    def blocks(frag):
        out, seen = [], set()
        for m in re.finditer(r"<(h[1-4]|p|li|blockquote|td)\b[^>]*>(.*?)</\1>", frag, re.S | re.I):
            t = _txt(m.group(2)); tag = m.group(1).lower()
            if tag == "li" and len(t) < 50: continue
            if tag == "td" and len(t) < 40: continue
            if len(t) < (3 if tag.startswith("h") else 25) or t in seen: continue
            seen.add(t); out.append(("## " if tag.startswith("h") else "") + t)
        return out

    best = ""
    for frag in cands:
        txt = "\n".join(blocks(frag))
        if len(txt) > len(best) * 1.15 or (not best and txt): best = txt   # a later, wider candidate only wins when it is clearly longer
        if len(best) > 1500 and frag is not cands[-1]: break   # the article element is enough: do not widen to the whole page
    if len(ld) > len(best) * 0.8 and len(ld) >= 600: best = ld
    return best.strip()
