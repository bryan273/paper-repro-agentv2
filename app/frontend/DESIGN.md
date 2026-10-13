# Paper Repro Agent frontend

## Direction & Layout
A scientific evidence workbench, not a chatbot. First-screen signature: a large typographic statement paired with a five-stage pipeline and a quiet green recorded-data indicator. Use a 224px white sidebar, pale cool canvas, and 1180px maximum content region. Reference: inspected project README's five-stage workflow and supplied recorded evidence. Three equally sized demo cards, followed by compact history rows. Desktop padding 40px; below 1000px sidebar shrinks to top navigation and cards wrap; below 640px use 20px padding and one column. Never imply replay is live. No glow, gradients, or decorative icon grids.

## Tokens
Primary #16634b, dark green #104d3b, canvas #f6f8f7, surfaces #ffffff, border #e1e7e4, text #172b24, secondary #6a7b73. Success #217551 on #e9f5ee; partial #8b6514 on #fff4d9. Sans: Arial with system sans fallback, body 14px/1.6, captions 12px/1.5, h1 40px/1.15 weight 600, h2 21px/1.3 weight 600. Mono: Consolas for timestamps and logs. Spacing 4/8/12/16/24/32/40px. Cards 12px radius, buttons/inputs 7px. Borders 1px; card shadow 0 2px 8px #172b2405; overlays shadow 0 16px 60px #172b2430.

## Shared Patterns & States
Sidebar navigation uses green tinted active state. Demo cards show release tier, paper identity, real target, and replay action; do not claim live status. History is a compact table with actual recorded verdicts. Run viewer uses 50/50 paper and evidence columns and collapses to stacked on mobile. Tabs switch timeline, contract, and verdict. Timeline is paginated to 30 events with stage filtering and a time scrubber; play advances recorded time, not execution. Loading and fetch errors are explicit with retry; empty history search displays explanatory text. Hover 150ms ease, no entrance animations. Buttons have 40px targets, visible 2px green focus outlines, keyboard labels and strongly contrasting text; icon buttons have accessible names. Escape closes the run viewer.

## Media
Reuse supplied original PDFs and JSONL logs from the ZIP in public/assets, without model transcription or regenerated evidence. PDFs are small enough for local bundling and use the browser document viewer with a download/open fallback. No marketing imagery is needed for this operational scientific tool. Logo is an in-page document icon, not a generated favicon.
