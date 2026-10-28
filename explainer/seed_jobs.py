"""Put the laptop-made demo videos into the same store the server renderer uses (done rows + public MP4s)."""
import os, sys, json, glob
sys.argv = [sys.argv[0], "seed"]
import importlib.util
ROOT = os.path.dirname(os.path.abspath(__file__))
SB, KEY = os.environ["SUPABASE_URL"], os.environ["SUPABASE_SECRET"]
import urllib.request
def req(method, path, body=None, ctype="application/json", extra=None):
    h = {"apikey": KEY, "Authorization": "Bearer " + KEY, "Content-Type": ctype, **(extra or {})}
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    with urllib.request.urlopen(urllib.request.Request(SB + path, data=data, method=method, headers=h), timeout=300) as f:
        t = f.read(); return json.loads(t) if t and "json" in f.headers.get("content-type", "") else None
def upload(local, name):
    req("POST", f"/storage/v1/object/explainer-videos/{name}", open(local, "rb").read(), "video/mp4" if name.endswith(".mp4") else "application/json", {"x-upsert": "true"})
    return f"{SB}/storage/v1/object/public/explainer-videos/{name}"
for a in sys.stdin.read().split():
    d = os.path.join(ROOT, "out", a); sc = json.load(open(os.path.join(d, "scenes.json"), encoding="utf-8"))
    if req("GET", f"/rest/v1/explainer_jobs?arxiv=eq.{a}&status=eq.done&select=id"): print("skip", a); continue
    v = {}
    for l in ("en", "zh"):
        v[l] = upload(os.path.join(d, f"{a}_{l}.mp4"), f"{a}/{a}_{l}.mp4")
        v[l + "_vertical"] = upload(os.path.join(d, f"{a}_{l}_vertical.mp4"), f"{a}/{a}_{l}_vertical.mp4")
    upload(os.path.join(d, "scenes.json"), f"{a}/scenes.json")
    checked = sum(1 for s in sc["scenes"] if s.get("evidence") or s["type"] in ("quote", "number")) + sum(len(s.get("bars") or []) for s in sc["scenes"])
    req("POST", "/rest/v1/explainer_jobs", {"arxiv": a, "status": "done", "title": sc.get("paper_title"), "videos": v, "checks": {"checked": checked, "removed": sc.get("unverified", [])}, "visitor": "demo"}, extra={"Prefer": "return=minimal"})
    print("seeded", a, sc.get("paper_title"))
