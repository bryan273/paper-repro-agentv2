---
last_updated: 2026-10-13T08:38:03Z
---

# Architecture Design

## System Overview
Supported React/Vite frontend using original local demo manifests, JSONL event logs and PDF files. No backend needed for approved replay-only scope. Original long-running Python sandbox runner is preserved as reference, not deployed or replaced.

## Tech Stack
React 18, TypeScript, Vite, existing shadcn/ui and lucide-react.

## Module Design
双语界面模块：src/lib/i18n.tsx 统一中文映射、语言切换和本地保存；src/pages/language.css 适配中文及移动端切换控件。原始 PDF、日志、代码和技术标识不翻译。 / Bilingual UI: shared translations, switch and local preference in src/lib/i18n.tsx; Chinese/mobile styling in src/pages/language.css; original PDF, logs, code and technical identifiers stay unchanged.
| Module | Responsibility | Key Files |
|--------|---------------|-----------|
| Dashboard | Demo cards, recorded history search, guide | src/pages/Index.tsx, src/pages/paper-repro.css |
| Evidence viewer | Time-based playback, stage navigation, PDF, contract, verdict, downloads | src/components/RunViewer.tsx |
| Recorded contract | Typed manifests and original event parsing | src/lib/replay.ts, public/assets |

## Tech Decisions
长期交付要求：工作汇报中英双语，网站中英切换；语言偏好浏览器本地保存，无新增后端。 / Ongoing delivery requirement: bilingual reports and Chinese/English website switching; preference stored locally without a new backend.
| Decision | Choice | Rationale |
|----------|--------|-----------|
| Backend | None for approved scope | Replays use original local assets and do not call runtime models. |
| Live runner | Preserved external reference only | Original Python sandbox is a long-running compute service, not a supported replacement backend project. |
| Remote repository | Intended paper-repro-agentv2 main; sync blocked | Configured github remote matches destination, but HTTPS git authentication fails and MCP discovery exposes no tools. |

## File Tree Plan
Frontend implementation under app/frontend; original source under uploads/reference; copied recordings under app/frontend/public/assets.

## Implementation Guide
视觉增量使用 src/pages/premium.css 统一材质和响应式层级，Index.tsx 去除装饰图标；数据、双语和回放逻辑不变。 / Visual update uses src/pages/premium.css for consistent materials and responsive hierarchy; decorative icons removed without changing data, language or replay logic.
See app/frontend/DELIVERY.md for data provenance and the inspected original runner API boundary.
