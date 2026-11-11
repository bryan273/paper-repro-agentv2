"""paper_sources() reads several sources for one video, marks each one, and shares the text budget. Read out of gen.py as source so the test needs none of gen.py's heavy dependencies."""
import json, os, re, pytest

SRC = open(os.path.join(os.path.dirname(__file__), "..", "gen.py"), encoding="utf-8").read()
m = re.search(r"^def paper_sources\(path\):.*?(?=^async def main)", SRC, re.S | re.M)
assert m, "paper_sources not found in gen.py"


def load(reader):
    ns = {"json": json, "re": re, "progress": lambda msg: None, "paper_file": reader, "paper_url": reader, "paper": reader}
    exec(m.group(0), ns)
    return ns["paper_sources"]


def test_marks_each_source_and_shares_the_budget(tmp_path):
    texts = {"a": "alpha " * 20000, "b": "beta " * 20000}
    fn = load(lambda key: (key.upper(), "", texts[key]))
    p = tmp_path / "s.json"
    p.write_text(json.dumps([{"kind": "file", "path": "a", "name": "Notes A"}, {"kind": "url", "url": "b", "name": "", "outline": ["Intro", "Method"]}]))
    names, text, outlines = fn(str(p))
    assert names == {1: "Notes A", 2: "B"}
    assert "=== SOURCE 1: Notes A ===" in text and "=== SOURCE 2: B ===" in text
    assert len(text) <= 60000 + 200
    assert outlines and "Intro; Method" in outlines[0] and outlines[0].startswith("Source 2")


def test_a_source_that_cannot_be_read_is_named(tmp_path):
    def reader(key):
        if key == "bad": raise ValueError("404")
        return ("Fine", "", "text " * 100)
    fn = load(reader)
    p = tmp_path / "s.json"
    p.write_text(json.dumps([{"kind": "file", "path": "ok", "name": "One"}, {"kind": "url", "url": "bad", "name": "Broken page"}]))
    with pytest.raises(RuntimeError, match=r"Source 2 \(Broken page\)"):
        fn(str(p))


def test_at_most_five_sources(tmp_path):
    fn = load(lambda key: (key, "", "x " * 50))
    p = tmp_path / "s.json"
    p.write_text(json.dumps([{"kind": "file", "path": str(i), "name": f"S{i}"} for i in range(7)]))
    names, _, _ = fn(str(p))
    assert len(names) == 5
