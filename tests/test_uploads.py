"""PDF upload: the reader of an uploaded file (cut out of gen.py, which is a script) and the sweeper's age rule."""
import ast
import datetime
import importlib.util
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def _paper_file():
    src = (ROOT / "explainer/gen.py").read_text(encoding="utf-8")
    fn = next(n for n in ast.parse(src).body if isinstance(n, ast.FunctionDef) and n.name == "paper_file")
    ns = {"re": re}
    exec(compile(ast.Module([fn], []), "paper_file", "exec"), ns)
    return ns["paper_file"]


def _pdf(path, text, title=None):
    fitz = pytest.importorskip("fitz")
    doc = fitz.open()
    for chunk in range(0, len(text), 1800):
        page = doc.new_page()
        page.insert_textbox(fitz.Rect(40, 40, 555, 800), text[chunk:chunk + 1800], fontsize=10)
    if title:
        doc.set_metadata({"title": title})
    doc.save(str(path))
    return path


LONG = ("We study how a small model can reproduce a large result. " * 60).strip()


def test_reads_title_and_text(tmp_path):
    p = _pdf(tmp_path / "a.pdf", LONG, "A Study of Small Models")
    title, abstract, text = _paper_file()(str(p))
    assert title == "A Study of Small Models"
    assert len(abstract) == 1500 and "small model" in text


def test_title_falls_back_to_first_line(tmp_path):
    p = _pdf(tmp_path / "b.pdf", LONG)
    title, _, _ = _paper_file()(str(p))
    assert title.startswith("We study how a small model")


def test_rejects_a_file_that_is_not_a_pdf(tmp_path):
    p = tmp_path / "c.pdf"
    p.write_bytes(b"<html>not a pdf</html>" * 100)
    with pytest.raises(RuntimeError, match="not a PDF"):
        _paper_file()(str(p))


def test_rejects_a_scan_without_text(tmp_path):
    p = _pdf(tmp_path / "d.pdf", "tiny")
    with pytest.raises(RuntimeError, match="Scanned pages"):
        _paper_file()(str(p))


def test_sweeper_keeps_fresh_uploads_and_picks_old_ones():
    spec = importlib.util.spec_from_file_location("uploads_sweep", ROOT / "scripts/uploads_sweep.py")
    import os
    os.environ.setdefault("SUPABASE_URL", "http://x")
    os.environ.setdefault("SUPABASE_SECRET", "x")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    now = datetime.datetime(2026, 11, 7, 12, tzinfo=datetime.timezone.utc)
    rows = [
        {"path": "fresh", "created_at": "2026-11-07T01:00:00+00:00"},
        {"path": "old", "created_at": "2026-11-05T01:00:00Z"},
        {"path": "edge", "created_at": "2026-11-05T23:59:00+00:00"},
    ]
    assert mod.pick_stale(rows, now) == ["old", "edge"]
