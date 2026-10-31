# Paper Repro Agent

> Contributing: see [CONTRIBUTING.md](CONTRIBUTING.md). You do not need any key or `.env` to run the checks or the web apps.

An autonomous agent that takes a research paper (and its code, if any), writes or adapts the code,
runs it in a sandbox, and returns a verdict on whether the paper's headline number holds, with the
evidence. Every step is visible live: what each agent is thinking, every command and its output, how
long each stage took, and what it cost.

It is built from published methods (PaperBench, RECLAIM, Paper2Code, DeepCode, ReproAgent, HiRAS,
CORE-Bench and others; see [docs/RESEARCH.md](docs/RESEARCH.md)) and runs on any OpenAI-compatible
model. Development and testing use DeepSeek through the Tsinghua Paratera gateway.

## How it works

Five agents in a fixed order ([docs/DESIGN.md](docs/DESIGN.md)):

1. **Reader** reads the paper and writes a *claim contract*: the target number, where it is in the
   paper, a tolerance fixed before any run, the requirements a faithful implementation must meet, and
   an *assumption ledger* of every detail the paper leaves open.
2. **Router** clones the repository if there is one and sorts the paper by what the authors released:
   `full_release`, `partial_release` or `paper_only`. It also checks this machine (CPU, RAM, GPU) and
   decides whether the target fits, or plans a disclosed scale-down.
3. **Planner** lays out files in dependency order, one config, a smoke test and checks to run before
   the full run.
4. **Implementer** works alone in a sandbox with file and command tools until `python reproduce.py`
   writes `results/metrics.json`. It is never shown the paper's target values. A **Repair Manager**
   steps in when commands keep failing or the result misses the tolerance.
5. **Verifier** deletes the results, re-runs `reproduce.py` from scratch, scans the code for copied
   paper numbers and audits it against the requirements. The verdict (`reproduced`,
   `partially_reproduced`, `not_reproduced`, `could_not_run`) is computed from the re-run number.

No step asks a human for confirmation.

## Quick start (Windows or Linux, Python 3.12)

```bash
git clone https://github.com/bryan273/paper-repro-agent && cd paper-repro-agent
python -m venv .venv && .venv/Scripts/activate          # Linux/mac: source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env                                     # then put your API key in .env
python scripts/setup_sandbox.py                          # base env for papers: numpy, sklearn, torch-cpu...
uvicorn repro.server:app --port 8765
```

Open http://localhost:8765, pick a demo paper and press **Run live**, or start a run with an arXiv
id, a PDF URL or an uploaded PDF. The model for each agent can be chosen under *Models and budget*.

Command line:

```bash
python scripts/run.py --demo fasttext
python scripts/run.py --paper 1607.01759 --repo https://github.com/facebookresearch/fastText --hint "Table 1, AG News"
python scripts/run.py --paper 2504.17192 --model DeepSeek-V4-Pro --max-cost 20
```

Each run writes `runs/<id>/` (events, contract, route, plan, ledger, verdict, report) and
`workspaces/<id>/` (the code, data, logs and command ledger).

## Demo papers

| Demo | Route | Target | Paper | Clean re-run | Verdict | Time, cost |
|---|---|---|---|---|---|---|
| fastText, *Bag of Tricks for Efficient Text Classification* (Joulin et al., 2016) | full release | AG News test accuracy, Table 1 | 92.5 % | 92.34 % | reproduced | 21 min, ¥0.56 |
| MC dropout, *Dropout as a Bayesian Approximation* (Gal and Ghahramani, 2016) | partial release | Boston Housing test RMSE, Table 1 | 2.97 | 2.93 (5 of 20 splits) | partially reproduced | 43 min, ¥0.51 |
| *Isolation Forest* (Liu, Ting and Zhou, 2008) | paper only | Ionosphere AUC, Table 3 | 0.85 | 0.849, then 0.851 in a second run | reproduced twice | 24 and 32 min, ¥0.53 and ¥0.32 |

