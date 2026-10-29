"""One section as an AI-drawn Manim animation, synced to its narration.
Claude (through RKAPI) writes a Manim scene for the section's beats; the scene is checked, rendered without secrets or network,
and on an error the traceback goes back to the model to fix (up to 3 tries). The narration and two-line subtitles are laid on after.
usage: python manim_section.py <slug> <section>   (reads out/<slug>/scenes.json, script_en.json, script_zh.json, sections.json)
writes out/<slug>/<slug>_en_s<k>.mp4 and <slug>_zh_s<k>.mp4. Exit 2 = no working animation, the caller uses the template player."""
import sys, os, re, ast, json, time, shutil, getpass, subprocess, urllib.request
sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.abspath(__file__))
slug, k = sys.argv[1], int(sys.argv[2])
d = os.path.join(ROOT, "out", slug)
BASE = os.environ.get("RKAPI_BASE_URL", "https://rkapi.com") + "/v1"
# (model, key): measured on the same section (29 Oct): gpt-6.1-sol drew the cleanest, best spaced pictures at terra's price; terra drew richer but messier ones; gpt-6-astra is as clean but 5x the price; claude-opus-4-8 only wrote small floating text; Sonnet 4.6 is the steady last resort
LADDER = [(m, os.environ.get(k, "")) for m, k in (("gpt-6.1-sol", "RKAPI_OPENAI_KEY"), ("gpt-5.6-terra", "RKAPI_OPENAI_KEY"), ("claude-sonnet-4-6", "RKAPI_API_KEY"))]
if os.environ.get("MANIM_MODEL"): LADDER = [(os.environ["MANIM_MODEL"], os.environ.get("RKAPI_OPENAI_KEY" if os.environ["MANIM_MODEL"].startswith("gpt") else "RKAPI_API_KEY", ""))]
LADDER = [(m, k) for m, k in LADDER if k]
if not LADDER: print("no RKAPI key: template player instead"); sys.exit(2)

sc = json.load(open(os.path.join(d, "scenes.json"), encoding="utf-8"))
meta = next((m for m in json.load(open(os.path.join(d, "sections.json"), encoding="utf-8")) if m["i"] == k), {})
idx = [i for i, s in enumerate(sc["scenes"]) if s.get("sec") == k]
dur = {lang: json.load(open(os.path.join(d, f"script_{lang}.json"), encoding="utf-8"))["scenes"] for lang in ("en", "zh")}
# a beat lasts as long as the longer of its two narrations, so both languages fit the same picture
beats = [round(max(dur["en"][i]["dur"], dur["zh"][i]["dur"]) / 1000, 2) for i in idx]
NARR_DELAY = 0.15   # each narration clip starts this long after its beat
def words_of(lang, i):
    try: return json.load(open(os.path.join(d, f"{lang}_{i}.words.json"), encoding="utf-8"))
    except Exception: return []
norm = lambda w: re.sub(r"[^0-9a-z]+", "", str(w).lower())
# per beat: [seconds from the beat start, word] of the English narration, so a picture can appear on the word that names it
CUES = {n: [[round(a + NARR_DELAY, 2), norm(w)] for a, _, w in words_of("en", i) if norm(w)] for n, i in enumerate(idx)}
THEMES = {"classic": ("#04070c", "#3dff8f", "#4aa3ff", "#e9f3ff", "#8aa0b8"), "light": ("#f4f1ea", "#4a3cf0", "#e0560f", "#17171c", "#6a6a75"),
          "sunset": ("#120a1f", "#ff7a59", "#c86bff", "#fff1ea", "#b496b0"), "cinema": ("#050510", "#c9a96a", "#6a8fd8", "#f2efe6", "#8a86a0"), "mono": ("#050505", "#ffffff", "#9aa0aa", "#f4f4f4", "#8a8a8a")}
theme = json.load(open(os.path.join(d, "script_en.json"), encoding="utf-8")).get("theme") or "classic"
BG, ACC, ACC2, TXT, MUT = THEMES.get(theme, THEMES["classic"])
CINEMA = ("\nLook: cinematic documentary. Deep blue-black space, thin gold lines and gold highlights, slow smooth movement, a few faint drifting dots as background, generous empty space, labels in a serif font (font=\"Georgia\"). Each idea arrives like a title card: fade in, hold, fade out. Calm and elegant, never busy." if theme == "cinema" else "")
work = os.path.join(d, f"manim_s{k}")
shutil.rmtree(work, ignore_errors=True); os.makedirs(work)

