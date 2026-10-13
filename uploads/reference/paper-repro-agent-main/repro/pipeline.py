"""The fixed scaffold: Reader -> Router -> Planner -> Implementer (+ Repair Manager) -> Verifier.

Every stage hands its output to the next as a structured record (state/*.json + a `handoff` event).
Handoffs pass through `injections.apply`, the single point where the companion study can plant
errors. The scaffold itself (roles, order, prompts, tools, retry budgets) never changes between runs.
"""
from __future__ import annotations

import copy
import json
import re
import shutil
import time
import traceback
import uuid
from contextlib import contextmanager
from pathlib import Path

from . import injections, prompts, quotes
from .config import RUNS_DIR, WORKSPACES_DIR, RunConfig
from .events import EventLog
from .executor import Executor, rerun_limit_s
from .llm import BudgetExceeded, Cancelled, Meter, chat, parse_json
from .paper import fetch_paper, pdf_to_text
from .sandbox import LocalSandbox, SandboxError, machine_resources

HIGH_FLAGS = {"hardcoded_constant", "echoed_paper_number", "proxy_metric", "wrong_split", "wrong_experiment", "wrong_dataset",
              "method_substituted"}
CODE_EXT = {".py", ".sh", ".yaml", ".yml", ".json", ".cfg", ".toml", ".txt", ".ipynb"}


def new_run_id() -> str:
    return time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]


