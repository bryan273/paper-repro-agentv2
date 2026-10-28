"""HTTP API + static UI.

  uvicorn repro.server:app --port 8765
Then open http://localhost:8765. The same UI can be deployed on its own (e.g. Vercel) and pointed
at a runner URL, or used in replay mode with the recorded demo runs in web/demo-runs/.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .config import DEFAULT_MODEL, DEFAULT_PROVIDER, PROVIDERS, ROLES, ROOT, RUNS_DIR, WORKSPACES_DIR, RunConfig
from .events import read_events, read_events_with_offsets
from .llm import global_spend
from .pipeline import Run, new_run_id
from .sandbox import machine_resources
from .search import fetch_ids, matches, past_runs, search_arxiv

app = FastAPI(title="Paper Repro Agent")
app.add_middleware(CORSMiddleware, allow_origins=os.getenv("REPRO_CORS", "*").split(","), allow_methods=["*"], allow_headers=["*"])
POOL = ThreadPoolExecutor(max_workers=int(os.getenv("REPRO_WORKERS", "2")))
ACTIVE: dict[str, object] = {}
_models_cache: dict = {"t": 0, "data": None}
UPLOADS = ROOT / ".cache" / "uploads"
# When the runner is reachable from the internet (a tunnel behind the Vercel page), starting or
# stopping a run needs this key: a run spends model credit and executes code on this machine.
ACCESS_KEY = os.getenv("REPRO_ACCESS_KEY", "")
if os.getenv("REPRO_REQUIRE_KEY") == "1" and len(ACCESS_KEY) < 12:
    # A public server without a key would let anyone spend the model credit; the Docker image sets this.
    raise SystemExit("REPRO_ACCESS_KEY must be set (12+ characters) when REPRO_REQUIRE_KEY=1")
MAX_ACTIVE = int(os.getenv("REPRO_MAX_ACTIVE", "2"))
# Upper bounds a caller cannot raise from the browser.
CAP_COST, CAP_MIN, CAP_STEPS = (float(os.getenv("REPRO_CAP_COST_CNY", "20")), float(os.getenv("REPRO_CAP_MIN", "90")),
                                int(os.getenv("REPRO_CAP_STEPS", "120")))


def _check_key(request: Request):
    if ACCESS_KEY and not hmac.compare_digest(request.headers.get("x-access-key", ""), ACCESS_KEY):
        raise HTTPException(401, "access key required")


@app.on_event("startup")
def _mark_interrupted_runs():
    """A run still marked 'running' when the server starts was cut off by a restart or a crash."""
    if not RUNS_DIR.exists():
        return
    for m in RUNS_DIR.glob("*/meta.json"):
        try:
            meta = json.loads(m.read_text(encoding="utf-8"))
        except Exception:
            continue
        if meta.get("status") == "running":
            meta["status"] = "interrupted"
            m.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")


def _demos() -> list[dict]:
    return json.loads((ROOT / "demos" / "demos.json").read_text(encoding="utf-8"))


@app.get("/api/health")
def health():
    return {"ok": True, "resources": machine_resources(), "global_spend_cny": round(global_spend(), 3),
            "active_runs": list(ACTIVE), "needs_key": bool(ACCESS_KEY), "max_active": MAX_ACTIVE}


@app.get("/api/models")
def models():
    if _models_cache["data"] and time.time() - _models_cache["t"] < 600:
        return _models_cache["data"]
    out = {"roles": list(ROLES), "providers": {}, "default": {"provider": DEFAULT_PROVIDER, "model": DEFAULT_MODEL}}
    try:
        import httpx
    except ImportError:
        import httpx2 as httpx
    for name, p in PROVIDERS.items():
        if not p.api_key:
            continue
        ids = []
        try:
            r = httpx.get(p.base_url.rstrip("/") + "/models", headers={"Authorization": f"Bearer {p.api_key}"}, timeout=20)
            ids = sorted(m["id"] for m in r.json().get("data", []))
        except Exception:
            ids = []
        chat_like = [i for i in ids if not any(x in i for x in ("Embedding", "Rerank", "CogView", "T2I", "I2V", "T2V", "ASR", "Seedream", "Seedance", "Hailuo", "OCR", "WanX"))]
        out["providers"][name] = chat_like
    _models_cache.update(t=time.time(), data=out)
    return out


@app.get("/api/demos")
def demos():
    return _demos()


@app.get("/api/search")
def search(q: str, mode: str = "author", limit: int = 40, start: int = 0):
    """arXiv papers by author or keywords, newest first, one page at a time. Each paper lists this runner's past
    runs of it, and on the first page the papers already run here that match the query are listed first, even
    when they are older than the page."""
    q, mode = q.strip(), ("author" if mode == "author" else "keywords")
    if not 2 <= len(q) <= 200:
        raise HTTPException(400, "give 2 to 200 characters")
    limit, start = min(max(1, limit), 100), max(0, start)
    runs = past_runs(RUNS_DIR)
    try:
        rows = search_arxiv(q, mode, limit, start)
        pinned = []
        if start == 0:
            on_page = {r["id"] for r in rows}
            pinned = [p for p in fetch_ids([i for i in runs if i not in on_page]) if matches(p, q, mode)]
            pinned += [r for r in rows if r["id"] in runs]
    except Exception as e:
        raise HTTPException(502, f"arXiv search failed: {e}")
    tag = lambda rs: [r | {"runs": runs.get(r["id"], [])} for r in rs]  # noqa: E731
    return {"already_run": tag(pinned), "papers": tag(rows), "start": start, "has_more": len(rows) == limit}


def _start(paper: str, repo: str | None, hint: str | None, config: dict | None, demo_id: str | None, injections: list | None):
    if len(ACTIVE) >= MAX_ACTIVE:
        raise HTTPException(429, f"{len(ACTIVE)} runs are already going; try again when one finishes")
    cfg = RunConfig.from_dict(config)
    cfg.max_cost_cny = min(cfg.max_cost_cny, CAP_COST)
    cfg.max_wall_minutes = min(cfg.max_wall_minutes, CAP_MIN)
    cfg.max_executor_steps = min(cfg.max_executor_steps, CAP_STEPS)
    rid = new_run_id()
    run = Run(rid, paper, repo, hint, cfg, demo_id=demo_id, injection_spec=injections)
    ACTIVE[rid] = run

    def work():
        try:
            run.execute()
        finally:
            ACTIVE.pop(rid, None)

    POOL.submit(work)
    return {"run_id": rid}


@app.post("/api/runs")
def create_run(body: dict, request: Request):
    _check_key(request)
    demo_id = body.get("demo_id")
    paper, repo, hint = body.get("paper"), body.get("repo"), body.get("target_hint")
    if demo_id:
        d = next((x for x in _demos() if x["id"] == demo_id), None)
        if not d:
            raise HTTPException(404, "unknown demo")
        paper, repo, hint = paper or d["paper"], repo or d.get("repo"), hint or d.get("target_hint")
    if not paper:
        raise HTTPException(400, "paper is required (arXiv id, URL or uploaded file)")
    return _start(paper, repo, hint, body.get("config"), demo_id, body.get("injections"))


@app.post("/api/runs/upload")
async def create_run_upload(request: Request, file: UploadFile = File(...), repo: str = Form(""), target_hint: str = Form(""), config: str = Form("")):
    _check_key(request)
    data = await file.read()
    if len(data) > 40_000_000 or not data.startswith(b"%PDF"):
        raise HTTPException(400, "send a PDF of at most 40 MB")
    UPLOADS.mkdir(parents=True, exist_ok=True)
    dest = UPLOADS / f"{int(time.time())}-{Path(file.filename or 'paper.pdf').name}"
    dest.write_bytes(data)
    return _start(str(dest), repo or None, target_hint or None, json.loads(config) if config else None, None, None)


@app.get("/api/runs")
def list_runs():
    out = []
    if RUNS_DIR.exists():
        for d in sorted(RUNS_DIR.iterdir(), reverse=True):
            m = d / "meta.json"
            if m.exists():
                meta = json.loads(m.read_text(encoding="utf-8"))
                out.append({k: meta.get(k) for k in ("id", "title", "paper", "status", "verdict", "route", "seconds", "demo_id", "started")}
                           | {"cost_cny": (meta.get("meter") or {}).get("cost_cny")})
    return out[:200]


@app.get("/api/runs/{rid}")
def get_run(rid: str):
    d = RUNS_DIR / rid
    if not (d / "meta.json").exists():
        raise HTTPException(404)
    out = {"meta": json.loads((d / "meta.json").read_text(encoding="utf-8"))}
    for name in ("claim_contract", "route", "plan", "assumption_ledger", "verdict"):
        p = d / f"{name}.json"
        if p.exists():
            out[name] = json.loads(p.read_text(encoding="utf-8"))
    return out


def _is_running(rid: str) -> bool:
    """A run started from the CLI is not in ACTIVE; trust its meta.json while it is fresh."""
    m = RUNS_DIR / rid / "meta.json"
    ev = RUNS_DIR / rid / "events.jsonl"
    try:
        status = json.loads(m.read_text(encoding="utf-8")).get("status")
        return status == "running" and time.time() - ev.stat().st_mtime < 1800
    except Exception:
        return False


@app.get("/api/runs/{rid}/events")
async def stream_events(rid: str, request: Request, offset: int = 0):
    path = RUNS_DIR / rid / "events.jsonl"
    if not path.exists():
        raise HTTPException(404)

    last = request.headers.get("last-event-id")
    start = int(last) if last and last.isdigit() else offset

    async def gen():
        off = start
        idle = 0
        while True:
            batch = read_events_with_offsets(path, off)
            evs = [e for e, _ in batch]
            for e, end in batch:
                off = end  # each event carries the position just after it, so a reconnect resumes exactly
                yield f"id: {end}\ndata: {json.dumps(e, ensure_ascii=False)}\n\n"
                if e.get("type") == "run_end":
                    return
            if not evs:
                idle += 1
                if idle > 6 and rid not in ACTIVE and not _is_running(rid):
                    yield "event: idle\ndata: {}\n\n"
                    return
                if idle % 30 == 0:
                    yield ": keep-alive\n\n"
            await asyncio.sleep(0.4)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/runs/{rid}/cancel")
def cancel_run(rid: str, request: Request):
    _check_key(request)
    run = ACTIVE.get(rid)
    if not run:
        raise HTTPException(404, "run is not active")
    run.cancel()
    return {"ok": True}


@app.get("/api/runs/{rid}/report.md")
def report(rid: str):
    p = RUNS_DIR / rid / "report.md"
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p, media_type="text/markdown", filename=f"{rid}-report.md")


@app.get("/api/runs/{rid}/events.jsonl")
def events_file(rid: str):
    p = RUNS_DIR / rid / "events.jsonl"
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p, media_type="application/x-ndjson")


@app.get("/api/runs/{rid}/files/{path:path}")
def run_file(rid: str, path: str):
    root = (WORKSPACES_DIR / rid).resolve()
    p = (root / path).resolve()
    if root not in p.parents or not p.is_file() or ".venv" in p.parts:
        raise HTTPException(404)
    if p.stat().st_size > (40_000_000 if p.suffix.lower() == ".pdf" else 2_000_000):
        raise HTTPException(413, "file too large")
    return FileResponse(p)


@app.get("/api/runs/{rid}/tree")
def run_tree(rid: str):
    root = (WORKSPACES_DIR / rid).resolve()
    if not root.exists():
        raise HTTPException(404)
    files = []
    for p in root.rglob("*"):
        rel = p.relative_to(root)
        if p.is_file() and not any(x in (".venv", ".tmp", ".git") for x in rel.parts) and rel.parts[0] != "repo" or (
                p.is_file() and rel.parts[0] == "repo" and len(rel.parts) <= 2 and ".git" not in rel.parts):
            files.append({"path": str(rel).replace("\\", "/"), "size": p.stat().st_size})
        if len(files) > 400:
            break
    return sorted(files, key=lambda f: f["path"])


app.mount("/", StaticFiles(directory=ROOT / "web", html=True), name="web")
