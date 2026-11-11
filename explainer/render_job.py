"""Server renderer: one queued Paper Explainer job -> EN and ZH MP4s (16:9 and 9:16) in Supabase Storage.
Runs in GitHub Actions (.github/workflows/explainer-render.yml). usage: python render_job.py <job_id>
env: SUPABASE_URL, SUPABASE_SECRET, DEEPSEEK_API_KEY; optional R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE (final files go to Cloudflare R2)"""
import sys, os, json, subprocess, urllib.request, traceback, datetime, tempfile
from concurrent.futures import ThreadPoolExecutor
import threading, time
sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.abspath(__file__))
SB, KEY = os.environ["SUPABASE_URL"].rstrip("/"), os.environ["SUPABASE_SECRET"]
job = sys.argv[1]
os.environ.setdefault("USAGE_FILE", os.path.join(ROOT, f"usage_{job[:8]}.jsonl"))   # every model call of this render is logged here (usage.py)

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

R2 = {k: os.environ.get(k, "") for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE")}
_r2 = None

def r2_client():
    global _r2
    if not all(R2.values()): raise RuntimeError("R2 not configured")
    if _r2 is None:
        import boto3
        from botocore.config import Config
        _r2 = boto3.client("s3", endpoint_url=f"https://{R2['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com", aws_access_key_id=R2["R2_ACCESS_KEY_ID"],
                           aws_secret_access_key=R2["R2_SECRET_ACCESS_KEY"], region_name="auto", config=Config(signature_version="s3v4", retries={"max_attempts": 5}))
    return _r2

def r2_put(local, name, ctype):
    """Final videos, posters and scenes.json go to Cloudflare R2 (10 GB free, no egress fees), so watching and downloading cost Supabase nothing.
    Returns the public URL. Raises if R2 is not configured or the upload fails; the caller then falls back to Supabase Storage."""
    with open(local, "rb") as fh:   # names carry the job id and are never rewritten, so a year of caching is safe
        r2_client().put_object(Bucket=R2["R2_BUCKET"], Key=name, Body=fh.read(), ContentType=ctype, CacheControl="public, max-age=31536000, immutable")
    return f"{R2['R2_PUBLIC_BASE'].rstrip('/')}/{name}"

def record_r2_usage():
    """Writes the bucket size into ops_r2_usage so the admin panel shows how much of the free 10 GB is used. Best effort: never fails a render."""
    try:
        if not all(R2.values()): return
        total = n = 0
        for page in r2_client().get_paginator("list_objects_v2").paginate(Bucket=R2["R2_BUCKET"]):
            total += sum(o["Size"] for o in page.get("Contents", [])); n += len(page.get("Contents", []))
        req("POST", "/rest/v1/ops_r2_usage", {"bytes": total, "objects": n}, extra={"Prefer": "return=minimal"})
    except Exception as e:
        print("R2 usage record skipped:", str(e)[:120])

def upload(local, name, final=False):
    ctype = "video/mp4" if name.endswith(".mp4") else "image/jpeg" if name.endswith(".jpg") else "application/json"
    if final:
        try: return r2_put(local, name, ctype)
        except Exception as e: print("R2 upload skipped, using Supabase Storage:", str(e)[:160])
    # multipart with a cacheControl field is the only form Storage honours: a plain body is served "private, no-cache", so every
    # play went back to the origin. The file names carry the job id and are never rewritten, so a year of caching is safe.
    b = "----rs" + os.urandom(8).hex()
    with open(local, "rb") as fh:
        crlf = "\r\n"
        head = crlf.join([f"--{b}", 'Content-Disposition: form-data; name="cacheControl"', "", "31536000", f"--{b}", 'Content-Disposition: form-data; name=""; filename="f"', f"Content-Type: {ctype}", "", ""])
        body = head.encode() + fh.read() + (crlf + f"--{b}--" + crlf).encode()
    req("POST", f"/storage/v1/object/explainer-videos/{name}", body, f"multipart/form-data; boundary={b}", {"x-upsert": "true"})
    return f"{SB}/storage/v1/object/public/explainer-videos/{name}"

def clip_dur(mp4):
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4], capture_output=True, text=True).stdout.strip() or 0)

