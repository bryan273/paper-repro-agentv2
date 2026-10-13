"""OpenAI-compatible chat client with streaming, retries, tool calls and cost metering.

Streaming is mandatory: on the Paratera gateway, non-streamed DeepSeek requests stall.
The gateway also drops TLS connections now and then (SSL UNEXPECTED_EOF), so every call retries.
"""
from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass, field

try:
    import httpx
except ImportError:  # openai>=3 ships its HTTP client as httpx2
    import httpx2 as httpx
from openai import APIConnectionError, APIStatusError, APITimeoutError, OpenAI

from .config import DEFAULT_PRICE, GLOBAL_SPEND_CAP_CNY, PRICES_CNY, PROVIDERS, SPEND_FILE, ModelChoice
from .events import EventLog


STALL_SECONDS = 150
# after half the retries fail, switch to a sibling model on the same gateway
FALLBACKS = {"DeepSeek-V4-Flash": "DeepSeek-V4.1-Flash", "DeepSeek-V4.1-Flash": "DeepSeek-V4-Flash",
             "DeepSeek-V4-Pro": "DeepSeek-V4-Pro-0813"}


class BudgetExceeded(RuntimeError):
    pass


class Cancelled(RuntimeError):
    pass


_spend_lock = threading.Lock()


def _add_global_spend(cny: float) -> float:
    with _spend_lock:
        SPEND_FILE.parent.mkdir(parents=True, exist_ok=True)
        total = 0.0
        if SPEND_FILE.exists():
            try:
                total = json.loads(SPEND_FILE.read_text())["total_cny"]
            except Exception:
                total = 0.0
        total += cny
        SPEND_FILE.write_text(json.dumps({"total_cny": round(total, 4), "updated": time.time()}))
        return total


def global_spend() -> float:
    try:
        return json.loads(SPEND_FILE.read_text())["total_cny"]
    except Exception:
        return 0.0


