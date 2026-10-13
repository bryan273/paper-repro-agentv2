# Runner image: the FastAPI server, the UI, and the base environment every run's sandbox is layered on.
# The container is the isolation boundary on a server: the in-process sandbox is not one (see repro/sandbox.py).
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Base environment for the agent's code: the same packages as scripts/setup_sandbox.py, torch CPU only.
RUN python -m venv /opt/sandbox-base \
    && /opt/sandbox-base/bin/pip install -q --no-cache-dir --upgrade pip \
    && /opt/sandbox-base/bin/pip install -q --no-cache-dir numpy scipy pandas scikit-learn matplotlib tqdm requests \
    && /opt/sandbox-base/bin/pip install -q --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

WORKDIR /app
COPY requirements.txt .
RUN pip install -q --no-cache-dir -r requirements.txt
COPY repro repro
COPY scripts scripts
COPY demos demos
COPY web web

# Runs, workspaces and the dataset cache live on a volume, so they survive restarts and redeploys.
RUN useradd -m -u 1000 runner && mkdir -p /data && chown runner /data /app \
    && ln -s /data/runs /app/runs && ln -s /data/workspaces /app/workspaces && ln -s /data/cache /app/.cache
USER runner
ENV SANDBOX_BASE_PYTHON=/opt/sandbox-base/bin/python \
    REPRO_REQUIRE_KEY=1 \
    PYTHONUNBUFFERED=1
VOLUME /data
EXPOSE 8765
CMD ["sh", "-c", "mkdir -p /data/runs /data/workspaces /data/cache && exec uvicorn repro.server:app --host 0.0.0.0 --port 8765"]
