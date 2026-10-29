#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=128}"

npx --yes \
  --package=vite@latest \
  --package=vitest@5.0.5 \
  vitest run \
  --config vitest.work-radar.config.mjs \
  --maxWorkers=1
