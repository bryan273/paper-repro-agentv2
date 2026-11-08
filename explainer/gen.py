"""Paper -> grounded scene script -> narration audio -> script json for player.html.
usage: python gen.py 1706.03762 [--seconds 24] [--voice-en en-US-AriaNeural] [--voice-zh zh-CN-XiaoxiaoNeural]"""
import sys, os, re, json, html, time, asyncio, subprocess, argparse, urllib.request
sys.stdout.reconfigure(encoding="utf-8")
import edge_tts

ROOT = os.path.dirname(os.path.abspath(__file__))
ENV = dict(os.environ)   # on the server renderer the key comes from the environment
_dotenv = os.path.join(ROOT, "..", ".env") if os.path.exists(os.path.join(ROOT, "..", ".env")) else "C:/Users/bryan/Documents/Github/paper-repro-agent/.env"
if os.path.exists(_dotenv):
    for line in open(_dotenv, encoding="utf-8"):
        if "=" in line and not line.startswith("#"):
            k, v = line.rstrip("\n").split("=", 1); ENV.setdefault(k, v.strip().strip('"'))

def get_bytes(url, ms=40):
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (paper-explainer)"}), timeout=ms).read(30_000_000)

def get(url, ms=40):
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "paper-explainer/0.1"}), timeout=ms).read().decode("utf-8", "ignore")

def clean(h):
    h = re.sub(r"<script.*?</script>|<style.*?</style>|<annotation.*?</annotation>", " ", h, flags=re.S)
    h = re.sub(r"</(p|div|h\d|li|tr)>", "\n", h); h = re.sub(r"<[^>]+>", " ", h)
    return re.sub(r"[ \t]+", " ", html.unescape(h)).strip()

import ipaddress, socket
def safe_url(url):
    from urllib.parse import urlparse
    u = urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname: raise RuntimeError("That link is not a web address.")
    for ai in socket.getaddrinfo(u.hostname, None):
        ip = ipaddress.ip_address(ai[4][0])
        if any(ip in ipaddress.ip_network(n) for n in ("198.18.0.0/15", "fdfe:dcba:9876::/48") if ip.version == ipaddress.ip_network(n).version): continue   # fake-ip range used by local proxies, not a real internal host
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved: raise RuntimeError("That link points to a private address.")
    return url

def ensure_readable(text, what="document"):
    """Stop at the very first step when the text is garbled (a scanned or protected PDF, a wrong encoding, a symbol font), instead of writing a script and rendering a video about noise."""
    sample = text[:30000]
    chars = [c for c in sample if not c.isspace()]
    msg = ("We could not read the text of this %s: it looks garbled or protected (for example a scanned or locked PDF). "
           "Try another link, a different PDF, or paste the text instead. Nothing was charged." % what)
    if len(chars) < 200: raise RuntimeError(msg)
    def common(c):
        o = ord(c)
        return (o < 0x250 and not (0x1BB < o < 0x250 and o not in (0x1A0, 0x1A1, 0x1AF, 0x1B0))) or 0x1EA0 <= o <= 0x1EF9 or 0x370 <= o <= 0x3FF or 0x400 <= o <= 0x4FF             or 0x3040 <= o <= 0x30FF or 0x3400 <= o <= 0x9FFF or 0xAC00 <= o <= 0xD7AF or 0xFF00 <= o <= 0xFFEF
    letters = [c for c in chars if c.isalpha()]
    pua = sum(1 for c in chars if 0xE000 <= ord(c) <= 0xF8FF or c in ("\ufffd", "\x00"))
    odd = sum(1 for c in letters if not common(c))
    if pua / len(chars) > 0.02 or (letters and odd / len(letters) > 0.12) or len(letters) / len(chars) < 0.45:
        raise RuntimeError(msg)
    latin_words = re.findall(r"[A-Za-z\u00C0-\u024F\u1EA0-\u1EF9]{3,}", sample)
    cjk = sum(1 for c in chars if "\u3400" <= c <= "\u9fff" or "\u3040" <= c <= "\u30ff" or "\uac00" <= c <= "\ud7af")
    if cjk < len(chars) * 0.2 and len(latin_words) < 80: raise RuntimeError(msg)
    return text

