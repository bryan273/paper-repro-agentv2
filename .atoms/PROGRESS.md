---
last_updated: 2026-10-13T08:38:03Z
---

# Requirements & Progress

## Requirements Overview
Approved: React/Vite dashboard based on uploaded Paper Repro Agent, three actual demo replays, recorded history, PDF/evidence inspection and evidence download. No runtime AI, upload, arXiv search, or sandbox execution this round.

## User Stories
- User can explore three supplied demo papers and four recorded runs, inspect PDF/contract/verdict evidence, navigate replay time/stages, and download original evidence.
- User intends frontend delivery to paper-repro-agentv2 main; actual remote synchronization remains blocked by unavailable GitHub tools.

## Task Breakdown
| ID | Task | Assignee | Status | Deps |
|----|------|----------|--------|------|
| F1 | Inspect archive, workflows and contracts; obtain scope approval. | Alex | done | — |
| F2 | Preserve source and copy original demo assets. | Alex | done | F1 |
| F3 | Implement dashboard and recorded run evidence viewer. | Alex | done | F1 |
| F4 | Validate lint/build and rendered UI. | Alex | done | Lint/build and desktop rendering passed; manual browser checks opened fastText replay, timeline, verdict and claim evidence. Mobile and actual download completion remain untested. |
| F5 | Sync intended bryan273/paper-repro-agentv2 main destination. | Alex | blocked | No MCP tools; configured github remote exists, but git ls-remote fails because HTTPS username/credentials are unavailable. |

## Progress Log
- 2026-10-13: Safely inspected 63-entry ZIP; preserved original source, copied ten demo assets mechanically, and obtained approval for replay-only frontend scope.
- 2026-10-13: Implemented dashboard, four-run history/search, time/stage replay navigation, original PDF fallback, contract/verdict inspection, JSONL and recorded-report downloads.
- 2026-10-13: pnpm run lint && pnpm run build passed; available desktop visual validation passed. No dedicated functional verification tool is available; modal/mobile were not independently verified by the visual check.
- 2026-10-13: No runtime AI backend was added; live runner integration is excluded from approved scope. GitHub discovery returned []; no remote repository creation or push occurred.
- 2026-10-15: Replaced the React dashboard by the original UI under `public/repro/` (byte for byte copy of `web/`), added 6 more recorded runs (10 in total, local paths removed from the logs), and made `/` redirect to it. Frozen-directory rule added to ATOMS.md.
