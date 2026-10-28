# Paper Explainer

Turns an arXiv paper into a short explainer video: grounded scene script (DeepSeek), narration (edge-tts, EN and ZH), animated player (player.html), recorded to MP4 with Playwright and ffmpeg.

- `gen.py <arxiv-id> [--seconds 24]` fetches the paper, asks the model for a scene script, checks every quote and number against the paper text, makes narration audio, writes `out/<id>/script_en.json` and `script_zh.json`.
- `record.py <arxiv-id> en|zh [--limit 20]` plays the script in `player.html`, records it, mixes the narration, writes an MP4.
- `player.html` has no dependencies. It also accepts a script by `postMessage({type:"script",script,limit,speak})`, which is how the Atoms app plays AI-made previews in the browser.
- `bundle/` is what the Atoms app serves under `/explainer/`. Production serves only .html and .mp3 files as-is, so every .json and .md has a `.html` copy.

Live: https://paperexplainer-aiid.pub.atoms.world
