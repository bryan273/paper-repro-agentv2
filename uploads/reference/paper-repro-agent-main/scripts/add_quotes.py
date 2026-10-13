"""Backfill PDF highlights for runs recorded before the Reader returned quotes.

One model call asks for exact quotes for each claim, requirement and assumption; every quote is then
checked against the paper text (quotes.annotate) and dropped if it is not there. The script inserts a
`contract_full` event after the `contract` event and `paper_read` events after reads of paper.txt.

  python scripts/add_quotes.py demo-fasttext-3
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from repro import quotes  # noqa: E402
from repro.config import RUNS_DIR, WORKSPACES_DIR, ModelChoice  # noqa: E402
from repro.llm import Meter, chat, parse_json  # noqa: E402

rid = sys.argv[1]
d, ws = RUNS_DIR / rid, WORKSPACES_DIR / rid
c = json.loads((d / "claim_contract.json").read_text(encoding="utf-8"))
ledger = json.loads((d / "assumption_ledger.json").read_text(encoding="utf-8"))
text = (ws / "paper" / "paper.txt").read_text(encoding="utf-8")

items = ([{"id": x["id"], "what": x.get("statement")} for x in c.get("claims", [])]
         + [{"id": x["id"], "what": x.get("stmt") + " (" + str(x.get("cite")) + ")"} for x in c.get("requirements", [])]
         + [{"id": x["id"], "what": x.get("gap")} for x in ledger])
meter = Meter(2, time.time() + 900)
q = None
for attempt in range(3):
  r = chat(ModelChoice(), [
    {"role": "system", "content": "For each item, copy 8-25 consecutive words EXACTLY from the paper text that state or "
                                  "best support it (character for character, no ellipsis). Use null if nothing fits. "
                                  "Return JSON {\"quotes\": {\"<id>\": \"<quote>\"|null}}."},
    {"role": "user", "content": json.dumps({"items": items}, ensure_ascii=False) + "\n\n=== PAPER TEXT ===\n" + text[:150000]}],
    role="reader", meter=meter, max_tokens=30000, json_mode=True)
  try:
    q = parse_json(r.content).get("quotes", {})
    break
  except Exception:
    print("empty or bad JSON reply, retrying")
if q is None:
    sys.exit("no quotes after 3 attempts")
for x in c.get("claims", []) + c.get("requirements", []) + ledger:
    x["quote"] = q.get(x["id"])
view = quotes.annotate(c, ledger, text)
(d / "claim_contract.json").write_text(json.dumps(c, ensure_ascii=False, indent=1), encoding="utf-8")
(d / "assumption_ledger.json").write_text(json.dumps(ledger, ensure_ascii=False, indent=1), encoding="utf-8")

pages = int(json.loads((d / "meta.json").read_text(encoding="utf-8")).get("pages") or 0) or max(
    [n for n, _ in quotes.page_texts(text)] or [1])
evs = [json.loads(l) for l in (d / "events.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
evs = [e for e in evs if e["type"] not in ("contract_full", "paper_read")]
out = []
for e in evs:
    out.append(e)
    if e["type"] == "contract":
        out.append({**{k: e[k] for k in ("t", "ts")}, "seq": e["seq"], "type": "contract_full", "pages": pages, **view})
    if e["type"] == "tool_call" and e.get("name") == "read_file" and str(e["args"].get("path", "")).endswith("paper/paper.txt"):
        a = int(e["args"].get("start", 1))
        n = int(e["args"].get("max_lines", 250))
        pa, pb = quotes.page_of_line(text, a) or 1, quotes.page_of_line(text, a + n) or 1
        out.append({"t": e["t"], "ts": e["ts"], "seq": e["seq"], "type": "paper_read", "by": "implementer",
                    "pages": list(range(pa, pb + 1)), "how": "read_file"})
    if e["type"] == "tool_call" and e.get("name") == "run" and any("paper.txt" in str(x) for x in e["args"].get("argv", [])):
        out.append({"t": e["t"], "ts": e["ts"], "seq": e["seq"], "type": "paper_read", "by": "implementer",
                    "pages": None, "how": "searched the paper text with a script"})
(d / "events.jsonl").write_text("\n".join(json.dumps(e, ensure_ascii=False) for e in out) + "\n", encoding="utf-8")
print(rid, "quotes kept", view["quote_check"], "cost ¥", round(meter.cost_cny, 4))
