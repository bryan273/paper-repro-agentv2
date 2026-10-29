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
# (model, key): measured on the same section, gpt-5.6-terra drew the richest pictures (charts, diagrams) in about 2 minutes, Sonnet 4.6 was the steady second
LADDER = [(m, os.environ.get(k, "")) for m, k in (("gpt-5.6-terra", "RKAPI_OPENAI_KEY"), ("claude-sonnet-4-6", "RKAPI_API_KEY"))]
if os.environ.get("MANIM_MODEL"): LADDER = [(os.environ["MANIM_MODEL"], os.environ.get("RKAPI_API_KEY", ""))]
LADDER = [(m, k) for m, k in LADDER if k]
if not LADDER: print("no RKAPI key: template player instead"); sys.exit(2)

sc = json.load(open(os.path.join(d, "scenes.json"), encoding="utf-8"))
meta = next((m for m in json.load(open(os.path.join(d, "sections.json"), encoding="utf-8")) if m["i"] == k), {})
idx = [i for i, s in enumerate(sc["scenes"]) if s.get("sec") == k]
dur = {lang: json.load(open(os.path.join(d, f"script_{lang}.json"), encoding="utf-8"))["scenes"] for lang in ("en", "zh")}
# a beat lasts as long as the longer of its two narrations, so both languages fit the same picture
beats = [round(max(dur["en"][i]["dur"], dur["zh"][i]["dur"]) / 1000, 2) for i in idx]
THEMES = {"classic": ("#04070c", "#3dff8f", "#4aa3ff", "#e9f3ff", "#8aa0b8"), "light": ("#f4f1ea", "#4a3cf0", "#e0560f", "#17171c", "#6a6a75"),
          "sunset": ("#120a1f", "#ff7a59", "#c86bff", "#fff1ea", "#b496b0"), "cinema": ("#050510", "#c9a96a", "#6a8fd8", "#f2efe6", "#8a86a0"), "mono": ("#050505", "#ffffff", "#9aa0aa", "#f4f4f4", "#8a8a8a")}
theme = json.load(open(os.path.join(d, "script_en.json"), encoding="utf-8")).get("theme") or "classic"
BG, ACC, ACC2, TXT, MUT = THEMES.get(theme, THEMES["classic"])
CINEMA = ("\nLook: cinematic documentary. Deep blue-black space, thin gold lines and gold highlights, slow smooth movement, a few faint drifting dots as background, generous empty space, labels in a serif font (font=\"Georgia\"). Each idea arrives like a title card: fade in, hold, fade out. Calm and elegant, never busy." if theme == "cinema" else "")
work = os.path.join(d, f"manim_s{k}")
shutil.rmtree(work, ignore_errors=True); os.makedirs(work)

HARNESS = f'''from manim import *
import numpy as np, math, random, json, contextlib
config.background_color = "{BG}"
BG, ACCENT, ACCENT2, TEXT, MUTED = "{BG}", "{ACC}", "{ACC2}", "{TXT}", "{MUT}"
BEATS = {beats!r}

class ExplainerScene(Scene):
    """with self.beat(i): ... runs beat i; whatever time its animations leave over is waited out, and each beat's real start is recorded."""
    _starts = []
    @contextlib.contextmanager
    def beat(self, i):
        t0 = self.renderer.time
        type(self)._starts.append(t0)
        yield
        left = BEATS[i] - (self.renderer.time - t0)
        if left > 0.02: self.wait(left)
    def tear_down(self):
        json.dump({{"starts": type(self)._starts, "end": self.renderer.time}}, open("beat_times.json", "w"))
'''

SYSTEM = f"""You are an expert Manim Community (v0.19+) animator in the style of 3Blue1Brown. You write ONE scene that explains one section of a research paper, synced to its narration beats.
Return ONLY Python code in one ```python block: a single class `Section(ExplainerScene)` with `construct(self)`. Do not import anything: `from manim import *`, `np`, `math`, `random` and the colour constants BG, ACCENT, ACCENT2, TEXT, MUTED are already available, and so is BEATS (seconds per beat).
Hard rules (the code is checked and rejected otherwise):
- For every beat i, in order, one block `with self.beat(i):`. Inside it, the animations' run_time plus waits must total at most BEATS[i] seconds (the harness waits out the rest). Every beat must visibly change something.
- NO LaTeX is installed: never use Tex, MathTex, DecimalNumber, Integer, Variable, Matrix, Brace, BraceLabel, BarChart, Title, Code, MathTable, add_coordinates, get_axis_labels, get_graph_label. Write every label, number and formula with Text or MarkupText (use unicode like √ Σ × ≈ → ≤ ² ³). For a changing number use a ValueTracker with always_redraw(lambda: Text(f"{{t.get_value():.1f}}", ...)).
- No files, images, SVGs, sound, network, OS access, config changes, getattr/eval/exec or dunder names.
- Keep everything inside x in [-6.6, 6.6] and y in [-2.4, 3.7]; the bottom of the frame is reserved for subtitles. Never write the narration sentences on screen: on-screen text is short labels (at most 6 words), font_size 22 to 44, color TEXT or MUTED, highlights in ACCENT / ACCENT2.
- Every number shown must come from the beat data given; never invent results.
{CINEMA}Craft: fill the stage (main shapes 2.5 to 6 units wide, filled with fill_opacity 0.15 to 0.35 in ACCENT/ACCENT2 with a bright stroke), never leave a beat as plain text on black. Pick ONE visual metaphor for the section and evolve it across beats; about one beat in five may just hold and emphasise (Indicate, Circumscribe) instead of adding something new. Keep the picture moving: entrances 0.6 to 1.2 s, then slow emphasis or camera-like shifts (VGroup.animate.shift/scale) instead of long static waits. Build a visual metaphor and evolve it across beats (Transform, ReplacementTransform, FadeIn/FadeOut, Create, Write, GrowArrow, Indicate, Circumscribe, LaggedStart, animate, ValueTracker, Axes with plot, NumberPlane, Dot, Arrow, Line, Rectangle, RoundedRectangle, Circle, VGroup.arrange). Clear the stage between ideas so it never gets cluttered. Smooth, calm pacing; nothing static for long."""

