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
- 长期偏好：今后工作汇报均提供中英双语，网站均提供中文/英文切换。 / Ongoing preference: all work reports must be bilingual Chinese/English, and websites must provide a Chinese/English switch.
- Approved frontend-only scope has no live AI, uploads, arXiv search or sandbox execution.
- Original ZIP and extracted Python source are reference only; supplied demo assets are copied mechanically.
- User-reported destination: bryan273/paper-repro-agentv2 on main. Configured github remote matches; MCP discovery exposes no tools and non-interactive git ls-remote fails with missing HTTPS username/credentials. No repository creation or push occurred.