HARNESS_HEAD = f'''from manim import *
import numpy as np, math, random, json, contextlib
config.background_color = "{BG}"
BG, ACCENT, ACCENT2, TEXT, MUTED = "{BG}", "{ACC}", "{ACC2}", "{TXT}", "{MUT}"
BEATS = {beats!r}
CUES = {CUES!r}
PALETTE = [ACCENT, ACCENT2, "#ffb547", "#ff6b9a", "#a78bfa"]
FONT = {('"Inter"' if os.name != "nt" else '""')}
ICON_DIR = {os.path.join(ROOT, "icons")!r}
'''
HARNESS_BODY = open(os.path.join(ROOT, "kit.py"), encoding="utf-8").read() + r'''
def _bb(m):
    return (m.get_left()[0], m.get_right()[0], m.get_bottom()[1], m.get_top()[1])

def _shown(m):
    try:
        parts = m.family_members_with_points()[:6] or [m]
        return any(max(p.get_fill_opacity(), p.get_stroke_opacity() if p.get_stroke_width() > 0 else 0) > 0.03 for p in parts)
    except Exception:
        return True

def _overlap(a, b, pad=0.0):
    w = min(a[1], b[1]) + pad - max(a[0], b[0]) + pad
    h = min(a[3], b[3]) + pad - max(a[2], b[2]) + pad
    return (w, h) if w > 0 and h > 0 else (0.0, 0.0)

def _audit_now(scene, i):
    """What a viewer sees at the end of beat i, checked with numbers: text over text, text cut by a line or a box edge, text outside the frame or in the subtitle strip."""
    out = []
    try:
        skip, glyphs, texts, shapes = set(), set(), [], []
        tops = list(scene.mobjects)
        for top in tops:
            for m in top.get_family():
                if isinstance(m, CoordinateSystem): skip.update(id(x) for x in m.get_family())
                if isinstance(m, (Text, MarkupText)):
                    glyphs.update(id(x) for x in m.get_family() if x is not m)
        for top in tops:
            for m in top.get_family():
                if id(m) in glyphs or id(m) in skip: continue
                if isinstance(m, (Text, MarkupText)):
                    if _shown(m) and m.width > 0.01: texts.append(m)
                elif isinstance(m, VMobject) and len(m.points) > 0 and (m.width > 0.02 or m.height > 0.02) and _shown(m):
                    shapes.append(m)
        name = lambda t: '"' + str(getattr(t, "original_text", None) or getattr(t, "text", "?"))[:32] + '"'
        for a in range(len(texts)):
            ta = _bb(texts[a])
            if ta[0] < -6.9 or ta[1] > 6.9 or ta[3] > 3.9:
                out.append(f"text {name(texts[a])} is outside the frame (x {ta[0]:.1f}..{ta[1]:.1f}, y {ta[2]:.1f}..{ta[3]:.1f}): move it in or shrink it")
            elif ta[2] < -2.7:
                out.append(f"text {name(texts[a])} sits in the subtitle strip (bottom y {ta[2]:.1f}): keep everything above y -2.4")
            for b in range(a + 1, len(texts)):
                tb = _bb(texts[b]); w, h = _overlap(ta, tb)
                if w * h > 0.15 * min((ta[1] - ta[0]) * (ta[3] - ta[2]), (tb[1] - tb[0]) * (tb[3] - tb[2])) and w > 0.05 and h > 0.04:
                    out.append(f"text {name(texts[a])} overlaps text {name(texts[b])}: put them apart (next_to with buff 0.3, or arrange)")
            for sh in shapes:
                sb = _bb(sh)
                try: closed = sh.is_closed()
                except Exception: closed = True
                if not closed:
                    # a line, arrow or arc: look at the path itself, not its bounding box; the ends may touch what they point at
                    if not (_overlap(ta, sb, 0.02)[0] > 0):
                        continue
                    hits = 0
                    for f in np.linspace(0.15, 0.85, 36):
                        p = sh.point_from_proportion(f)
                        if ta[0] + 0.04 < p[0] < ta[1] - 0.04 and ta[2] + 0.04 < p[1] < ta[3] - 0.04: hits += 1
                    if hits:
                        out.append(f"a line or arrow at ({(sb[0] + sb[1]) / 2:.1f}, {(sb[2] + sb[3]) / 2:.1f}) runs through text {name(texts[a])}: route it around the label or move the label off it")
                    continue
                if max(sb[1] - sb[0], sb[3] - sb[2]) < 0.3: continue   # dots and arrow tips
                thin = min(sb[1] - sb[0], sb[3] - sb[2]) < 0.15
                w, h = _overlap(ta, sb, 0.02 if thin else 0.0)
                if not (w > 0 and h > 0): continue
                inside = sb[0] <= ta[0] + 0.03 and sb[1] >= ta[1] - 0.03 and sb[2] <= ta[2] + 0.03 and sb[3] >= ta[3] - 0.03
                swallow = ta[0] <= sb[0] and ta[1] >= sb[1] and ta[2] <= sb[2] and ta[3] >= sb[3]
                at = f"({(sb[0] + sb[1]) / 2:.1f}, {(sb[2] + sb[3]) / 2:.1f})"
                if thin and w * h > 0.0005 and not swallow:
                    out.append(f"a line or arrow at {at} crosses text {name(texts[a])}: route it around the label or move the label off it")
                elif not thin and not inside and not swallow and w * h > 0.06 * (ta[1] - ta[0]) * (ta[3] - ta[2]):
                    out.append(f"text {name(texts[a])} sticks out of or cuts the edge of a {type(sh).__name__} at {at}: fit the label inside (use Box) or move it clear")
        for sh in shapes:
            if isinstance(sh, Arc) and not isinstance(sh, (Circle, Dot)) and sh.get_arc_length() > 0.8:
                ends = [sh.get_start(), sh.get_end()]
                others = [_bb(t) for t in texts] + [_bb(o) for o in shapes if o is not sh and not isinstance(o, Arc)]
                lost = [e for e in ends if not any(b[0] - 0.45 <= e[0] <= b[1] + 0.45 and b[2] - 0.45 <= e[1] <= b[3] + 0.45 for b in others)]
                if lost:
                    c = sh.get_center()
                    out.append(f"an arc around ({c[0]:.1f}, {c[1]:.1f}) is floating: its end at ({lost[0][0]:.1f}, {lost[0][1]:.1f}) touches nothing; keep arcs attached to the words or boxes they connect (move them together with their row)")
        if not texts and not shapes:
            out.append("the frame is empty")
    except Exception:
        return []
    seen, res = set(), []
    for m in out:
        if m not in seen:
            seen.add(m); res.append({"beat": i, "msg": m})
    return res[:5]

class ExplainerScene(Scene):
    """with self.beat(i): ... runs beat i; whatever time its animations leave over is waited out, and each beat's real start is recorded."""
    _starts = []
    _audit = []
    @contextlib.contextmanager
    def beat(self, i):
        t0 = self.renderer.time
        type(self)._starts.append(t0)
        yield
        left = BEATS[i] - (self.renderer.time - t0)
        if left > 0.02: self.wait(left)
        type(self)._audit.extend(_audit_now(self, i))
    def until(self, i, word, lead=0.15):
        """Inside beat i: wait until the narrator says `word` (the first one still ahead), so what is drawn next appears on that word."""
        w = re.sub(r"[^0-9a-z]+", "", str(word).lower().split()[0] if str(word).split() else "")
        el = self.renderer.time - type(self)._starts[i]
        for t, x in CUES.get(i, []):
            if x == w and t - lead > el + 0.03:
                gap = t - lead - el
                if gap > 0.7 and any(m["msg"] == "the frame is empty" for m in _audit_now(self, i)):
                    type(self)._audit.append({"beat": i, "msg": f"the stage is empty for {gap:.1f} s while waiting for the word '{word}': keep the previous picture (or show the new one) until then, FadeOut and FadeIn together"})
                self.wait(gap); return
    def tear_down(self):
        json.dump({"starts": type(self)._starts, "end": self.renderer.time}, open("beat_times.json", "w"))
        json.dump(type(self)._audit, open("audit.json", "w"))
'''
HARNESS = HARNESS_HEAD + HARNESS_BODY

