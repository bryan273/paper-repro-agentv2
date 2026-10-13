"""Local process sandbox.

Each run gets its own workspace folder and its own Python virtual environment (layered on a
prepared base env with numpy/scipy/sklearn/torch-cpu). Commands are argv lists, never shell
strings, and only a small set of executables is allowed. File tools cannot leave the workspace.
The child process gets a scrubbed environment: no API keys, HOME and TEMP inside the workspace.

This is process-level isolation for a single-user machine, NOT a security boundary for hostile
code. For untrusted papers at scale, swap in a container or microVM backend with the same interface
(see docs/DESIGN.md).
"""
from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import psutil

from .config import CACHE_DIR, SANDBOX_BASE_PYTHON
from .events import EventLog

IS_WIN = platform.system() == "Windows"
ALLOWED_GIT = {"clone", "checkout", "log", "status", "diff", "ls-files", "show", "rev-parse", "branch", "tag"}
SKIP_DIRS = {".venv", ".git", "__pycache__", ".cache", "node_modules", ".good"}
MAX_RETURN_CHARS = 7000


class SandboxError(RuntimeError):
    pass


@dataclass
class CommandResult:
    argv: list[str]
    exit_code: int | None
    seconds: float
    stdout_tail: str
    timed_out: bool
    changed_files: list[str]

    def for_model(self) -> str:
        status = "TIMEOUT" if self.timed_out else f"exit={self.exit_code}"
        files = ", ".join(self.changed_files[:25]) or "none"
        return f"[{status} in {self.seconds:.1f}s] files changed: {files}\n{self.stdout_tail}"


def _clip(text: str, limit: int = MAX_RETURN_CHARS) -> str:
    if len(text) <= limit:
        return text
    head = limit // 3
    return text[:head] + f"\n... [{len(text) - limit} chars omitted] ...\n" + text[-(limit - head):]


def machine_resources() -> dict:
    gpu = None
    if shutil.which("nvidia-smi"):
        try:
            out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
                                 capture_output=True, text=True, timeout=10).stdout.strip()
            gpu = out or None
        except Exception:
            gpu = None
    du = shutil.disk_usage(Path.cwd())
    return {
        "os": f"{platform.system()} {platform.release()}",
        "cpu_cores": os.cpu_count(),
        "ram_gb": round(psutil.virtual_memory().total / 2**30, 1),
        "gpu": gpu or "none",
        "disk_free_gb": round(du.free / 2**30, 1),
        "python": platform.python_version(),
    }


