"""Upload the converter's results to the private bucket under studio/<run>/ and add one ledger event (type "studio") for the admin page."""
import json, os, sys, urllib.request
SB, KEY = os.environ["SUPABASE_URL"].rstrip("/"), os.environ["SUPABASE_SECRET"]
out, client, run = sys.argv[1], sys.argv[2], sys.argv[3]
H = {"apikey": KEY, "Authorization": "Bearer " + KEY}
rep = json.load(open(os.path.join(out, "report.json")))
files = {}
for name, ctype in (("document.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), ("document.html", "text/html"), ("report.json", "application/json")):
    data = open(os.path.join(out, name), "rb").read()
    # the private bucket only accepts PDF and plain text uploads: the bytes go in as text/plain, the admin download sets the real type from the file name
    req = urllib.request.Request(f"{SB}/storage/v1/object/explainer-uploads/studio/{run}/{name}", data, dict(H, **{"Content-Type": "text/plain", "x-upsert": "true"}), method="POST")
    try: urllib.request.urlopen(req, timeout=120).read(); files[name] = f"studio/{run}/{name}"
    except Exception as e: print("upload failed", name, str(e)[:120]); files[name] = None
meta = {"client": client, "run": run, "file": rep["file"], "pages": rep["pages"], "failed_pages": rep["failed_pages"], "calls": rep["calls"], "retried_pages": rep["retried_pages"],
        "tokens_in": rep["tokens_in"], "tokens_out": rep["tokens_out"], "usd": rep["usd"], "usd_per_page": rep["usd_per_page"], "seconds": rep["seconds"], "by_model": rep["by_model"], "files": files}
req = urllib.request.Request(SB + "/rest/v1/explainer_events", json.dumps({"actor": "studio", "type": "studio", "meta": meta}).encode(), dict(H, **{"Content-Type": "application/json", "Prefer": "return=minimal"}), method="POST")
urllib.request.urlopen(req, timeout=60).read()
print("saved", json.dumps({k: v for k, v in meta.items() if k != "files"}), "files", {k: bool(v) for k, v in files.items()})
