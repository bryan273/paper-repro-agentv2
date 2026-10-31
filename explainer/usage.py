"""Token and cost ledger for one render. Every model call appends one line to the file named by USAGE_FILE
(render_job.py sets it per job and reads the totals at the end, so the admin page can show what a video cost).
Token counts come from the API when it reports them; otherwise they are estimated from the text length (est: true).
PRICE is USD per 1M tokens (input, output) and is an ESTIMATE: edit it when the provider prices change."""
import json, os, threading
PRICE = {
    "claude-haiku-4-5": (1.0, 5.0), "claude-sonnet-4-6": (3.0, 15.0), "claude-opus-4-8": (5.0, 25.0),
    "gpt-6.1-sol": (2.5, 15.0), "gpt-5.6-terra": (2.5, 15.0), "gpt-6-astra": (10.0, 50.0),
    "deepseek-v4.1-flash": (0.14, 0.28),
}
DEFAULT_PRICE = (3.0, 15.0)
_LOCK = threading.Lock()

def _path():
    return os.environ.get("USAGE_FILE") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "usage.jsonl")

def est_tokens(text):
    return max(1, int(len(text or "") / 3.5))

def rec(model, prompt_tokens=None, completion_tokens=None, prompt_text="", completion_text="", part=""):
    est = prompt_tokens is None or completion_tokens is None
    pt = int(prompt_tokens) if prompt_tokens is not None else est_tokens(prompt_text)
    ct = int(completion_tokens) if completion_tokens is not None else est_tokens(completion_text)
    line = json.dumps({"model": str(model), "in": pt, "out": ct, "est": est, "part": part})
    try:
        with _LOCK, open(_path(), "a", encoding="utf-8") as f: f.write(line + "\n")
    except Exception:
        pass   # a failed ledger write must never break a render

def price(model):
    m = str(model).lower()
    for k, v in PRICE.items():
        if k in m: return v
    return DEFAULT_PRICE

def summary(path=None):
    path = path or _path()
    out = {"usd": 0.0, "calls": 0, "tokens_in": 0, "tokens_out": 0, "estimated_calls": 0, "by_model": {}}
    try: lines = open(path, encoding="utf-8").read().splitlines()
    except Exception: return out
    for ln in lines:
        try: r = json.loads(ln)
        except Exception: continue
        pi, po = price(r["model"]); usd = (r["in"] * pi + r["out"] * po) / 1e6
        b = out["by_model"].setdefault(r["model"], {"calls": 0, "in": 0, "out": 0, "usd": 0.0})
        b["calls"] += 1; b["in"] += r["in"]; b["out"] += r["out"]; b["usd"] = round(b["usd"] + usd, 4)
        out["usd"] += usd; out["calls"] += 1; out["tokens_in"] += r["in"]; out["tokens_out"] += r["out"]; out["estimated_calls"] += 1 if r.get("est") else 0
    out["usd"] = round(out["usd"], 4)
    return out