class LocalSandbox:
    def __init__(self, root: Path, log: EventLog, default_timeout: int = 900):
        self.root = root.resolve()
        self.log = log
        self.default_timeout = default_timeout
        self.ledger = self.root / "ledger.jsonl"
        self.venv = self.root / ".venv"
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / ".tmp").mkdir(exist_ok=True)
        self._proc: subprocess.Popen | None = None
        self.cancelled = False

    # ---------- environment ----------
    @property
    def python(self) -> Path:
        return self.venv / ("Scripts/python.exe" if IS_WIN else "bin/python")

    def prepare(self) -> None:
        if self.python.exists():
            return
        base = SANDBOX_BASE_PYTHON if Path(SANDBOX_BASE_PYTHON).exists() else Path(shutil.which("python") or "python")
        t0 = time.time()
        subprocess.run([str(base), "-m", "venv", str(self.venv)], check=True, capture_output=True, timeout=300)
        # Layer the prepared base env underneath: its site-packages go on sys.path after the run's own,
        # so anything the agent pip-installs wins, and nothing it installs touches the base.
        base_sp = subprocess.run([str(base), "-c", "import site,json;print(json.dumps(site.getsitepackages()))"],
                                 capture_output=True, text=True, timeout=60).stdout.strip()
        run_sp = subprocess.run([str(self.python), "-c", "import site;print(site.getsitepackages()[-1])"],
                                capture_output=True, text=True, timeout=60).stdout.strip()
        paths = [p for p in json.loads(base_sp or "[]") if p.endswith("site-packages")]
        if run_sp and paths:
            Path(run_sp, "_sandbox_base.pth").write_text(chr(10).join(paths) + chr(10), encoding="utf-8")
        self.log.emit("sandbox_ready", seconds=round(time.time() - t0, 1), base=str(base.name),
                      workspace=self.root.name, layered=paths)

    def _env(self) -> dict:
        keep = ("SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "LANG")
        env = {k: os.environ[k] for k in keep if k in os.environ}
        # Proxy settings pass through: on a network that reaches GitHub, PyPI or dataset hosts only through a
        # proxy, dropping them makes every clone and download time out.
        env.update({k: v for k, v in os.environ.items() if k.lower() in ("http_proxy", "https_proxy", "all_proxy", "no_proxy")})
        scripts = self.venv / ("Scripts" if IS_WIN else "bin")
        git_dir = Path(shutil.which("git") or "git").parent
        sysdirs = [os.environ.get("SYSTEMROOT", r"C:\Windows") + r"\System32"] if IS_WIN else ["/usr/bin", "/bin"]
        env.update({
            "PATH": os.pathsep.join([str(scripts), str(git_dir), *sysdirs]),
            "HOME": str(self.root), "USERPROFILE": str(self.root),
            "TEMP": str(self.root / ".tmp"), "TMP": str(self.root / ".tmp"),
            "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8", "PIP_DISABLE_PIP_VERSION_CHECK": "1",
            "PIP_CACHE_DIR": str(CACHE_DIR / "pip-cache"),
            "MPLBACKEND": "Agg", "GIT_TERMINAL_PROMPT": "0",
            # public datasets are cached across runs so the same download is not repeated
            "SCIKIT_LEARN_DATA": str(CACHE_DIR / "datasets" / "sklearn"),
            "HF_HOME": str(CACHE_DIR / "datasets" / "huggingface"),
            "TORCH_HOME": str(CACHE_DIR / "datasets" / "torch"),
            "REPRO_DATA_CACHE": str(CACHE_DIR / "datasets" / "files"),
        })
        return env

    # ---------- paths ----------
    def resolve(self, rel: str, readonly: bool = False) -> Path:
        p = (self.root / rel).resolve() if not Path(rel).is_absolute() else Path(rel).resolve()
        if p == self.root or self.root in p.parents:
            return p
        # The shared dataset cache (REPRO_DATA_CACHE and friends) may be looked at, never written through file tools.
        cache = (CACHE_DIR / "datasets").resolve()
        if readonly and (p == cache or cache in p.parents):
            return p
        raise SandboxError(f"path '{rel}' is outside the workspace")

    def _snapshot(self) -> dict[str, float]:
        snap = {}
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".tmp")]
            for f in filenames:
                p = Path(dirpath) / f
                try:
                    snap[str(p.relative_to(self.root)).replace("\\", "/")] = p.stat().st_mtime
                except OSError:
                    pass
            if len(snap) > 20000:
                break
        return snap

    # ---------- commands ----------
    def _check_argv(self, argv: list[str]) -> list[str]:
        if not argv or not isinstance(argv, list):
            raise SandboxError("argv must be a non-empty list of strings")
        exe = argv[0].lower().removesuffix(".exe")
        if exe in ("python", "python3", "py"):
            return [str(self.python), *argv[1:]]
        if exe in ("pip", "pip3"):
            return [str(self.python), "-m", "pip", *argv[1:]]
        if exe == "git":
            if len(argv) < 2 or argv[1] not in ALLOWED_GIT:
                raise SandboxError(f"git subcommand not allowed; allowed: {sorted(ALLOWED_GIT)}")
            return [shutil.which("git") or "git", *argv[1:]]
        raise SandboxError("only python, pip and git are allowed. Write a Python script for anything else "
                           "(downloads, unzipping, data prep) and run it with python.")

    def run(self, argv: list[str], cwd: str = ".", timeout: int | None = None, call_id: str = "") -> CommandResult:
        real = self._check_argv(argv)
        wd = self.resolve(cwd)
        if not wd.is_dir():
            raise SandboxError(f"cwd '{cwd}' does not exist")
        timeout = min(int(timeout or self.default_timeout), 3600)
        before = self._snapshot()
        t0 = time.time()
        lines: list[str] = []
        proc = subprocess.Popen(real, cwd=wd, env=self._env(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL, text=True, encoding="utf-8", errors="replace", bufsize=1,
                                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if IS_WIN else 0)
        self._proc = proc
        timed_out = False

        def reader():
            buf, last = [], time.time()
            for line in proc.stdout:  # type: ignore[union-attr]
                lines.append(line)
                buf.append(line)
                if time.time() - last > 0.7 or len(buf) > 40:
                    self.log.emit("tool_output", call_id=call_id, text=_clip("".join(buf), 4000))
                    buf, last = [], time.time()
            if buf:
                self.log.emit("tool_output", call_id=call_id, text=_clip("".join(buf), 4000))

        th = threading.Thread(target=reader, daemon=True)
        th.start()
        deadline = time.time() + timeout
        while proc.poll() is None:
            if self.cancelled:
                self._kill_tree(proc.pid)
                break
            if time.time() > deadline:
                timed_out = True
                self._kill_tree(proc.pid)
                break
            time.sleep(0.25)
        self._proc = None
        th.join(timeout=10)
        secs = time.time() - t0
        after = self._snapshot()
        changed = sorted(k for k, v in after.items() if before.get(k) != v)
        res = CommandResult(argv, proc.returncode, secs, _clip("".join(lines)), timed_out, changed)
        with self.ledger.open("a", encoding="utf-8") as f:
            f.write(json.dumps({"ts": time.time(), "argv": argv, "cwd": cwd, "exit": proc.returncode,
                                "seconds": round(secs, 2), "timed_out": timed_out, "changed": changed[:200],
                                "output_tail": "".join(lines)[-2000:]}, ensure_ascii=False) + "\n")
        return res

    def cancel(self):
        self.cancelled = True
        if self._proc is not None:
            self._kill_tree(self._proc.pid)

    @staticmethod
    def _kill_tree(pid: int):
        try:
            parent = psutil.Process(pid)
            for c in parent.children(recursive=True):
                c.kill()
            parent.kill()
        except psutil.NoSuchProcess:
            pass

    # ---------- files ----------
    def write(self, rel: str, content: str) -> str:
        p = self.resolve(rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        existed = p.exists()
        p.write_text(content, encoding="utf-8")
        return f"{'overwrote' if existed else 'created'} {rel} ({len(content)} chars, {content.count(chr(10)) + 1} lines)"

    def read(self, rel: str, start: int = 1, max_lines: int = 250) -> str:
        p = self.resolve(rel, readonly=True)
        if not p.is_file():
            raise SandboxError(f"no such file: {rel}")
        if p.stat().st_size > 30_000_000:
            raise SandboxError("file too large to read; inspect it with a Python script")
        lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
        start = max(1, start)
        chunk = lines[start - 1 : start - 1 + max_lines]
        body = "\n".join(f"{i:5d}| {l[:400]}" for i, l in enumerate(chunk, start))
        more = f"\n... ({len(lines) - (start - 1 + len(chunk))} more lines; read again with start=)" if start - 1 + len(chunk) < len(lines) else ""
        return f"{rel}: {len(lines)} lines\n{body}{more}"

    def edit(self, rel: str, old: str, new: str) -> str:
        p = self.resolve(rel)
        text = p.read_text(encoding="utf-8")
        n = text.count(old)
        if n != 1:
            raise SandboxError(f"old text found {n} times in {rel}; it must match exactly once")
        p.write_text(text.replace(old, new), encoding="utf-8")
        return f"edited {rel}"

    def listdir(self, rel: str = ".", depth: int = 2) -> str:
        base = self.resolve(rel, readonly=True)
        out = []
        for dirpath, dirnames, filenames in os.walk(base):
            d = Path(dirpath)
            level = len(d.relative_to(base).parts)
            dirnames[:] = sorted(x for x in dirnames if x not in SKIP_DIRS and not x.startswith(".tmp"))
            if level >= depth:
                dirnames[:] = []
            indent = "  " * level
            if level:
                out.append(f"{indent[:-2]}{d.name}/")
            for f in sorted(filenames)[:60]:
                try:
                    size = (d / f).stat().st_size
                except OSError:
                    size = 0
                out.append(f"{indent}{f}  ({size:,} B)")
            if len(out) > 400:
                out.append("... (truncated)")
                break
        return "\n".join(out) or "(empty)"
