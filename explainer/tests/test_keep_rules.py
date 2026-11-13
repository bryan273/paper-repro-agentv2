import datetime, importlib.util, os

spec = importlib.util.spec_from_file_location("r2_maintain", os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "r2_maintain.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
BASE = "https://r2.test"
NOW = datetime.datetime(2026, 12, 31, tzinfo=datetime.timezone.utc)


def job(i, user, day, month=11):
    return {"id": i, "user_id": user, "created_at": datetime.datetime(2026, month, day, tzinfo=datetime.timezone.utc).isoformat(), "videos": {"en": "%s/p-%s/main.mp4" % (BASE, i)}}


def ids(out):
    return sorted(x[0] for x in out)


def test_free_video_goes_after_30_days_not_before():
    jobs = [job("old", "u", 1, 11), job("new", "u", 15, 12)]   # 60 days old, and 16 days old
    assert ids(m.pick_expired(jobs, {}, NOW, BASE, {})) == ["old"]


def test_a_running_plan_keeps_every_video():
    assert m.pick_expired([job("old", "u", 1, 1)], {}, NOW, BASE, {"u": m.FOREVER}) == []


def test_the_clock_starts_when_the_plan_ended_not_when_the_video_was_made():
    ended = datetime.datetime(2026, 12, 20, tzinfo=datetime.timezone.utc).isoformat()   # 11 days ago: the 3-month-old video still has 19 days
    assert m.pick_expired([job("a", "u", 1, 9)], {}, NOW, BASE, {"u": ended}) == []
    ended_long = datetime.datetime(2026, 11, 20, tzinfo=datetime.timezone.utc).isoformat()   # 41 days ago: gone
    assert ids(m.pick_expired([job("a", "u", 1, 9)], {}, NOW, BASE, {"u": ended_long})) == ["a"]


def test_a_video_made_after_the_plan_ended_counts_from_its_own_date():
    ended = datetime.datetime(2026, 10, 1, tzinfo=datetime.timezone.utc).isoformat()
    assert m.pick_expired([job("a", "u", 25, 12)], {}, NOW, BASE, {"u": ended}) == []


def test_expired_and_foreign_videos_are_skipped():
    j = job("a", "u", 1, 1); j["expired_at"] = "2026-02-01T00:00:00+00:00"
    other = job("b", "u", 1, 1); other["videos"] = {"en": "https://elsewhere/x/main.mp4"}
    assert m.pick_expired([j, other], {}, NOW, BASE, {}) == []


def test_subscribe_just_before_the_limit_then_stop_starts_a_fresh_30_days():
    day = lambda y, mo, d: datetime.datetime(y, mo, d, tzinfo=datetime.timezone.utc)
    made = [dict(job("a", "u", 1, 11), created_at=day(2026, 11, 1).isoformat())]
    # day 29 on the free plan: still there, one day left
    assert m.pick_expired(made, {}, day(2026, 11, 30), BASE, {}) == []
    # subscribed on day 29: nothing is removed however long the plan runs
    assert m.pick_expired(made, {}, day(2027, 3, 1), BASE, {"u": m.FOREVER}) == []
    # the plan ends on 1 March: 29 days later the video is still there, 31 days later it goes
    ended = day(2027, 3, 1).isoformat()
    assert m.pick_expired(made, {}, day(2027, 3, 30), BASE, {"u": ended}) == []
    assert ids(m.pick_expired(made, {}, day(2027, 4, 1), BASE, {"u": ended})) == ["a"]
