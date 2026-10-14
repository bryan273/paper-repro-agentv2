---
last_updated: 2026-10-13T08:38:03Z
---

# Requirements & Progress

## Requirements Overview
长期偏好：所有后续工作汇报中英双语、网站中英切换；当前网站已实施，原始证据保持来源语言。 / Ongoing preference: all future work reports bilingual Chinese/English and websites language-switchable; implemented for current UI, with original evidence preserved in its source language.
Approved: React/Vite dashboard based on uploaded Paper Repro Agent, three actual demo replays, recorded history, PDF/evidence inspection and evidence download. No runtime AI, upload, arXiv search, or sandbox execution this round.

## User Stories
- User can explore three supplied demo papers and four recorded runs, inspect PDF/contract/verdict evidence, navigate replay time/stages, and download original evidence.
- User intends frontend delivery to paper-repro-agentv2 main; actual remote synchronization remains blocked by unavailable GitHub tools.

## Task Breakdown
| ID | Task | Assignee | Status | Deps |
|----|------|----------|--------|------|
| B1 | 按钮半立体材质和高度层级 / Semi-dimensional button materials and elevation | Alex | done | 顶部受光、1–4px侧壁、接触阴影、悬停抬升/按压下沉 / Highlights, sidewalls, contact shadows and press feedback |
| B2 | 双语、移动端、按压/焦点/禁用验证 / Bilingual, mobile, press/focus/disabled validation | Alex | done | 1440px/390px中英、悬停/按压、禁用、减少动态、键盘焦点及lint/build通过；截图未取得，独立视觉评估未完成 / Bilingual desktop/mobile button states, reduced motion, focus and lint/build passed; screenshot unavailable |
| U1 | 精致研究工作台视觉升级 / Refine research workbench visual design | Alex | done | 深墨导航、纸张档案、主次布局、统一回放材质 / Ink navigation, paper dossiers, asymmetric hierarchy, replay materials |
| U2 | 双语、回放和响应式验证 / Validate bilingual replay and responsive layout | Alex | done | 1440px/390px 中英概览、回放结论/契约、指南、无页面溢出及 lint/build 通过；截图检查未取得图像，未完成独立视觉评估 / Bilingual desktop/mobile interaction, overflow and lint/build checks passed; screenshot unavailable, independent visual assessment incomplete |
| L1 | 当前网站中英切换，保留原始论文与证据 / Localize existing UI without changing original evidence | Alex | done | 字典、切换入口、双语导出报告 / Dictionary, switch controls, bilingual exported reports |
| L2 | 双语页面、交互和构建验证 / Verify bilingual UI, interactions and build | Alex | done | lint/build、144 项字典检查、浏览器双语及回放交互、可见布局检查通过 / Lint/build, 144-key dictionary audit, bilingual browser/replay checks and visible layout passed |
| F1 | Inspect archive, workflows and contracts; obtain scope approval. | Alex | done | — |
| F2 | Preserve source and copy original demo assets. | Alex | done | F1 |
| F3 | Implement dashboard and recorded run evidence viewer. | Alex | done | F1 |
| F4 | Validate lint/build and rendered UI. | Alex | done | Lint/build and desktop rendering passed; manual browser checks opened fastText replay, timeline, verdict and claim evidence. Mobile and actual download completion remain untested. |
| F5 | Sync intended bryan273/paper-repro-agentv2 main destination. | Alex | blocked | No MCP tools; configured github remote exists, but git ls-remote fails because HTTPS username/credentials are unavailable. |

## Progress Log
- 2026-10-14：质感升级统一深墨导航、非对称纸张档案、编号指南和回放控制台；修复手机表格辅助文字导致的页面溢出。1440px/390px 中英概览、回放结论/契约、指南测试及 lint/build 通过。 / Refined ink rail, asymmetric dossiers, numbered guide and replay console; fixed mobile overflow; bilingual desktop/mobile interactions and lint/build passed.
- 2026-10-14：中英切换覆盖导航、概览、指南、演示说明、状态、错误、回放控件和双语报告；lint/build、144 项字典映射及浏览器切换/结论/契约检查通过。 / Chinese/English UI and bilingual reports implemented; lint/build, 144-key audit and browser switch/verdict/contract checks passed.
- 2026-10-14：Playwright 自动化因缺少浏览器执行文件未运行，改用现有浏览器检查；未新增后端，未执行 GitHub 推送。 / Playwright automation unavailable due to missing browser executable; existing browser used instead; no backend or GitHub push added.
- 2026-10-13: Safely inspected 63-entry ZIP; preserved original source, copied ten demo assets mechanically, and obtained approval for replay-only frontend scope.
- 2026-10-13: Implemented dashboard, four-run history/search, time/stage replay navigation, original PDF fallback, contract/verdict inspection, JSONL and recorded-report downloads.
- 2026-10-13: pnpm run lint && pnpm run build passed; available desktop visual validation passed. No dedicated functional verification tool is available; modal/mobile were not independently verified by the visual check.
- 2026-10-13: No runtime AI backend was added; live runner integration is excluded from approved scope. GitHub discovery returned []; no remote repository creation or push occurred.
