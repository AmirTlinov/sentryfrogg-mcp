#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_FILE="$ROOT_DIR/package-lock.json"
STAMP_FILE="$ROOT_DIR/.npm-install.checksum"
LOG_PREFIX="[sentryfrogg-setup]"

hash_file() {
  sha256sum "$1" | awk '{print $1}'
}

if [[ ! -f "$LOCK_FILE" ]]; then
  echo "$LOG_PREFIX package-lock.json не найден" >&2
  exit 1
fi

DESIRED_HASH="$(hash_file "$LOCK_FILE")"
CURRENT_HASH=""
if [[ -f "$STAMP_FILE" ]]; then
  CURRENT_HASH="$(cat "$STAMP_FILE")"
fi

if [[ ! -d "$ROOT_DIR/node_modules" || "$CURRENT_HASH" != "$DESIRED_HASH" ]]; then
  echo "$LOG_PREFIX запускаю npm ci (обновление зависимостей)" >&2
  (cd "$ROOT_DIR" && npm ci --include=dev)
  printf '%s' "$DESIRED_HASH" > "$STAMP_FILE"
  echo "$LOG_PREFIX зависимости готовы" >&2
fi

cd "$ROOT_DIR"
if [[ -f "$ROOT_DIR/dist/sentryfrogg_server.js" ]]; then
  exec node dist/sentryfrogg_server.js "$@"
fi

echo "$LOG_PREFIX dist не найден, собираю TypeScript" >&2
npm run build
exec node dist/sentryfrogg_server.js "$@"
