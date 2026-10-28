"""Implementer tool loop plus the repair manager that supervises it."""
from __future__ import annotations

import hashlib
import json
import re
import time
from pathlib import Path

from . import prompts
from .config import RunConfig
from .events import EventLog
from .llm import BudgetExceeded, Meter, chat, parse_json
from .sandbox import LocalSandbox, SandboxError

TOOLS = [
    {"type": "function", "function": {
        "name": "list_files", "description": "List files under a workspace folder.",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "default": "."}, "depth": {"type": "integer", "default": 2}}}}},
    {"type": "function", "function": {
        "name": "read_file", "description": "Read a text file with line numbers.",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string"}, "start": {"type": "integer", "default": 1},
            "max_lines": {"type": "integer", "default": 250}}, "required": ["path"]}}},
    {"type": "function", "function": {
        "name": "write_file", "description": "Create or overwrite a text file in the workspace.",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}}},
    {"type": "function", "function": {
        "name": "edit_file", "description": "Replace one exact, unique snippet in a file. Prefer this over rewriting.",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string"}, "old": {"type": "string"}, "new": {"type": "string"}},
            "required": ["path", "old", "new"]}}},
    {"type": "function", "function": {
        "name": "run", "description": "Run a command in the sandbox. argv is a list, e.g. [\"python\", \"prepare.py\"] "
                                      "or [\"pip\", \"install\", \"fasttext-wheel\"]. Only python, pip and git are allowed.",
        "parameters": {"type": "object", "properties": {
            "argv": {"type": "array", "items": {"type": "string"}}, "cwd": {"type": "string", "default": "."},
            "timeout": {"type": "integer", "default": 900}}, "required": ["argv"]}}},
    {"type": "function", "function": {
        "name": "note_assumption", "description": "Record a decision the paper does not pin down.",
        "parameters": {"type": "object", "properties": {
            "gap": {"type": "string"}, "chosen": {"type": "string"}, "rationale": {"type": "string"},
            "risk": {"type": "string", "enum": ["low", "medium", "high"]},
            "options": {"type": "array", "items": {"type": "string"}}}, "required": ["gap", "chosen", "rationale", "risk"]}}},
    {"type": "function", "function": {
        "name": "finish", "description": "Declare the reproduction finished (reproduce.py ran and wrote results/metrics.json) or blocked.",
        "parameters": {"type": "object", "properties": {
            "summary": {"type": "string"}, "blocked": {"type": "boolean", "default": False},
            "scaled_down": {"type": "boolean", "description": "true only if the target run used less data, fewer epochs/repeats or a smaller model than the paper"},
            "scale_notes": {"type": "string", "description": "what was reduced and why, if scaled_down is true"}},
            "required": ["summary"]}}},
]


def rerun_limit_s(cfg: RunConfig) -> int:
    """Seconds the verifier's clean re-run may take: a third of the run budget, between 10 and 30 minutes."""
    return int(max(600, min(1800, cfg.max_wall_minutes * 60 / 3)))


def _args_preview(name: str, args: dict) -> dict:
    a = dict(args)
    if name == "write_file" and isinstance(a.get("content"), str):
        c = a["content"]
        a["content"] = c if len(c) < 6000 else c[:6000] + f"\n... ({len(c)} chars)"
    return a


