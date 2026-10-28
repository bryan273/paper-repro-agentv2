"""Server tests with FastAPI's TestClient: the event stream must resume after a reconnect instead of
replaying the whole run (that replay made the UI duplicate every row and grow without end)."""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
fastapi_testclient = pytest.importorskip("fastapi.testclient")

from repro import server  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    runs = tmp_path / "runs"
    d = runs / "r1"
    d.mkdir(parents=True)
    events = [{"seq": i, "t": i, "type": t} for i, t in enumerate(["run_start", "stage_start", "stage_end", "run_end"], 1)]
    (d / "events.jsonl").write_text("".join(json.dumps(e) + "\n" for e in events), encoding="utf-8")
    (d / "meta.json").write_text(json.dumps({"id": "r1", "status": "finished"}), encoding="utf-8")
    monkeypatch.setattr(server, "RUNS_DIR", runs)
    return fastapi_testclient.TestClient(server.app)


def data_lines(text):
    return [json.loads(l[6:]) for l in text.splitlines() if l.startswith("data: ") and l[6:] != "{}"]


def test_stream_sends_every_event_once_and_ends(client):
    r = client.get("/api/runs/r1/events")
    evs = data_lines(r.text)
    assert [e["type"] for e in evs] == ["run_start", "stage_start", "stage_end", "run_end"]
    assert "id: " in r.text   # each event carries a resume position


def test_reconnect_with_last_event_id_does_not_replay(client):
    first = client.get("/api/runs/r1/events").text
    ids = [l[4:] for l in first.splitlines() if l.startswith("id: ")]
    r = client.get("/api/runs/r1/events", headers={"Last-Event-ID": ids[1]})
    assert [e["type"] for e in data_lines(r.text)] == ["stage_end", "run_end"]


def test_interrupted_runs_are_marked_on_startup(tmp_path, monkeypatch):
    runs = tmp_path / "runs"
    (runs / "old").mkdir(parents=True)
    (runs / "old" / "meta.json").write_text(json.dumps({"id": "old", "status": "running"}), encoding="utf-8")
    monkeypatch.setattr(server, "RUNS_DIR", runs)
    server._mark_interrupted_runs()
    assert json.loads((runs / "old" / "meta.json").read_text(encoding="utf-8"))["status"] == "interrupted"


FEED = """<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
<entry><id>http://arxiv.org/abs/2510.13311v2</id><published>2025-10-15T00:00:00Z</published>
<title>Isolation-based Spherical
  Ensemble Representations</title><summary>Code at https://github.com/charles-cao/ISER.</summary>
<author><name>Yang Cao</name></author><author><name>Yujiu Yang</name></author>
<arxiv:comment>ICDM 2026</arxiv:comment><arxiv:primary_category term="cs.LG"/></entry></feed>"""


def test_parse_feed_and_query_forms():
    from repro.search import build_query, parse_feed
    rows = parse_feed(FEED)
    assert rows[0]["id"] == "2510.13311" and rows[0]["title"] == "Isolation-based Spherical Ensemble Representations"
    assert rows[0]["authors"] == ["Yang Cao", "Yujiu Yang"] and rows[0]["category"] == "cs.LG" and rows[0]["links_code"]
    assert build_query("Yujiu Yang", "author") == 'au:"Yujiu Yang"'
    assert build_query("isolation forest", "keywords") == "all:isolation AND all:forest"
    assert build_query("https://arxiv.org/abs/2510.13311v2", "author") == "id:2510.13311"


def test_search_pins_matching_past_runs_even_when_older_than_the_page(client, monkeypatch):
    # the newest 40 papers of a prolific author did not include the ones reproduced here
    from repro.search import parse_feed
    (server.RUNS_DIR / "r1" / "meta.json").write_text(json.dumps({"id": "r1", "status": "finished", "paper": "2510.13311",
                                                                  "verdict": "reproduced"}), encoding="utf-8")
    monkeypatch.setattr(server, "search_arxiv", lambda q, mode, n, start: [])
    monkeypatch.setattr(server, "fetch_ids", lambda ids: parse_feed(FEED) if ids == ["2510.13311"] else [])
    j = client.get("/api/search", params={"q": "Yujiu Yang"}).json()
    assert [p["id"] for p in j["already_run"]] == ["2510.13311"]
    assert j["already_run"][0]["runs"][0]["verdict"] == "reproduced"
    assert client.get("/api/search", params={"q": "Kaiming He"}).json()["already_run"] == []   # not this author
    assert client.get("/api/search", params={"q": "x"}).status_code == 400
