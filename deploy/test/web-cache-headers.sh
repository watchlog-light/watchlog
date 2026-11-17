#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# The web image's cache headers (ADR-206), on the image's own Caddy with web/Caddyfile and a
# stand-in /srv: hashed assets a year and immutable, a missing asset a plain 404 (never the
# dashboard's HTML), index.html and the dashboard's routes revalidated (no-cache), and
# /install.sh sent to the backend (ADR-209), in both editions. Needs Docker; takes a few seconds. Usage: deploy/test/web-cache-headers.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="$(awk '/^FROM caddy/ {print $2; exit}' "$ROOT/web/Dockerfile")"
NAME="wl-cache-headers-$$"
PORT="${WEB_CACHE_TEST_PORT:-18093}"
SRV="$(mktemp -d)"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$SRV"' EXIT

mkdir -p "$SRV/assets"
echo '<!doctype html><title>WatchLog</title>' >"$SRV/index.html"
echo 'console.log(1)' >"$SRV/assets/index-AbC123.js"
echo 'favicon' >"$SRV/favicon.svg"

fail=0
check() { # what, url, expected status, header regex (or !regex for "absent")
  local what="$1" url="$2" status="$3" want="$4" got headers
  headers="$(curl -s -D - -o /dev/null "http://127.0.0.1:$PORT$url" | tr -d '\r')"
  got="$(head -1 <<<"$headers" | awk '{print $2}')"
  local cc
  cc="$(grep -i '^cache-control:' <<<"$headers" || true)"
  if [[ "$got" != "$status" ]]; then
    echo "FAIL $what: status $got, want $status"; fail=1; return
  fi
  if [[ "$want" == !* ]]; then
    if grep -Eiq "${want#!}" <<<"$cc"; then echo "FAIL $what: has '$cc'"; fail=1; return; fi
  elif ! grep -Eiq "$want" <<<"$cc"; then
    echo "FAIL $what: cache-control '$cc', want /$want/"; fail=1; return
  fi
  echo "ok   $what ($got, ${cc:-no cache-control})"
}

for edition in community cloud; do
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8080" \
    -e WATCHLOG_EDITION="$edition" -e WATCHLOG_BACKEND=127.0.0.1:9 \
    -v "$ROOT/web/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$SRV:/srv:ro" "$IMAGE" >/dev/null
  for _ in $(seq 1 50); do curl -sf -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.1; done
  echo "-- $edition"
  check "hashed asset" /assets/index-AbC123.js 200 'max-age=31536000.*immutable'
  check "missing asset" /assets/index-Gone99.js 404 '!immutable'
  check "index.html" / 200 '^cache-control: no-cache$'
  check "a dashboard route" /nodes 200 '^cache-control: no-cache$'
  check "a root file" /favicon.svg 200 '^cache-control: no-cache$'
  # The install script goes to the backend (unreachable here: 502), never index.html's 200.
  check "the install script, from the backend" /install.sh 502 '!no-cache'
done
exit "$fail"
