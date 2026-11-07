"""Delete PDFs that visitors uploaded but that never became a video (the renderer deletes the rest itself).

A file older than MAX_AGE_HOURS with no finished use is removed from the private explainer-uploads bucket, and its bookkeeping row
goes after KEEP_DAYS. Run daily from the retention workflow. env: SUPABASE_URL, SUPABASE_SECRET. --dry-run only prints.
"""
import datetime
import json
import os
import sys
import urllib.parse
import urllib.request

SB = os.environ["SUPABASE_URL"].rstrip("/")
KEY = os.environ["SUPABASE_SECRET"]
BUCKET = "explainer-uploads"
MAX_AGE_HOURS = 36
KEEP_DAYS = 30


def req(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    r = urllib.request.Request(SB + path, data=data, method=method, headers={"apikey": KEY, "Authorization": "Bearer " + KEY, "Content-Type": "application/json", "Prefer": "return=minimal"})
    with urllib.request.urlopen(r, timeout=60) as f:
        t = f.read()
        return json.loads(t) if t and "json" in (f.headers.get("content-type") or "") else None


def pick_stale(rows, now, max_age_hours=MAX_AGE_HOURS):
    """Rows whose file should be gone: older than the limit. (A file already deleted by the renderer is harmless to delete again.)"""
    cut = now - datetime.timedelta(hours=max_age_hours)
    return [r["path"] for r in rows if datetime.datetime.fromisoformat(r["created_at"].replace("Z", "+00:00")) < cut]


def main():
    dry = "--dry-run" in sys.argv
    now = datetime.datetime.now(datetime.timezone.utc)
    since = (now - datetime.timedelta(days=KEEP_DAYS)).isoformat()
    rows = req("GET", f"/rest/v1/explainer_uploads?created_at=gte.{urllib.parse.quote(since)}&select=path,created_at&order=created_at.asc&limit=1000") or []
    stale = pick_stale(rows, now)
    print(f"{len(rows)} upload rows in the last {KEEP_DAYS} days, {len(stale)} older than {MAX_AGE_HOURS} h")
    if stale and not dry:
        for i in range(0, len(stale), 100):
            req("DELETE", f"/storage/v1/object/{BUCKET}", {"prefixes": stale[i:i + 100]})
    old = (now - datetime.timedelta(days=KEEP_DAYS)).isoformat()
    if not dry:
        req("DELETE", f"/rest/v1/explainer_uploads?created_at=lt.{urllib.parse.quote(old)}")
    print("dry run, nothing deleted" if dry else f"deleted {len(stale)} files")


if __name__ == "__main__":
    main()