def best_still(mp4, jpg, tries=9):
    """The most visible frame of a clip (mean brightness plus contrast), written to jpg."""
    from PIL import Image, ImageStat
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4], capture_output=True, text=True).stdout.strip() or 6)
    best, pick = -1.0, None
    for k in range(tries):
        t = dur * (0.12 + 0.76 * k / max(1, tries - 1))
        tmp = jpg + f".{k}.jpg"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.2f}", "-i", mp4, "-frames:v", "1", "-vf", "scale=960:-2", "-q:v", "4", tmp], check=True)
        st = ImageStat.Stat(Image.open(tmp).convert("L").crop((0, 0, 960, 380)))   # the picture area, without the subtitle strip
        score = st.mean[0] + st.stddev[0]
        if score > best: best, pick = score, tmp
    os.replace(pick, jpg)
    for k in range(tries):
        try: os.remove(jpg + f".{k}.jpg")
        except OSError: pass
    return jpg

row = req("GET", f"/rest/v1/explainer_jobs?id=eq.{job}&select=*")[0]
key = row["arxiv"]
model, voice = row.get("model") or "deepseek", row.get("voice") or "female"
MONO = ("en", "zh", "vi", "id", "ja", "ko", "es", "fr", "de")
LG = ("en", "zh") if (row.get("langs") or "both") not in MONO else (row["langs"],)   # the languages this video is made in
VOICES = {"female": ("en-US-AriaNeural", "zh-CN-XiaoxiaoNeural"), "male": ("en-US-GuyNeural", "zh-CN-YunxiNeural")}
VOICE_X = {"vi": {"female": "vi-VN-HoaiMyNeural", "male": "vi-VN-NamMinhNeural"}, "id": {"female": "id-ID-GadisNeural", "male": "id-ID-ArdiNeural"},
           "ja": {"female": "ja-JP-NanamiNeural", "male": "ja-JP-KeitaNeural"}, "ko": {"female": "ko-KR-SunHiNeural", "male": "ko-KR-InJoonNeural"},
           "es": {"female": "es-ES-ElviraNeural", "male": "es-ES-AlvaroNeural"}, "fr": {"female": "fr-FR-DeniseNeural", "male": "fr-FR-HenriNeural"},
           "de": {"female": "de-DE-KatjaNeural", "male": "de-DE-ConradNeural"}}
# files and uploads are named by this slug, so one paper can exist in several model / voice versions
arxiv = f"{key}-{job[:8]}"
d = os.path.join(ROOT, "out", arxiv)
USER_ERROR_FILE = os.path.join(tempfile.gettempdir(), "explainer_user_error_%s.txt" % os.getpid())
os.environ["USER_ERROR_FILE"] = USER_ERROR_FILE
def run(*a): subprocess.run([sys.executable, *a], cwd=ROOT, check=True)

def run_watched(*a):
    """Run the script writer and, while it works, show the viewer what it is doing: it writes one line per event to PROGRESS_FILE and the last line becomes the job's stage."""
    import time
    pf = os.path.join(tempfile.gettempdir(), "explainer_progress_%s.txt" % os.getpid())
    open(pf, "w").close()
    proc = subprocess.Popen([sys.executable, *a], cwd=ROOT, env=dict(os.environ, PROGRESS_FILE=pf))
    last = ""
    while proc.poll() is None:
        time.sleep(2)
        try: lines = [l.strip() for l in open(pf, encoding="utf-8").read().splitlines() if l.strip()]
        except Exception: lines = []
        if lines and lines[-1] != last:
            last = lines[-1]
            try: update(stage=last[:140])
            except Exception: pass   # a missed detail never fails the video
    if proc.returncode: raise subprocess.CalledProcessError(proc.returncode, a)
def cost_fields():
    """What this render cost (estimated from token counts, see usage.py); empty if the ledger is unreadable."""
    try:
        import usage
        t = usage.summary()
        return {"cost_usd": t["usd"], "usage": t}
    except Exception as e:
        print("cost summary skipped:", str(e)[:100]); return {}