SYSTEM = f"""You are the motion designer of a high-quality explainer channel (think 3Blue1Brown, Kurzgesagt, a good YouTube tutorial). You write ONE Manim Community scene that explains one section of a research paper, synced word by word to its narration.
Return ONLY Python code in one ```python block: a single class `Section(ExplainerScene)` with `construct(self)`. Do not import anything: `from manim import *`, `np`, `math`, `random`, the colours BG, ACCENT, ACCENT2, TEXT, MUTED, PALETTE (5 colours) and BEATS (seconds per beat) are available.

HARD RULES (checked; the code is rejected otherwise)
- For every beat i, in order, one block `with self.beat(i):`. Inside it, run_times plus waits total at most BEATS[i] seconds (the rest is waited out for you). Every beat visibly changes something.
- NO LaTeX: never Tex, MathTex, DecimalNumber, Integer, Variable, Matrix, Brace, BraceLabel, BarChart, Title, Code, MathTable, add_coordinates, get_axis_labels, get_graph_label. All text is Text (unicode is fine: √ Σ × ≈ → ≤ ² ³).
- No files, SVGs, images, sound, network, OS access, config, getattr/eval/exec, dunder names.
- Everything inside x [-6.6, 6.6], y [-2.4, 3.7] (the bottom is the caption strip). Never write narration sentences on screen: labels of at most 6 words. Text size 26 or more.
- Every number on screen comes from the beat data; never invent results.

THE DESIGN KIT (use these: they are laid out, sized and spaced for you, so nothing overlaps)
  Heading(text)                                   title at the top for a beat that needs one
  BigNumber(value, label)  /  g, t = Counter(target, label, decimals, suffix) then self.play(t.animate.set_value(target))
  Bars(labels, values, highlight=i, unit="%")      .base .bars .values .labels ; GrowFromEdge(b, DOWN)
  HBars(labels, values, highlight=i)               rankings ; GrowFromEdge(b, LEFT)
  LinePlot(ys, xs, x_label, y_label)               .axes .curve ; trends, training curves, scaling
  Donut(percent, label)                            .ring .arc .value ; a share or a rate
  Compare(left_title, [..], right_title, [..])     .left .right .left_items .right_items ; before/after, old/new, problem/fix
  Pipeline([steps], icons=[..])                    .nodes .arrows .labels ; a process, a method, data flow
  Timeline([(when, what), ..])                     .line .events ; history, stages of training
  IconRow([(icon, label), ..])  /  IconLabel(icon, label)  /  Icon(name, size, color)
  Tokens([words], highlight=[i])  +  Attention(tokens, [(i, j), ..], weights)   language, attention, tokenisation
  NeuralNet((3, 5, 5, 2), labels=[..])             .edges .layers ; models, layers
  Heatmap(matrix, row_labels, col_labels)          .cells ; attention maps, confusion matrices, similarity
  Stack([bottom .. top labels])                    .layers ; architectures, stacks of blocks
  Equation(["y", "=", "F(x)", "+", "x"], colors=[..])   build a formula piece by piece, Indicate the key part
  Quote(text, source)                              a short line quoted from the paper
  Venn(a, b, both)  /  Callout(target, text, UR)  /  Box(label, w, h, color)  /  Lbl(text, size, color, w)  /  fit(mob, w, h)  /  wrap(text, n)
  Icons: brain cpu database file-text image globe zap layers search lock users clock target trending-up trending-down eye message-square book-open graduation-cap lightbulb puzzle network git-branch shuffle repeat filter scale gauge rocket shield-check sparkles languages type cog box boxes grid-3x3 list-ordered check x alert-triangle sigma function-square scan-search workflow microscope flask-conical award timer coins server cloud camera music video bot user code chart-column chart-line chart-pie arrow-right split merge
  Every kit piece is a VGroup you can move (.move_to, .shift, .scale, .to_edge), animate, Transform and FadeOut. You may also draw your own shapes when the idea needs it.

DESIGN RULES
- Variety: choose the form that fits what the narration says (a number -> BigNumber/Counter, a comparison of results -> Bars/HBars, a trend -> LinePlot, a process -> Pipeline, two approaches -> Compare, words or attention -> Tokens+Attention, an architecture -> Stack/NeuralNet, history -> Timeline, a formula -> Equation). Never use the same kind of picture in two beats in a row, use at least four different kinds in the section, and at most one beat may be plain boxes.
- One idea per beat, big and centred; the main picture spans at least 8 units wide or 4 tall. Before a new idea, FadeOut what is no longer needed (or Transform the old picture into the new one when they are related).
- Sync to the voice: the narration's word timings are given per beat. `self.until(i, "word")` waits inside beat i until that word is spoken; put it right before the animation that shows that thing, so it appears exactly when it is named (for example `self.until(3, "residual")` then `self.play(GrowArrow(shortcut))`). Use one to three cues per beat.
- The stage is never empty: each beat starts from the previous picture (Transform it, or FadeOut old and FadeIn new in the SAME self.play) and the main picture of a beat appears in its first second; use until() for the parts that follow (the second bar, the highlight, the arrow), never to delay the whole picture. Remove a group as a whole (FadeOut(group)), never leave half of a picture (arcs without their words, labels without their bars). Things that belong together move together: `VGroup(tk, arcs).animate.shift(UP)`.
- Motion with purpose: entrances 0.5 to 1.0 s (FadeIn with shift, GrowFromCenter, Create, LaggedStart), then emphasise what the voice stresses (Indicate, Circumscribe, Flash, a colour change, a gentle scale). No long static holds, no spinning for its own sake.
- Colour means something: ACCENT for the paper's idea or the winner, ACCENT2 for the other side, MUTED for context and baselines, PALETTE for categories.
- Never leave dimmed leftovers behind a new picture (set_opacity(0.1) ghosts): FadeOut them completely.
- Never put text on an arrow or a line, never two labels in the same place; the picture is measured after every beat and any overlap is sent back to you.
{CINEMA}"""

