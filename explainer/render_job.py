"""Server renderer: one queued Paper Explainer job -> EN and ZH MP4s (16:9 and 9:16) in Supabase Storage.
Runs in GitHub Actions (.github/workflows/explainer-render.yml). usage: python render_job.py <job_id>
env: SUPABASE_URL, SUPABASE_SECRET, DEEPSEEK_API_KEY"""
import sys, os, json, subprocess, urllib.request, traceback, datetime
from concurrent.futures import ThreadPoolExecutor
import threading, time
sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.abspath(__file__))
SB, KEY = os.environ["SUPABASE_URL"].rstrip("/"), os.environ["SUPABASE_SECRET"]
job = sys.argv[1]

def req(method, path, body=None, ctype="application/json", extra=None):
    h = {"apikey": KEY, "Authorization": "Bearer " + KEY, "Content-Type": ctype, **(extra or {})}
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    r = urllib.request.Request(SB + path, data=data, method=method, headers=h)
    with urllib.request.urlopen(r, timeout=120) as f:
        t = f.read(); return json.loads(t) if t and "json" in f.headers.get("content-type", "") else None

def update(**f):
    f["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    for k in range(5):   # the connection from a home network can drop; a lost status write must not leave a job stuck
        try:
            return req("PATCH", f"/rest/v1/explainer_jobs?id=eq.{job}", f, extra={"Prefer": "return=minimal"})
        except Exception:
            if k == 4: raise
            import time; time.sleep(3 * (k + 1))

def upload(local, name):
    with open(local, "rb") as fh:
        req("POST", f"/storage/v1/object/explainer-videos/{name}", fh.read(), "video/mp4" if name.endswith(".mp4") else "image/jpeg" if name.endswith(".jpg") else "application/json", {"x-upsert": "true"})
    return f"{SB}/storage/v1/object/public/explainer-videos/{name}"

row = req("GET", f"/rest/v1/explainer_jobs?id=eq.{job}&select=*")[0]
key = row["arxiv"]
model, voice = row.get("model") or "deepseek", row.get("voice") or "female"
VOICES = {"female": ("en-US-AriaNeural", "zh-CN-XiaoxiaoNeural"), "male": ("en-US-GuyNeural", "zh-CN-YunxiNeural")}
# files and uploads are named by this slug, so one paper can exist in several model / voice versions
arxiv = f"{key}-{job[:8]}"
d = os.path.join(ROOT, "out", arxiv)
def run(*a): subprocess.run([sys.executable, *a], cwd=ROOT, check=True)
# Claim the job: only one renderer (the laptop worker or a GitHub Actions run) may take a queued job, so it is never rendered twice.
try:
    got = req("PATCH", f"/rest/v1/explainer_jobs?id=eq.{job}&status=eq.queued", {"status": "running", "stage": "reading the paper and writing the script", "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}, extra={"Prefer": "return=representation"})
except Exception as e:
    print("could not claim the job:", e); sys.exit(0)
if not got:
    print("job is not queued any more (another renderer has it), nothing to do"); sys.exit(0)
try:
    run("gen.py", key, "--slug", arxiv, "--model", model, "--voice-en", VOICES[voice][0], "--voice-zh", VOICES[voice][1], "--seconds", str(row.get("seconds") or 36), "--tone", row.get("tone") or "teacher", "--theme", row.get("style") or "classic", "--custom", row.get("custom") or "", *(["--url", row["source_url"]] if row.get("source_url") else []))
    sc = json.load(open(os.path.join(d, "scenes.json"), encoding="utf-8"))
    checked = sum(1 for s in sc["scenes"] if s.get("evidence") or s["type"] in ("quote", "number")) + sum(len(s.get("bars") or []) for s in sc["scenes"])
    update(title=sc.get("paper_title"), checks={"checked": checked, "removed": sc.get("unverified", [])}, stage="recording the sections")
    meta = json.load(open(os.path.join(d, "sections.json"), encoding="utf-8"))
    secs = [{**m, "status": "waiting", "videos": {}} for m in meta]
    update(sections=secs)
    # the heavy installs (fonts, Manim, Chromium) run in the background while the script is written; wait for them only now
    if os.path.exists("/tmp/heavy.started"):
        update(stage="getting the drawing tools ready")
        for _ in range(900):
            if os.path.exists("/tmp/heavy.done"): break
            if os.path.exists("/tmp/heavy.failed"): raise RuntimeError("could not install the drawing tools")
            time.sleep(1)
    lock, rec_lock = threading.Lock(), threading.Lock()
    animated = (row.get("style") or "") in ("animated", "cinema")
    def section(n, m):
        drawn = False
        if animated:   # the AI draws this section with Manim; on failure the template player records it
            drawn = subprocess.run([sys.executable, "manim_section.py", arxiv, str(m["i"])], cwd=ROOT).returncode == 0
        if not drawn:
            with rec_lock:   # one browser pair at a time
                with ThreadPoolExecutor(2) as ex: list(ex.map(lambda lg: run("record.py", arxiv, lg, "--part", str(m["i"])), ("en", "zh")))
        vids = {lang: upload(os.path.join(d, f"{arxiv}_{lang}_s{m['i']}.mp4"), f"{arxiv}/{arxiv}_{lang}_s{m['i']}.mp4") for lang in ("en", "zh")}
        # a still from the middle of the English cut, so the player shows a picture instead of a black box
        poster = None
        try:
            mp4 = os.path.join(d, f"{arxiv}_en_s{m['i']}.mp4"); jpg = os.path.join(d, f"{arxiv}_s{m['i']}.jpg")
            dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4], capture_output=True, text=True).stdout.strip() or 6)
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{max(1.0, dur * 0.4):.2f}", "-i", mp4, "-frames:v", "1", "-vf", "scale=960:-2", "-q:v", "4", jpg], check=True)
            poster = upload(jpg, f"{arxiv}/{arxiv}_s{m['i']}.jpg")
        except Exception as e: print("poster skipped:", str(e)[:100])
        with lock:
            secs[n]["videos"].update(vids); secs[n]["status"] = "done"
            if poster: secs[n]["poster"] = poster
            ready = sum(1 for s in secs if s["status"] == "done")
            update(sections=secs, stage=f"sections ready: {ready} of {len(meta)}")   # the page shows each section as soon as it is ready
    update(stage=f"drawing {len(meta)} sections")
    with ThreadPoolExecutor(2 if animated else 1) as ex:   # two at a time: while one waits for the model the other renders
        for f in [ex.submit(section, n, m) for n, m in enumerate(meta)]: f.result()
    videos = {}
    update(stage="putting the sections together")
    def assemble(lang):
        lst = os.path.join(d, f"concat_{lang}.txt")
        with open(lst, "w") as fh:
            for m in meta: fh.write(f"file '{arxiv}_{lang}_s{m['i']}.mp4'\n")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", "-movflags", "+faststart", os.path.join(d, f"{arxiv}_{lang}.mp4")], check=True)
        run("vertical.py", arxiv, lang)
        return lang, upload(os.path.join(d, f"{arxiv}_{lang}.mp4"), f"{arxiv}/{arxiv}_{lang}.mp4"), upload(os.path.join(d, f"{arxiv}_{lang}_vertical.mp4"), f"{arxiv}/{arxiv}_{lang}_vertical.mp4")
    with ThreadPoolExecutor(2) as ex:
        for lang, wide, tall in ex.map(assemble, ("en", "zh")): videos[lang] = wide; videos[lang + "_vertical"] = tall
    update(videos=videos)
    upload(os.path.join(d, "scenes.json"), f"{arxiv}/scenes.json")
    update(status="done", stage=None, videos=videos)
    print("done", videos)
except Exception as e:
    traceback.print_exc()
    msg = str(e)
    if "402" in msg or "Insufficient" in msg or "gen.py" in msg and "non-zero" in msg:
        msg = "The video service is temporarily out of credit or unavailable. Please try again later; no daily quota was used."
    update(status="failed", stage=None, error=msg[:400])
    sys.exit(1)
