# Research notes: paper-to-code reproduction agents (as of 2026-09-30)

Every arXiv ID below was opened on arxiv.org. Numbers are as reported by each source.

## Systems

### PaperBench (2504.01848, OpenAI)
- Replicate 20 ICML 2024 papers from scratch; author repos are blocked. Rubrics co-written with authors, 8,316 leaves of three types: Code Development, Execution, Result Match.
- Submission is a repo with `reproduce.sh`, re-run in a fresh VM (A10 GPU); only files produced there count for Execution and Result Match.
- BasicAgent (ReAct: bash, python, browser, reader) and IterativeAgent (no early stop, works piecemeal over 12 h).
- Claude 3.5 Sonnet 21.0%; o1 IterativeAgent 24.4% (12 h), 26.0% (36 h); human ML PhDs 41.4% on a subset. By leaf type (Sonnet): Code Dev 35.4%, Execution 1.8%, Result Match 0.7%.
- Failure modes: agents finish early (claim success or an unsolvable blocker), nobody plans the time budget.
- **We copy:** single entrypoint re-run in a clean environment; do not accept a voluntary "done".

### RECLAIM (2609.28850, UIUC/NCSA, Sep 2026)
- 100 NeurIPS 2025 papers in three tiers by what authors released: Run (code, data, weights), Retrain (no weights), Reimplement (paper only).
- Target = the cheapest configuration the authors report that still establishes the central claim.
- Adversarial LLM auditor traces every number to execution evidence and recomputes from raw artifacts; typed anti-cheat flags (echoed paper number, hardcoded constant, proxy value, missing artifact) force a zero. Auditor vs humans F1 0.82.
- Best agent DeepSeek-V4-Flash: 41% Run (14/34), 27% Retrain (9/33), 12% Reimplement (4/33).
- Failures over 400 runs: outside tolerance 76, reproduced 73, reimplemented but never checked against the paper's numbers 63, wrong artifact measured 38, wrong experiment 31, failed before any number 31, echoed a shipped number 24, dependency failures 24, never launched 11. Failed runs used 29% of their GPU budget; 58 of 73 successes ran the authors' own entrypoint.
- **We copy:** release-tier routing, cheapest match target, anti-cheat flags, recomputation from artifacts.

### Paper2Code / PaperCoder (2504.17192)
- Planning (overall plan, architecture, logic design = file order by dependency, `config.yaml`), analysis (a spec per file), generation in dependency order.
- PaperBench Code-Dev 45.14% with o3-mini-high; about $0.90 per paper. Architecture design alone hurt until logic design fixed the file order.
- Failures: underspecified data processing, loss errors, deprecated APIs, runs needing subsampling.
- **We copy:** dependency-ordered file plan, one config for every hyperparameter.

### DeepCode (github.com/HKUDS/DeepCode, 2512.07921)
- Blueprint distillation, stateful code memory (symbols and interfaces per file), CodeRAG over reference repos, closed-loop error correction. Reports 73.5% on PaperBench Code-Dev.
- **We copy:** compact state instead of the raw paper in every prompt.

### ReproAgent (2608.24291, Findings of EMNLP 2026)
- Persistent implementation contract: requirement units `{id, src, stmt, cite, surf, art, status}` and scoped reference evidence. Preservation invariant: every unit owned, projected to a file, verified.
- Repair tickets that name failed units and protect passing ones; 3 stage reviews plus 5 repo rounds.
- Code-Dev 73.7 (Sonnet-4.5). Ablation: without evidence 21.6, without requirements 25.6.
- **We copy:** requirement list with citations, repair that protects working parts.

### HiRAS (2604.17745)
- Two-level hierarchy of managers that inspect the shared workspace and re-dispatch incomplete or hallucinated work. Only the executor has bash.
- Code-Dev: Sonnet 64.1; **DeepSeek-v3.1 57.4** (baseline 40.8). The hierarchy alone added about 6 points on DeepSeek.
- Showed a reference-free LLM judge scores an empty repo 3.89/5.
- **We copy:** a manager that reads artifacts and command history, not chat.

### CORE-Bench (2409.11363) and "Life After Benchmark Saturation" (2606.26158)
- 270 tasks from 90 papers at Easy / Medium / Hard. Numeric answers must fall in a 95% prediction interval from 3 manual runs.
- CORE-Agent tips: check output schemas programmatically, read existing outputs first, plan installs.
- 2606.26158 found exploitable shortcuts (reading answers from pre-existing artifacts, skipping seeds). Minimal fixes succeed 95.2% vs 67.8% for rewrites. Agents' stated confidence is unrelated to success.
- **We copy:** delete pre-existing outputs before the verifier re-run; prefer small edits; ignore self-reported confidence.

### Other work used
- AutoReproduce (2505.20662): paper lineage, sampling-based unit tests (mini-batch with early break), line-range edits.
- RePro (2508.16671): paper "fingerprint" of atomic checkable criteria, verify-and-refine.
- xKG (2510.17795): executable knowledge graph of paper, technique and code nodes.
- Agentic social-science reproduction (2604.21965): information isolation (numbers masked from the reimplementer), deterministic grading, divergences attributed to causes, paper underspecification the largest.
- Paper-replication workflow (2607.02134): completion blocked until validation checks pass.
- FactReview (2604.04074): claim extraction plus execution under a fixed repair budget.
- MLReplicate (2605.16616): 59% of accepted automated papers had fabricated or unsupported claims, which argues for an adversarial verifier.

## What this project combines

1. **Routing by release status inside one agent.** RECLAIM uses the three tiers only as a benchmark split with one harness. Paper-to-code systems assume paper-only. Here the strategy changes per route.
2. **One ledger from claim to verdict.** Requirement, assumption, run artifact and verdict are linked, so a failure can be traced to the assumption it depends on.
3. **Assumptions recorded before running**, not attributed after grading, and used to steer the "understanding" repair branch.
4. **Compute feasibility as an explicit verdict ceiling**, shown to the user before the run.
5. **Target values hidden from the implementer**, with a verifier that re-runs from a clean state and scans for copied numbers. Parts of this are prior art (2604.21965, 2607.02134, RECLAIM's auditor); the combination inside one agent with a live, inspectable trace is ours.
6. **Every handoff is a record that can be intercepted**, so the same frozen agent can be used to study how models handle planted errors.

## Pitfalls for a DeepSeek-class model, and what the code does about them

| Pitfall | Mitigation in this repo |
|---|---|
| Declares done early or without evidence | `finish` is gated on a successful `reproduce.py` run that wrote the metrics; the verdict comes from the verifier's own re-run |
| Never checks intermediate numbers | the plan must contain checks to run before the full run |
| Echoes or hardcodes paper values | targets removed from the implementer brief; verifier scans code for paper numbers; high flags force "not reproduced" |
| Wrong artifact, split or experiment | the contract pins dataset, split and table; the verifier checks `right_experiment` |
| Dependency loops | error signatures are hashed; three repeats call the manager |
| Rewrites working files | `edit_file` tool and prompt rule to prefer small edits |
| Silently fills gaps | `note_assumption` tool; the ledger is shown live |
| Unused or blown budget | step, cost and time caps; manager review when a result misses tolerance and budget remains |
| Untrustworthy self-assessment | the model's confidence is never used |