def user_msg():
    b = []
    for n, i in enumerate(idx):
        s = {kk: v for kk, v in sc["scenes"][i].items() if kk not in ("zh", "audio", "audio_ms", "dur", "sec", "evidence")}
        cue = " ".join(f"{w}@{t:.1f}" for t, w in CUES.get(n, []))
        b.append({"beat": n, "seconds": beats[n], **s, "spoken_words_at": cue})
    return (f"PAPER: {sc.get('paper_title') or sc.get('title')}\nSECTION {k + 1}: {meta.get('title', '')}\nWHAT IT EXPLAINS: {meta.get('text', '')}\n"
            f"KEY TAKEAWAY: {meta.get('takeaway', '')}\nBEATS (the narration said during each beat, with the visual hint and data):\n{json.dumps(b, ensure_ascii=False, indent=1)}")

BANNED = {"Tex", "MathTex", "SingleStringMathTex", "DecimalNumber", "Integer", "Variable", "Matrix", "Brace", "BraceLabel", "BraceBetweenPoints", "BarChart", "Title",
          "Code", "MathTable", "IntegerTable", "DecimalTable", "ImageMobject", "SVGMobject", "config", "open", "exec", "eval", "compile", "__import__", "globals", "locals",
          "vars", "getattr", "setattr", "delattr", "input", "breakpoint", "exit", "quit", "help", "os", "sys", "subprocess", "socket", "shutil", "pathlib", "requests",
          "urllib", "importlib", "builtins", "contextlib", "json"}
