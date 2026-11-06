"""Keeps the Cloudflare R2 bucket inside its free 10 GB: removes the videos of jobs older than RETENTION_DAYS (14), and if the bucket
is still above HARD_LIMIT (9 GB) removes the oldest ones until it is under TARGET (8.5 GB). A removed video's job is kept (title, text,
history) but marked expired_at, so the page says "expired, make it again" instead of showing a broken player. It also records the bucket
size in ops_r2_usage for the admin panel.

usage: SUPABASE_URL SUPABASE_SECRET R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET R2_PUBLIC_BASE python scripts/r2_maintain.py [--dry-run]
Only jobs whose videos live on R2 are touched; the gallery examples (shipped with the site) and older Supabase-hosted videos are never removed here."""
import datetime
import json
import os
import sys
import urllib.parse
import urllib.request

RETENTION_DAYS = 14
GB = 1024 ** 3
HARD_LIMIT, TARGET = int(9 * GB), int(8.5 * GB)
DRY = "--dry-run" in sys.argv


def pick_expired(jobs, sizes, now, base):
    """jobs: rows with id, created_at, videos. sizes: {prefix: bytes}. Returns the prefixes to remove, oldest first, with the reason."""
    mine = []
    for j in jobs:
        url = (j.get("videos") or {}).get("en") or ""
        if not url.startswith(base.rstrip("/") + "/") or j.get("expired_at"):
            continue
        prefix = urllib.parse.urlparse(url).path.lstrip("/").rsplit("/", 1)[0] + "/"
        mine.append((j["created_at"], j["id"], prefix))
    mine.sort()
    cutoff = (now - datetime.timedelta(days=RETENTION_DAYS)).isoformat()
    out = [(i, p, "older than %d days" % RETENTION_DAYS) for c, i, p in mine if c < cutoff]
    left = sum(sizes.values()) - sum(sizes.get(p, 0) for _, p, _ in out)
    for c, i, p in mine:
        if left <= HARD_LIMIT:
            break
        if any(i == o[0] for o in out):
            continue
        out.append((i, p, "bucket above 9 GB"))
        left -= sizes.get(p, 0)
        if left <= TARGET:
            break
    return out


def pick_orphans(prefixes, job_ids, now, min_age_days=2):
    """prefixes: {prefix: newest LastModified}. A job folder is named <paper>-<first 8 chars of the job id>; one with no matching job row (a job that was
    deleted) and nothing written for min_age_days is leftover, so it is removed. Folders that are not job folders (underscore names) are skipped."""
    ids8 = {i[:8] for i in job_ids}
    cutoff = now - datetime.timedelta(days=min_age_days)
    return sorted(p for p, newest in prefixes.items() if not p.startswith("_") and p.rstrip("/")[-8:] not in ids8 and newest < cutoff)


def main():
    import boto3
    from botocore.config import Config
    sb, key = os.environ["SUPABASE_URL"].rstrip("/"), os.environ["SUPABASE_SECRET"]
    hdr = {"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"}
    bucket, base = os.environ["R2_BUCKET"], os.environ["R2_PUBLIC_BASE"]

    def sbcall(method, path, body=None):
        r = urllib.request.Request(sb + path, data=None if body is None else json.dumps(body).encode(), headers={**hdr, "Prefer": "return=minimal"}, method=method)
        with urllib.request.urlopen(r, timeout=60) as f:
            t = f.read()
            return json.loads(t) if t else None

    s3 = boto3.client("s3", endpoint_url="https://%s.r2.cloudflarestorage.com" % os.environ["R2_ACCOUNT_ID"], aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                      aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto", config=Config(signature_version="s3v4", retries={"max_attempts": 5}))

    newest = {}

    def scan():
        sizes, n = {}, 0
        newest.clear()
        for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket):
            for o in page.get("Contents", []):
                pre = o["Key"].rsplit("/", 1)[0] + "/"
                sizes[pre] = sizes.get(pre, 0) + o["Size"]
                newest[pre] = max(newest.get(pre, o["LastModified"]), o["LastModified"])
                n += 1
        return sizes, n

    def remove_prefix(prefix):
        keys = [o["Key"] for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix) for o in page.get("Contents", [])]
        for i in range(0, len(keys), 1000):
            s3.delete_objects(Bucket=bucket, Delete={"Objects": [{"Key": k} for k in keys[i:i + 1000]]})

    sizes, n = scan()
    print("bucket: %.1f MB in %d files" % (sum(sizes.values()) / 1048576, n))
    req = urllib.request.Request(sb + "/rest/v1/explainer_jobs?status=eq.done&expired_at=is.null&select=id,created_at,videos&order=created_at.asc&limit=2000", headers=hdr)
    jobs = json.load(urllib.request.urlopen(req, timeout=60))
    todo = pick_expired(jobs, sizes, datetime.datetime.now(datetime.timezone.utc), base)
    print("to expire: %d" % len(todo))
    for jid, prefix, why in todo:
        print("  %s %s (%s, %.1f MB)%s" % (jid[:8], prefix, why, sizes.get(prefix, 0) / 1048576, " [dry run]" if DRY else ""))
        if DRY:
            continue
        remove_prefix(prefix)
        sbcall("PATCH", "/rest/v1/explainer_jobs?id=eq.%s" % jid, {"expired_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "videos": {}})
    # leftovers of deleted jobs
    ids = [j["id"] for j in json.load(urllib.request.urlopen(urllib.request.Request(sb + "/rest/v1/explainer_jobs?select=id&limit=5000", headers=hdr), timeout=60))]
    orphans = pick_orphans(dict(newest), ids, datetime.datetime.now(datetime.timezone.utc))
    print("orphan folders (no job row): %d" % len(orphans))
    for prefix in orphans:
        print("  %s (%.1f MB)%s" % (prefix, sizes.get(prefix, 0) / 1048576, " [dry run]" if DRY else ""))
        if not DRY:
            remove_prefix(prefix)
    sizes, n = scan()
    total = sum(sizes.values())
    print("bucket after: %.1f MB in %d files" % (total / 1048576, n))
    if not DRY:
        sbcall("POST", "/rest/v1/ops_r2_usage", {"bytes": total, "objects": n})


if __name__ == "__main__":
    main()
