#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -f ".env" ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

export PORT="${PORT:-8081}"
export NEXT_PUBLIC_API_BASE="${NEXT_PUBLIC_API_BASE:-http://localhost:${PORT}}"

check_port() {
  local port="$1"
  if lsof -iTCP:"$port" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
    echo "Port $port is already in use."
    echo "Run: lsof -ti tcp:$port | xargs kill -9"
    exit 1
  fi
}

check_port 3122
check_port "$PORT"

ensure_docker_daemon() {
  if docker info >/dev/null 2>&1; then
    return
  fi

  echo "Docker daemon 未运行，尝试启动 Docker Desktop..."
  if command -v open >/dev/null 2>&1; then
    open -a Docker >/dev/null 2>&1 || true
  fi

  for _ in $(seq 1 45); do
    if docker info >/dev/null 2>&1; then
      return
    fi
    sleep 2
  done

  echo "Docker daemon 仍不可用。请手动打开 Docker Desktop 并等待 Engine running。"
  echo "若你已在本机自行启动 Postgres/Redis/MinIO，可用：SKIP_INFRA=1 pnpm dev:up"
  exit 1
}

if [ "${SKIP_INFRA:-0}" != "1" ]; then
  ensure_docker_daemon
  echo "Starting infrastructure containers (postgres, redis, minio, minio-init)..."
  docker compose -f infra/docker-compose.yml up -d postgres redis minio minio-init
else
  echo "SKIP_INFRA=1, skipping docker infrastructure startup."
fi

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
echo "Web: http://localhost:3122"
echo "API: http://localhost:${PORT}/healthz"
echo "Press Ctrl+C to stop all services."

wait