BANNED_ATTR = {"add_coordinates", "get_axis_labels", "get_x_axis_label", "get_y_axis_label", "get_graph_label", "renderer", "camera", "file_writer"}

def strip_imports(code):
    return "\n".join(l for l in code.splitlines() if not re.match(r"\s*(import\s+\w|from\s+\w+(\.\w+)*\s+import\s)", l))

def check(code):
    """Static gate before anything runs: the class is there, one beat block per beat, and nothing outside plain drawing."""
    tree = ast.parse(code)
    for n in ast.walk(tree):
        if isinstance(n, (ast.Import, ast.ImportFrom)): return "do not import anything"
        if isinstance(n, ast.Name) and n.id in BANNED: return f"`{n.id}` is not allowed (see the rules)"
        if isinstance(n, ast.Attribute) and (n.attr in BANNED_ATTR or n.attr.startswith("__")): return f"`.{n.attr}` is not allowed (see the rules)"
    if not any(isinstance(n, ast.ClassDef) and n.name == "Section" for n in tree.body): return "define class Section(ExplainerScene)"
    used = sorted({c.args[0].value for c in ast.walk(tree) if isinstance(c, ast.Call) and isinstance(c.func, ast.Attribute) and c.func.attr == "beat" and c.args and isinstance(c.args[0], ast.Constant)})
    if used != list(range(len(beats))): return f"use `with self.beat(i):` exactly once for each beat 0..{len(beats) - 1} (found {used})"
    return None

def ask(messages, model, key):
    body = json.dumps({"model": model, "max_tokens": 16000, "temperature": 0.4, "stream": True, "messages": messages}).encode()
    req = urllib.request.Request(BASE + "/chat/completions", body, {"Authorization": "Bearer " + key, "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (paper-explainer)"})
    txt = ""
    for raw in urllib.request.urlopen(req, timeout=240):   # streamed: RKAPI stalls non-streamed answers
        line = raw.decode("utf-8", "ignore").strip()
        if not line.startswith("data:") or line.endswith("[DONE]"): continue
        try: txt += (json.loads(line[5:])["choices"][0].get("delta") or {}).get("content") or ""
        except Exception: pass
    m = re.search(r"```(?:python)?\s*(.*?)```", txt, re.S)
    if m: return m.group(1).strip(), txt
    # no closing fence (the answer was cut or the model just stopped): drop an opening fence and any text before it
    return (re.sub(r"^[\s\S]*?```(?:python)?\s*", "", txt, count=1) if "```" in txt else txt).strip(), txt

