"""Proves the R2 bucket works end to end: write, public read, CORS for the site, Range requests, then delete.
usage: R2_* env (same as explainer-render) python scripts/r2_check.py"""
import os
import sys
import urllib.request

import boto3
from botocore.config import Config

E = {k: os.environ[k] for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE")}
ORIGIN = "https://bryan273.github.io"
s3 = boto3.client("s3", endpoint_url=f"https://{E['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com", aws_access_key_id=E["R2_ACCESS_KEY_ID"],
                  aws_secret_access_key=E["R2_SECRET_ACCESS_KEY"], region_name="auto", config=Config(signature_version="s3v4"))
key, body = "_check/probe.mp4", bytes(range(256)) * 64   # 16 KB
ok = True


def step(name, cond, extra=""):
    global ok
    ok &= bool(cond)
    print(("PASS " if cond else "FAIL ") + name, extra)


s3.put_object(Bucket=E["R2_BUCKET"], Key=key, Body=body, ContentType="video/mp4", CacheControl="public, max-age=31536000, immutable")
step("write with the scoped token", True)
url = E["R2_PUBLIC_BASE"].rstrip("/") + "/" + key


def get(headers):
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", **headers}), timeout=30)


r = get({"Origin": ORIGIN})
step("public read", r.status == 200 and len(r.read()) == len(body), f"status={r.status}")
step("content type", r.headers.get("content-type") == "video/mp4", r.headers.get("content-type", ""))
step("cache header", "max-age=31536000" in (r.headers.get("cache-control") or ""), r.headers.get("cache-control", ""))
step("CORS for the site", r.headers.get("access-control-allow-origin") == ORIGIN, r.headers.get("access-control-allow-origin", ""))
r2 = get({"Range": "bytes=0-99", "Origin": ORIGIN})
step("range request (seeking)", r2.status == 206 and len(r2.read()) == 100, f"status={r2.status}")
try:
    r3 = get({"Origin": "https://evil.example"})
    step("other origins get no CORS grant", r3.headers.get("access-control-allow-origin") != "https://evil.example")
except Exception as e:
    step("other origins get no CORS grant", True, str(e)[:60])
s3.delete_object(Bucket=E["R2_BUCKET"], Key=key)
step("cleanup", True)
sys.exit(0 if ok else 1)
