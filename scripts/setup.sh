#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required. Install via 'corepack enable pnpm' or https://pnpm.io/installation." >&2
  exit 1
fi

if [ ! -f ".env" ]; then
  echo "Creating .env from .env.example"
  cp .env.example .env
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker CLI not found. Install Docker Desktop or another runtime and re-run this script." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "'docker compose' command unavailable. Ensure Docker Desktop v2.20+ or install Docker Compose plugin." >&2
  exit 1
fi

echo "Starting Postgres and Redis via docker compose..."
docker compose up -d

echo "Waiting for Postgres to report healthy..."
ATTEMPTS=0
until docker compose exec -T postgres pg_isready -U codex >/dev/null 2>&1; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "$ATTEMPTS" -gt 30 ]; then
    echo "Postgres failed to become ready within expected time." >&2
    exit 1
  fi
  sleep 2
done

echo "Ensuring npm dependencies are installed..."
pnpm install

echo "Applying Prisma migrations..."
pnpm prisma:migrate:deploy

echo "Seeding database..."
pnpm prisma:seed

echo
echo "✅ Environment ready. Launch the app with:"
echo "   pnpm dev"
echo "Then open http://localhost:3002"
