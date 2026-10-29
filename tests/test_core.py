"""Unit tests for the parts of the agent that decide things without a model: verdict rules, quote
validation, error injection, the sandbox guards, the event log and the finish gate. No API calls."""
import json
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from repro import injections, quotes  # noqa: E402
from repro.config import RunConfig  # noqa: E402
from repro.events import EventLog, read_events  # noqa: E402
from repro import executor as executor_mod  # noqa: E402
from repro.executor import Executor, rerun_limit_s  # noqa: E402
from repro.llm import Cancelled, Meter, Reply, parse_json  # noqa: E402
from repro.pipeline import Run  # noqa: E402
from repro.sandbox import LocalSandbox, SandboxError  # noqa: E402


# ---------------------------------------------------------------- verdict rules
def contract(value=92.5, tol=("absolute", 1.0)):
    return {"claims": [{"id": "C1", "value": value, "statement": "acc"}], "match_target": {"claim_id": "C1"},
            "tolerance": {"type": tol[0], "value": tol[1]}}


def decide(measured, audit=None, route=None, impl=None, exit_code=0, c=None):
    run = Run.__new__(Run)
    metrics = {"value": measured} if measured is not None else None
    return run.decide(c or contract(), route or {"feasibility": {"verdict_ceiling": "reproduced"}}, impl or {},
                      {"exit": exit_code}, metrics, audit or {"scaled_down": False, "right_experiment": True})


def test_within_tolerance_is_reproduced():
    assert decide(92.1)["verdict"] == "reproduced"


def test_fraction_is_matched_to_percent():
    v = decide(0.921)
    assert v["verdict"] == "reproduced" and abs(v["gap"]["measured_normalised"] - 92.1) < 1e-9


def test_scaled_down_caps_the_verdict():
    assert decide(92.1, audit={"scaled_down": True, "right_experiment": True})["verdict"] == "partially_reproduced"
    # without an audit boolean the router's forecast still caps the verdict
    assert decide(92.1, audit={"right_experiment": True},
                  route={"feasibility": {"verdict_ceiling": "partially_reproduced"}})["verdict"] == "partially_reproduced"


def test_verifier_overrides_the_routers_forecast():
    # regression (ISER run): the router capped the verdict for a contingency plan the code never used
    v = decide(92.1, route={"feasibility": {"verdict_ceiling": "partially_reproduced"}},
               audit={"scaled_down": False, "right_experiment": True})
    assert v["verdict"] == "reproduced" and v["scaled_down"] is False


def test_implementer_note_saying_no_scaling_does_not_cap():
    # regression: free text "No scaling ..." used to be read as a scale-down
    v = decide(92.1, audit={"right_experiment": True}, impl={"scaled_down": "No scaling for the target claim"})
    assert v["verdict"] == "reproduced"


def test_close_but_outside_is_partial_and_far_is_not_reproduced():
    assert decide(91.0)["verdict"] == "partially_reproduced"     # 1.5 off, band 1 -> within 2x
    assert decide(90.0)["verdict"] == "not_reproduced"           # 2.5 off: regression, 3x used to call this partial
    assert decide(85.0)["verdict"] == "not_reproduced"


def test_high_flag_forces_not_reproduced():
    v = decide(92.5, audit={"flags": ["hardcoded_constant"], "right_experiment": True})
    assert v["verdict"] == "not_reproduced"


def test_substituted_method_is_not_reproduced():
    v = decide(92.5, audit={"flags": ["method_substituted"], "right_experiment": True})
    assert v["verdict"] == "not_reproduced"


def test_wrong_experiment_is_not_reproduced():
    assert decide(92.5, audit={"right_experiment": False})["verdict"] == "not_reproduced"


def test_failed_rerun_is_could_not_run():
    assert decide(None, exit_code=1)["verdict"] == "could_not_run"


def test_relative_tolerance():
    c = contract(value=2.97, tol=("relative", 0.1))
    assert decide(2.93, c=c)["verdict"] == "reproduced"
    assert decide(3.5, c=c)["verdict"] == "partially_reproduced"


# ---------------------------------------------------------------- quotes
PAPER = "=== page 1 ===\nIntro text here.\n=== page 2 ===\nWe use 10 hidden units and run fastText for 5 epochs with a learn-\ning rate selected on a validation set."


def test_quote_found_on_right_page_even_across_hyphenation():
    q, page = quotes.locate("run fastText for 5 epochs with a learning rate selected", quotes.page_texts(PAPER))
    assert q and page == 2


