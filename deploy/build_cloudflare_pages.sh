#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WORK_DIR=$(mktemp -d)

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

cd "$ROOT_DIR"

APP_RUNTIME_ENV_FILE=${APP_RUNTIME_ENV_FILE:-.env} npm run build:production
mv dist "$WORK_DIR/web"

APP_RUNTIME_ENV_FILE=${APP_RUNTIME_ENV_FILE:-.env} npm run telegram:build:production
mv dist "$WORK_DIR/telegram"

mkdir -p dist/telegram
cp -a "$WORK_DIR/web/." dist/
cp -a "$WORK_DIR/telegram/." dist/telegram/

telegram_csp=$(sed -n 's/^  Content-Security-Policy: //p' dist/telegram/_headers | head -1)
if [ -z "$telegram_csp" ] || [ "${#telegram_csp}" -gt 1950 ]; then
  printf 'Invalid Cloudflare CSP length: %s\n' "${#telegram_csp}" >&2
  exit 1
fi

{
  printf '# Shared security headers for web and Telegram Mini App routes.\n'
  printf '/*\n'
  printf '  Content-Security-Policy: %s\n' "$telegram_csp"
  printf '  X-Content-Type-Options: nosniff\n'
  printf '  X-XSS-Protection: 1; mode=block\n'
  printf '  Link: <https://wallet.legends.energy/>; rel="canonical"\n'
  printf '/*.*.*\n'
  printf '  Cache-Control: public, max-age=31536000, immutable\n'
  printf '/build.txt\n'
  printf '  Cache-Control: no-cache\n'
  printf '/telegram/build.txt\n'
  printf '  Cache-Control: no-cache\n'
  printf '/telegram\n'
  printf '  X-Robots-Tag: noindex, nofollow\n'
  printf '/telegram/*\n'
  printf '  X-Robots-Tag: noindex, nofollow\n'
} > dist/_headers

{
  printf '/get/*       https://wallet.legends.energy/:splat  302\n'
  printf '/telegram    /telegram/index.html                 200\n'
  printf '/telegram/*  /telegram/index.html                 200\n'
  printf '/*           /index.html                          200\n'
} > dist/_redirects

rm -f dist/telegram/_headers dist/telegram/_redirects
