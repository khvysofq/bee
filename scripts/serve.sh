#!/usr/bin/env bash
# 生产模式起服务（构建产物），默认端口 22081，可用 PORT 覆盖。
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-22081}"
exec pnpm --filter @bee/web exec next start -p "$PORT"
