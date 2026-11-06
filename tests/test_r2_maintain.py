"""Retention rules of scripts/r2_maintain.py: what gets removed from the R2 bucket and what never does."""
import datetime
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from r2_maintain import GB, HARD_LIMIT, pick_expired  # noqa: E402

BASE = "https://pub-x.r2.dev"
NOW = datetime.datetime(2026, 11, 20, tzinfo=datetime.timezone.utc)


def job(i, days_old, host=BASE, expired=None):
    created = (NOW - datetime.timedelta(days=days_old)).isoformat()
    return {"id": i, "created_at": created, "expired_at": expired, "videos": {"en": f"{host}/1409.0473-{i}/1409.0473-{i}_en.mp4"}}


def test_only_videos_older_than_14_days_go():
    jobs = [job("old", 15), job("new", 13), job("edge", 14.5)]
    got = {i for i, _, _ in pick_expired(jobs, {}, NOW, BASE)}
    assert got == {"old", "edge"}


def test_supabase_hosted_gallery_and_already_expired_are_never_touched():
    jobs = [job("gal", 100, host="https://x.supabase.co/storage/v1/object/public/explainer-videos"), job("done", 100, expired="2026-11-01"), job("r2old", 100)]
    assert [i for i, _, _ in pick_expired(jobs, {}, NOW, BASE)] == ["r2old"]


def test_prefix_is_the_job_folder():
    assert pick_expired([job("abc", 20)], {}, NOW, BASE)[0][1] == "1409.0473-abc/"


def test_over_9gb_removes_oldest_first_until_8_5gb():
    jobs = [job(str(n), 10 - n) for n in range(5)]   # all younger than 14 days; 0 is the oldest
    sizes = {f"1409.0473-{n}/": 2 * GB for n in range(5)}   # 10 GB in total
    got = [i for i, _, _ in pick_expired(jobs, sizes, NOW, BASE)]
    assert got == ["0"] and sum(sizes.values()) - 2 * GB * len(got) <= HARD_LIMIT   # 10 GB -> 8 GB, which is under the 8.5 GB target


def test_under_the_limit_nothing_extra_goes():
    jobs = [job("a", 1), job("b", 2)]
    assert pick_expired(jobs, {"1409.0473-a/": GB, "1409.0473-b/": GB}, NOW, BASE) == []
