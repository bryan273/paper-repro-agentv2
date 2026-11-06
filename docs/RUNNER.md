# Moving the renders to another machine

The Paper Explainer renders run in GitHub Actions (`explainer-render.yml`). GitHub's own runner is free for this public repository.
If it is ever blocked, out of minutes or stalled, the same workflow can run on your own machine with one command.

## Switch

```
gh variable set RENDER_RUNNER --repo bryan273/paper-repro-agentv2 --body '["self-hosted","linux"]'   # to your machine
gh variable delete RENDER_RUNNER --repo bryan273/paper-repro-agentv2                                   # back to GitHub's runner
```

Jobs already queued need `gh workflow run explainer-render.yml -f job_id=<id>` once more after the switch.

## What the machine needs

Ubuntu 22.04 or 24.04 (a WSL2 Ubuntu on a laptop works), 4 cores, 16 GB RAM, 20 GB free disk, a normal internet connection, `sudo` without a
password for the runner user (the workflow installs ffmpeg, fonts, Cairo and Pango with apt), and Python 3.12. No GPU.

## Install the runner

1. Repository Settings, Actions, Runners, New self-hosted runner, Linux. Run the commands it shows.
2. `./run.sh` (or `sudo ./svc.sh install && sudo ./svc.sh start` to keep it running).
3. Secrets stay in GitHub Secrets; nothing secret is stored on the machine.

## Safety

Only `explainer-render.yml` may use the self-hosted label, and it only starts by hand or from the explainer-render function (`workflow_dispatch`).
Never point a workflow that runs on pull requests at the self-hosted runner: anyone could open a pull request on a public repository.

## Check

`python scripts/ops_alert.py` (also the last step of the daily backup) turns the run red and emails the owner when a job has been queued or running
for more than 30 minutes, which is how a dead runner shows up.
