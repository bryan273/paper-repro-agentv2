---
last_updated: 2026-10-13T08:38:03Z
---

# Architecture Design

## System Overview
Supported React/Vite frontend using original local demo manifests, JSONL event logs and PDF files. No backend needed for approved replay-only scope. Original long-running Python sandbox runner is preserved as reference, not deployed or replaced.

## Tech Stack
React 18, TypeScript, Vite, existing shadcn/ui and lucide-react.

## Module Design
| Module | Responsibility | Key Files |
|--------|---------------|-----------|
| Dashboard | Demo cards, recorded history search, guide | src/pages/Index.tsx, src/pages/paper-repro.css |
| Evidence viewer | Time-based playback, stage navigation, PDF, contract, verdict, downloads | src/components/RunViewer.tsx |
| Recorded contract | Typed manifests and original event parsing | src/lib/replay.ts, public/assets |

## Tech Decisions
| Decision | Choice | Rationale |
|----------|--------|-----------|
| Backend | None for approved scope | Replays use original local assets and do not call runtime models. |
| Live runner | Preserved external reference only | Original Python sandbox is a long-running compute service, not a supported replacement backend project. |
| Remote repository | Intended paper-repro-agentv2 main; sync blocked | Configured github remote matches destination, but HTTPS git authentication fails and MCP discovery exposes no tools. |

## File Tree Plan
Frontend implementation under app/frontend; original source under uploads/reference; copied recordings under app/frontend/public/assets.

## Implementation Guide
See app/frontend/DELIVERY.md for data provenance and the inspected original runner API boundary.
