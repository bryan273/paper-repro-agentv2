"""Create the base Python environment that every run's sandbox venv is layered on."""
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
base = root / ".cache" / "sandbox-base"
py = base / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
if not py.exists():
    subprocess.check_call([sys.executable, "-m", "venv", str(base)])
pip = [str(py), "-m", "pip", "install", "-q"]
subprocess.check_call(pip + ["--upgrade", "pip"])
subprocess.check_call(pip + ["numpy", "scipy", "pandas", "scikit-learn", "matplotlib", "tqdm", "requests"])
subprocess.check_call(pip + ["torch", "--index-url", "https://download.pytorch.org/whl/cpu"])
print("sandbox base ready:", py)
