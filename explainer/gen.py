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

def get(url, ms=40):
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "paper-explainer/0.1"}), timeout=ms).read().decode("utf-8", "ignore")

def clean(h):
    h = re.sub(r"<script.*?</script>|<style.*?</style>|<annotation.*?</annotation>", " ", h, flags=re.S)
    h = re.sub(r"</(p|div|h\d|li|tr)>", "\n", h); h = re.sub(r"<[^>]+>", " ", h)
    return re.sub(r"[ \t]+", " ", html.unescape(h)).strip()

def paper(arxiv):
    xml = get(f"https://export.arxiv.org/api/query?id_list={arxiv}")
    title = re.sub(r"\s+", " ", re.search(r"<title>(.*?)</title>", xml.split("<entry>")[1], re.S).group(1)).strip()
    abstract = re.sub(r"\s+", " ", re.search(r"<summary>(.*?)</summary>", xml, re.S).group(1)).strip()
    try: full = clean(get(f"https://arxiv.org/html/{arxiv}"))
    except Exception:
        try: full = clean(get(f"https://ar5iv.labs.arxiv.org/html/{arxiv}"))
        except Exception: full = ""
    return title, abstract, (abstract + "\n" + full)[:60000]

SYSTEM = """You turn one research paper into a short, accurate explainer video script. Return ONLY JSON.
Style: simple words, one idea per scene, like a clear teacher. Never invent facts or numbers: every number or claim must come from the PAPER TEXT given.
Schema: {"title":str,"scenes":[scene,...]}. Each scene has: "type", "en" (one spoken sentence, max 22 words), "zh" (the same sentence in Chinese, natural),
"evidence" (a verbatim quote of at most 25 words copied exactly from the paper text that supports the scene, or null for title/end), plus fields by type:
- "title": {"big":str,"sub":str}  (big = 1-2 words, sub = short line; first scene)
- "cards": {"cards":[{"h":str(max 3 words),"t":str(max 9 words)}, 2 to 4 items]}  (use for problem / ideas / comparison)
- "tokens": {"words":[5 to 7 words],"links":[[from_index,to_index,weight 0-1],...],"focus":int}  (shows words attending to each other)
- "flow": {"nodes":[{"h":str,"t":str},3 to 5 items]}  (a pipeline or architecture)
- "number": {"value":number,"unit":str,"label":str,"bars":[{"label":str,"value":number}...] optional}  (a headline result; value must appear in the paper)
- "quote": {"text":str,"source":str}  (text must be a verbatim quote)
- "end": {"big":str,"sub":str,"note":str}  (last scene)
Order: title, problem (cards), key idea (tokens or flow), how it works (flow or cards), result (number), end. Total spoken length about {SECONDS} seconds at normal speed (about {WORDS} words in all)."""

def llm(system, user):
    body = json.dumps({"model": "deepseek-flash", "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                       "temperature": 0.3, "max_tokens": 2600, "response_format": {"type": "json_object"}, "thinking": {"type": "disabled"}}).encode()
    r = urllib.request.Request("https://api.deepseek.com/v1/chat/completions", body, {"Authorization": "Bearer " + ENV["DEEPSEEK_API_KEY"], "Content-Type": "application/json"})
    out = json.load(urllib.request.urlopen(r, timeout=120))
    return json.loads(out["choices"][0]["message"]["content"]), out.get("usage", {})

def norm(s): return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()

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
            await asyncio.wait_for(edge_tts.Communicate(text, voice, rate="-4%", proxy=proxy).save(path), 45)
            if os.path.getsize(path) > 2000: return
        except Exception as e:
            last = e; await asyncio.sleep(1.5)
    raise RuntimeError(f"tts failed: {last}")

def dur_ms(path):
    return float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]).decode().strip()) * 1000

async def main():
    ap = argparse.ArgumentParser(); ap.add_argument("arxiv"); ap.add_argument("--seconds", type=int, default=24)
    ap.add_argument("--voice-en", default="en-US-AriaNeural"); ap.add_argument("--voice-zh", default="zh-CN-XiaoxiaoNeural"); ap.add_argument("--reuse", action="store_true")
    a = ap.parse_args()
    out = os.path.join(ROOT, "out", a.arxiv.replace("/", "_")); os.makedirs(out, exist_ok=True)
    title, abstract, text = paper(a.arxiv); print("paper:", title, "| text chars", len(text))
    sp = os.path.join(out, "scenes.json")
    if a.reuse and os.path.exists(sp): sc = json.load(open(sp, encoding="utf-8"))
    else:
        sysmsg = SYSTEM.replace("{SECONDS}", str(a.seconds)).replace("{WORDS}", str(int(a.seconds * 2.4)))
        sc, usage = llm(sysmsg, f"TITLE: {title}\n\nPAPER TEXT:\n{text}"); print("llm usage", usage)
        bad = verify(sc, text); print("unverified:", bad)
        sc["arxiv"] = a.arxiv; sc["paper_title"] = title; sc["unverified"] = [str(b) for b in bad]
        json.dump(sc, open(sp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    for lang, voice in (("en", a.voice_en), ("zh", a.voice_zh)):
        scenes = json.loads(json.dumps(sc["scenes"]))
        for i, s in enumerate(scenes):
            p = os.path.join(out, f"{lang}_{i}.mp3")
            if not (os.path.exists(p) and os.path.getsize(p) > 2000): await tts(s[lang], voice, p)
            s["audio"] = f"{lang}_{i}.mp3"; s["audio_ms"] = dur_ms(p); s["dur"] = int(max(s["audio_ms"] + 900, 3200))
            if s["type"] in ("cards", "flow", "tokens") : s["dur"] = max(s["dur"], 4200)
            if s.get("evidence") is not None: s["evidence"] = f"arXiv:{a.arxiv} · \u201c{s['evidence']}\u201d" if len(s["evidence"]) < 90 else f"arXiv:{a.arxiv}"
            elif s["type"] not in ("title", "end"): s["evidence"] = f"arXiv:{a.arxiv}"
        json.dump({"title": sc["title"], "arxiv": a.arxiv, "lang": lang, "scenes": scenes, "total": sum(s["dur"] for s in scenes)},
                  open(os.path.join(out, f"script_{lang}.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print(lang, "total seconds", round(sum(s["dur"] for s in scenes) / 1000, 1))
asyncio.run(main())
