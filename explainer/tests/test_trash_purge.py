import datetime, importlib.util, os

spec = importlib.util.spec_from_file_location("r2_maintain", os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "r2_maintain.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
NOW = datetime.datetime(2026, 11, 20, tzinfo=datetime.timezone.utc)


def ev(t, job, day, on=None, user="u1"):
    meta = {"job": job} if on is None else {"job": job, "on": on}
    return {"type": t, "user_id": user, "created_at": (datetime.datetime(2026, 11, day, tzinfo=datetime.timezone.utc)).isoformat(), "meta": meta}


def test_old_trash_is_purged_recent_is_kept():
    out = m.pick_trash([ev("trash", "a", 1, True), ev("trash", "b", 18, True)], NOW)
    assert out == [("a", "u1")]


def test_old_events_without_on_count_as_deleted():
    assert m.pick_trash([ev("trash", "a", 1)], NOW) == [("a", "u1")]


def test_a_restored_video_is_not_purged_and_a_new_delete_restarts_the_clock():
    assert m.pick_trash([ev("trash", "a", 1, True), ev("trash", "a", 2, False)], NOW) == []
    assert m.pick_trash([ev("trash", "a", 1, True), ev("trash", "a", 2, False), ev("trash", "a", 19, True)], NOW) == []


def test_an_already_purged_video_is_skipped():
    assert m.pick_trash([ev("trash", "a", 1, True), ev("purged", "a", 10)], NOW) == []


def test_exactly_seven_days_is_purged():
    assert m.pick_trash([ev("trash", "a", 13, True)], NOW) == [("a", "u1")]
