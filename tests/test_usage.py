import os, sys, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "explainer"))

def test_ledger_sums_and_estimates(monkeypatch, tmp_path):
    f = tmp_path / "u.jsonl"
    monkeypatch.setenv("USAGE_FILE", str(f))
    import usage
    usage.rec("claude-sonnet-4-6", 1000, 500)
    usage.rec("gpt-6.1-sol", None, None, "x" * 3500, "y" * 700)
    t = usage.summary()
    assert t["calls"] == 2 and t["estimated_calls"] == 1
    assert t["tokens_in"] == 2000 and t["tokens_out"] == 700
    assert 0.014 < t["usd"] < 0.015

def test_missing_file_is_zero(monkeypatch, tmp_path):
    monkeypatch.setenv("USAGE_FILE", str(tmp_path / "none.jsonl"))
    import usage
    assert usage.summary()["usd"] == 0.0