def render(code):
    open(os.path.join(work, "section.py"), "w", encoding="utf-8").write(HARNESS + "\n\n" + code + "\n")
    for f in ("beat_times.json",):
        try: os.remove(os.path.join(work, f))
        except FileNotFoundError: pass
    cmd = [os.environ.get("MANIM_PYTHON") or sys.executable, "-m", "manim", "render", "-qm", "--fps", "30", "--disable_caching", "--media_dir", "media", "-o", "section.mp4", "section.py", "Section"]
    env = {"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", work), "SYSTEMROOT": os.environ.get("SYSTEMROOT", ""), "TEMP": work, "TMP": work, "PYTHONIOENCODING": "utf-8"}
    if os.name == "nt": env.update({v: os.environ.get(v, "") for v in ("USERPROFILE", "APPDATA", "LOCALAPPDATA", "WINDIR", "PATHEXT", "COMSPEC", "PROGRAMDATA")})   # what Windows itself needs; still no secrets
    if os.name != "nt" and shutil.which("unshare") and shutil.which("sudo"):
        # the generated code runs with no network and none of the job's secrets
        cmd = ["sudo", "unshare", "-n", "sudo", "-u", getpass.getuser(), "env", "-i", *[f"{a}={b}" for a, b in env.items() if b]] + cmd
        env = None
    try:
        p = subprocess.run(cmd, cwd=work, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=420)
    except subprocess.TimeoutExpired:
        return None, "rendering took too long: use fewer objects and simpler animations"
    vid = next((os.path.join(r, f) for r, _, fs in os.walk(os.path.join(work, "media")) for f in fs if f == "section.mp4"), None)
    if p.returncode != 0 or not vid or not os.path.exists(os.path.join(work, "beat_times.json")):
        tail = "\n".join((p.stdout + "\n" + p.stderr).strip().splitlines()[-40:])
        return None, tail or f"manim exited {p.returncode}"
    return vid, None

def ass_color(h):
    h = h.lstrip("#"); return f"&H00{h[4:6]}{h[2:4]}{h[0:2]}&"

def caption_track(lang, starts, end):
    """Captions in the video's own language, a short phrase at a time, the word being spoken lit in the accent colour (like a good tutorial).
    Falls back to whole sentences when the voice gave no word timings."""
    font = ("Microsoft YaHei" if os.name == "nt" else ("Noto Sans CJK SC" if lang == "zh" else "Inter"))
    ts = lambda t: f"{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}"
    esc = lambda x: x.replace("\\", "").replace("{", "(").replace("}", ")").replace("\n", " ")
    hi = ass_color(ACC)
    ass = ["[Script Info]", "ScriptType: v4.00+", "PlayResX: 1280", "PlayResY: 720", "WrapStyle: 0", "", "[V4+ Styles]",
           "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
           f"Style: S,{font},{40 if lang == 'en' else 42},&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,1,0,0,0,100,100,0,0,1,3,0,2,90,90,42,1", "", "[Events]",
           "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]
    PUNCT = ".,;:?!\u3002\uff0c\uff1b\uff1a\uff1f\uff01\u3001"
    for n, i in enumerate(idx):
        a0, b0 = starts[n], (starts[n + 1] if n + 1 < len(starts) else end)
        sent = sc["scenes"][i][lang]
        ws = words_of(lang, i)
        if not ws:
            ass.append(f"Dialogue: 0,{ts(a0 + 0.05)},{ts(max(a0 + 0.5, b0 - 0.1))},S,,0,0,0,,{esc(sent)}"); continue
        # cut the sentence at each spoken word, so punctuation and spacing come from the script
        pieces, cur = [], 0
        for k, (t, _, w) in enumerate(ws):
            pos = sent.find(w, cur)
            if pos < 0: pieces.append([t, w]); continue
            pieces.append([t, None, pos]); cur = pos + len(w)
        spans = []
        for k, p in enumerate(pieces):
            if p[1] is not None: spans.append([p[0], p[1]]); continue
            nxt = next((q[2] for q in pieces[k + 1:] if q[1] is None), len(sent))
            spans.append([p[0], sent[p[2]:nxt].strip() if lang == "en" else sent[p[2]:nxt].strip()])
        # phrases: up to 7 words (English) or 16 characters (Chinese), cut after punctuation
        chunks, cur_c = [], []
        for t, txt in spans:
            cur_c.append([t, txt])
            size = len(cur_c) if lang == "en" else sum(len(x[1]) for x in cur_c)
            if (lang == "en" and size >= 7) or (lang == "zh" and size >= 16) or (txt and txt[-1] in PUNCT and size >= (3 if lang == "en" else 6)):
                chunks.append(cur_c); cur_c = []
        if cur_c: chunks.append(cur_c)
        sep = " " if lang == "en" else ""
        for c, ch in enumerate(chunks):
            c_end = (a0 + NARR_DELAY + chunks[c + 1][0][0]) if c + 1 < len(chunks) else max(a0 + 0.6, b0 - 0.1)
            for k, (t, txt) in enumerate(ch):
                st = a0 + NARR_DELAY + (ch[0][0] if k == 0 else t)
                en_ = (a0 + NARR_DELAY + ch[k + 1][0]) if k + 1 < len(ch) else c_end
                if en_ <= st + 0.02: continue
                line = sep.join((f"{{\\c{hi}}}{esc(x)}{{\\c&H00FFFFFF&}}" if j == k else esc(x)) for j, (_, x) in enumerate(ch))
                ass.append(f"Dialogue: 0,{ts(st)},{ts(en_)},S,,0,0,0,,{line}")
    open(os.path.join(work, f"subs_{lang}.ass"), "w", encoding="utf-8").write("\n".join(ass) + "\n")

def subs_and_audio(vid, times):
    """Captions in each language (phrase by phrase, the spoken word highlighted) burned in, and each language's narration placed at its beat."""
    starts, end = times["starts"], times["end"]
    for lang in ("en", "zh"): caption_track(lang, starts, end)
    for lang in ("en", "zh"):
        inputs, filt = ["-i", vid], []
        for n, i in enumerate(idx):
            inputs += ["-i", os.path.join(d, f"{lang}_{i}.mp3")]
            ms = int((starts[n] + NARR_DELAY) * 1000)
            filt.append(f"[{n + 1}:a]adelay={ms}|{ms}[a{n}]")
        mix = "".join(f"[a{n}]" for n in range(len(idx))) + f"amix=inputs={len(idx)}:normalize=0,apad=whole_dur={end:.2f}[aout]"
        out = os.path.join(d, f"{slug}_{lang}_s{k}.mp4")
        subprocess.run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", ";".join(filt) + ";" + mix + ";[0:v]subtitles=subs_" + lang + ".ass[v]",
                        "-map", "[v]", "-map", "[aout]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
                        "-t", f"{end:.2f}", "-movflags", "+faststart", out], check=True, cwd=work)   # an explicit length: an unbounded padded stream filled the runner disk
        print(out, round(os.path.getsize(out) / 1e6, 1), "MB")
    shutil.rmtree(os.path.join(work, "media", "videos", "section", "720p30", "partial_movie_files"), ignore_errors=True)   # frames of the animation are not needed once it is muxed