def user_msg():
    b = []
    for n, i in enumerate(idx):
        s = {kk: v for kk, v in sc["scenes"][i].items() if kk not in ("zh", "audio", "audio_ms", "dur", "sec", "evidence")}
        b.append({"beat": n, "seconds": beats[n], **s})
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
    body = json.dumps({"model": model, "max_tokens": 9000, "temperature": 0.4, "stream": True, "messages": messages}).encode()
    req = urllib.request.Request(BASE + "/chat/completions", body, {"Authorization": "Bearer " + key, "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (paper-explainer)"})
    txt = ""
    for raw in urllib.request.urlopen(req, timeout=240):   # streamed: RKAPI stalls non-streamed answers
        line = raw.decode("utf-8", "ignore").strip()
        if not line.startswith("data:") or line.endswith("[DONE]"): continue
        try: txt += (json.loads(line[5:])["choices"][0].get("delta") or {}).get("content") or ""
        except Exception: pass
    m = re.search(r"```(?:python)?\s*(.*?)```", txt, re.S)
    return (m.group(1) if m else txt).strip(), txt

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
        p = subprocess.run(cmd, cwd=work, env=env, capture_output=True, text=True, timeout=420)
    except subprocess.TimeoutExpired:
        return None, "rendering took too long: use fewer objects and simpler animations"
    vid = next((os.path.join(r, f) for r, _, fs in os.walk(os.path.join(work, "media")) for f in fs if f == "section.mp4"), None)
    if p.returncode != 0 or not vid or not os.path.exists(os.path.join(work, "beat_times.json")):
        tail = "\n".join((p.stdout + "\n" + p.stderr).strip().splitlines()[-40:])
        return None, tail or f"manim exited {p.returncode}"
    return vid, None

def subs_and_audio(vid, times):
    """Two-line subtitles (Chinese over English, like the template videos) burned in, and each language's narration placed at its beat."""
    starts, end = times["starts"], times["end"]
    font = "Microsoft YaHei" if os.name == "nt" else "Noto Sans CJK SC"
    ts = lambda t: f"{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}"
    esc = lambda s: s.replace("\\", "").replace("{", "(").replace("}", ")").replace("\n", " ")
    ass = ["[Script Info]", "ScriptType: v4.00+", "PlayResX: 1280", "PlayResY: 720", "", "[V4+ Styles]",
           "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
           f"Style: S,{font},36,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,2.4,1,2,70,70,30,1", "", "[Events]",
           "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]
    for n, i in enumerate(idx):
        a, b = starts[n], (starts[n + 1] if n + 1 < len(starts) else end)
        s = sc["scenes"][i]
        ass.append(f"Dialogue: 0,{ts(a + 0.05)},{ts(max(a + 0.5, b - 0.1))},S,,0,0,0,,{esc(s['zh'])}\\N{{\\b0\\i1\\fs24\\c&H00D8C7B9&}}{esc(s['en'])}")
    open(os.path.join(work, "subs.ass"), "w", encoding="utf-8").write("\n".join(ass) + "\n")
    for lang in ("en", "zh"):
        inputs, filt = ["-i", vid], []
        for n, i in enumerate(idx):
            inputs += ["-i", os.path.join(d, f"{lang}_{i}.mp3")]
            ms = int(starts[n] * 1000) + 150
            filt.append(f"[{n + 1}:a]adelay={ms}|{ms}[a{n}]")
        mix = "".join(f"[a{n}]" for n in range(len(idx))) + f"amix=inputs={len(idx)}:normalize=0,apad=whole_dur={end:.2f}[aout]"
        out = os.path.join(d, f"{slug}_{lang}_s{k}.mp4")
        subprocess.run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", ";".join(filt) + ";" + mix + ";[0:v]subtitles=subs.ass[v]",
                        "-map", "[v]", "-map", "[aout]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
                        "-t", f"{end:.2f}", "-movflags", "+faststart", out], check=True, cwd=work)   # an explicit length: an unbounded padded stream filled the runner disk
        print(out, round(os.path.getsize(out) / 1e6, 1), "MB")
    shutil.rmtree(os.path.join(work, "media", "videos", "section", "720p30", "partial_movie_files"), ignore_errors=True)   # frames of the animation are not needed once it is muxed

messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user_msg()}]
t0 = time.time()
for attempt in range(4):
    model, key = LADDER[(attempt if attempt < 2 else attempt - 2) % len(LADDER)] if len(LADDER) > 1 else LADDER[0]   # terra, then Sonnet, then each once more
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
        open(os.path.join(work, "final_code.py"), "w", encoding="utf-8").write(code)
        subs_and_audio(vid, json.load(open(os.path.join(work, "beat_times.json"))))
        sys.exit(0)
    messages += [{"role": "assistant", "content": raw}, {"role": "user", "content": f"That did not work:\n{problem}\nFix it and return the whole corrected class in one ```python block, keeping every rule."}]
print("no working animation after 4 tries")
sys.exit(2)
