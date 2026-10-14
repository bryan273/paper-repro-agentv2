# Frontend delivery

This React/Vite frontend presents original Paper Repro Agent recordings from the uploaded archive. It does not execute experiments or invoke models.

## Data provenance
Original source is preserved in `/workspace/uploads/reference/paper-repro-agent-main`; original ZIP remains unchanged. PDFs, manifests and JSONL files were copied mechanically into `public/assets`. Reports exported by the viewer contain the original verdict event, explicitly marked as recorded evidence rather than the runner's original report file.

## Integration boundary
The original server exposes `/api/health`, `/api/models`, `/api/demos`, `/api/search`, `/api/runs`, `/api/runs/upload`, `/api/runs/{rid}`, streamed `/api/runs/{rid}/events`, cancellation, report, event-log and workspace-file endpoints. Live experiments require the original separately hosted Python sandbox runner, appropriate security controls, and long-running job infrastructure. These endpoints are not connected or simulated in this frontend-only delivery. The current UI supports recorded demo playback only.

## Repository destination
User-reported intended destination is `bryan273/paper-repro-agentv2`, branch `main`. Connector tool discovery returned no tools in this session. No remote repository was created, read, overwritten or pushed. A connected UI status is not proof that this agent session can invoke GitHub operations. Follow-up verification found the local `github` remote points at the intended repository, but `GIT_TERMINAL_PROMPT=0 git ls-remote --heads github main` fails because HTTPS username/credentials are unavailable. No push was attempted. Production output exists under `dist/`; no separate downloadable ZIP export has been produced.

## Verification
### 双语增量交付 / Bilingual update
已添加中文/English 切换，覆盖现有界面说明、控件、状态和错误提示；导出报告同时包含中文和英文，原始论文及证据保留来源语言。语言偏好使用浏览器本地存储，无新增后端。 / Added Chinese/English switching for existing interface copy, controls, statuses and errors; exported reports include both languages, while original papers and evidence retain source language. Preference is stored locally with no backend added.

lint/build、144 项静态字典映射检查和现有浏览器中英切换、回放结论及契约检查通过；可见布局检查通过。Playwright 自动化因缺少浏览器执行文件未运行。GitHub 仍无成功推送证据。 / Lint/build, 144-key dictionary audit, existing-browser language switching and replay verdict/contract checks passed, as did visible layout inspection. Playwright automation could not run because its browser executable is missing. No successful GitHub push is established.

Lint and production build passed. Desktop visual check passed. Follow-up browser checks at the configured port 3000 opened the fastText replay, original event timeline, recorded verdict, and claim/requirement/assumption evidence. PDF fallback and JSONL download links were present. Actual download completion, embedded PDF rendering, playback timing, and mobile interactions were not independently tested. An initial browser request on incorrect port 5173 was refused; the configured port loaded successfully.
