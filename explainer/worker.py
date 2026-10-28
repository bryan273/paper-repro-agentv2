"""Laptop fallback for the server renderer: takes queued explainer_jobs one at a time and renders them with render_job.py.
Used while GitHub Actions is not wired up (no GH_DISPATCH_TOKEN yet). usage: python worker.py   (env as render_job.py)"""
import os, sys, json, time, subprocess, urllib.request
sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.abspath(__file__))
SB, KEY = os.environ["SUPABASE_URL"], os.environ["SUPABASE_SECRET"]
H = {"apikey": KEY, "Authorization": "Bearer " + KEY}
while True:
    try:
        q = urllib.request.Request(SB + "/rest/v1/explainer_jobs?status=eq.queued&select=id,arxiv&order=created_at.asc&limit=1", headers=H)
        rows = json.load(urllib.request.urlopen(q, timeout=30))
        if rows:
            print(time.strftime("%H:%M:%S"), "render", rows[0]["arxiv"], flush=True)
            subprocess.run([sys.executable, "render_job.py", rows[0]["id"]], cwd=ROOT)
            continue
    except Exception as e:
        print("poll error", e, flush=True)
    time.sleep(15)