REVIEW_MODEL = (os.environ.get("REVIEW_MODEL", "claude-sonnet-4-6"), os.environ.get("RKAPI_API_KEY", ""))

def frames_at(vid, t_list, tag, width=640):
    out = []
    for n, t in enumerate(t_list):
        jpg = os.path.join(work, f"{tag}_{n}.jpg")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{max(0.0, t):.2f}", "-i", vid, "-frames:v", "1", "-vf", f"scale={width}:-1", "-q:v", "5", jpg], check=True, cwd=work)
        out.append(jpg)
    return out

def review(vid, times):
    """Watch the animation the way a viewer does, in time: three frames per beat (soon after it starts, in the middle, just before it ends) with what the narrator says then.
    Checks that the picture matches the words, that it changes and settles cleanly, and that nothing is garbled. '' = fine."""
    import base64
    if not REVIEW_MODEL[1]: return ""
    starts = times["starts"]; end = times["end"]; content = []
    for n in range(len(beats)):
        a0 = starts[n]; b0 = starts[n + 1] if n + 1 < len(starts) else end
        ts = [a0 + 0.35 * (b0 - a0), a0 + 0.65 * (b0 - a0), b0 - 0.25]
        said = sc["scenes"][idx[n]]["en"]
        content.append({"type": "text", "text": f"BEAT {n} ({b0 - a0:.1f} s). Narrator says: \"{said}\"  Frames at 35%, 65% and the end of the beat:"})
        for jpg in frames_at(vid, ts, f"rv{n}"):
            content.append({"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(open(jpg, "rb").read()).decode()}})
    content.insert(0, {"type": "text", "text": (
        "You are a strict video editor reviewing an explainer animation of a research paper. For each beat you see three frames in time order and what the narrator says during it. "
        "Report ONLY real problems, at most 8, most serious first, one line each as `Beat N: problem -> fix`. Look for:\n"
        "1. MISMATCH: the picture does not show what the narrator says (random words, a generic diagram, wrong numbers, a chart whose bars do not match the claim).\n"
        "2. BROKEN: shapes that look wrong or distorted, arcs or arrows that float and touch nothing, text that is garbled, blurry or overlapping, labels cut off or outside the frame.\n"
        "3. LEFTOVERS: ghosts or half-faded elements from the previous beat still visible in the end frame; two ideas sharing the stage.\n"
        "4. STATIC OR EMPTY: all three frames identical although the narrator moves on, or an empty stage.\n"
        "5. TOO SMALL: text or pictures that would be unreadable on a phone.\n"
        "If everything is good, reply exactly OK.")})
    body = json.dumps({"model": REVIEW_MODEL[0], "max_tokens": 900, "temperature": 0, "messages": [{"role": "user", "content": content}]}).encode()
    req = urllib.request.Request(BASE + "/chat/completions", body, {"Authorization": "Bearer " + REVIEW_MODEL[1], "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (paper-explainer)"})
    try:
        txt = json.load(urllib.request.urlopen(req, timeout=180))["choices"][0]["message"]["content"].strip()
    except Exception as e:
        print("review failed:", str(e)[:120]); return ""
    return "" if txt.upper().startswith("OK") else txt[:1400]

def make_poster(vid, times):
    """The poster of this section: among the settled end-of-beat frames, the one with the most picture on it (never a mid-fade frame)."""
    try:
        from PIL import Image
        starts, end = times["starts"], times["end"]
        ts = [(starts[n + 1] if n + 1 < len(starts) else end) - 0.3 for n in range(len(starts))]
        best, pick = -1.0, None
        for jpg in frames_at(vid, ts, "poster", 960):
            im = Image.open(jpg).convert("L").crop((0, 0, 960, 400))
            px = list(im.getdata()); bgv = sorted(px)[len(px) // 4]
            ink = sum(1 for v in px if v > bgv + 40) / len(px)
            score = ink if ink < 0.45 else 0.45 - (ink - 0.45)   # a picture, not a wall of colour
            if score > best: best, pick = score, jpg
        if pick: shutil.copy(pick, os.path.join(d, f"{slug}_s{k}.jpg"))
    except Exception as e:
        print("poster skipped:", str(e)[:100])

messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user_msg()}]
t0 = time.time()
for attempt in range(4):
    model, key = LADDER[attempt % len(LADDER)]   # sol, terra, Sonnet, then sol again
    try:
        code, raw = ask(messages, model, key)
        code = strip_imports(code)
    except Exception as e:
        print(f"{model} call failed:", str(e)[:150]); time.sleep(3); continue
    problem = None
    try: problem = check(code)
    except SyntaxError as e: problem = f"SyntaxError: {e}"
    vid = None
    if not problem:
        vid, problem = render(code)
    print(f"attempt {attempt + 1} ({model}): {'ok' if vid else 'failed: ' + (problem or '')[:300]} ({round(time.time() - t0)}s)", flush=True)
    if vid:
        times = json.load(open(os.path.join(work, "beat_times.json")))
        def issues():
            try: return [f"Beat {x['beat']}: {x['msg']}" for x in json.load(open(os.path.join(work, "audit.json"), encoding="utf-8"))]
            except Exception: return []
        geo = issues(); n_geo = len(geo)
        # repair rounds: first what the numbers say (overlaps, spill), then, once those are clean, what the eyes of the reviewer say
        for rnd in range(2):
            found = "\n".join(geo)[:1400] if geo else review(vid, times)
            print(f"check {rnd + 1}:", (f"{n_geo} layout issues" if geo else found) or "no defects", flush=True)
            if not found or time.time() - t0 > 600: break
            keep = os.path.join(work, f"keep_{rnd}.mp4"); shutil.copy(vid, keep); keep_times = dict(times); fixed = False
            try:
                code2, raw2 = ask(messages + [{"role": "assistant", "content": raw}, {"role": "user", "content": f"The animation rendered, but the picture has these defects:\n{found}\nFix them (use the kit pieces, which are spaced for you; move things apart, shorten labels, FadeOut old things first) and return the whole corrected class in one ```python block, keeping every rule."}], model, key)
                code2 = strip_imports(code2)
                if not check(code2):
                    vid2, problem2 = render(code2)
                    geo2 = issues() if vid2 else geo
                    if vid2 and (len(geo2) < n_geo or (not geo and not geo2)):   # better than before, or the eyes' complaint fixed without new overlaps
                        vid, times, code, raw, geo, n_geo, fixed = vid2, json.load(open(os.path.join(work, "beat_times.json"))), code2, raw2, geo2, len(geo2), True
                        print("fix: ok", flush=True)
                    else: print("fix not better, keeping the previous version:", (problem2 or f"{len(geo2)} issues")[:120], flush=True)
            except Exception as e:
                print("fix skipped:", str(e)[:120], flush=True)
            if not fixed: vid, times = keep, keep_times; break   # a failed fix must not replace the version that worked
        open(os.path.join(work, "final_code.py"), "w", encoding="utf-8").write(code)
        make_poster(vid, times)
        subs_and_audio(vid, times)
        sys.exit(0)
    messages += [{"role": "assistant", "content": raw}, {"role": "user", "content": f"That did not work:\n{problem}\nFix it and return the whole corrected class in one ```python block, keeping every rule."}]
print("no working animation after 4 tries")
sys.exit(2)