def test_invented_quote_is_dropped():
    c = {"claims": [{"id": "C1", "quote": "this sentence is not in the paper at all"}], "requirements": [], "match_target": {"claim_id": "C1"}}
    view = quotes.annotate(c, [], PAPER)
    assert c["claims"][0]["quote"] is None and view["quote_check"]["dropped"] == 1


def test_page_of_line():
    assert quotes.page_of_line(PAPER, 4) == 2


# ---------------------------------------------------------------- injections
def rec():
    return {"from": "planner", "to": "implementer", "kind": "plan",
            "content": {"config": {"lr": 0.1}, "steps": ["a", "b", "c"]}}


def test_no_spec_changes_nothing():
    r, applied = injections.apply(rec(), [])
    assert r == rec() and applied == []


def test_false_info_and_omission_are_applied_with_markers():
    spec = [{"at": "planner->implementer", "type": "false_info", "path": "config.lr", "value": 0.5, "marker": "INJ-1"},
            {"at": "planner->implementer", "type": "omission", "path": "steps.1"}]
    r, applied = injections.apply(rec(), spec)
    assert r["content"]["config"]["lr"] == 0.5 and r["content"]["steps"] == ["a", "c"]
    assert all(a["ok"] for a in applied) and applied[0]["marker"] == "INJ-1"


def test_injection_at_other_point_is_ignored():
    r, applied = injections.apply(rec(), [{"at": "reader->router", "type": "omission", "path": "config"}])
    assert r == rec() and applied == []


# ---------------------------------------------------------------- sandbox
@pytest.fixture
def sb(tmp_path):
    log = EventLog(tmp_path / "events.jsonl")
    box = LocalSandbox(tmp_path / "ws", log, default_timeout=60)
    box.prepare()
    return box


def test_only_python_pip_git_allowed(sb):
    for bad in (["rm", "-rf", "/"], ["cmd", "/c", "dir"], ["git", "push"], ["bash", "-c", "ls"]):
        with pytest.raises(SandboxError):
            sb._check_argv(bad)


def test_paths_cannot_leave_workspace(sb):
    with pytest.raises(SandboxError):
        sb.resolve("../outside.txt")
    with pytest.raises(SandboxError):
        sb.write("../../evil.py", "x")


def test_run_captures_output_and_changed_files(sb):
    sb.write("hello.py", "open('out.txt','w').write('hi'); print('done')")
    res = sb.run(["python", "hello.py"])
    assert res.exit_code == 0 and "done" in res.stdout_tail and "out.txt" in res.changed_files


def test_child_has_no_api_keys(sb, monkeypatch):
    monkeypatch.setenv("PARATERA_API_KEY", "secret-value")
    sb.write("env.py", "import os; print('KEY' if any('secret-value' in v for v in os.environ.values()) else 'CLEAN')")
    assert "CLEAN" in sb.run(["python", "env.py"]).stdout_tail