def paper_url(url):
    """Any paper that is not on arXiv: a direct PDF, a paper page, or a DOI. Returns (title, abstract, text)."""
    safe_url(url)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (paper-explainer)", "Accept": "application/pdf,text/html;q=0.9,*/*;q=0.5"})
    r = urllib.request.urlopen(req, timeout=60); data = r.read(30_000_000); ctype = (r.headers.get("content-type") or "").lower()
    safe_url(r.geturl())
    if "pdf" in ctype or data[:5] == b"%PDF-" or url.lower().split("?")[0].endswith(".pdf"):
        import fitz
        doc = fitz.open(stream=data, filetype="pdf"); text = "\n".join(p.get_text() for p in doc)
        title = (doc.metadata or {}).get("title") or ""
        if len(title.strip()) < 6: title = next((l.strip() for l in text.splitlines() if len(l.strip()) > 12), "Paper")
    else:
        h = data.decode("utf-8", "ignore")
        m = re.search(r"<meta[^>]+name=[\"']citation_title[\"'][^>]+content=[\"']([^\"']+)", h, re.I) or re.search(r"<title>(.*?)</title>", h, re.S | re.I)
        title = html.unescape(re.sub(r"\s+", " ", m.group(1))).strip() if m else "Paper"
        text = clean(h)
        pm = re.search(r"<meta[^>]+href=[\"']([^\"']+\.pdf)[\"']|<meta[^>]+name=[\"']citation_pdf_url[\"'][^>]+content=[\"']([^\"']+)", h, re.I)
        if len(text) < 3000 and pm:   # a landing page: follow its PDF link
            from urllib.parse import urljoin
            return paper_url(urljoin(r.geturl(), pm.group(1) or pm.group(2)))
    text = re.sub(r"[ \t]+", " ", text).strip()
    if len(text) < 1500: raise RuntimeError("Could not read enough text from that link. Try a direct PDF link.")
    ensure_readable(text, "link")
    return title[:200], text[:1500], text[:60000]

def page_texts(data):
    """The text of each page of a PDF (so an answer or a scene can say which page its sentence is on). Best effort: [] if the PDF cannot be read."""
    try:
        import fitz
        doc = fitz.open(stream=data, filetype="pdf")
        return [re.sub(r"\s+", " ", p.get_text().replace(chr(0), " ")).strip()[:7000] for p in doc][:60]
    except Exception as e:
        print("page texts skipped:", str(e)[:100]); return []

def extract_figures(data, out, limit=10):
    """Crop the figures of a PDF (the picture above each "Figure N" caption) to PNG files, so a scene can show the paper's own chart or diagram.
    Best effort: returns [{"id","page","caption","file"}], [] when nothing usable is found."""
    figs = []
    try:
        import fitz
        doc = fitz.open(stream=data, filetype="pdf"); fd = os.path.join(out, "figs"); os.makedirs(fd, exist_ok=True)
        seen = set()
        for pno, page in enumerate(doc):
            if len(figs) >= limit or pno > 40: break
            pr = page.rect
            blocks = [b for b in page.get_text("blocks") if b[6] == 0]
            caps = [b for b in blocks if re.match(r"^\s*(Figure|Fig\.)\s*(\d+)", b[4] or "")]
            if not caps: continue
            art = [fitz.Rect(i["bbox"]) for i in page.get_image_info() if fitz.Rect(i["bbox"]).width > 60 and fitz.Rect(i["bbox"]).height > 40]
            art += [fitz.Rect(d["rect"]) for d in page.get_drawings() if d["rect"].width > 6 and d["rect"].height > 6 and d["rect"].width < pr.width * 0.98]
            for c in caps:
                n = re.match(r"^\s*(?:Figure|Fig\.)\s*(\d+)", c[4]).group(1)
                if n in seen: continue
                cap = fitz.Rect(c[:4])
                above = [r for r in art if r.y1 <= cap.y0 + 4 and r.y1 > cap.y0 - pr.height * 0.95 and r.y0 >= 0]
                if len(above) < 1: continue
                top = min(r.y0 for r in above); ys = cap.y0 - 3
                # grow upward only through art that is connected to the picture (no body text in between)
                texts = [fitz.Rect(b[:4]) for b in blocks if b is not c and len(b[4] or "") > 120]
                clip = fitz.Rect(max(0, min(r.x0 for r in above) - 6), max(0, top - 6), min(pr.width, max(r.x1 for r in above) + 6), ys)
                if any(t.intersects(clip) and t.height > 18 and t.width > clip.width * 0.6 for t in texts): continue
                if clip.width < 120 or clip.height < 70: continue
                f = os.path.join(fd, f"fig{n}.png"); page.get_pixmap(clip=clip, dpi=170).save(f)
                if os.path.getsize(f) < 6000: os.remove(f); continue
                seen.add(n); figs.append({"id": f"fig{n}", "page": pno + 1, "caption": re.sub(r"\s+", " ", c[4]).strip()[:200], "file": f"figs/fig{n}.png"})
                if len(figs) >= limit: break
    except Exception as e:
        print("figures skipped:", str(e)[:120])
    json.dump(figs, open(os.path.join(out, "figures.json"), "w", encoding="utf-8"), ensure_ascii=False)
    return figs

def paper_file(path):
    """A PDF the visitor uploaded (already saved on this machine). Returns (title, abstract, text)."""
    import fitz
    data = open(path, "rb").read(30_000_000)
    if data[:5] != b"%PDF-":   # pasted text or a .txt / .md file: any subject, not only papers
        text = re.sub(r"[ \t]+", " ", data.decode("utf-8", "ignore").replace(chr(0), " ")).strip()
        if len(text) < 300: raise RuntimeError("That text is too short to explain. Paste at least a few paragraphs.")
        ensure_readable(text, "text")
        title = next((l.strip().lstrip("#").strip() for l in text.splitlines() if len(l.strip()) > 6), "Text")
        return title[:200], text[:1500], text[:60000]
    try: doc = fitz.open(stream=data, filetype="pdf")
    except Exception: raise RuntimeError("That PDF could not be opened. It may be damaged or password protected.")
    text = "\n".join(p.get_text() for p in doc)
    title = (doc.metadata or {}).get("title") or ""
    if len(title.strip()) < 6: title = next((l.strip() for l in text.splitlines() if len(l.strip()) > 12), "Paper")
    text = re.sub(r"[ \t]+", " ", text).strip()
    if len(text) < 1500: raise RuntimeError("Could not read enough text from that PDF. Scanned pages without text are not supported.")
    ensure_readable(text, "PDF")
    return title[:200], text[:1500], text[:60000]

def paper(arxiv):
    xml = get(f"https://export.arxiv.org/api/query?id_list={arxiv}")
    title = re.sub(r"\s+", " ", re.search(r"<title>(.*?)</title>", xml.split("<entry>")[1], re.S).group(1)).strip()
    abstract = re.sub(r"\s+", " ", re.search(r"<summary>(.*?)</summary>", xml, re.S).group(1)).strip()
    try: full = clean(get(f"https://arxiv.org/html/{arxiv}"))
    except Exception:
        try: full = clean(get(f"https://ar5iv.labs.arxiv.org/html/{arxiv}"))
        except Exception: full = ""
    return title, abstract, (abstract + "\n" + full)[:60000]

SYSTEM = """You turn one source text (a research paper, an article, a lesson, a report or notes) into a short, accurate explainer video script. Return ONLY JSON.
Style: {TONE} Never invent facts or numbers: every number or claim must come from the PAPER TEXT given.
Schema: {"title":str,"section":{"title":str(max 7 words, names what the section is about, never the paper title),"title_zh":str,"text":str(2 to 3 plain sentences that explain the content itself as a reader would want it, e.g. "Older models read a sentence one word at a time, which is slow..."; never write \"this part\" or \"this section\"),"text_zh":str,"takeaway":str(one sentence),"takeaway_zh":str},"scenes":[scene,...]}. Each scene has: "type", "en" (the spoken narration of this scene: 2 sentences, 18 to 32 words, that flow as continuous speech; title and end scenes use one short sentence), "zh" (the same narration in natural spoken Chinese, not a word-for-word translation),
"evidence" (a verbatim quote of at most 25 words copied exactly from the paper text that supports the scene, or null for title/end), plus fields by type:
- "title": {"big":str,"sub":str}  (big = 1-2 words, sub = short line; first scene)
- "cards": {"cards":[{"h":str(max 3 words),"t":str(max 9 words)}, 2 to 4 items]}  (use for problem / ideas / comparison)
- "tokens": {"words":[5 to 7 words],"links":[[from_index,to_index,weight 0-1],...],"focus":int}  (shows words attending to each other)
- "flow": {"nodes":[{"h":str,"t":str},3 to 5 items]}  (a pipeline or architecture)
- "number": {"value":number,"unit":str,"label":str,"bars":[{"label":str,"value":number}...] optional}  (a headline result; value must appear in the paper)
- "quote": {"text":str,"source":str}  (text must be a verbatim quote)
- "figure": {"fig":str}  (shows one of the paper's own figures, by id from the FIGURES list below; use it for a scene whose narration explains what that figure shows, up to a third of the scenes; never invent an id)
- "end": {"big":str,"sub":str,"note":str}  (last scene)
{ORDER} Total spoken length about {SECONDS} seconds at normal speed (about {WORDS} words in all, counting English only). Write it as one person talking to a friend, not as a list of captions: join the scenes with natural transitions ("So", "Here is the catch", "That is why", "Now"), start the next scene from where the last one stopped, never repeat what an earlier scene already said, and make an abstract idea concrete with one short example or analogy when it helps. Use as many scenes as that length needs and vary the scene types.{CUSTOM}"""

TONES = {
    "teacher": "simple words, one idea per scene, like a clear teacher.",
    "casual": "friendly and conversational, like a smart friend explaining over coffee; light and a little playful, never silly, still precise.",
    "academic": "precise and formal, the register of a conference talk; use the paper's own terms and say exactly what was measured.",
    "eli5": "for a complete beginner: everyday analogies, no jargon (explain any term in plain words the first time), very short sentences.",
    "story": "a narrative: start from the problem the researchers faced, build tension, then the turn and the payoff.",
}
SECTIONS = ["the problem and why it matters", "what earlier approaches did and where they fall short", "the key idea", "the main components or architecture",
            "how it works and is trained, step by step", "the experimental setup", "the main results", "ablations and what drives the results",
            "limits and open questions", "what it means and the takeaway"]

PLAN_SYSTEM = """You plan a short explainer video about one source text (a research paper, article, lesson, report or notes) that is told in {N} consecutive sections. Return ONLY JSON: {"sections":[{"title":str(max 7 words),"focus":str(one sentence),"points":[3 or 4 short concrete points from the paper this section explains, each a different fact, method step or number]}]} with exactly {N} sections.
Rules: the sections follow the paper's own logic (problem, idea, method, evidence, meaning) and tell one story from first to last; no point appears in two sections; every point comes from the PAPER TEXT; the last section ends on what it means for the reader."""

def plan_sections(title, text, n, model):
    """One cheap call that decides what each section covers, so the sections written in parallel do not repeat each other."""
    try:
        r, _ = llm(PLAN_SYSTEM.replace("{N}", str(n)), f"TITLE: {title}\n\nPAPER TEXT:\n{text[:30000]}", model)
        sec = r.get("sections") or []
        if len(sec) == n and all(isinstance(x, dict) and x.get("title") for x in sec): return sec
    except Exception as e: print("plan skipped:", str(e)[:120], flush=True)
    return None

def part_plan(seconds):
    """The video is written as sections of roughly 50 seconds, each its own short video, so no single model call has to write it all."""
    n = max(1, min(10, round(seconds / 50)))
    return n, [round(seconds / n)] * n

def order_for(i, n, plan=None):
    if n > 1 and plan and len(plan) == n:
        me = plan[i]; others = "; ".join(f"{k + 1}. {p['title']}" for k, p in enumerate(plan) if k != i)
        before = f" The section before this one covered: {plan[i - 1]['title']}; continue from there without recapping it." if i else ""
        after = f" The section after this one covers: {plan[i + 1]['title']}; leave that to it." if i < n - 1 else ""
        pts = "; ".join(me.get("points") or [])
        return (f"This is section {i + 1} of {n} of one video; each section is a short video of its own, and together they tell one story. This section is about: {me['title']} ({me.get('focus', '')}). "
                f"Cover these points, in this order: {pts}. The other sections of the video are: {others}. Do NOT cover their content here, and do not repeat it.{before}{after} "
                + ("Start with a title scene. " if i == 0 else "Do NOT use a title scene; open straight into the point. ")
                + ("End with an end scene." if i == n - 1 else "Do NOT use an end scene; stop after the last point of this section."))
    if n == 1: return "Order: title, problem (cards), key idea (tokens or flow), how it works (flow or cards), result (number), end."
    L = len(SECTIONS); lo, hi = i * L // n, max(i * L // n, (i + 1) * L // n - 1)
    focus = "; then ".join(SECTIONS[lo:hi + 1])
    first, last = i == 0, i == n - 1
    return (f"This is section {i + 1} of {n} of one video; each section is a short video of its own. Cover only: {focus}. "
            + ("Start with a title scene. " if first else "Do NOT use a title scene; open straight into the point. ")
            + ("End with an end scene." if last else "Do NOT use an end scene; stop after the last point of this section."))

MODELS = {   # selectable script writers: id -> (base url, model name, env key, extra body)
    "deepseek": ("https://api.deepseek.com/v1", "deepseek-flash", "DEEPSEEK_API_KEY", {"thinking": {"type": "disabled"}}),
    "stepfun": ("https://api.stepfun.com/v1", "step-3.5-flash", "STEPFUN_API_KEY", {}),
    "paratera": ("https://llmapi.paratera.com/v1", "DeepSeek-V4.1-Flash", "PARATERA_API_KEY", {}),   # DeepSeek served by the Tsinghua Paratera gateway
}
MODELS["rkapi"] = (os.environ.get("RKAPI_BASE_URL", "https://rkapi.com") + "/v1", os.environ.get("RKAPI_MODEL", "claude-haiku-4-5-20251001"), "RKAPI_API_KEY", {})
MODELS["relay"] = ((ENV.get("SUPABASE_URL") or "") + "/functions/v1", "DeepSeek-V4.1-Flash", "SUPABASE_SECRET", {})   # Paratera through the Asian-region relay: the US renderer reaches the gateway badly
MODEL_ORDER = ["rkapi", "relay", "deepseek", "paratera", "stepfun"]

def lenient_json(txt):
    """A model that stops mid-answer or leaves one bad quote: keep everything up to the last complete value instead of losing the whole call."""
    start = txt.find("{")
    if start < 0: return None
    body = txt[start:]; tries = 0
    p = body.rfind("}")
    while p > 0 and tries < 80:
        stack, in_str, esc = [], False, False
        for ch in body[:p + 1]:
            if in_str:
                if esc: esc = False
                elif ch == chr(92): esc = True
                elif ch == '"': in_str = False
                continue
            if ch == '"': in_str = True
            elif ch in "{[": stack.append("}" if ch == "{" else "]")
            elif ch in "}]" and stack: stack.pop()
        if not in_str:
            try:
                v = json.loads(body[:p + 1] + "".join(reversed(stack)))
                if isinstance(v, dict) and v.get("scenes"): return v
            except Exception: pass
        p = body.rfind("}", 0, p); tries += 1
    return None

def llm_one(mid, system, user, attempt=0):
    base, name, keyname, extra = MODELS[mid]
    if not ENV.get(keyname): raise RuntimeError(f"{mid}: no key configured")
    stream = mid == "rkapi"   # RKAPI holds a non-streamed answer for a minute or more; streamed it answers at once
    payload = {"model": name, "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}], "temperature": 0.3, "max_tokens": 8000, **extra}
    if stream: payload["stream"] = True
    elif mid not in ("relay", "paratera"): payload["response_format"] = {"type": "json_object"}   # the DeepSeek gateway answers empty in JSON mode under load; the reply is parsed leniently instead
    hdr = {"Authorization": "Bearer " + ENV[keyname], "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (paper-explainer)"}
    if mid == "relay": url = base + "/llm-relay"; hdr.update({"x-region": ("ap-northeast-2", "ap-southeast-1")[attempt % 2], "x-timeout-ms": "90000"})
    else: url = base + "/chat/completions"
    r = urllib.request.Request(url, json.dumps(payload).encode(), hdr)
    resp = urllib.request.urlopen(r, timeout=100)
    if stream:
        txt, usage = "", {}
        for raw in resp:
            line = raw.decode("utf-8", "ignore").strip()
            if not line.startswith("data:") or line.endswith("[DONE]"): continue
            try: ch = json.loads(line[5:])
            except Exception: continue
            for c in ch.get("choices") or []: txt += (c.get("delta") or {}).get("content") or ""
            usage = ch.get("usage") or usage
    else:
        out = json.load(resp); txt = out["choices"][0]["message"]["content"] or ""; usage = out.get("usage", {})
    try:
        import usage as _u
        _u.rec(name, usage.get("prompt_tokens"), usage.get("completion_tokens"), system + user, txt, "script")
    except Exception: pass
    m = re.search(r"\{.*\}", txt, re.S)
    try: return json.loads(m.group(0) if m else txt), usage
    except json.JSONDecodeError:
        fixed = lenient_json(txt)
        if fixed is None: raise
        return fixed, usage

RK_DEAD_UNTIL = [0.0]

def llm(system, user, model="deepseek"):
    """The chosen model first; if its account is out of credit or down, the other one, so a video is not lost to a billing problem.
    The gateway's model list sometimes goes empty for a minute or two ("Invalid model name"), so a model that answers like that is waited out, not dropped."""
    if model == "deepseek" and ENV.get("RKAPI_API_KEY"): model = "rkapi"
    elif model == "deepseek" and ENV.get("SUPABASE_SECRET") and ENV.get("SUPABASE_URL"): model = "relay"
    elif model == "deepseek" and ENV.get("PARATERA_API_KEY"): model = "paratera"
    order = [model] + [m for m in MODEL_ORDER if m != model]
    if time.time() < RK_DEAD_UNTIL[0]: order = [m for m in order if m != "rkapi"] or order   # the gateway just failed every call: do not spend a minute on it for each section
    last = None; t_end = time.time() + 300
    for mid in order:
        patient = mid in ("relay", "paratera")
        if mid == "rkapi" and not ENV.get("RKAPI_API_KEY"): continue
        for attempt in range(6 if patient else 3):
            if time.time() > t_end and last is not None: break
            try:
                sc, usage = llm_one(mid, system, user, attempt); usage = dict(usage or {}); usage["model_used"] = mid; return sc, usage
            except urllib.error.HTTPError as e:
                last = e; body = e.read()[:200]; print(f"llm {mid} attempt {attempt}: HTTP {e.code} {body!r}", flush=True)
                if patient and (e.code in (429, 500, 502, 503, 504) or (e.code == 400 and b"Invalid model name" in body)):
                    time.sleep(min(6 + attempt * 2, 16)); continue   # no deployments for a moment: wait and ask again
                if mid == "rkapi" and e.code in (429, 500, 502, 503, 504) and attempt < 2:
                    time.sleep(4 * (attempt + 1)); continue   # a busy moment on the gateway (several sections ask at once): ask again before giving up on it
                if e.code in (401, 402, 403, 429, 502, 503):   # out of credit, no access or busy: try the next model
                    if mid == "rkapi": RK_DEAD_UNTIL[0] = time.time() + 600
                    break
            except Exception as e:
                last = e; print(f"llm {mid} attempt {attempt}: {type(e).__name__} {str(e)[:200]}", flush=True)
                if patient: time.sleep(4)
    raise RuntimeError(f"all script models failed: {last}")

OTHER = {"vi": ("Vietnamese", "vi-VN-HoaiMyNeural", "vi-VN-NamMinhNeural"), "id": ("Indonesian", "id-ID-GadisNeural", "id-ID-ArdiNeural")}   # languages made as one-language videos besides en and zh
FIGS = []   # the figures cropped from the paper: scenes may show them
SLOT = {"v": "zh"}   # the field that carries the second narration: "zh" normally, the language code for a Vietnamese or Indonesian video

def localize(sysmsg, code):
    """Ask for the narration and the section texts in another language, in the field named after its code."""
    name = OTHER[code][0]
    sysmsg = sysmsg.replace('"zh" (the same narration in natural spoken Chinese, not a word-for-word translation)', f'"{code}" (the same narration in natural spoken {name}, not a word-for-word translation)')
    for f in ("title", "text", "takeaway"): sysmsg = sysmsg.replace(f'"{f}_zh"', f'"{f}_{code}"')
    return sysmsg

def norm(s): return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()

def normalize(sc):
    """A scene missing the fields its type needs becomes a plain card scene, so one sloppy scene cannot break the video."""
    need = {"figure": ("fig",), "title": ("big",), "cards": ("cards",), "tokens": ("words",), "flow": ("nodes",), "number": ("value",), "quote": ("text",), "end": ("big",)}
    keep = []
    for s in sc.get("scenes") or []:
        if not isinstance(s, dict) or not s.get("en") or not s.get(SLOT["v"]): continue
        t = s.get("type")
        for f in ("cards", "nodes", "words"):   # a model sometimes wraps the list as {"cards": [...]}, as the prompt example is written
            if isinstance(s.get(f), dict): s[f] = s[f].get(f) if isinstance(s[f].get(f), list) else None
        ok = t in need and all(s.get(f) not in (None, "", []) for f in need[t])
        if ok and t == "figure" and s.get("fig") not in {f["id"] for f in FIGS}: ok = False
        if ok and t == "figure": s["cards"] = [{"h": "Figure", "t": (next((f["caption"] for f in FIGS if f["id"] == s["fig"]), "") or s["en"])[:60]}]
        if ok and t == "number":
            try: float(str(s["value"]).replace(",", ""))
            except ValueError: ok = False
        if not ok: s["type"] = "cards"; s["cards"] = s.get("cards") if isinstance(s.get("cards"), list) and s["cards"] else [{"h": "Key point", "t": s["en"][:50]}]
        keep.append(s)
    sc["scenes"] = keep
    return sc

def verify(sc, text):
    """keep evidence only if it really is in the paper (whitespace/punctuation tolerant)"""
    nt = norm(text); bad = []
    text = text + "\n" + re.sub(r"(?<=\d),(?=\d{3})", "", text)   # "10,000" also counts as "10000"
    for i, s in enumerate(sc["scenes"]):
        ev = s.get("evidence")
        if ev and norm(ev) not in nt: bad.append((i, ev)); s["evidence"] = None
        if s["type"] == "quote" and norm(s["text"]) not in nt: bad.append((i, "quote")); s["type"] = "cards"; s["cards"] = [{"h": "Key point", "t": s["en"][:50]}]
        if s["type"] == "number":
            v = str(s["value"]).rstrip("0").rstrip(".") if "." in str(s["value"]) else str(s["value"])
            if v not in text: bad.append((i, f"number {s['value']} not in paper"))
            for b in s.get("bars") or []:
                bv = str(b["value"]).rstrip("0").rstrip(".") if "." in str(b["value"]) else str(b["value"])
                if bv not in text: bad.append((i, f"bar {b['value']} not in paper")); s["bars"] = [x for x in s["bars"] if x is not b]
    return bad

async def tts(text, voice, path):
    last = None
    for k in range(6):
        try:
            proxy = None if k % 2 == 0 or os.name != "nt" else "http://127.0.0.1:7897"   # local proxy only on the laptop
            # streamed so the word timings come along: captions and animations are cued on the spoken word
            async def run():
                words = []
                comm = edge_tts.Communicate(text, voice, rate="-4%", proxy=proxy, boundary="WordBoundary")
                with open(path, "wb") as fh:
                    async for ch in comm.stream():
                        if ch["type"] == "audio": fh.write(ch["data"])
                        elif ch["type"] == "WordBoundary": words.append([round(ch["offset"] / 1e7, 3), round((ch["offset"] + ch["duration"]) / 1e7, 3), ch["text"]])
                json.dump(words, open(path[:-4] + ".words.json", "w", encoding="utf-8"), ensure_ascii=False)
            await asyncio.wait_for(run(), 45)
            if os.path.getsize(path) > 2000: return
        except Exception as e:
            last = e; await asyncio.sleep(1.5)
    raise RuntimeError(f"tts failed: {last}")

def trim_tail(path):
    """The speech engine leaves about half a second of silence after every clip; with many clips that reads as a stop after every sentence."""
    tmp = path[:-4] + ".trim.mp3"
    af = "areverse,silenceremove=start_periods=1:start_threshold=-42dB:start_silence=0.12,areverse"
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", path, "-af", af, "-c:a", "libmp3lame", "-q:a", "4", tmp], capture_output=True)
    if r.returncode == 0 and os.path.exists(tmp) and os.path.getsize(tmp) > 2000: os.replace(tmp, path)
    elif os.path.exists(tmp): os.remove(tmp)

def dur_ms(path):
    return float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]).decode().strip()) * 1000

async def main():
    ap = argparse.ArgumentParser(); ap.add_argument("arxiv"); ap.add_argument("--url", default=""); ap.add_argument("--file", default=""); ap.add_argument("--model", default="deepseek"); ap.add_argument("--slug", default=""); ap.add_argument("--seconds", type=int, default=24)
    ap.add_argument("--voice-en", default="en-US-AriaNeural"); ap.add_argument("--voice-zh", default="zh-CN-XiaoxiaoNeural"); ap.add_argument("--reuse", action="store_true"); ap.add_argument("--tone", default="teacher"); ap.add_argument("--theme", default="classic"); ap.add_argument("--custom", default=""); ap.add_argument("--langs", default="both"); ap.add_argument("--voice-x", default="")
    a = ap.parse_args()
    if a.langs in OTHER: SLOT["v"] = a.langs
    out = os.path.join(ROOT, "out", (a.slug or a.arxiv).replace("/", "_")); os.makedirs(out, exist_ok=True)
    LABEL = 'uploaded PDF' if a.file else (__import__('urllib.parse').parse.urlparse(a.url).hostname or 'paper').replace('www.', '') if a.url else f'arXiv:{a.arxiv}'
    try:
        title, abstract, text = paper_file(a.file) if a.file else paper_url(a.url) if a.url else paper(a.arxiv); print("paper:", title, "| text chars", len(text)); open(os.path.join(out, "paper.txt"), "w", encoding="utf-8").write(text)
        try:
            pdf = open(a.file, "rb").read(30_000_000) if a.file else (get_bytes(f"https://arxiv.org/pdf/{a.arxiv}") if (a.arxiv and not a.url) else b"")
            if pdf[:5] == b"%PDF-":
                json.dump(page_texts(pdf), open(os.path.join(out, "pages.json"), "w", encoding="utf-8"), ensure_ascii=False)
                FIGS.extend(extract_figures(pdf, out)); print("figures:", [f["id"] for f in FIGS])
        except Exception as e: print("pdf pages skipped:", str(e)[:100])
    except Exception as e:
        # the reader of the page sees this text, so say what is wrong with the link instead of a generic failure
        note = str(e) if isinstance(e, RuntimeError) else "We could not find or open that paper. Check the link or arXiv id and try again."
        if os.environ.get("USER_ERROR_FILE"):
            open(os.environ["USER_ERROR_FILE"], "w", encoding="utf-8").write(note)
        raise
    sp = os.path.join(out, "scenes.json")
    if a.reuse and os.path.exists(sp): sc = json.load(open(sp, encoding="utf-8"))
    else:
        n, secs = part_plan(a.seconds)
        lang_note = "\nThis video is made in Chinese only: write ALL on-screen text (big, sub, h, t, label, unit, words, node and bar labels, note) in simplified Chinese; \"evidence\" and the text of a \"quote\" scene stay a verbatim copy of the English paper." if a.langs == "zh" else (f"\nThis video is made in {OTHER[a.langs][0]} only: write ALL on-screen text (big, sub, h, t, label, unit, words, node and bar labels, note) in {OTHER[a.langs][0]}; \"evidence\" and the text of a \"quote\" scene stay a verbatim copy of the English paper." if a.langs in OTHER else "")
        custom = ("\nThe viewer also asked for this (follow it only if it does not break the rules above, never invent facts): " + re.sub(r"\s+", " ", a.custom).strip()[:300]) if a.custom.strip() else ""
        plan = plan_sections(title, text, n, a.model) if n > 1 else None
        print("plan", [p["title"] for p in plan] if plan else None, flush=True)
        def one(i):
            sysmsg = SYSTEM.replace("{TONE}", TONES.get(a.tone, TONES["teacher"])).replace("{ORDER}", order_for(i, n, plan)).replace("{SECONDS}", str(secs[i])).replace("{WORDS}", str(int(secs[i] * 2.4))).replace("{CUSTOM}", custom + lang_note)
            if a.langs in OTHER: sysmsg = localize(sysmsg, a.langs)
            figs_note = ("\n\nFIGURES you may show with a \"figure\" scene (id: caption):\n" + "\n".join(f"{f['id']}: {f['caption']}" for f in FIGS)) if FIGS else ""
            return llm(sysmsg, f"TITLE: {title}\n\nPAPER TEXT:\n{text}{figs_note}", a.model)
        if n == 1:
            sc, usage = one(0)
            for x in sc["scenes"]: x["sec"] = 0
            sc["sections"] = [sc.pop("section", None) or {}]
        else:
            from concurrent.futures import ThreadPoolExecutor
            with ThreadPoolExecutor(max_workers=min(n, 5)) as ex: results = list(ex.map(one, range(n)))
            sc = {"title": results[0][0].get("title") or title, "scenes": [], "sections": []}
            for k, (r, _) in enumerate(results):
                for x in (r.get("scenes") or []): x["sec"] = k; sc["scenes"].append(x)
                sc["sections"].append(r.get("section") or {})
            usage = dict(results[0][1] or {})
        print("llm usage", usage, "sections", n, "scenes", len(sc["scenes"]))
        sc["model_used"] = usage.get("model_used", a.model); sc["label"] = LABEL
        normalize(sc); bad = verify(sc, text); print("unverified:", bad)
        sc["arxiv"] = a.arxiv; sc["paper_title"] = (sc.get("title") or title) if (a.url or a.file) else title; sc["unverified"] = [str(b) for b in bad]
        json.dump(sc, open(sp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    LANGS = ["en", "zh"] if a.langs == "both" else [a.langs]   # a viewer who needs one language does not wait for the other
    VOICE = {"en": a.voice_en, "zh": a.voice_zh, **({a.langs: a.voice_x or OTHER[a.langs][1]} if a.langs in OTHER else {})}
    gate = asyncio.Semaphore(8)   # narration is a few clips per section: fetch them side by side, in every language at once
    async def clip(lang, i, s):
        p = os.path.join(out, f"{lang}_{i}.mp3")
        if not (os.path.exists(p) and os.path.getsize(p) > 2000):
            async with gate: await tts(s[lang], VOICE[lang], p)
            trim_tail(p)
    await asyncio.gather(*(clip(lg, i, s) for lg in LANGS for i, s in enumerate(sc["scenes"])))
    for lang in LANGS:
        scenes = json.loads(json.dumps(sc["scenes"]))
        for i, s in enumerate(scenes):
            p = os.path.join(out, f"{lang}_{i}.mp3")
            s["audio"] = f"{lang}_{i}.mp3"; s["audio_ms"] = dur_ms(p); s["dur"] = int(max(s["audio_ms"] + 350, 2600))   # a small breath after each scene, not a pause
            if s["type"] in ("cards", "flow", "tokens") : s["dur"] = max(s["dur"], 3600)
            if s.get("evidence") is not None: s["evidence"] = f"{LABEL} · \u201c{s['evidence']}\u201d" if len(s["evidence"]) < 90 else LABEL
            elif s["type"] not in ("title", "end"): s["evidence"] = LABEL
        json.dump({"title": sc["title"], "arxiv": a.arxiv, "lang": lang, "mono": a.langs != "both", "theme": a.theme, "scenes": scenes, "total": sum(s["dur"] for s in scenes)},
                  open(os.path.join(out, f"script_{lang}.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print(lang, "total seconds", round(sum(s["dur"] for s in scenes) / 1000, 1))
        for k in range(len(sc.get("sections") or [])):
            part = [s for s in scenes if s.get("sec") == k]
            if part: json.dump({"title": sc["title"], "arxiv": a.arxiv, "lang": lang, "mono": a.langs != "both", "theme": a.theme, "scenes": part, "total": sum(s["dur"] for s in part)},
                               open(os.path.join(out, f"script_{lang}_s{k}.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    meta = []
    for k, sec in enumerate(sc.get("sections") or []):
        part = [s for s in sc["scenes"] if s.get("sec") == k]
        if not part: continue
        meta.append({"i": k, "title": sec.get("title") or f"Part {k + 1}", "title_zh": sec.get("title_zh") or sec.get("title") or f"第 {k + 1} 部分",
                     "text": sec.get("text") or " ".join(s["en"] for s in part), "text_zh": sec.get("text_zh") or "".join(s.get("zh") or "" for s in part),
                     "takeaway": sec.get("takeaway") or "", "takeaway_zh": sec.get("takeaway_zh") or "",
                     **({f"title_{a.langs}": sec.get(f"title_{a.langs}") or sec.get("title") or "", f"text_{a.langs}": sec.get(f"text_{a.langs}") or " ".join(s[a.langs] for s in part), f"takeaway_{a.langs}": sec.get(f"takeaway_{a.langs}") or ""} if a.langs in OTHER else {})})
    json.dump(meta, open(os.path.join(out, "sections.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
asyncio.run(main())