class Executor:
    def __init__(self, sb: LocalSandbox, log: EventLog, meter: Meter, cfg: RunConfig, state: dict,
                 on_assumption, save_state):
        self.sb, self.log, self.meter, self.cfg, self.state = sb, log, meter, cfg, state
        self.on_assumption, self.save_state = on_assumption, save_state
        self.messages: list[dict] = []
        self.history: list[dict] = []          # compact command history for the manager
        self.steps = 0
        self.repair_rounds = 0
        self.failures_since_manager = 0
        self.last_manager_step = 0
        self.error_hashes: dict[str, int] = {}
        self.finish_info: dict | None = None
        self.last_repro_ok: float | None = None
        self.last_repro_seconds: float | None = None
        self.has_good = False
        self.time_warned = False
        # The verifier deletes results/ and runs `python reproduce.py` once, so that run must fit in a fixed slice.
        self.rerun_limit_s = rerun_limit_s(cfg)

    # ---------- brief ----------
    def brief(self, masked_contract: dict, route: dict, plan: dict, resources: dict) -> str:
        return (
            "## Claim contract (target values removed)\n" + json.dumps(masked_contract, ensure_ascii=False, indent=1)
            + "\n\n## Route and feasibility\n" + json.dumps(route, ensure_ascii=False, indent=1)
            + "\n\n## Plan\n" + json.dumps(plan, ensure_ascii=False, indent=1)
            + "\n\n## Machine\n" + json.dumps(resources)
            + f"\n\n## Budget\nAbout {self.cfg.max_executor_steps} tool steps and {self.cfg.max_wall_minutes:.0f} minutes for the whole run."
            + f"\n\n## Clean re-run limit\nThe verifier deletes results/ and runs `python reproduce.py` once with no arguments; it must "
              f"finish within {self.rerun_limit_s // 60} minutes. If a hyperparameter search would make it longer, run the search "
              "separately (e.g. `python reproduce.py --search`), save the selected configuration and the search log to a file "
              "outside results/ (e.g. selected_config.json), and let the default run train and evaluate only that configuration "
              "with the paper's number of repeats. Report the search in metrics.json."
            + "\n\n## Workspace now\n" + self.sb.listdir(".", 2)
            + "\n\nStart by looking at what is in the workspace, then follow the plan."
        )

    # ---------- tools ----------
    def _tool(self, name: str, args: dict, call_id: str) -> str:
        sb = self.sb
        if name == "list_files":
            return sb.listdir(args.get("path", "."), int(args.get("depth", 2)))
        if name == "read_file":
            out = sb.read(args["path"], int(args.get("start", 1)), int(args.get("max_lines", 250)))
            self._note_paper_read(args["path"], int(args.get("start", 1)), int(args.get("max_lines", 250)))
            return out
        if name == "write_file":
            return sb.write(args["path"], args["content"])
        if name == "edit_file":
            return sb.edit(args["path"], args["old"], args["new"])
        if name == "run":
            argv = args.get("argv")
            if isinstance(argv, str):
                argv = argv.split()
            if any("paper.txt" in str(x) for x in argv):
                self.log.emit("paper_read", by="implementer", pages=None, how="searched the paper text with a script")
            res = sb.run(argv, args.get("cwd", "."), args.get("timeout"), call_id=call_id)
            ok = res.exit_code == 0 and not res.timed_out
            is_repro = len(argv) >= 2 and argv[0].startswith("python") and Path(argv[1]).name == "reproduce.py"
            # Only a run with no arguments counts: that is how the verifier runs it.
            if is_repro and ok and len(argv) == 2:
                self.last_repro_ok = time.time() - res.seconds  # start time of the last clean run
                self.last_repro_seconds = res.seconds
                if (self.sb.root / "results" / "metrics.json").exists():
                    self._snapshot_good()
            self.history.append({"step": self.steps, "argv": argv, "exit": res.exit_code, "timed_out": res.timed_out,
                                 "seconds": round(res.seconds, 1), "tail": res.stdout_tail[-1200:]})
            if not ok:
                self.failures_since_manager += 1
                sig = hashlib.md5(re.sub(r"\d+", "#", res.stdout_tail[-400:]).encode()).hexdigest()
                self.error_hashes[sig] = self.error_hashes.get(sig, 0) + 1
            return res.for_model()
        if name == "note_assumption":
            entry = self.on_assumption({k: args.get(k) for k in ("gap", "chosen", "rationale", "risk", "options")}, "implementer")
            return f"recorded assumption {entry['id']}"
        if name == "finish":
            return self._finish(args)
        raise SandboxError(f"unknown tool {name}")

    # ---------- last known good ----------
    GOOD_SKIP = {"repo", "paper", "state", "data", "results", ".venv", ".tmp", ".good", "pip", "AppData"}

    def _code_files(self):
        root = self.sb.root
        for p in root.rglob("*"):
            rel = p.relative_to(root)
            if p.is_file() and rel.parts[0] not in self.GOOD_SKIP and p.suffix in (".py", ".json", ".yaml", ".yml", ".txt", ".cfg", ".toml")                     and p.stat().st_size < 2_000_000 and ".venv" not in rel.parts:
                yield p, rel

    def _snapshot_good(self):
        import shutil
        good = self.sb.root / ".good"
        shutil.rmtree(good, ignore_errors=True)
        n = 0
        for p, rel in self._code_files():
            dst = good / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, dst)
            n += 1
        self.has_good = True
        self.log.emit("snapshot", note=f"saved last working version ({n} files) after a clean `python reproduce.py`")

    def restore_good(self) -> bool:
        import shutil
        good = self.sb.root / ".good"
        if not good.exists():
            return False
        for p in good.rglob("*"):
            if p.is_file():
                dst = self.sb.root / p.relative_to(good)
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(p, dst)
        self.log.emit("snapshot", note="restored the last working version before verification")
        return True

    def _note_paper_read(self, path: str, start: int, n: int):
        if not path.replace("\\", "/").endswith("paper/paper.txt"):
            return
        try:
            from .quotes import page_of_line
            text = (self.sb.root / "paper" / "paper.txt").read_text(encoding="utf-8")
            a, b = page_of_line(text, start) or 1, page_of_line(text, start + n) or 1
            self.log.emit("paper_read", by="implementer", pages=list(range(a, b + 1)), how="read_file")
        except Exception:
            pass

    def _finish(self, args: dict) -> str:
        if args.get("blocked"):
            self.finish_info = {**args, "accepted": True}
            return "finish accepted (blocked)"
        root = self.sb.root
        problems = []
        if not (root / "reproduce.py").exists():
            problems.append("reproduce.py does not exist in the workspace root")
        mpath = root / "results" / "metrics.json"
        metrics = None
        if not mpath.exists():
            problems.append("results/metrics.json does not exist")
        else:
            try:
                metrics = json.loads(mpath.read_text(encoding="utf-8"))
                if not isinstance(metrics.get("value"), (int, float)):
                    problems.append("results/metrics.json needs a numeric 'value' key")
            except Exception as e:
                problems.append(f"results/metrics.json is not valid JSON: {e}")
        if self.last_repro_ok is None:
            problems.append("`python reproduce.py` with NO arguments has not yet run successfully (exit 0) from the workspace root; the verifier runs it exactly that way")
        elif mpath.exists() and mpath.stat().st_mtime + 2 < self.last_repro_ok:
            problems.append("results/metrics.json was not written by the last successful reproduce.py run")
        left = self.cfg.max_executor_steps - self.steps
        if not problems and self.last_repro_seconds and self.last_repro_seconds > self.rerun_limit_s and left > 6:
            problems.append(f"the last `python reproduce.py` took {self.last_repro_seconds / 60:.0f} min but the verifier's clean "
                            f"re-run allows {self.rerun_limit_s // 60} min. Keep the search behind a flag, save the selected "
                            "configuration outside results/, and make the default run evaluate only that configuration")
        if problems:
            return "finish REJECTED: " + "; ".join(problems) + ". Fix these, run `python reproduce.py`, then call finish again."
        self.finish_info = {**args, "metrics": metrics}
        return "finish received; the manager will review it."

    # ---------- manager ----------
    def manager(self, reason: str, full_contract: dict, plan: dict, ledger: list, metrics: dict | None = None) -> dict:
        ctx = {
            "reason_for_review": reason,
            "contract": full_contract, "plan_steps": plan.get("steps"), "assumption_ledger": ledger,
            "recent_commands": self.history[-8:], "steps_used": self.steps, "max_steps": self.cfg.max_executor_steps,
            "repair_rounds_used": self.repair_rounds, "metrics_json": metrics,
            "files": self.sb.listdir(".", 2)[:3000],
        }
        msgs = [{"role": "system", "content": prompts.MANAGER},
                {"role": "user", "content": json.dumps(ctx, ensure_ascii=False, default=str)}]
        d = None
        # A reasoning model can spend the whole token budget thinking and return no JSON; then ask once more, briefly.
        for _ in range(2):
            r = chat(self.cfg.models["planner"], msgs, role="manager", meter=self.meter, log=self.log, temperature=0.2,
                     max_tokens=16000, json_mode=True)
            try:
                d = parse_json(r.content)
                break
            except Exception:
                msgs = msgs[:2] + [{"role": "user", "content": "Your last reply had no JSON object. Think briefly and reply "
                                                              "with the JSON object only."}]
        if d is None:
            d = {"diagnosis": "on_track", "evidence": "manager reply unparseable", "instruction": "Continue with the plan.", "stop": False}
        self.log.emit("manager", reason=reason, **{k: d.get(k) for k in ("diagnosis", "evidence", "instruction", "assumption_to_revisit", "stop")})
        self.failures_since_manager = 0
        self.last_manager_step = self.steps
        return d

    # ---------- context management ----------
    def _compact(self):
        total = sum(len(json.dumps(m, ensure_ascii=False)) for m in self.messages)
        if total < 220_000:
            return
        cut = max(2, len(self.messages) - 24)
        for m in self.messages[2:cut]:
            if m["role"] == "tool" and len(m["content"]) > 400:
                m["content"] = m["content"][:300] + "\n[older output trimmed]"
            if m["role"] == "assistant" and len(m.get("reasoning_content") or "") > 600:
                m["reasoning_content"] = m["reasoning_content"][:500] + " [trimmed]"
            if m["role"] == "assistant":
                for tc in m.get("tool_calls") or []:
                    a = tc["function"]["arguments"]
                    if len(a) > 1500:
                        tc["function"]["arguments"] = json.dumps({"_trimmed": a[:1200]})

    # ---------- main loop ----------
    def loop(self, brief: str, full_contract: dict, plan: dict, ledger_ref, within_tolerance) -> dict:
        self.messages = [{"role": "system", "content": prompts.EXECUTOR}, {"role": "user", "content": brief}]
        idle = 0
        while self.steps < self.cfg.max_executor_steps:
            self.meter.check()
            # Leave the verifier time for its clean re-run and audit.
            reserve = (self.last_repro_seconds or 0) * 1.3 + 300
            if self.has_good and time.time() > self.meter.deadline - reserve:
                if not self.time_warned:
                    self.time_warned = True
                    self.messages.append({"role": "user", "content": "Time is nearly up: the verifier needs the rest for its "
                                          "clean re-run. Make no more changes; call finish now."})
                else:
                    self.restore_good()
                    return {"summary": "time budget nearly used; verifying the last version that ran cleanly",
                            "blocked": False, "restored_last_good": True}
            self._compact()
            reply = chat(self.cfg.models["executor"], self.messages, role="executor", meter=self.meter, log=self.log,
                         tools=TOOLS, temperature=self.cfg.temperature, max_tokens=16000)
            self.messages.append(reply.as_message())
            if reply.content.strip():
                self.log.emit("message", role="executor", text=reply.content[:4000])
            if not reply.tool_calls:
                idle += 1
                nudge = "Continue: use the tools. When reproduce.py has run and written results/metrics.json, call finish."
                if idle >= 3:
                    d = self.manager("implementer stopped using tools", full_contract, plan, ledger_ref())
                    nudge = "Manager: " + d.get("instruction", nudge)
                    idle = 0
                self.messages.append({"role": "user", "content": nudge})
                continue
            idle = 0
            for tc in reply.tool_calls:
                self.steps += 1
                name = tc["name"]
                try:
                    args = json.loads(tc["arguments"] or "{}")
                except json.JSONDecodeError:
                    args = None
                t0 = time.time()
                if args is None:
                    out, ok = "tool arguments were not valid JSON; send them again", False
                else:
                    self.log.emit("tool_call", call_id=tc["id"], name=name, args=_args_preview(name, args), step=self.steps)
                    try:
                        out, ok = self._tool(name, args, tc["id"]), True
                    except KeyError as e:
                        out, ok = f"ERROR: missing required argument {e} for {name}", False
                    except (SandboxError, TypeError, ValueError, OSError) as e:
                        out, ok = f"ERROR: {e}", False
                self.log.emit("tool_result", call_id=tc["id"], name=name, ok=ok and not out.startswith("finish REJECTED"),
                              seconds=round(time.time() - t0, 2), text=out[:3000], step=self.steps)
                left = self.cfg.max_executor_steps - self.steps
                if left <= max(5, self.cfg.max_executor_steps // 5):
                    out += (f"\n\n[budget: {left} tool steps left. Do not start new features or extra datasets. "
                            + ("A working reproduce.py already exists; if results/metrics.json covers the target, call finish now."
                               if getattr(self, "has_good", False) else "Get `python reproduce.py` to run end to end and call finish.") + "]")
                self.messages.append({"role": "tool", "tool_call_id": tc["id"], "content": out})
            # ----- supervision -----
            if self.finish_info:
                info = self.finish_info
                if info.get("blocked"):
                    return info
                verdict_hint = within_tolerance(info.get("metrics") or {})
                budget_left = self.steps < 0.8 * self.cfg.max_executor_steps
                if verdict_hint is False and budget_left and self.repair_rounds < self.cfg.max_repair_rounds:
                    self.repair_rounds += 1
                    d = self.manager("finish requested but the result is outside tolerance", full_contract, plan,
                                     ledger_ref(), info.get("metrics"))
                    if not d.get("stop"):
                        self.finish_info = None
                        self.messages.append({"role": "user", "content":
                            f"Manager review (repair round {self.repair_rounds}/{self.cfg.max_repair_rounds}): the result is "
                            f"outside the tolerance. Diagnosis: {d.get('diagnosis')}. {d.get('instruction')} "
                            "Keep every change faithful to the paper and record new choices with note_assumption; "
                            "then re-run reproduce.py and call finish again."})
                        continue
                return info
            repeated = any(v >= 3 for v in self.error_hashes.values())
            if self.failures_since_manager >= 3 or repeated or self.steps - self.last_manager_step >= 15:
                reason = "same error repeated" if repeated else ("several failed commands" if self.failures_since_manager >= 3 else "periodic check")
                if repeated:
                    self.error_hashes.clear()
                d = self.manager(reason, full_contract, plan, ledger_ref())
                if d.get("stop") and d.get("diagnosis") == "done" and self.has_good:
                    # finished, not blocked: the target is in hand and the working entrypoint is snapshotted
                    self.restore_good()
                    return {"summary": "manager ended the run with the target done: " + (d.get("evidence") or ""), "blocked": False}
                if d.get("diagnosis") == "done" and not self.has_good:
                    # "done" from a run with flags is not done: the verifier runs `python reproduce.py` with no
                    # arguments, and in the CLAR run that default path crashed on a never-tested branch.
                    self.messages.append({"role": "user", "content": "Manager: the result looks done, but `python reproduce.py` "
                                          "has not yet run cleanly with NO arguments, which is exactly how the verifier will "
                                          "run it. Run it that way now (fix the default path if it fails), then call finish."})
                    continue
                if d.get("stop"):
                    return {"summary": "manager stopped the run: " + (d.get("evidence") or ""), "blocked": True}
                if d.get("diagnosis") == "done":
                    self.messages.append({"role": "user", "content": f"Manager: the target is done. {d.get('instruction')} Call finish now."})
                elif d.get("diagnosis") != "on_track":
                    self.messages.append({"role": "user", "content": f"Manager ({d.get('diagnosis')}): {d.get('instruction')}"})
        info = {"summary": "step budget exhausted", "blocked": False, "budget_exhausted": True}
        if self.has_good:
            self.restore_good()
            info["summary"] = "step budget exhausted; verifying the last version that ran cleanly"
            info["restored_last_good"] = True
        return info
