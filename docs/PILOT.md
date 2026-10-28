# Pilot results (2026-09-30)

All agents on **DeepSeek-V4-Flash** via the Paratera gateway. The runs were on a laptop CPU (22 cores, 15 GB RAM, no GPU, Windows 11). One run per paper, so these numbers show that the pipeline works end to end, not how reliable it is.

| Paper | Route (chosen by the Router) | Target | Paper | Clean re-run | Verdict | Time | Cost |
|---|---|---|---|---|---|---|---|
| fastText (Joulin et al., 2016) | full release | AG News test accuracy, Table 1, h=10 + bigrams | 92.5 % | 92.34 % (mean of 5 seeds) | reproduced | 21 min | ¥0.56 |
| Isolation Forest (Liu et al., 2008) | paper only | Ionosphere AUC, Table 3 | 0.85 | 0.849 (mean of 10 seeds) | reproduced | 24 min | ¥0.53 |
| MC dropout (Gal and Ghahramani, 2016) | partial release | Boston Housing test RMSE, Table 1 | 2.97 ± 0.19 | 2.93 (5 of 20 splits) | partially reproduced | 43 min | ¥0.51 |

Costs use the estimated prices in `repro/config.py`. Total model spend for the whole night, including failed runs and tests, was about ¥2.8.

## What each run did

- **fastText.** The agent installed `fasttext-wheel`, since the C++ build needs `make`, which Windows lacks. It downloaded AG News from the authors' Google Drive link and ported the shell pipeline to Python. It picked the learning rate on a 10 % train hold-out from the paper's grid, then averaged 5 seeds.
  - The verifier's audit noted one reporting error: the code uses full softmax instead of the paper's hierarchical softmax, and `metrics.json` mislabels it. For 4 classes this does not change accuracy.
- **Isolation Forest.** The agent implemented iTrees, the path length c(n) and the anomaly score from the paper's algorithms. It used no library isolation forest. It checked structure along the way (tree depth 8, c(256) = 10.2487, anomalies have shorter paths).
  - It also reproduced 5 more Table 3 rows within about 0.01 AUC.
  - It reported Http and Mulcross as not run, because those exact datasets are not public. It did not substitute them.
- **MC dropout.** The authors' code needs Theano and Keras 1. The agent ported the model to PyTorch, using the released data, the released split indices, and the weight-decay formula from the authors' code.
  - One split takes about 3 minutes on this CPU, so it ran 5 of the 20 splits and recorded that in the assumption ledger.
  - The verdict is capped at "partially reproduced" because of that scale-down.

## Problems found during the pilot, and the fixes

1. **The sandbox venv did not see the base packages.** Creating it with `--system-site-packages` on top of another venv points at the global Python, not at the prepared env. Fixed by layering the base env with a `.pth` file.
2. **The gateway stalls and drops connections.** At times up to half the calls failed, and one stream hung for over 10 minutes. Fixed with:
   - a per-chunk read timeout;
   - a watchdog that closes a silent stream after 150 s;
   - 10 retries with backoff;
   - a switch to a sibling model after half the retries.
3. **Scope creep.** In the first MC dropout run the agent had a working result inside tolerance at step 41. It then broke `reproduce.py` while adding more datasets and ran out of steps, so the verdict was "could not run". Fixes:
   - a clean run of `reproduce.py` now snapshots the code, and that version is restored if the budget runs out;
   - tool results warn when steps are running low;
   - the manager can declare the target "done", and it did in the second run.
   - That failed run was deleted before its replay was exported. Only the later run is in the repo.
4. **Verdict rules were too strict in two places.**
   - The implementer's free-text note "no scaling" was read as a scale-down.
   - The verifier marked a simplified protocol (fewer splits, grid search instead of Bayesian optimisation) as the "wrong experiment".
   - Both rules are fixed, and the prompt now defines "wrong experiment" as a different dataset, metric or method.
   - The Isolation Forest verdict was recomputed with no model call, and the MC dropout audit was re-run with one model call on the saved re-run. Both replays show the correction.

## Second round (UI and testing)

- A second Isolation Forest run was started by uploading the PDF through the UI. It was reproduced again, in 32 minutes for ¥0.32, and this time the Reader produced its own quotes: 25 kept and 2 dropped by the check against the paper text. It measured 0.851 against the paper's 0.85 (the first run measured 0.849). This is the first repeat on the same paper, and both runs agree. One thing did not repeat: the Reader chose a tolerance of ±0.03 in the first run and ±0.05 in the second, for the same claim. The verdict is the same either way here, but the tolerance should not depend on the run. Fixing it for a paper once, before any run, is the next thing to do.
- **Stop.** Live runs can be stopped. The first version only checked between model calls, so a stop during a long Reader call waited minutes. It now closes the running stream and kills the sandbox process at once (tested: under 1 second).
- **Interrupted runs.** A run that was cut off by a server restart stayed "running" forever. The server now marks such runs "interrupted" when it starts.
- **Tests.** 32 automated tests, all passing: 25 unit tests with no model calls, and 7 end-to-end UI tests in replay mode. The UI tests caught one UX issue: a sample paper's title only appeared after its thumbnail had rendered.

## Third round (why runs take 30 minutes, lag, overview)

- **Where the time goes.** In the second Isolation Forest run, 24 of 32 minutes were commands, and one command was 18 minutes of downloading the KDDCUP99 Http data. That is an extra dataset, not the Ionosphere target. The model itself thought for about 8 minutes. In the MC dropout run, 29 of 43 minutes were the experiment running on CPU. Changes:
  - datasets now go into caches shared across runs (scikit-learn, Hugging Face, torch, and a generic folder);
  - the implementer is told to download only what the target needs until the target is reproduced.
- **UI lag and duplicated timeline.** When a finished run was opened live, the browser reconnected to the event stream every few seconds and replayed the whole run again. In a test it replayed 7 times in 20 seconds, which added 750 rows. Fixes:
  - the page now closes the stream at the end of a run;
  - the server resumes from the Last-Event-ID;
  - each event carries its own position (a test caught that events sent together shared one id).
  - After the fix the same test shows the run once, with 108 rows. Highlights no longer use blend modes, and off-screen pages and rows are not painted.
- **Overview panel.** Each run now starts with a plain summary of what happened, a breakdown of where the time went (model thinking per agent versus commands), the slowest step, and a run map. The run map shows stages, model calls, commands (failed ones in red) and repair-manager interventions on one time axis, and each bar jumps to its step.
- **Tests:** 36 passing (25 unit, 3 server, 8 end-to-end UI).

## Not done yet

- Only one run per paper. Stability needs 3 or more runs per paper and a held-out set of papers, as in the proposal.
- Only DeepSeek-V4-Flash was tried. Every agent's model can be switched in the UI or with `--model`.
- The sandbox is process-level isolation on the local machine. There is no container backend yet.
- The UI is not deployed. `web/` works as a static replay site (tested locally), and live runs need the Python runner.