# Claim the job: only one renderer (the laptop worker or a GitHub Actions run) may take a queued job, so it is never rendered twice.
try:
    got = req("PATCH", f"/rest/v1/explainer_jobs?id=eq.{job}&status=eq.queued", {"status": "running", "stage": "reading the paper and writing the script", "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}, extra={"Prefer": "return=representation"})
except Exception as e:
    print("could not claim the job:", e); sys.exit(0)
if not got:
    print("job is not queued any more (another renderer has it), nothing to do"); sys.exit(0)
# a PDF the visitor uploaded: copy it from the private bucket next to the work files; it is deleted again when the job ends
KEEP_UPLOAD = False
UP_PATH = (row.get("source_url") or "")[len("upload:"):] if (row.get("source_url") or "").startswith("upload:") else ""
upfile = ""
# an edit of a finished video (explainer-render op "edit"): the previous script is kept except the part the member asked to change
EDIT, edit_args = None, []
try:
    ev = req("GET", f"/rest/v1/explainer_events?type=eq.edit&meta->>job=eq.{job}&select=meta&limit=1")
    if ev: EDIT = ev[0]["meta"]
except Exception as e: print("edit lookup skipped:", str(e)[:100])
if EDIT:
    os.makedirs(d, exist_ok=True)
    par = req("GET", f"/rest/v1/explainer_jobs?id=eq.{EDIT['parent']}&select=arxiv,id")[0]
    pslug, prevp = f"{par['arxiv']}-{par['id'][:8]}", os.path.join(d, "prev_scenes.json")
    for base in [os.environ.get("R2_PUBLIC_BASE", "").rstrip("/"), f"{SB}/storage/v1/object/public/explainer-videos"]:
        if not base: continue
        try:
            with urllib.request.urlopen(urllib.request.Request(f"{base}/{pslug}/scenes.json", headers={"User-Agent": "paperlit-render"}), timeout=60) as f_: open(prevp, "wb").write(f_.read())
            break
        except Exception as e: print("previous script not at", base[:30], str(e)[:80])
    if os.path.exists(prevp): edit_args = ["--edit-from", prevp, "--edit-part", str(EDIT.get("part", 0)), "--edit-note", str(EDIT.get("note") or "")]
    else: print("previous script not found: the edit is made as a fresh version with the note")
    if UP_PATH and len(row.get("paper_text") or "") > 300:   # the uploaded file is gone; the text kept with the video stands in for it
        upfile = os.path.join(d, "source.txt"); open(upfile, "w", encoding="utf-8").write(row["paper_text"]); UP_PATH = ""
    update(stage="rewriting the part you asked to change")
try:
    if UP_PATH:
        os.makedirs(d, exist_ok=True); upfile = os.path.join(d, "upload.pdf")
        r_ = urllib.request.Request(f"{SB}/storage/v1/object/explainer-uploads/{UP_PATH}", headers={"apikey": KEY, "Authorization": "Bearer " + KEY})
        with urllib.request.urlopen(r_, timeout=120) as f_, open(upfile, "wb") as o_: o_.write(f_.read(25_000_000))
    if EDIT and not edit_args and EDIT.get("note"):   # no previous script: a fresh version that follows the note
        row["custom"] = ((row.get("custom") or "") + " Change requested by the viewer: " + str(EDIT["note"]))[:600]
    run_watched("gen.py", *edit_args, key, "--slug", arxiv, "--model", model, "--voice-en", VOICES[voice][0], "--voice-zh", VOICES[voice][1], "--voice-x", VOICE_X.get(row.get("langs"), {}).get(voice, ""), "--seconds", str(row.get("seconds") or 36), "--tone", row.get("tone") or "teacher", "--langs", row.get("langs") if row.get("langs") in MONO else "both", "--theme", row.get("style") or "classic", "--custom", row.get("custom") or "", *(["--file", upfile] if upfile else ["--url", row["source_url"]] if row.get("source_url") else []))
    try: update(paper_text=open(os.path.join(d, "paper.txt"), encoding="utf-8").read()[:60000])   # kept for the Ask tab until the video expires
    except Exception as e: print("paper text not saved:", str(e)[:100])
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
    animated = (row.get("style") or "").startswith("animated") or (row.get("style") or "") == "cinema"   # "animated" or "animated:<look>"; the look itself is in the script
    def section(n, m):
        drawn = False
        if animated:   # the AI draws this section with Manim; on failure the template player records it
            drawn = subprocess.run([sys.executable, "manim_section.py", arxiv, str(m["i"])], cwd=ROOT).returncode == 0
        if not drawn:
            with rec_lock:   # one browser pair at a time
                with ThreadPoolExecutor(2) as ex: list(ex.map(lambda lg: run("record.py", arxiv, lg, "--part", str(m["i"])), LG))
        vids = {lang: upload(os.path.join(d, f"{arxiv}_{lang}_s{m['i']}.mp4"), f"{arxiv}/{arxiv}_{lang}_s{m['i']}.mp4") for lang in LG}
        # a still from the English cut, so the player shows a picture instead of a black box: the brightest of several frames (some beats fade through black)
        poster = None
        try:
            mp4 = os.path.join(d, f"{arxiv}_{LG[0]}_s{m['i']}.mp4"); jpg = os.path.join(d, f"{arxiv}_s{m['i']}.jpg")
            if not os.path.exists(jpg): best_still(mp4, jpg)   # the animation step already picked a settled frame; the template player gets the brightest one
            poster = upload(jpg, f"{arxiv}/{arxiv}_s{m['i']}.jpg", final=True)
        except Exception as e: print("poster skipped:", str(e)[:100])
        with lock:
            secs[n]["videos"].update(vids); secs[n]["status"] = "done"
            if poster: secs[n]["poster"] = poster
            ready = sum(1 for s in secs if s["status"] == "done")
            update(sections=secs, stage=f"sections ready: {ready} of {len(meta)}")   # the page shows each section as soon as it is ready
    update(stage=f"drawing {len(meta)} sections")
    with ThreadPoolExecutor((4 if len(meta) >= 4 else max(2, len(meta))) if animated else 1) as ex:   # up to three at a time: while one waits for the model the other renders
        for f in [ex.submit(section, n, m) for n, m in enumerate(meta)]: f.result()
    videos = {}
    update(stage="putting the sections together")
    def assemble(lang):
        lst = os.path.join(d, f"concat_{lang}.txt")
        offs, t = [], 0.0   # each section's [start, end] within the concatenated video, in this language (narration length differs en/zh)
        with open(lst, "w") as fh:
            for m in meta:
                fh.write(f"file '{arxiv}_{lang}_s{m['i']}.mp4'\n")
                dur = clip_dur(os.path.join(d, f"{arxiv}_{lang}_s{m['i']}.mp4"))
                offs.append([round(t, 2), round(t + dur, 2)]); t += dur
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", "-movflags", "+faststart", os.path.join(d, f"{arxiv}_{lang}.mp4")], check=True)
        run("vertical.py", arxiv, lang)
        return lang, upload(os.path.join(d, f"{arxiv}_{lang}.mp4"), f"{arxiv}/{arxiv}_{lang}.mp4", final=True), upload(os.path.join(d, f"{arxiv}_{lang}_vertical.mp4"), f"{arxiv}/{arxiv}_{lang}_vertical.mp4", final=True), offs
    offsets = {}
    with ThreadPoolExecutor(2) as ex:
        for lang, wide, tall, offs in ex.map(assemble, LG): videos[lang] = wide; videos[lang + "_vertical"] = tall; offsets[lang] = offs
    update(videos=videos)
    upload(os.path.join(d, "scenes.json"), f"{arxiv}/scenes.json", final=True)
    # the per-section clips were only needed live, while sections finished one at a time; now that the full video exists each section
    # plays from it over a time range, so the clip (the same picture, stored twice) is removed from Storage instead of kept forever
    deleted = False
    try:
        req("DELETE", "/storage/v1/object/explainer-videos", {"prefixes": [f"{arxiv}/{arxiv}_{lg}_s{m['i']}.mp4" for lg in LG for m in meta]})
        deleted = True
    except Exception as e:
        print("section clip cleanup skipped:", str(e)[:120])
    for n, m in enumerate(meta):
        secs[n]["clip"] = {lg: offsets[lg][n] for lg in LG}
        if deleted: secs[n].pop("videos", None)
    update(sections=secs)
    # where each scene is in the video and on which page of the paper its evidence sits: the player and the Ask tab jump to them
    try:
        import re as _re
        nrm = lambda t: _re.sub(r"[^a-z0-9]+", " ", str(t).lower()).strip()
        try: pages = json.load(open(os.path.join(d, "pages.json"), encoding="utf-8"))
        except Exception: pages = []
        npages = [nrm(p) for p in pages]
        def page_of(q):
            w = nrm(q).split()
            for k in range(0, max(1, len(w) - 5), 3):
                win = " ".join(w[k:k + 6])
                if len(w) >= 5:
                    for n_, p_ in enumerate(npages):
                        if win in p_: return n_ + 1
            return None
        raw = json.load(open(os.path.join(d, "scenes.json"), encoding="utf-8"))["scenes"]
        timeline = {}
        for lg in LG:
            scr = json.load(open(os.path.join(d, f"script_{lg}.json"), encoding="utf-8"))["scenes"]
            rows = []
            for n, m in enumerate(meta):
                mine = [(i, s_) for i, s_ in enumerate(scr) if s_.get("sec") == m["i"]]
                span = max(0.1, offsets[lg][n][1] - offsets[lg][n][0]); tot = max(1, sum(s_["dur"] for _, s_ in mine)); acc = 0
                for i, s_ in mine:
                    ev = (raw[i].get("evidence") or "") if i < len(raw) else ""
                    rows.append({"t": round(offsets[lg][n][0] + span * acc / tot, 1), "sec": n, "x": (s_.get(lg) or "")[:220], "pg": page_of(ev) if ev else None, "ev": ev[:200]})
                    acc += s_["dur"]
            timeline[lg] = rows
        update(timeline=timeline)
        if pages:   # a PDF page can carry NUL characters, which the database refuses in text: strip them, and never let this cost the timeline
            try: update(paper_pages=[p.replace(chr(0), "")[:5000] for p in pages])
            except Exception as e: print("paper pages skipped:", str(e)[:120])
    except Exception as e: print("timeline skipped:", str(e)[:160])
    update(status="done", stage=None, videos=videos, **cost_fields())
    record_r2_usage()
    print("done", videos)
except Exception as e:
    traceback.print_exc()
    msg = str(e)
    if os.path.exists(USER_ERROR_FILE) and open(USER_ERROR_FILE, encoding="utf-8").read().strip():
        msg = open(USER_ERROR_FILE, encoding="utf-8").read().strip() + " No daily quota was used."
    elif "402" in msg or "Insufficient" in msg or "gen.py" in msg and "non-zero" in msg:
        msg = "The video service is temporarily out of credit or unavailable. Please try again later; no daily quota was used."
    elif isinstance(e, subprocess.CalledProcessError):
        # name the step instead of showing the raw command line; the full trace is in the Actions log
        step = {"record.py": "recording a section", "manim_section.py": "drawing a section", "vertical.py": "making the vertical cut", "ffmpeg": "putting the sections together"}
        what = next((v for k, v in step.items() if k in " ".join(map(str, e.cmd))), "rendering")
        msg = f"The video stopped while {what}. Please try again; no daily quota was used."
    KEEP_UPLOAD = True   # a failed video keeps its file so "Try again" works; the daily sweep removes it after 36 hours
    update(status="failed", stage=None, error=msg[:400], **cost_fields())
    sys.exit(1)
finally:
    if UP_PATH and not KEEP_UPLOAD:   # the visitor's file is private: gone as soon as the video is made
        try: req("DELETE", "/storage/v1/object/explainer-uploads", {"prefixes": [UP_PATH]})
        except Exception as e_: print("upload cleanup skipped:", str(e_)[:120])
