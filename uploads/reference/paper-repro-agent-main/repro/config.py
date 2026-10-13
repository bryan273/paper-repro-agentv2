"""Runtime configuration: providers, per-agent models, prices and budgets.

Everything here can be overridden per run from the UI or the CLI. API keys are read from
the environment (.env) and never written to run logs or passed into the sandbox.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

RUNS_DIR = ROOT / "runs"
WORKSPACES_DIR = ROOT / "workspaces"
CACHE_DIR = ROOT / ".cache"
SANDBOX_BASE_PYTHON = Path(os.getenv("SANDBOX_BASE_PYTHON", CACHE_DIR / "sandbox-base" / "Scripts" / "python.exe"))
if not SANDBOX_BASE_PYTHON.exists():  # linux / mac layout
    alt = CACHE_DIR / "sandbox-base" / "bin" / "python"
    if alt.exists():
        SANDBOX_BASE_PYTHON = alt


@dataclass
class Provider:
    name: str
    base_url: str
    key_env: str

    @property
    def api_key(self) -> str | None:
        return os.getenv(self.key_env)


# Any OpenAI-compatible endpoint works. Paratera (Tsinghua) serves DeepSeek, GLM, Qwen, Kimi...
PROVIDERS: dict[str, Provider] = {
    "paratera": Provider("paratera", os.getenv("PARATERA_BASE_URL", "https://llmapi.paratera.com/v1"), "PARATERA_API_KEY"),
    "deepseek": Provider("deepseek", "https://api.deepseek.com/v1", "DEEPSEEK_API_KEY"),
    "stepfun": Provider("stepfun", "https://api.stepfun.com/v1", "STEPFUN_API_KEY"),
    "zhipu": Provider("zhipu", "https://open.bigmodel.cn/api/paas/v4", "ZHIPU_API_KEY"),
}

# Price per 1M tokens in CNY: (input cache miss, input cache hit, output). These are ESTIMATES
# used for the live cost meter; check your provider's price page. Unknown models fall back to DEFAULT.
PRICES_CNY: dict[str, tuple[float, float, float]] = {
    "DeepSeek-V4-Flash": (1.0, 0.1, 2.0),
    "DeepSeek-V4.1-Flash": (1.0, 0.1, 2.0),
    "DeepSeek-V4-Pro": (4.0, 0.4, 16.0),
    "DeepSeek-V3.2-Exp": (2.0, 0.2, 3.0),
    "GLM-5.3-Flash": (0.0, 0.0, 0.0),
    "GLM-5.3": (4.0, 1.0, 16.0),
    "Qwen3.8-Max": (6.0, 1.2, 24.0),
    "Kimi-K3": (4.0, 1.0, 16.0),
}
DEFAULT_PRICE = (4.0, 1.0, 16.0)

ROLES = ("reader", "router", "planner", "executor", "verifier")
# Default to the first provider that has a key, so a DeepSeek-only (or Paratera-only) .env just works.
_PROVIDER_DEFAULT_MODEL = {"paratera": "DeepSeek-V4-Flash", "deepseek": "deepseek-chat", "stepfun": "step-2-mini", "zhipu": "glm-4-flash"}
DEFAULT_PROVIDER = os.getenv("REPRO_DEFAULT_PROVIDER") or next(
    (n for n in _PROVIDER_DEFAULT_MODEL if os.getenv(PROVIDERS[n].key_env)), "paratera")
DEFAULT_MODEL = os.getenv("REPRO_DEFAULT_MODEL") or _PROVIDER_DEFAULT_MODEL[DEFAULT_PROVIDER]


@dataclass
class ModelChoice:
    provider: str = DEFAULT_PROVIDER
    model: str = DEFAULT_MODEL


@dataclass
class RunConfig:
    models: dict[str, ModelChoice] = field(default_factory=lambda: {r: ModelChoice() for r in ROLES})
    max_cost_cny: float = float(os.getenv("REPRO_MAX_COST_CNY", "15"))
    max_wall_minutes: float = float(os.getenv("REPRO_MAX_WALL_MIN", "60"))
    max_executor_steps: int = int(os.getenv("REPRO_MAX_STEPS", "120"))
    max_repair_rounds: int = 3
    command_timeout_s: int = 900
    temperature: float = 0.2

    @classmethod
    def from_dict(cls, d: dict | None) -> "RunConfig":
        cfg = cls()
        if not d:
            return cfg
        for role, m in (d.get("models") or {}).items():
            if role in ROLES and m:
                cfg.models[role] = ModelChoice(m.get("provider", DEFAULT_PROVIDER), m.get("model", DEFAULT_MODEL))
        for k in ("max_cost_cny", "max_wall_minutes", "max_executor_steps", "max_repair_rounds", "command_timeout_s", "temperature"):
            if k in d and d[k] is not None:
                setattr(cfg, k, type(getattr(cfg, k))(d[k]))
        return cfg

    def to_dict(self) -> dict:
        return {
            "models": {r: {"provider": m.provider, "model": m.model} for r, m in self.models.items()},
            "max_cost_cny": self.max_cost_cny,
            "max_wall_minutes": self.max_wall_minutes,
            "max_executor_steps": self.max_executor_steps,
            "max_repair_rounds": self.max_repair_rounds,
            "command_timeout_s": self.command_timeout_s,
            "temperature": self.temperature,
        }


# A hard cap across all runs, so an unattended night cannot drain the account.
GLOBAL_SPEND_CAP_CNY = float(os.getenv("REPRO_GLOBAL_CAP_CNY", "600"))
SPEND_FILE = CACHE_DIR / "spend.json"
