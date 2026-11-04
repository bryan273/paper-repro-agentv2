"""Dump every public table of the Supabase project to one JSON file per table, plus a manifest.

usage: SUPABASE_URL=... SUPABASE_SECRET=... python scripts/backup_db.py <out dir>

Reads through PostgREST with the service key, 1000 rows a page. The table list comes from the API's own
OpenAPI document, so a new table is picked up without editing this file. Exits non-zero if any table fails
or a table comes back with fewer rows than the server reported, so a bad backup never looks like a good one.
"""
import json
import os
import sys
import time
import urllib.request

URL = os.environ["SUPABASE_URL"].rstrip("/")
KEY = os.environ["SUPABASE_SECRET"]
OUT = sys.argv[1]
PAGE = 1000


def get(path, headers=None):
    req = urllib.request.Request(URL + path, headers={"apikey": KEY, "Authorization": "Bearer " + KEY, **(headers or {})})
    for attempt in range(4):
        try:
            return urllib.request.urlopen(req, timeout=60)
        except Exception:
            if attempt == 3:
                raise
            time.sleep(2 * (attempt + 1))


def tables():
    spec = json.load(get("/rest/v1/", {"Accept": "application/openapi+json"}))
    return sorted(spec.get("definitions", {}).keys())


def dump(table):
    rows = []
    total = None
    while True:
        r = get(f"/rest/v1/{table}?select=*", {"Range-Unit": "items", "Range": f"{len(rows)}-{len(rows) + PAGE - 1}", "Prefer": "count=exact"})
        chunk = json.load(r)
        total = int(r.headers.get("Content-Range", "*/0").split("/")[-1])
        rows += chunk
        if len(chunk) < PAGE:
            break
    if len(rows) != total:
        raise RuntimeError(f"{table}: got {len(rows)} rows, server says {total}")
    return rows


def main():
    os.makedirs(OUT, exist_ok=True)
    manifest = {"taken_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "project": URL, "tables": {}}
    failed = []
    for t in tables():
        try:
            rows = dump(t)
            with open(os.path.join(OUT, t + ".json"), "w", encoding="utf-8") as f:
                json.dump(rows, f, ensure_ascii=False, default=str)
            manifest["tables"][t] = len(rows)
            print(f"{t}: {len(rows)}")
        except Exception as e:
            failed.append(t)
            print(f"{t}: FAILED {str(e)[:120]}")
    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    if failed or not manifest["tables"]:
        sys.exit(1)


main()
