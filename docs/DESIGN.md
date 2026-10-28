# Design

This document explains how the agent works and why. The research behind each choice is in
[RESEARCH.md](RESEARCH.md).

## The fixed scaffold

```
paper (+ repo) ──► Reader ──► Router ──► Planner ──► Implementer ⇄ Repair Manager ──► Verifier ──► verdict
                   contract   route +     files,      sandbox tool loop                clean re-run,
                   ledger     compute     checks                                       audit, flags
```

The roles, their order, their prompts, their tools and the retry budgets do not change between runs.
Only the model behind each role and the paper change. Because of that, two runs on the same paper
differ only in model behaviour, and the path each run takes is logged as a result rather than treated
as a change to the setup. That is what makes the system usable for controlled experiments later.

| Role | Input | Output (in `state/`) | Idea taken from |
|---|---|---|---|
| Reader | paper text, links, optional target hint | `claim_contract.json`: claims with values and table refs, the cheapest match target, a tolerance fixed before any run, requirements, data sources | RECLAIM match target; ReproAgent requirement units; PaperBench rubric leaves |
| Reader | same | `assumption_ledger.json`: every detail the paper leaves open, the option chosen, the risk | 2604.21965 underspecification attribution; PaperCoder and AutoReproduce hotspots |
| Router | contract, cloned repo inspection, machine resources | `route.json`: `full_release` / `partial_release` / `paper_only`, entrypoints, blockers, and a compute feasibility decision with a verdict ceiling | RECLAIM release tiers; 58/73 RECLAIM successes ran the authors' entrypoint |
| Planner | contract, route, repo tree | `plan.json`: files in dependency order, one config, smoke test, checks before the full run, budget split | PaperCoder logic design; AutoReproduce smoke tests; PaperBench budget lesson |
| Implementer | contract **with target values removed**, route, plan | a workspace where `python reproduce.py` writes `results/metrics.json` | CORE-Bench and PaperBench single entrypoint; 2604.21965 information isolation |
| Repair Manager | contract with targets, recent commands, ledger | a diagnosis (`env` / `code` / `understanding`) and one instruction | HiRAS managers; ReproAgent repair tickets; CORE-Bench install loops |
| Verifier | contract, ledger, agent-written code, command ledger, **its own clean re-run** | `verdict.json`: requirement check, flags, divergence causes | RECLAIM adversarial auditor and anti-cheat flags; CORE-Bench shortcut findings |

## What makes the verdict trustworthy

1. **The target is fixed before any code runs.** The Reader sets the tolerance with a stated reason.
   Nothing later can move it.
2. **The implementer never sees the target value** in its brief, so it cannot aim at it. It can still
   read the paper, so the verifier also scans the agent's code for the paper's numbers.
3. **Finishing is gated.** `finish` is refused unless `reproduce.py` exists, ran with exit 0, and wrote
   `results/metrics.json` in that same run.
4. **The verifier re-runs from scratch.** It deletes `results/`, runs `python reproduce.py` itself, and
   only uses the number that run produces.
5. **The verdict is computed, not asked for.** Code compares the re-run number with the target and
   tolerance. The verifier model can only lower the verdict, through flags such as
   `hardcoded_constant`, `wrong_experiment` or `undisclosed_scale_down`, never raise it.
6. **Scale-downs cap the verdict.** If the Router says the paper does not fit this machine and plans a
   smaller run, the best possible verdict is "partially reproduced".

Verdicts: `reproduced` (within tolerance, full setup, no flags) · `partially_reproduced` (within
tolerance but scaled down, or outside tolerance but within 2× the band) · `not_reproduced` ·
`could_not_run`.

## Repair loop

The manager is called when three commands fail, when the same error signature repeats three times,
every 15 steps, and when the implementer tries to finish with a result outside the tolerance. In the
last case, if budget remains, the run goes back for up to three repair rounds. The manager may say
whether the result is inside the tolerance and in which direction it misses, but never the value,
and any change must be justified by the paper and written to the ledger.

## Handoffs and error injection

Every stage passes its output to the next as a record `{from, to, kind, content, evidence}`, logged
as a `handoff` event. All records pass through `repro/injections.py`, which is a no-op unless the run
has an injection spec. With a spec, a handoff can be changed at a named point (`reader->router`,
`router->planner`, `planner->implementer`, `implementer->verifier`) by false information, omission,
a wrong conclusion, conflicting evidence or a corrupted value, each carrying a traceable marker.
This is the hook for the companion robustness study.

## Sandbox

`repro/sandbox.py` gives each run its own folder and virtual environment, layered on a prepared base
environment (numpy, scipy, pandas, scikit-learn, matplotlib, torch CPU). Only `python`, `pip` and
`git` (read-only subcommands plus clone) can run, as argv lists, never through a shell. File tools
cannot leave the workspace. The child gets a scrubbed environment: no API keys, and HOME and TEMP
point inside the workspace. Commands have hard timeouts and the whole process tree is killed on
timeout. Every command is written to `ledger.jsonl`.

This is process isolation for a single-user machine, not a security boundary for hostile code.
Papers' code runs with the user's permissions and can reach the network (needed to download data).
For running strangers' papers at scale, implement the same five methods (`prepare`, `run`, `read`,
`write`, `edit`, `listdir`) on a container or microVM backend (Docker, E2B, Vercel Sandbox, Modal).

## Compute and GPUs

The Router receives the machine's resources (CPU cores, RAM, GPU from `nvidia-smi`, disk). It must
say whether the target needs a GPU, estimate runtime here, and if it does not fit, write a scale-down
plan (data subset, fewer epochs, fewer repeats) with the expected effect. The UI shows this before
the implementer starts, and a scaled run can never be labelled plain "reproduced".

## Cost and time

Every model call is streamed, and its tokens, cost and duration are recorded per role. Each run has a
cost cap, a wall-clock cap and a step cap (UI or CLI), and a global cap across runs
(`REPRO_GLOBAL_CAP_CNY`) stops an unattended session from draining the account. Prices in
`repro/config.py` are estimates.

## Models

Any OpenAI-compatible endpoint works. Each role can use a different model. Providers are listed in
`repro/config.py` (Paratera, DeepSeek, StepFun, Zhipu); add a key to `.env` and the models appear in
the UI. On the Paratera gateway, DeepSeek must be streamed (non-streamed calls stall) and connections
occasionally drop, so every call retries with backoff.
