"""Keeps the Cloudflare R2 bucket inside its free 10 GB: removes the videos of members without a paid plan 30 days after they were made or after the plan ended (RETENTION_DAYS), and if the bucket
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

RETENTION_DAYS = 30   # without a paid plan a video is kept this long: from when it was made, or from when the last plan ended, whichever is later
TRASH_DAYS = 7   # a video the member deleted waits this long in "Recently deleted", then it is removed for good
FOREVER = "forever"   # a member with a paid plan running (and an admin): their videos are not removed for age
GB = 1024 ** 3
HARD_LIMIT, TARGET = int(9 * GB), int(8.5 * GB)
DRY = "--dry-run" in sys.argv


def pick_expired(jobs, sizes, now, base, keep=None):
    """jobs: rows with id, created_at, videos, user_id. sizes: {prefix: bytes}.
    keep: {user_id: FOREVER or the ISO time the member's last plan ended}. A member with a plan running keeps every video; everyone else's video goes
    RETENTION_DAYS after the later of "made" and "plan ended". If the bucket is still above the hard limit the oldest of the rest go first.
    Returns [(job_id, prefix, reason)], oldest first."""
    keep = keep or {}
    mine = []
    for j in jobs:
        url = (j.get("videos") or {}).get("en") or ""
        if not url.startswith(base.rstrip("/") + "/") or j.get("expired_at"):
            continue
        k = keep.get(j.get("user_id"))
        if k == FOREVER:
            continue
        prefix = urllib.parse.urlparse(url).path.lstrip("/").rsplit("/", 1)[0] + "/"
        start = max(j["created_at"], k or "")
        mine.append((j["created_at"], j["id"], prefix, start))
    mine.sort()
    cutoff = (now - datetime.timedelta(days=RETENTION_DAYS)).isoformat()
    out = [(i, p, "older than %d days without a plan" % RETENTION_DAYS) for c, i, p, start in mine if start < cutoff]
    left = sum(sizes.values()) - sum(sizes.get(p, 0) for _, p, _ in out)
    for c, i, p, _start in mine:
        if left <= HARD_LIMIT:
            break
        if any(i == o[0] for o in out):
            continue
        out.append((i, p, "bucket above 9 GB"))
        left -= sizes.get(p, 0)
        if left <= TARGET:
            break
    return out


def pick_trash(events, now, days=TRASH_DAYS):
    """events: the members' trash and purged events, oldest first, each {type, user_id, created_at, meta:{job, on}}. A video is deleted when its newest
    trash event is on (not on: false, a restore) and no purged event exists. Returns [(job_id, user_id)] deleted `days` or more days ago."""
    since, purged, owner = {}, set(), {}
    for e in events:
        j = str((e.get("meta") or {}).get("job") or "")
        if not j:
            continue
        if e.get("type") == "purged":
            purged.add(j)
        elif (e.get("meta") or {}).get("on") is False:
            since.pop(j, None)
        else:
            since[j] = e["created_at"]
            owner[j] = e.get("user_id")
    cutoff = (now - datetime.timedelta(days=days)).isoformat()
    return sorted((j, owner[j]) for j, c in since.items() if j not in purged and c <= cutoff)


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
    req = urllib.request.Request(sb + "/rest/v1/explainer_jobs?status=eq.done&expired_at=is.null&select=id,created_at,videos,user_id&order=created_at.asc&limit=2000", headers=hdr)
    jobs = json.load(urllib.request.urlopen(req, timeout=60))
    keep = {}
    try:   # members with a plan running keep every video; for the others the later of "made" and "last plan ended" starts the clock
        pe = json.load(urllib.request.urlopen(urllib.request.Request(sb + "/rest/v1/explainer_events?type=eq.plan&select=user_id,meta&order=created_at.desc&limit=5000", headers=hdr), timeout=60))
        now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
        for e in pe:
            if e["user_id"] in keep:
                continue   # newest plan event per member only
            until = ((e.get("meta") or {}).get("until") or "")
            keep[e["user_id"]] = FOREVER if until > now_iso else until
        admins = [x.strip().lower() for x in os.environ.get("ADMIN_EMAILS", "bryantjandra273@gmail.com").split(",") if x.strip()]
        for u in json.load(urllib.request.urlopen(urllib.request.Request(sb + "/rest/v1/explainer_users?select=id&username=in.(" + ",".join(urllib.parse.quote(a) for a in admins) + ")", headers=hdr), timeout=60)):
            keep[u["id"]] = FOREVER
    except Exception as ex:
        print("plan lookup skipped:", str(ex)[:100])
    todo = pick_expired(jobs, sizes, datetime.datetime.now(datetime.timezone.utc), base, keep)
    print("to expire: %d" % len(todo))
    for jid, prefix, why in todo:
        print("  %s %s (%s, %.1f MB)%s" % (jid[:8], prefix, why, sizes.get(prefix, 0) / 1048576, " [dry run]" if DRY else ""))
        if DRY:
            continue
        remove_prefix(prefix)
        sbcall("PATCH", "/rest/v1/explainer_jobs?id=eq.%s" % jid, {"expired_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "videos": {}, "paper_text": None})
    # videos the member deleted more than TRASH_DAYS ago: files, source text and script go; the row stays (its cost still counts in the admin figures)
    try:
        evs = json.load(urllib.request.urlopen(urllib.request.Request(sb + "/rest/v1/explainer_events?type=in.(trash,purged)&select=type,user_id,created_at,meta&order=created_at.asc&limit=10000", headers=hdr), timeout=60))
        gone = pick_trash(evs, datetime.datetime.now(datetime.timezone.utc))
    except Exception as ex:
        print("trash lookup skipped:", str(ex)[:100])
        gone = []
    print("deleted videos to remove for good: %d" % len(gone))
    for jid, uid in gone:
        row = json.load(urllib.request.urlopen(urllib.request.Request(sb + "/rest/v1/explainer_jobs?id=eq.%s&select=id,videos" % jid, headers=hdr), timeout=60))
        url = ((row[0].get("videos") or {}).get("en") or "") if row else ""
        prefix = urllib.parse.urlparse(url).path.lstrip("/").rsplit("/", 1)[0] + "/" if url.startswith(base.rstrip("/") + "/") else ""
        print("  %s%s%s" % (jid[:8], " " + prefix if prefix else "", " [dry run]" if DRY else ""))
        if DRY:
            continue
        if prefix:
            remove_prefix(prefix)
        sbcall("PATCH", "/rest/v1/explainer_jobs?id=eq.%s" % jid, {"expired_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "videos": {}, "paper_text": None, "sections": [], "title": "Deleted video"})
        sbcall("POST", "/rest/v1/explainer_events", {"actor": "", "user_id": uid, "type": "purged", "meta": {"job": jid}})
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