@dataclass
class Meter:
    """Tokens, cost and time for one run, enforced against the run budget."""
    max_cost_cny: float
    deadline: float
    prompt_tokens: int = 0
    cached_tokens: int = 0
    completion_tokens: int = 0
    reasoning_tokens: int = 0
    cost_cny: float = 0.0
    calls: int = 0
    by_role: dict = field(default_factory=dict)
    cancelled: bool = False

    def add(self, role: str, model: str, usage: dict) -> float:
        p_in, p_hit, p_out = PRICES_CNY.get(model, DEFAULT_PRICE)
        pt = usage.get("prompt_tokens", 0) or 0
        ct = usage.get("completion_tokens", 0) or 0
        cached = ((usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0)
        rt = ((usage.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0)
        cost = ((pt - cached) * p_in + cached * p_hit + ct * p_out) / 1e6
        self.prompt_tokens += pt
        self.cached_tokens += cached
        self.completion_tokens += ct
        self.reasoning_tokens += rt
        self.cost_cny += cost
        self.calls += 1
        r = self.by_role.setdefault(role, {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0, "cost_cny": 0.0, "model": model})
        r["calls"] += 1
        r["prompt_tokens"] += pt
        r["completion_tokens"] += ct
        r["cost_cny"] = round(r["cost_cny"] + cost, 5)
        _add_global_spend(cost)
        return cost

    def check(self):
        if self.cancelled:
            raise Cancelled("stopped by the user")
        if self.cost_cny >= self.max_cost_cny:
            raise BudgetExceeded(f"run cost budget reached (¥{self.cost_cny:.2f} of ¥{self.max_cost_cny:.2f})")
        if time.time() >= self.deadline:
            raise BudgetExceeded("run time budget reached")
        if global_spend() >= GLOBAL_SPEND_CAP_CNY:
            raise BudgetExceeded(f"global spend cap reached (¥{GLOBAL_SPEND_CAP_CNY:.0f})")

    def snapshot(self) -> dict:
        return {
            "prompt_tokens": self.prompt_tokens, "cached_tokens": self.cached_tokens,
            "completion_tokens": self.completion_tokens, "reasoning_tokens": self.reasoning_tokens,
            "cost_cny": round(self.cost_cny, 4), "calls": self.calls, "by_role": self.by_role,
        }


_clients: dict[str, OpenAI] = {}


def client_for(provider: str) -> OpenAI:
    if provider not in _clients:
        p = PROVIDERS[provider]
        if not p.api_key:
            raise RuntimeError(f"no API key for provider '{provider}' (set {p.key_env} in .env)")
        # read timeout is per chunk: a healthy stream sends reasoning tokens continuously
        _clients[provider] = OpenAI(api_key=p.api_key, base_url=p.base_url, max_retries=0,
                                    timeout=httpx.Timeout(connect=15.0, read=120.0, write=60.0, pool=30.0))
    return _clients[provider]


@dataclass
class Reply:
    content: str
    reasoning: str
    tool_calls: list[dict]
    usage: dict
    finish_reason: str | None
    seconds: float

    def as_message(self) -> dict:
        msg: dict = {"role": "assistant", "content": self.content or ""}
        if self.reasoning:
            # DeepSeek thinking mode expects its reasoning back while a tool loop is in progress
            msg["reasoning_content"] = self.reasoning
        if self.tool_calls:
            msg["tool_calls"] = [
                {"id": tc["id"], "type": "function", "function": {"name": tc["name"], "arguments": tc["arguments"]}}
                for tc in self.tool_calls
            ]
        return msg


def chat(
    choice: ModelChoice,
    messages: list[dict],
    *,
    role: str,
    meter: Meter,
    log: EventLog | None = None,
    tools: list[dict] | None = None,
    temperature: float = 0.2,
    max_tokens: int = 8192,
    json_mode: bool = False,
    retries: int = 10,
) -> Reply:
    meter.check()
    cli = client_for(choice.provider)
    kwargs: dict = dict(model=choice.model, messages=messages, stream=True, temperature=temperature,
                        max_tokens=max_tokens, stream_options={"include_usage": True})
    if tools:
        kwargs["tools"] = tools
    if json_mode:
        kwargs["response_format"] = {"type": "json_object"}
    last_err: Exception | None = None
    for attempt in range(retries):
        if attempt == retries // 2 and FALLBACKS.get(choice.model) and kwargs["model"] == choice.model:
            kwargs["model"] = FALLBACKS[choice.model]
            if log:
                log.emit("llm_fallback", role=role, model=choice.model, fallback=kwargs["model"])
        t0 = time.time()
        content, reasoning, finish = [], [], None
        calls: dict[int, dict] = {}
        usage: dict = {}
        buf, last_flush = [], time.time()
        stream = None
        last_chunk = [time.time()]
        done = threading.Event()

        def watchdog():
            # The gateway sometimes keeps a connection open without sending anything; close it.
            while not done.wait(5):
                if time.time() - last_chunk[0] > STALL_SECONDS and stream is not None:
                    try:
                        stream.close()
                    except Exception:
                        pass
                    return

        threading.Thread(target=watchdog, daemon=True).start()
        try:
            stream = cli.chat.completions.create(**kwargs)
            for chunk in stream:
                last_chunk[0] = time.time()
                if meter.cancelled:
                    stream.close()
                    raise Cancelled("stopped by the user")
                if getattr(chunk, "usage", None):
                    usage = chunk.usage.model_dump()
                for ch in chunk.choices or []:
                    d = ch.delta
                    if ch.finish_reason:
                        finish = ch.finish_reason
                    extra = getattr(d, "model_extra", None) or {}
                    rc = getattr(d, "reasoning_content", None) or extra.get("reasoning_content")
                    if rc:
                        reasoning.append(rc)
                        buf.append(rc)
                    if d.content:
                        content.append(d.content)
                    for tc in d.tool_calls or []:
                        e = calls.setdefault(tc.index or 0, {"id": "", "name": "", "arguments": ""})
                        if tc.id:
                            e["id"] = tc.id
                        if tc.function:
                            e["name"] += tc.function.name or ""
                            e["arguments"] += tc.function.arguments or ""
                if log and buf and time.time() - last_flush > 0.8:
                    log.emit("thinking", role=role, delta="".join(buf))
                    buf, last_flush = [], time.time()
            done.set()
            if finish is None and not content and not calls:
                raise httpx.ReadError("stream ended without a finish reason (stalled or closed)")
            if log and buf:
                log.emit("thinking", role=role, delta="".join(buf))
            secs = time.time() - t0
            tool_calls = [dict(v, id=v["id"] or f"call_{i}") for i, v in sorted(calls.items()) if v["name"]]
            if not usage:  # estimate if the gateway did not report usage
                n_in = sum(len(json.dumps(m, ensure_ascii=False)) for m in messages) // 3
                usage = {"prompt_tokens": n_in, "completion_tokens": (len("".join(content)) + len("".join(reasoning))) // 3}
            cost = meter.add(role, choice.model, usage)
            if log:
                log.emit("llm_call", role=role, model=choice.model, seconds=round(secs, 2),
                         prompt_tokens=usage.get("prompt_tokens"), completion_tokens=usage.get("completion_tokens"),
                         cost_cny=round(cost, 5), attempt=attempt + 1, finish_reason=finish, meter=meter.snapshot())
            return Reply("".join(content), "".join(reasoning), tool_calls, usage, finish, secs)
        except Cancelled:
            raise
        except (APIConnectionError, APITimeoutError, httpx.HTTPError) as e:
            last_err = e
        except APIStatusError as e:
            last_err = e
            if e.status_code not in (408, 409, 429, 500, 502, 503, 504):
                done.set()
                raise
        except Exception as e:  # a stream closed by the watchdog surfaces as various errors
            last_err = e
        finally:
            done.set()
        if log:
            log.emit("llm_retry", role=role, model=choice.model, attempt=attempt + 1, error=str(last_err)[:300])
        meter.check()
        time.sleep(min(1.5 ** attempt, 15))
    raise RuntimeError(f"LLM call failed after {retries} attempts: {last_err}")


def parse_json(text: str) -> dict:
    """Parse a JSON object from a model reply, tolerating code fences and surrounding prose."""
    t = text.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[1] if "\n" in t else t
        t = t.rsplit("```", 1)[0]
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        a, b = t.find("{"), t.rfind("}")
        if a >= 0 and b > a:
            return json.loads(t[a : b + 1])
        raise
