---
last_updated: 2026-10-13T08:38:03Z
status: active
---

# Project Context

## Project Overview
Build the approved frontend-only Paper Repro Agent evidence dashboard from /workspace/uploads/paper-repro-agent-main.zip. Original project includes Python sandbox runner and static UI. Live execution is outside this round; only actual recorded demos are replayed.

## Key Decisions
| Date | Decision | By | Rationale |
|------|----------|-----|-----------|
| 2026-10-13 | Approved replay-only frontend; preserve original Python runner as reference. | Alex | Actual uploaded recordings satisfy approved scope without simulated AI experiments or unsupported sandbox deployment. |
| 2026-10-13 | Intended repository paper-repro-agentv2 main; remote sync blocked. | Alex | User reports connector UI connected, but discovery exposes no GitHub tools to this session. |

## Constraints
- Approved frontend-only scope has no live AI, uploads, arXiv search or sandbox execution.
- Original ZIP and extracted Python source are reference only; supplied demo assets are copied mechanically.
- User-reported destination: bryan273/paper-repro-agentv2 on main. Configured github remote matches; MCP discovery exposes no tools and non-interactive git ls-remote fails with missing HTTPS username/credentials. No repository creation or push occurred.


## Frozen directory: app/frontend/public/repro/
Decision, 2026-10-15, by Bryan: the product's viewer is the ORIGINAL Paper Repro Agent UI, not a React rebuild.
The rebuilt React dashboard dropped the PDF highlights, the result-first cards (target, result chart, paper vs
reproduction table), time and cost by stage, the process summary and run map, arXiv search and upload.

`app/frontend/public/repro/` holds that original UI (static HTML, JS and CSS), copied byte for byte from the local
repository `bryan273/paper-repro-agent`, folder `web/`, together with 10 recorded runs.

Rules for every future edit in this project:
- Never edit, regenerate, restyle, translate to React or "improve" any file under `public/repro/`.
- It changes only by replacing the whole folder with a newer copy pushed from the local repository (Pull Updates).
- `src/pages/Index.tsx` only redirects `/` to `/repro/index.html` (keeping `?runner=` and the hash). Keep it that way.
- Legacy and not used any more: `src/components/RunViewer.tsx`, `src/pages/paper-repro.css`, `src/lib/replay.ts`,
  `public/assets/`. Do not extend them.
- No secrets in this folder. A `runner.json` there may contain only `{"url": "https://..."}`.
