# Working on this repo

You do not need an `.env` file, an API key or a Supabase login to work on anything here. The web apps call the hosted
Supabase functions (their address is written in the code), and the checks below run without any key.

## Run things on your own machine

| I want to | Do this | Needs |
|---|---|---|
| Change a web app (Explainer, Lite, Reading, Desk, IndexBoard, Hub) | open that app's repo, `cd app/frontend && npm ci && npm run dev` | Node 22 |
| Change the Paper Repro Agent page | edit `app/frontend/public/repro/`, open `index.html` through any static server (`python -m http.server`) | nothing |
| Change the agent (`repro/`) | `pip install -r requirements.txt pytest && python -m pytest tests/test_core.py` | Python 3.12 |
| Change the video pipeline (`explainer/`) | `python -m pytest explainer/tests/test_helpers.py` (instant), then `python explainer/tests/kit_smoke.py` (renders every visual with Manim, about 3 minutes) | Python 3.12, `pip install manim`, ffmpeg, Cairo/Pango |
| Change a Supabase function (`supabase/functions/`) | edit it; CI type-checks it with `deno check`; it goes live when it is merged to `main` | nothing |

Making a **real video** end to end needs model keys (RKAPI, Paratera). You do not need them for a change to be reviewed:
CI checks the code, and the owner can render a test video from the site after the merge.

## How a change gets in

1. `git switch -c short-name` and push the branch. **Never push to `main` directly.**
   (GitHub does not offer branch protection on a free private repo, so this is a team rule and not a lock.)
2. Open a pull request. Four checks run: `python tests`, `supabase functions type check`, `no secrets in the diff`,
   `animation kit renders`. All must be green. None of them can read a secret.
3. The owner reviews and merges. After the merge, deployment is automatic:

| What changed | What happens by itself |
|---|---|
| `supabase/functions/**` | the changed functions are deployed to Supabase (`deploy-supabase`) |
| `app/frontend/public/repro/**` | the page is published to the Pages site `/repro/` (`deploy-main-site`) |
| `explainer/**` | the next video job uses the new code (the renderer always checks out `main`) |
| a web app repo | that repo's `ci-cd` workflow builds and publishes its folder on the Pages site |
| `supabase/*.sql` | nothing: database changes are applied by hand by the owner |

One-time owner setup for the automatic deploys (a deploy key and a Supabase token): [docs/OWNER-SETUP.md](docs/OWNER-SETUP.md).

Because the renderer runs whatever is on `main`, a broken merge breaks every video until it is fixed. That is why
`explainer/` changes need a green `animation kit renders` check and a look from the owner.

## Rules that keep everyone safe

- No keys, tokens, passwords or personal data in any file, issue or screenshot. CI fails the pull request if it finds one.
  If one slips through, tell the owner at once so it can be rotated; deleting the commit is not enough.
- Do not edit `.github/workflows/**` without telling the owner: those files run with the repo's secrets after a merge.
- Keep changes small and say in the pull request why you made them and how you checked them.
