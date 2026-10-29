"""record player.html for one language script, mux narration, write mp4. usage: python record.py 1706.03762 en [--limit 20]"""
import sys, os, json, subprocess, threading, http.server, socketserver, functools, time, shutil, glob
sys.stdout.reconfigure(encoding="utf-8")
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.abspath(__file__))
arxiv, lang = sys.argv[1], sys.argv[2]
part = sys.argv[sys.argv.index("--part") + 1] if "--part" in sys.argv else ""   # one section of the video: script_<lang>_s<part>.json
limit = float(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else 0
d = os.path.join(ROOT, "out", arxiv.replace("/", "_"))
scr = json.load(open(os.path.join(d, f"script_{lang}{'_s' + part if part != '' else ''}.json"), encoding="utf-8"))
scenes = scr["scenes"]
if limit:
    acc, keep = 0, []
    for s in scenes:
        if acc >= limit * 1000: break
        keep.append(s); acc += s["dur"]
    scenes = keep
total = sum(s["dur"] for s in scenes) / 1000
H = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
H.log_message = lambda *a, **k: None
srv = socketserver.TCPServer(("127.0.0.1", 0), H); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
rawdir = os.path.join(d, "raw"); shutil.rmtree(rawdir, ignore_errors=True)
q = f"?script=out/{arxiv.replace('/', '_')}/script_{lang}{'_s' + part if part != '' else ''}.json&rec" + (f"&limit={limit}" if limit else "")
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={"width": 1280, "height": 720}, record_video_dir=rawdir, record_video_size={"width": 1280, "height": 720})
    pg = ctx.new_page(); t_page = time.time(); pg.goto(f"http://127.0.0.1:{port}/player.html{q}"); t0 = time.time()
    pg.wait_for_function("window.__done===true", timeout=int((total + 30) * 1000)); pg.wait_for_timeout(900)
    lead = max(0.2, pg.evaluate("window.__startAt") / 1000 - t_page)   # seconds of page load before the first scene
    vid = pg.video.path(); ctx.close(); b.close()
# audio track: each scene's mp3 placed at its start offset, after the measured page load
inputs, filt, acc = [], [], min(lead, 0.3)
for i, s in enumerate(scenes):
    inputs += ["-i", os.path.join(d, s["audio"] if "/" not in s["audio"] else os.path.basename(s["audio"]))]
    filt.append(f"[{i+1}:a]adelay={int(acc*1000)}|{int(acc*1000)}[a{i}]"); acc += s["dur"] / 1000
mix = "".join(f"[a{i}]" for i in range(len(scenes))) + f"amix=inputs={len(scenes)}:normalize=0[aout]"
out = os.path.join(d, f"{arxiv.replace('/', '_')}_{lang}{'_s' + part if part != '' else ''}{'_trial' if limit else ''}.mp4")
subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{max(0, lead - 0.3):.2f}", "-i", vid, *inputs, "-filter_complex", ";".join(filt) + ";" + mix, "-map", "0:v", "-map", "[aout]",
                "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-crf", "23", "-r", "30", "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", out], check=True)
print(out, round(os.path.getsize(out) / 1e6, 1), "MB", round(total, 1), "s")
