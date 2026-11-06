"""Early warning: reads ops_stats() and fails (red run, GitHub emails the owner) when the project nears a free-plan limit.

usage: SUPABASE_URL=... SUPABASE_SECRET=... python scripts/ops_alert.py
Same thresholds as the admin panel (plus the R2 bucket at 70% of its free 10 GB) (pages/Admin.tsx in paper-explainer): storage 70%, database 70%, estimated egress 60%,
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

def r2_bytes():
    """Total size of the R2 bucket (free plan: 10 GB; above that Cloudflare bills 1.5 cents per GB-month, it does not stop). None if R2 is not configured."""
    keys = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")
    if not all(os.environ.get(k) for k in keys):
        return None
    import boto3
    from botocore.config import Config
    s3 = boto3.client("s3", endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com", aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                      aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto", config=Config(signature_version="s3v4"))
    total = 0
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=os.environ["R2_BUCKET"]):
        total += sum(o["Size"] for o in page.get("Contents", []))
    return total


rows = [
    ("Storage", storage, 1024 * MB, 0.7),
    ("Database", ops["db_bytes"], 500 * MB, 0.7),
    ("Egress estimate (30 d)", ops["egress"]["est_bytes"], 5 * 1024 * MB, 0.6),
]
r2 = r2_bytes()
if r2 is not None:
    rows.append(("R2 bucket", r2, 10 * 1024 * MB, 0.7))
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