class Run:
    def __init__(self, run_id: str, paper: str, repo: str | None = None, target_hint: str | None = None,
                 cfg: RunConfig | None = None, demo_id: str | None = None, injection_spec: list | None = None):
        self.id = run_id
        self.paper_source, self.repo_url, self.target_hint = paper, (repo or None), (target_hint or None)
        self.cfg = cfg or RunConfig()
        self.demo_id = demo_id
        self.injection_spec = injection_spec or []
        self.dir = RUNS_DIR / run_id
        self.dir.mkdir(parents=True, exist_ok=True)
        self.log = EventLog(self.dir / "events.jsonl")
        self.ws = WORKSPACES_DIR / run_id
        self.sb = LocalSandbox(self.ws, self.log, self.cfg.command_timeout_s)
        self.meter = Meter(self.cfg.max_cost_cny, time.time() + self.cfg.max_wall_minutes * 60)
        self.state: dict = {}
        self.ledger: list[dict] = []
        self.timings: dict[str, float] = {}
        self.meta = {"id": run_id, "paper": paper, "repo": repo, "target_hint": target_hint, "demo_id": demo_id,
                     "config": self.cfg.to_dict(), "status": "running", "started": time.time(), "injections": self.injection_spec}
        self._write_meta()

    # ---------- bookkeeping ----------
    def _write_meta(self):
        (self.dir / "meta.json").write_text(json.dumps(self.meta, ensure_ascii=False, indent=1, default=str), encoding="utf-8")

    def save_state(self, name: str, data):
        self.state[name] = data
        d = self.ws / "state"
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{name}.json").write_text(json.dumps(data, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
        (self.dir / f"{name}.json").write_text(json.dumps(data, ensure_ascii=False, indent=1, default=str), encoding="utf-8")

    def add_assumption(self, a: dict, by: str) -> dict:
        entry = {"id": f"A{len(self.ledger) + 1}", "by": by, **{k: v for k, v in a.items() if v is not None}}
        self.ledger.append(entry)
        self.save_state("assumption_ledger", self.ledger)
        self.log.emit("assumption", **entry)
        return entry

    @contextmanager
    def stage(self, name: str, title: str):
        t0 = time.time()
        self.log.emit("stage_start", stage=name, title=title)
        status = "ok"
        try:
            yield
        except Exception:
            status = "error"
            raise
        finally:
            self.timings[name] = round(time.time() - t0, 1)
            self.log.emit("stage_end", stage=name, status=status, seconds=self.timings[name], meter=self.meter.snapshot())

    def handoff(self, frm: str, to: str, kind: str, content: dict, evidence: str = "") -> dict:
        record = {"from": frm, "to": to, "kind": kind, "content": content, "evidence": evidence}
        record, applied = injections.apply(record, self.injection_spec)
        self.log.emit("handoff", **{k: record[k] for k in ("from", "to", "kind", "evidence")},
                      injected=applied, size=len(json.dumps(record["content"], default=str)))
        return record["content"]

    def _json_call(self, role: str, system: str, user: str, max_tokens: int = 40000) -> dict:
        # 40k: with thinking, a long claim contract used to hit 16k and come back cut off mid-JSON.
        last = None
        for attempt in range(3):
            r = chat(self.cfg.models[role], [{"role": "system", "content": system}, {"role": "user", "content": user}],
                     role=role, meter=self.meter, log=self.log, temperature=0.1, max_tokens=max_tokens, json_mode=True)
            try:
                return parse_json(r.content)
            except Exception as e:
                last = e
                if r.finish_reason == "length":
                    user += ("\n\nYour previous reply was cut off before the JSON ended. Write a shorter one: think briefly, "
                             "keep quotes under 20 words and list only the claims, requirements and assumptions that matter most.")
                else:
                    user += "\n\nYour previous reply was not one valid JSON object. Reply with the JSON object only."
        raise RuntimeError(f"{role}: no valid JSON after 3 attempts ({last})")

    # ---------- stages ----------
    def read_paper(self) -> dict:
        with self.stage("reader", "Reader: claim contract"):
            pdf, meta = fetch_paper(self.paper_source, self.ws / "paper")
            info = pdf_to_text(pdf)
            (self.ws / "paper" / "paper.txt").write_text(info["text"], encoding="utf-8")
            self.log.emit("paper", title=info["title"], pages=info["pages"], chars=info["chars"],
                          code_links=info["code_links"][:10], meta=meta)
            text = info["text"]
            if len(text) > 160_000:
                text = text[:120_000] + "\n...[middle omitted]...\n" + text[-40_000:]
            user = (f"Paper title (from PDF metadata, may be wrong): {info['title']}\n"
                    f"Links found in the PDF: {json.dumps(info['code_links'][:20])}\n"
                    f"User's target hint: {self.target_hint or '(none)'}\n\n=== PAPER TEXT ===\n{text}")
            c = self._json_call("reader", prompts.READER, user)
            ids = {x.get("id") for x in c.get("claims", [])}
            if not c.get("claims") or (c.get("match_target") or {}).get("claim_id") not in ids:
                raise RuntimeError("reader produced no usable match target")
            c["paper_meta"] = {**meta, "title": c.get("title") or info["title"], "pages": info["pages"]}
            for a in c.pop("assumptions", []) or []:
                self.add_assumption(a, "reader")
            view = quotes.annotate(c, self.ledger, info["text"])
            self.save_state("assumption_ledger", self.ledger)
            self.save_state("claim_contract", c)
            tgt = self.target(c)
            self.log.emit("contract", title=c.get("title"), summary=c.get("summary"), target=tgt,
                          tolerance=c.get("tolerance"), n_claims=len(c["claims"]), n_requirements=len(c.get("requirements", [])),
                          n_assumptions=len(self.ledger))
            self.log.emit("contract_full", pages=info["pages"], **view)
            return self.handoff("reader", "router", "claim_contract", c, "paper/paper.txt")

    @staticmethod
    def target(c: dict) -> dict:
        cid = c["match_target"]["claim_id"]
        return next(x for x in c["claims"] if x.get("id") == cid)

    def _find_repo(self, c: dict) -> str | None:
        if self.repo_url:
            return self.repo_url
        for u in (c.get("code_links") or []) + (c.get("paper_meta", {}).get("code_links") or []):
            m = re.match(r"https?://github\.com/([\w.-]+)/([\w.-]+)", u or "")
            if m:
                return f"https://github.com/{m.group(1)}/{m.group(2).removesuffix('.git')}"
        return None

    def inspect_repo(self, url: str) -> dict:
        res = self.sb.run(["git", "clone", "--depth", "1", url, "repo"], ".", 300, call_id="clone")
        if res.exit_code != 0:
            return {"url": url, "cloned": False, "error": res.stdout_tail[-800:]}
        repo = self.ws / "repo"
        files = [p for p in repo.rglob("*") if p.is_file() and ".git" not in p.parts]
        readme = next((p for p in repo.iterdir() if p.name.lower().startswith("readme")), None)
        deps = {}
        for name in ("requirements.txt", "setup.py", "environment.yml", "pyproject.toml", "setup.cfg", "Makefile"):
            p = repo / name
            if p.exists():
                deps[name] = p.read_text(encoding="utf-8", errors="replace")[:2500]
        py = [p for p in files if p.suffix == ".py"]
        imports: dict[str, int] = {}
        py2 = 0
        for p in py[:300]:
            t = p.read_text(encoding="utf-8", errors="replace")
            for m in re.findall(r"^\s*(?:import|from)\s+([\w]+)", t, re.M):
                imports[m] = imports.get(m, 0) + 1
            if re.search(r"^\s*print\s+[\"'\w]", t, re.M):
                py2 += 1
        scripts = [str(p.relative_to(repo)).replace("\\", "/") for p in files if p.suffix in (".sh", ".py") and p.stat().st_size < 200_000][:80]
        return {
            "url": url, "cloned": True, "n_files": len(files), "n_python": len(py),
            "tree": self.sb.listdir("repo", 3)[:5000],
            "readme": readme.read_text(encoding="utf-8", errors="replace")[:7000] if readme else None,
            "dependency_files": deps, "top_imports": sorted(imports.items(), key=lambda x: -x[1])[:25],
            "python2_style_files": py2, "scripts": scripts,
        }

    def route(self, c: dict) -> dict:
        with self.stage("router", "Router: release status + compute"):
            url = self._find_repo(c)
            repo_info = self.inspect_repo(url) if url else {"url": None, "cloned": False, "note": "no repository found or given"}
            self.log.emit("repo", **{k: repo_info.get(k) for k in ("url", "cloned", "n_files", "n_python", "python2_style_files", "error")})
            self.resources = machine_resources()
            self.log.emit("resources", **self.resources)
            system = prompts.ROUTER.replace("{wall_minutes}", str(int(self.cfg.max_wall_minutes)))
            user = json.dumps({"claim_contract": {k: c.get(k) for k in ("title", "summary", "claims", "match_target", "data", "code_links", "stated_compute")},
                               "repository": repo_info, "machine": self.resources}, ensure_ascii=False, default=str)
            r = self._json_call("router", system, user)
            r["repo_info"] = {k: repo_info.get(k) for k in ("url", "cloned", "n_files", "n_python", "python2_style_files")}
            self.save_state("route", r)
            f = r.get("feasibility") or {}
            self.log.emit("route", route=r.get("route"), why=r.get("why"), gpu_required=f.get("gpu_required"),
                          est_runtime=f.get("est_runtime_on_this_machine"), fits_budget=f.get("fits_budget"),
                          scale_down_plan=f.get("scale_down_plan"), verdict_ceiling=f.get("verdict_ceiling"),
                          blockers=r.get("blockers_seen"))
            self._repo_info = repo_info
            return self.handoff("router", "planner", "route", r, "repo/ + machine resources")

    def plan(self, c: dict, r: dict) -> dict:
        with self.stage("planner", "Planner: files, config, checks"):
            user = json.dumps({"claim_contract": c, "route": r, "assumption_ledger": self.ledger,
                               "repository": {k: self._repo_info.get(k) for k in ("tree", "readme", "dependency_files", "scripts")}},
                              ensure_ascii=False, default=str)
            p = self._json_call("planner", prompts.PLANNER, user)
            self.save_state("plan", p)
            self.log.emit("plan", approach=p.get("approach"), steps=p.get("steps"), files=[f.get("path") for f in p.get("files", [])],
                          smoke_test=p.get("smoke_test"), intermediate_checks=p.get("intermediate_checks"), budget_plan=p.get("budget_plan"))
            return self.handoff("planner", "implementer", "plan", p, "state/plan.json")

    @staticmethod
    def masked(c: dict) -> dict:
        m = copy.deepcopy(c)
        for cl in m.get("claims", []):
            for k in ("value", "reported_spread"):
                cl.pop(k, None)
        m.pop("tolerance", None)
        m.pop("summary", None)  # summaries tend to quote the headline number
        return m

    def within_tolerance(self, metrics: dict, c: dict | None = None) -> bool | None:
        c = c or self.state["claim_contract"]
        v = metrics.get("value") if isinstance(metrics, dict) else None
        if not isinstance(v, (int, float)):
            return None
        gap = self.gap(float(v), c)
        return gap["within"]

    def gap(self, measured: float, c: dict) -> dict:
        t = self.target(c)
        target = float(t["value"])
        tol = c.get("tolerance") or {"type": "relative", "value": 0.05}
        scaled = measured
        # unit mismatch: 0.925 vs 92.5 (%)
        if target > 1.5 and 0 <= measured <= 1.0 and abs(measured * 100 - target) < abs(measured - target):
            scaled = measured * 100
        elif target <= 1.0 and measured > 1.5 and abs(measured / 100 - target) < abs(measured - target):
            scaled = measured / 100
        diff = scaled - target
        band = float(tol.get("value", 0.05))
        if tol.get("type") == "relative":
            band = abs(target) * (band if band < 1 else band / 100)
        return {"target": target, "measured": measured, "measured_normalised": round(scaled, 6), "diff": round(diff, 6),
                "band": round(band, 6), "within": abs(diff) <= band + 1e-9, "close": abs(diff) <= 2 * band + 1e-9}

    def implement(self, c: dict, r: dict, p: dict) -> dict:
        with self.stage("implementer", "Implementer + Repair Manager"):
            self.sb.prepare()
            ex = Executor(self.sb, self.log, self.meter, self.cfg, self.state, self.add_assumption, self.save_state)
            info = ex.loop(ex.brief(self.masked(c), {k: v for k, v in r.items() if k != "repo_info"}, p, self.resources),
                           c, p, lambda: self.ledger, lambda m: self.within_tolerance(m, c))
            info["steps"], info["repair_rounds"] = ex.steps, ex.repair_rounds
            self.save_state("implementation", {k: v for k, v in info.items()})
            self.log.emit("implementation_done", summary=info.get("summary"), blocked=info.get("blocked"),
                          steps=ex.steps, repair_rounds=ex.repair_rounds, scaled_down=info.get("scale_notes") if info.get("scaled_down") is True else None)
            return self.handoff("implementer", "verifier", "implementation", info, "reproduce.py + results/")

    # ---------- verifier ----------
    def _agent_files(self) -> dict[str, str]:
        out, total = {}, 0
        for p in sorted(self.ws.rglob("*")):
            rel = p.relative_to(self.ws)
            if not p.is_file() or rel.parts[0] in ("repo", "paper", "state", ".venv", ".tmp", "results", ".good") or ".venv" in rel.parts:
                continue
            if p.suffix not in CODE_EXT or p.name == "ledger.jsonl" or p.stat().st_size > 200_000:
                continue
            t = p.read_text(encoding="utf-8", errors="replace")
            out[str(rel).replace("\\", "/")] = t
            total += len(t)
            if total > 90_000:
                break
        return out

    def _echo_scan(self, c: dict, files: dict[str, str]) -> list[dict]:
        hits = []
        for cl in c.get("claims", []):
            v = cl.get("value")
            if not isinstance(v, (int, float)):
                continue
            forms = {f"{v}", f"{v:.1f}", f"{v:.2f}"}
            if v > 1.5:
                forms |= {f"{v / 100:.3f}", f"{v / 100:.4f}"}
            forms = {f for f in forms if len(f.replace(".", "").lstrip("0")) >= 3}
            for path, text in files.items():
                for f in forms:
                    for m in re.finditer(rf"(?<![\d.]){re.escape(f)}(?![\d])", text):
                        line = text[: m.start()].count("\n") + 1
                        hits.append({"claim": cl.get("id"), "value": f, "file": path, "line": line,
                                     "context": text.splitlines()[line - 1][:200]})
        return hits[:30]

    def verify(self, c: dict, impl: dict, route: dict) -> dict:
        with self.stage("verifier", "Verifier: clean re-run + audit"):
            rerun, metrics = None, None
            if (self.ws / "reproduce.py").exists():
                shutil.rmtree(self.ws / "results", ignore_errors=True)
                remaining = max(120, int(self.meter.deadline - time.time()))
                # The implementer was told the clean re-run must fit in rerun_limit_s; allow some slack on top of that.
                timeout = min(max(remaining + 600, int(rerun_limit_s(self.cfg) * 1.5)), 3600)
                self.log.emit("verifier_rerun", note="deleted results/ and re-running `python reproduce.py` from scratch",
                              timeout_s=timeout)
                res = self.sb.run(["python", "reproduce.py"], ".", timeout, call_id="verifier-rerun")
                rerun = {"exit": res.exit_code, "timed_out": res.timed_out, "seconds": round(res.seconds, 1), "tail": res.stdout_tail[-2500:]}
                mp = self.ws / "results" / "metrics.json"
                if mp.exists():
                    try:
                        metrics = json.loads(mp.read_text(encoding="utf-8"))
                    except Exception:
                        metrics = None
            self.log.emit("rerun_result", **(rerun or {"exit": None, "note": "no reproduce.py"}), metrics=metrics)
            # The audit is one model call; a run that used its whole time budget still gets it.
            self.meter.deadline = max(self.meter.deadline, time.time() + 600)
            audit, echoes = self.audit(c, impl, route, rerun, metrics)
            verdict = self.decide(c, route, impl, rerun, metrics, audit)
            verdict.update({"audit": audit, "rerun": rerun, "metrics": metrics, "echo_hits": echoes})
            self.save_state("verdict", verdict)
            self.log.emit("verdict", **{k: verdict.get(k) for k in ("verdict", "reason", "target", "measured", "gap", "flags", "scaled_down")},
                          audit_summary=audit.get("audit_summary"), requirement_check=audit.get("requirement_check"),
                          divergence_causes=audit.get("divergence_causes"))
            return verdict

    def audit(self, c, impl, route, rerun, metrics) -> tuple[dict, list]:
        files = self._agent_files()
        echoes = self._echo_scan(c, files)
        audit = {}
        if files:
            user = json.dumps({"claim_contract": c, "assumption_ledger": self.ledger, "route": route.get("route"),
                               "implementer_summary": impl.get("summary"), "implementer_scaled_down": impl.get("scaled_down"),
                               "implementer_scale_notes": impl.get("scale_notes"),
                               "router_scale_down_plan": (route.get("feasibility") or {}).get("scale_down_plan"),
                               "clean_rerun": rerun, "metrics_json": metrics,
                               "paper_numbers_found_in_code": echoes, "source_files": files,
                               "command_ledger_tail": self._ledger_tail()}, ensure_ascii=False, default=str)
            try:
                audit = self._json_call("verifier", prompts.VERIFIER, user)
            except Exception as e:
                audit = {"audit_summary": f"verifier audit failed: {e}", "flags": []}
        return audit, echoes

    def _ledger_tail(self) -> list:
        p = self.ws / "ledger.jsonl"
        if not p.exists():
            return []
        rows = [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]
        return [{k: r.get(k) for k in ("argv", "exit", "seconds", "timed_out")} for r in rows[-40:]]

    def decide(self, c, route, impl, rerun, metrics, audit) -> dict:
        t = self.target(c)
        target = {"claim_id": t.get("id"), "statement": t.get("statement"), "value": t.get("value"), "unit": t.get("unit"),
                  "metric": t.get("metric"), "dataset": t.get("dataset"), "table_ref": t.get("table_ref"), "tolerance": c.get("tolerance")}
        flags = sorted(set(audit.get("flags") or []))
        ceiling = ((route.get("feasibility") or {}).get("verdict_ceiling")) or "reproduced"
        # The verifier saw the code and the re-run, so its boolean is authoritative. The router's ceiling is a forecast
        # made before any code existed (often a contingency plan that was never used); it only counts without an audit.
        if isinstance(audit.get("scaled_down"), bool):
            scaled = audit["scaled_down"]
        else:
            scaled = impl.get("scaled_down") is True or ceiling == "partially_reproduced"
        out = {"target": target, "flags": flags, "scaled_down": scaled, "measured": None, "gap": None}
        if not rerun or rerun.get("exit") != 0 or not isinstance((metrics or {}).get("value"), (int, float)):
            why = "the clean re-run did not produce results/metrics.json with a numeric value"
            if impl.get("blocked"):
                why = "implementer reported a blocker: " + (impl.get("summary") or "")
            return {**out, "verdict": "could_not_run", "reason": why}
        g = self.gap(float(metrics["value"]), c)
        out.update(measured=metrics["value"], gap=g)
        high = [f for f in flags if f in HIGH_FLAGS]
        if high:
            return {**out, "verdict": "not_reproduced", "reason": "verifier raised: " + ", ".join(high)}
        if audit.get("right_experiment") is False:
            return {**out, "verdict": "not_reproduced", "reason": "the code does not run the target experiment"}
        if g["within"] and not scaled:
            return {**out, "verdict": "reproduced", "reason": f"within tolerance (|diff| {abs(g['diff']):.4g} <= {g['band']:.4g}) on a clean re-run"}
        if g["within"]:
            return {**out, "verdict": "partially_reproduced", "reason": "within tolerance, but the run was scaled down from the paper's setup"}
        if g["close"]:
            return {**out, "verdict": "partially_reproduced", "reason": f"outside tolerance but within 2x the band (diff {g['diff']:+.4g})"}
        return {**out, "verdict": "not_reproduced", "reason": f"outside tolerance (diff {g['diff']:+.4g}, band {g['band']:.4g})"}

    # ---------- report ----------
    def write_report(self, v: dict):
        c = self.state.get("claim_contract", {})
        r = self.state.get("route", {})
        m = self.meter.snapshot()
        lines = [f"# Reproduction report: {c.get('title', self.paper_source)}", "",
                 f"- Run: `{self.id}`", f"- Verdict: **{v.get('verdict')}**, {v.get('reason')}",
                 f"- Target: {json.dumps(v.get('target'), ensure_ascii=False)}", f"- Measured: {v.get('measured')}",
                 f"- Route: {r.get('route')}, {r.get('why')}",
                 f"- Cost: ¥{m['cost_cny']:.2f} over {m['calls']} model calls; tokens in {m['prompt_tokens']:,}, out {m['completion_tokens']:,}",
                 f"- Stage times (s): {json.dumps(self.timings)}", "", "## Audit", (v.get("audit") or {}).get("audit_summary") or "", "",
                 "## Assumptions", *[f"- {a['id']} ({a.get('risk')}, {a.get('by')}): {a.get('gap')} -> {a.get('chosen')}" for a in self.ledger]]
        (self.dir / "report.md").write_text("\n".join(lines), encoding="utf-8")

    def cancel(self):
        self.meter.cancelled = True
        self.sb.cancel()

    # ---------- main ----------
    def execute(self):
        self.log.emit("run_start", run_id=self.id, paper=self.paper_source, repo=self.repo_url, target_hint=self.target_hint,
                      config=self.cfg.to_dict(), demo_id=self.demo_id, injections=self.injection_spec)
        status, verdict = "finished", None
        try:
            c = self.read_paper()
            r = self.route(c)
            p = self.plan(c, r)
            impl = self.implement(c, r, p)
            verdict = self.verify(c, impl, r)
        except Cancelled as e:
            status = "cancelled"
            self.log.emit("error", kind="cancelled", message=str(e))
        except BudgetExceeded as e:
            status = "budget_exceeded"
            self.log.emit("error", kind="budget", message=str(e))
            if "claim_contract" in self.state and "route" in self.state and (self.ws / "reproduce.py").exists():
                try:
                    self.meter.max_cost_cny += 2  # a little headroom so the verifier can still judge what exists
                    self.meter.deadline = time.time() + 1800
                    verdict = self.verify(self.state["claim_contract"], self.state.get("implementation", {"summary": str(e)}), self.state["route"])
                except Exception as e2:
                    self.log.emit("error", kind="verifier", message=str(e2))
        except Exception as e:
            status = "error"
            self.log.emit("error", kind=type(e).__name__, message=str(e)[:2000], trace=traceback.format_exc()[-3000:])
        if verdict:
            self.write_report(verdict)
        self.meta.update(status=status, finished=time.time(), verdict=(verdict or {}).get("verdict"),
                         title=self.state.get("claim_contract", {}).get("title"), route=self.state.get("route", {}).get("route"),
                         meter=self.meter.snapshot(), timings=self.timings,
                         seconds=round(time.time() - self.meta["started"], 1))
        self._write_meta()
        self.log.emit("run_end", status=status, verdict=(verdict or {}).get("verdict"), seconds=self.meta["seconds"],
                      meter=self.meter.snapshot(), timings=self.timings)
        return self.meta
