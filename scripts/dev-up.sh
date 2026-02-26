#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -f ".env" ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

check_port() {
  local port="$1"
  if lsof -iTCP:"$port" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
    echo "Port $port is already in use."
    echo "Run: lsof -ti tcp:$port | xargs kill -9"
    exit 1
  fi
}

check_port 3000
check_port 8080

echo "Starting infrastructure containers (postgres, redis, minio, minio-init)..."
docker compose -f infra/docker-compose.yml up -d postgres redis minio minio-init

cleanup() {
  if [ -n "${API_PID:-}" ]; then kill "$API_PID" >/dev/null 2>&1 || true; fi
  if [ -n "${WORKER_PID:-}" ]; then kill "$WORKER_PID" >/dev/null 2>&1 || true; fi
  if [ -n "${WEB_PID:-}" ]; then kill "$WEB_PID" >/dev/null 2>&1 || true; fi
}

trap cleanup EXIT INT TERM

echo "Starting API..."
pnpm --filter @matridx/api dev &
API_PID=$!

echo "Starting Worker..."
pnpm --filter @matridx/worker dev &
WORKER_PID=$!

echo "Starting Web..."
pnpm --filter @matridx/web dev &
WEB_PID=$!

echo "All services started."
echo "Web: http://localhost:3000"
echo "API: http://localhost:8080/healthz"
echo "Press Ctrl+C to stop all services."

wait
