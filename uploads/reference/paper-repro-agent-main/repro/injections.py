"""Error injection at handoffs, for controlled experiments on the frozen scaffold.

A spec is a list of dicts:
  {"at": "planner->implementer", "type": "false_info", "path": "config.lr", "value": "0.5", "marker": "INJ-7F3A"}
  {"at": "reader->router", "type": "omission", "path": "requirements.2"}
  {"at": "router->planner", "type": "wrong_conclusion", "path": "route", "value": "paper_only"}
Types: false_info (overwrite a value), omission (delete a field or list item), wrong_conclusion
(overwrite a decision field), conflicting_evidence (append a contradicting note), corrupted_handoff
(overwrite and keep the marker). Every applied injection is logged with its marker so its path through
the run can be traced. With an empty spec nothing changes.
"""
from __future__ import annotations

import copy
import uuid


def _walk(obj, parts):
    for p in parts[:-1]:
        obj = obj[int(p)] if isinstance(obj, list) else obj[p]
    return obj, parts[-1]


def apply(record: dict, spec: list[dict]) -> tuple[dict, list[dict]]:
    applied = []
    point = f"{record['from']}->{record['to']}"
    for inj in spec or []:
        if inj.get("at") != point:
            continue
        rec = copy.deepcopy(record)
        marker = inj.get("marker") or f"INJ-{uuid.uuid4().hex[:4].upper()}"
        try:
            parent, key = _walk(rec["content"], str(inj.get("path", "")).split("."))
            t = inj.get("type")
            if t == "omission":
                if isinstance(parent, list):
                    parent.pop(int(key))
                else:
                    parent.pop(key, None)
            elif t == "conflicting_evidence":
                notes = rec["content"].setdefault("notes", [])
                notes.append(f"[{marker}] {inj.get('value')}")
            else:
                if isinstance(parent, list):
                    parent[int(key)] = inj.get("value")
                else:
                    parent[key] = inj.get("value")
            record = rec
            applied.append({**inj, "marker": marker, "ok": True})
        except (KeyError, IndexError, ValueError, TypeError) as e:
            applied.append({**inj, "marker": marker, "ok": False, "error": str(e)})
    return record, applied