def test_child_keeps_proxy_settings(sb, monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:9")
    sb.write("proxy.py", "import os; print('PROXY=' + os.environ.get('HTTPS_PROXY', 'none'))")
    assert "PROXY=http://127.0.0.1:9" in sb.run(["python", "proxy.py"]).stdout_tail


def test_timeout_kills_process(sb):
    sb.write("sleep.py", "import time; time.sleep(30)")
    res = sb.run(["python", "sleep.py"], timeout=2)
    assert res.timed_out and res.seconds < 15


def test_cancel_stops_a_running_command(sb):
    sb.write("sleep.py", "import time; time.sleep(30)")
    threading.Timer(1.5, sb.cancel).start()
    t0 = time.time()
    sb.run(["python", "sleep.py"], timeout=60)
    assert time.time() - t0 < 15


# ---------------------------------------------------------------- events, parsing, meter
def test_read_events_ignores_partial_last_line(tmp_path):
    p = tmp_path / "e.jsonl"
    p.write_text('{"a": 1}\n{"b": 2}\n{"c": ', encoding="utf-8")
    evs, off = read_events(p)
    assert [list(e) for e in evs] == [["a"], ["b"]]
    with p.open("a", encoding="utf-8") as f:
        f.write('3}\n')
    evs2, _ = read_events(p, off)
    assert evs2 == [{"c": 3}]


def test_parse_json_tolerates_fences_and_prose():
    assert parse_json('```json\n{"x": 1}\n```') == {"x": 1}
    assert parse_json('Here it is: {"x": 2} done') == {"x": 2}


def test_meter_cancel_raises():
    m = Meter(10, time.time() + 60)
    m.cancelled = True
    with pytest.raises(Cancelled):
        m.check()


# ---------------------------------------------------------------- finish gate
def test_finish_is_rejected_until_reproduce_ran(sb):
    ex = Executor(sb, sb.log, Meter(10, time.time() + 600), RunConfig(), {}, lambda a, by: {"id": "A1"}, lambda *a: None)
    assert ex._finish({"summary": "done"}).startswith("finish REJECTED")
    sb.write("reproduce.py", "import json,os; os.makedirs('results',exist_ok=True); json.dump({'metric':'acc','value':0.9}, open('results/metrics.json','w'))")
    ex._tool("run", {"argv": ["python", "reproduce.py"]}, "c1")
    assert not ex._finish({"summary": "done"}).startswith("finish REJECTED")
    assert (sb.root / ".good" / "reproduce.py").exists()   # last working version was snapshotted


def test_finish_is_rejected_when_the_clean_rerun_would_be_too_slow(sb):
    # regression (CLAR run): reproduce.py ran a 30-minute grid and the verifier's re-run timed out
    ex = Executor(sb, sb.log, Meter(10, time.time() + 600), RunConfig(), {}, lambda a, by: {"id": "A1"}, lambda *a: None)
    sb.write("reproduce.py", "import json,os; os.makedirs('results',exist_ok=True); json.dump({'metric':'acc','value':0.9}, open('results/metrics.json','w'))")
    ex._tool("run", {"argv": ["python", "reproduce.py"]}, "c1")
    ex.last_repro_seconds = ex.rerun_limit_s + 60
    out = ex._finish({"summary": "done"})
    assert out.startswith("finish REJECTED") and "re-run allows" in out
    ex.last_repro_seconds = 30
    assert not ex._finish({"summary": "done"}).startswith("finish REJECTED")


def test_rerun_limit_is_a_third_of_the_budget_within_bounds():
    assert rerun_limit_s(RunConfig(max_wall_minutes=60)) == 1200
    assert rerun_limit_s(RunConfig(max_wall_minutes=15)) == 600
    assert rerun_limit_s(RunConfig(max_wall_minutes=240)) == 1800


def test_manager_retries_when_the_reply_has_no_json(sb, monkeypatch):
    # regression (CLAR run): the manager spent all 6,000 tokens thinking and its advice was lost
    replies = iter(["", '{"diagnosis": "code", "evidence": "e", "instruction": "fix x", "stop": false}'])
    monkeypatch.setattr(executor_mod, "chat", lambda *a, **k: Reply(next(replies), "", [], {}, "stop", 0.1))
    ex = Executor(sb, sb.log, Meter(10, time.time() + 600), RunConfig(), {}, lambda a, by: {"id": "A1"}, lambda *a: None)
    d = ex.manager("periodic check", {}, {}, [])
    assert d["diagnosis"] == "code" and d["instruction"] == "fix x"


def test_dataset_cache_is_readable_but_not_writable(sb):
    from repro.config import CACHE_DIR
    cache = CACHE_DIR / "datasets" / "files"
    cache.mkdir(parents=True, exist_ok=True)
    assert sb.listdir(str(cache), 1) is not None
    with pytest.raises(SandboxError):
        sb.write(str(cache / "x.txt"), "no")


def test_json_call_asks_for_a_shorter_reply_after_a_cut_off(monkeypatch):
    # regression: the Reader's claim contract hit max_tokens and came back cut off three times in a row
    import repro.pipeline as pipeline_mod
    seen = []

    def fake_chat(choice, messages, **k):
        seen.append(messages[-1]["content"])
        if len(seen) == 1:
            return Reply('{"claims": [', "", [], {}, "length", 0.1)
        return Reply('{"ok": true}', "", [], {}, "stop", 0.1)

    monkeypatch.setattr(pipeline_mod, "chat", fake_chat)
    run = Run.__new__(Run)
    run.cfg, run.meter, run.log, run.frozen = RunConfig(), Meter(10, time.time() + 600), None, {}
    assert run._json_call("reader", "sys", "paper") == {"ok": True}
    assert "cut off" in seen[1]


def test_finish_needs_a_run_with_no_arguments(sb):
    # regression (CLAR run): the full run used flags; the default path crashed in the verifier's re-run
    ex = Executor(sb, sb.log, Meter(10, time.time() + 600), RunConfig(), {}, lambda a, by: {"id": "A1"}, lambda *a: None)
    sb.write("reproduce.py", "import json,os,sys\nif len(sys.argv) == 1: raise SystemExit('default path broken')\n"
                             "os.makedirs('results',exist_ok=True); json.dump({'metric':'acc','value':0.9}, open('results/metrics.json','w'))")
    ex._tool("run", {"argv": ["python", "reproduce.py", "--full"]}, "c1")
    assert ex._finish({"summary": "done"}).startswith("finish REJECTED")
    assert not ex.has_good


_ROOT = Path(__file__).resolve().parent.parent
_WEB = _ROOT / "web" if (_ROOT / "web").exists() else _ROOT / "app" / "frontend" / "public" / "repro"


def test_directory_is_self_consistent():
    """web/directory.json: every listed paper exists once, each group member is an author of one of its papers."""
    import json
    from pathlib import Path
    d = json.loads((_WEB / "directory.json").read_text(encoding="utf-8"))
    assert d["groups"]
    for g in d["groups"]:
        assert g["institute"] and g["name"] and len(set(g["papers"])) == len(g["papers"])
        assert all(i in d["papers"] for i in g["papers"])
        authors = {a for i in g["papers"] for a in d["papers"][i]["authors"]}
        assert all(m["name"] in authors for m in g["members"])


def test_replays_are_strict_json():
    """A browser's JSON.parse rejects NaN and Infinity, so no replay line may contain them."""
    import json
    from pathlib import Path
    def bad(c):
        raise ValueError(c)
    for f in (_WEB / "demo-runs").glob("*.jsonl"):
        for n, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            if line.strip():
                json.loads(line, parse_constant=bad)


def test_fit_estimate_python_and_js_agree():
    """repro/probe.py (the kit) and web/fit.js (the viewer) must give the same estimate."""
    import json
    import shutil
    import subprocess

    from repro import probe

    cases = [
        ({"difficulty": 3, "needs_gpu": False, "ram_gb": 4, "ref_minutes": 40, "gpu_speedup": None}, dict(cpu=117.9, ram=15.4)),
        ({"difficulty": 4, "needs_gpu": True, "vram_gb": 8, "ref_minutes": 300, "gpu_speedup": 10}, dict(cpu=100, gpu=9, vram=12, ram=32)),
        ({"difficulty": 4, "needs_gpu": True, "vram_gb": 8, "ref_minutes": 300, "gpu_speedup": 10}, dict(cpu=70, ram=16)),
        ({"difficulty": 1, "needs_gpu": False, "ref_minutes": 3.8, "gpu_speedup": 2}, dict(cpu=35, gpu=3, vram=4, ram=8)),
    ]
    for compute, m in cases:
        py = probe.estimate(compute, m["cpu"], m.get("gpu"), m.get("vram"), m.get("ram"))
        assert py["known"]
        if not shutil.which("node"):
            continue
        js = json.loads(subprocess.run(
            ["node", "-e", "global.window={};global.navigator={};require('./" + _WEB.relative_to(_ROOT).as_posix() + "/fit.js');"
             f"console.log(JSON.stringify(window.Fit.estimate({json.dumps(compute)},{json.dumps(m)})))"],
            capture_output=True, text=True, cwd=Path(__file__).resolve().parent.parent, check=True).stdout)
        assert js["feasible"] == py["feasible"]
        if py["feasible"]:
            assert abs(js["minutes"] - py["minutes"]) < 0.11 and js["path"] == py["path"]
    assert probe.decide(probe.estimate(cases[0][0], 117.9), 30)["decision"] in ("scale_down", "stop_too_big")
    assert probe.tier(cases[1][0]) == "heavy"


def test_frozen_steps_are_returned_without_calling_the_model(monkeypatch, tmp_path):
    import json as _json
    import repro.pipeline as pipeline_mod
    monkeypatch.setattr(pipeline_mod, "chat", lambda *a, **k: (_ for _ in ()).throw(AssertionError("the model must not be called")))
    run = Run.__new__(Run)
    run.cfg, run.meter, run.log = RunConfig(), Meter(10, time.time() + 600), None
    run.frozen = {"reader": {"claims": [1]}}
    class L:  # minimal log
        def emit(self, *a, **k): pass
    run.log = L()
    got = run._json_call("reader", "s", "u")
    assert got == {"claims": [1]} and got is not run.frozen["reader"]   # a copy, so later edits cannot change the frozen step
