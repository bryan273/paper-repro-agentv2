"""Early warning: reads ops_stats() and fails (red run, GitHub emails the owner) when the project nears a free-plan limit.

usage: SUPABASE_URL=... SUPABASE_SECRET=... python scripts/ops_alert.py
Same thresholds as the admin panel (pages/Admin.tsx in paper-explainer): storage 70%, database 70%, estimated egress 60%,
plus three or more failed video jobs in the last 24 hours. Prints every figure so a green run is also a daily record.
"""
import datetime
import json
import os
import sys
import urllib.request

URL = os.environ["SUPABASE_URL"].rstrip("/")
KEY = os.environ["SUPABASE_SECRET"]
MB = 1024 * 1024
H = {"apikey": KEY, "Authorization": "Bearer " + KEY, "Content-Type": "application/json"}


def call(path, body=None):
    req = urllib.request.Request(URL + path, data=body, headers=H, method="POST" if body is not None else "GET")
    return json.load(urllib.request.urlopen(req, timeout=60))


ops = call("/rest/v1/rpc/ops_stats", b"{}")
storage = sum(b["bytes"] for b in ops["storage"])
since = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
failed = call(f"/rest/v1/explainer_jobs?select=id,error&status=eq.failed&created_at=gte.{since}")

rows = [
    ("Storage", storage, 1024 * MB, 0.7),
    ("Database", ops["db_bytes"], 500 * MB, 0.7),
    ("Egress estimate (30 d)", ops["egress"]["est_bytes"], 5 * 1024 * MB, 0.6),
]
bad = []
for name, used, limit, warn in rows:
    pct = used / limit
    flag = " <-- WARNING" if pct >= warn else ""
    print(f"{name}: {used / MB:.0f} MB of {limit / MB:.0f} MB ({pct:.0%}, warns at {warn:.0%}){flag}")
    if pct >= warn:
        bad.append(f"{name} at {pct:.0%} of the free limit")
print(f"Failed video jobs in the last 24 h: {len(failed)}")
if len(failed) >= 3:
    bad.append(f"{len(failed)} video jobs failed in the last 24 hours")
if bad:
    print("\nALERT: " + "; ".join(bad))
    sys.exit(1)
