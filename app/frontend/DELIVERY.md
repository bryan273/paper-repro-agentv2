# Frontend delivery

This React/Vite frontend presents original Paper Repro Agent recordings from the uploaded archive. It does not execute experiments or invoke models.

## Data provenance
Original source is preserved in `/workspace/uploads/reference/paper-repro-agent-main`; original ZIP remains unchanged. PDFs, manifests and JSONL files were copied mechanically into `public/assets`. Reports exported by the viewer contain the original verdict event, explicitly marked as recorded evidence rather than the runner's original report file.

## Integration boundary
The original server exposes `/api/health`, `/api/models`, `/api/demos`, `/api/search`, `/api/runs`, `/api/runs/upload`, `/api/runs/{rid}`, streamed `/api/runs/{rid}/events`, cancellation, report, event-log and workspace-file endpoints. Live experiments require the original separately hosted Python sandbox runner, appropriate security controls, and long-running job infrastructure. These endpoints are not connected or simulated in this frontend-only delivery. The current UI supports recorded demo playback only.

## Repository destination
User-reported intended destination is `bryan273/paper-repro-agentv2`, branch `main`. Connector tool discovery returned no tools in this session. No remote repository was created, read, overwritten or pushed. A connected UI status is not proof that this agent session can invoke GitHub operations. Follow-up verification found the local `github` remote points at the intended repository, but `GIT_TERMINAL_PROMPT=0 git ls-remote --heads github main` fails because HTTPS username/credentials are unavailable. No push was attempted. Production output exists under `dist/`; no separate downloadable ZIP export has been produced.

## Verification
Lint and production build passed. Desktop visual check passed. Follow-up browser checks at the configured port 3000 opened the fastText replay, original event timeline, recorded verdict, and claim/requirement/assumption evidence. PDF fallback and JSONL download links were present. Actual download completion, embedded PDF rendering, playback timing, and mobile interactions were not independently tested. An initial browser request on incorrect port 5173 was refused; the configured port loaded successfully.
