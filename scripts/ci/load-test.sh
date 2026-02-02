#!/usr/bin/env bash
set -euo pipefail

if ! command -v k6 >/dev/null 2>&1; then
  echo "[load-test] k6 binary not found. Skipping load test stage." >&2
  exit 0
fi

echo "[load-test] running booking availability scenario"
BASE_URL=${BASE_URL:-http://localhost:3002} \
LOCATION_SLUG=${LOCATION_SLUG:-city-center-salon} \
k6 run loadtests/booking-flow.js