One run each, all agents on DeepSeek-V4-Flash, laptop CPU. Details and the problems found along the
way are in [docs/PILOT.md](docs/PILOT.md).

All three run on a laptop CPU. Recorded runs are in `web/demo-runs/` and can be replayed in the UI
without a runner.

## Using the UI

- **Home:** drop a PDF (or paste an arXiv ID), optionally give the repository and which result to check, then start. The three sample papers work like pre-uploaded PDFs: watch the recorded run or run them live.
- **Find a paper:** search arXiv by author (e.g. `Yujiu Yang`) or title words. Papers already run on this runner come first, with their verdicts (select one to open that run); "Reproduce this paper" fills in the arXiv ID. Every run is saved under `runs/` on the runner machine and listed under Recent runs (`Show all` for the full list). Searching needs a runner, since the page asks arXiv through it.
- **Run view:** the paper is shown next to the agents' activity. While the Reader works, the pages it reads light up; then the target result (yellow), requirements (blue) and open details (purple) appear as highlights on the PDF. Pages the implementer goes back to flash. After the verdict, requirement highlights are coloured by the verifier (met, partial, missing). Click any requirement or open detail to jump to it in the paper, and click a stage in the stepper to jump to it in the timeline.
- **Live runs** can be stopped from the header. Finished runs can be downloaded as a Markdown report.

## Tests

```bash
pip install pytest playwright
python -m pytest tests/ -q
```

`tests/test_core.py` covers the verdict rules, quote validation, error injection, sandbox guards (allowed commands, paths, scrubbed environment, timeout, stop) and the finish gate. `tests/test_ui.py` drives the UI in replay mode with Playwright (installed Edge or Chrome): thumbnails render, a sample can be replayed to its verdict, highlights appear, clicks scroll the paper and the timeline, the report downloads, and phones get no horizontal scroll. No test calls a model.

## Deploying the UI

`web/` is a static site. Deployed on its own (for example on Vercel, see `vercel.json`) it runs in
replay mode with the recorded demo runs. To run papers live from a deployed UI, host the runner
(`uvicorn repro.server:app`) somewhere that can run Python jobs for tens of minutes, and open the UI
with `?runner=https://your-runner`. Serverless functions are not a good fit for the runner itself,
because a reproduction runs longer than their time limits and needs a real sandbox.

To run the runner on a server instead of a laptop, use the Docker image and the compose file in
`deploy/` (HTTPS through Caddy, runs kept on a volume, refuses to start without an access key). See
[docs/DEPLOY.md](docs/DEPLOY.md).

## Configuration

`.env`:

| Variable | Meaning |
|---|---|
| `PARATERA_API_KEY` | key for https://llmapi.paratera.com (also `DEEPSEEK_API_KEY`, `STEPFUN_API_KEY`, `ZHIPU_API_KEY`) |
| `REPRO_DEFAULT_MODEL` | default model for every agent (default `DeepSeek-V4-Flash`) |
| `REPRO_MAX_COST_CNY`, `REPRO_MAX_WALL_MIN`, `REPRO_MAX_STEPS` | per-run budgets |
| `REPRO_GLOBAL_CAP_CNY` | hard cap on spend across all runs (default 600) |

Prices used for the cost meter are estimates in `repro/config.py`.

## Safety

Paper code runs in a per-run folder and virtual environment, with only `python`, `pip` and `git`
allowed, no shell, a scrubbed environment without API keys, and hard timeouts. That is process-level
isolation for your own machine, not protection against hostile code. Run unknown papers inside a VM
or container, or plug in a container backend (see docs/DESIGN.md).

## Controlled experiments

Handoffs between agents pass through `repro/injections.py`. A run can be started with an injection
spec that plants false information, omissions, wrong conclusions, conflicting evidence or corrupted
values at a chosen handoff, each with a traceable marker. With no spec, nothing changes.
