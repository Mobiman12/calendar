#!/bin/zsh
# Automated verification + triple-backup job for Timevex Calendar.

set -euo pipefail

PROJECT_ROOT="/Users/larsbirndt/Projects/calendar/codex"
LOG_ROOT="${PROJECT_ROOT}/.backups/logs"
TIMESTAMP="$(date '+%Y-%m-%d %H:%M:%S')"

mkdir -p "${LOG_ROOT}"
LOG_FILE="${LOG_ROOT}/auto-backup.log"

{
  echo "[$TIMESTAMP] Starting automated verify & backup run..."
  cd "${PROJECT_ROOT}"
  export PATH="/opt/homebrew/bin:${PATH}"

  echo "[$TIMESTAMP] Running pnpm verify:critical"
  pnpm verify:critical

  echo "[$TIMESTAMP] Running pnpm backup -- --label nightly"
  pnpm backup -- --label nightly

  echo "[$TIMESTAMP] Completed successfully."
} >> "${LOG_FILE}" 2>&1
