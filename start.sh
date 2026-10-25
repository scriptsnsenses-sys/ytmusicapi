#!/usr/bin/env bash
# Start the FastAPI app (Render/Linux).
# Video mode resolves YouTube streams in-process via the InnerTube API,
# so there is no bridge binary to launch anymore.
set -euo pipefail

PORT="${PORT:-8000}"
exec uvicorn server.app:app --host 0.0.0.0 --port "$PORT"
