# Running the runner on a server

The UI is static and can live anywhere (Atoms, Vercel, or this server). The runner is the part that reads papers, calls the model and runs the agent's code. It runs long jobs (10 to 90 minutes), installs packages and uses many CPU cores, so it needs a real machine or container host, not a serverless function.

## What the server needs

- **CPU and memory:** 4 to 8 vCPU and 16 GB RAM for one or two runs at a time. No GPU; the agent is told the machine has none.
- **Disk:** 40 GB or more. torch, the per-run virtual environments and the dataset cache add up.
- **Network:** outbound access to GitHub, PyPI, arXiv, Hugging Face, the dataset hosts and the model API. A region outside mainland China (for example Hong Kong or Singapore) reaches all of these without a proxy, and Paratera's API is still reachable from there.
- **Ports:** 80 and 443 open for HTTPS.
- **A domain name** pointing at the server, so Caddy can get a certificate. The UI on Atoms or Vercel is served over HTTPS and can only call an HTTPS runner.

## Deploy with Docker Compose

```bash
git clone https://github.com/bryan273/paper-repro-agent && cd paper-repro-agent
cp .env.example .env        # set PARATERA_API_KEY and REPRO_ACCESS_KEY (12+ random characters)
cd deploy
DOMAIN=runner.example.com docker compose up -d --build
```

The first build takes a while because it installs torch. Then:

- `https://runner.example.com/` serves the UI with the runner built in.
- `https://runner.example.com/api/health` should return `"needs_key": true`.
- Runs, workspaces and the dataset cache are kept on the `repro-data` volume, so they survive restarts and redeploys.

## Point a separately hosted UI at it

Use either of these:

- Open the UI with `?runner=https://runner.example.com`.
- Publish a `runner.json` next to the UI with `{"url": "https://runner.example.com"}`.

People who start runs type the access key in the form. Searching papers and viewing runs work without a key.

## Safety

- The image refuses to start without `REPRO_ACCESS_KEY`, because a runner without one lets anyone spend the model credit.
- These limits apply on top of the key, and a caller cannot raise them from the browser:
  - per-run caps on cost, time and steps (`REPRO_CAP_*`);
  - a cap on runs at the same time (`REPRO_MAX_ACTIVE`);
  - a global spend cap (`REPRO_GLOBAL_CAP_CNY`).
- The agent's code runs inside the container as a non-root user, with no API keys in its environment. The per-run sandbox is process-level only, so the container (and the VM it runs on) is the real boundary. Give the runner its own VM, not one shared with other services.
- `mem_limit` in the compose file stops a run that eats memory before it takes the server down.

## Not yet tested

This setup has not been built or run on Linux yet; all runs so far were on Windows. Check the first deployment with one short sample run, for example the Isolation Forest demo, before you share the URL.
