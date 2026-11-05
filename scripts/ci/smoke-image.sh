#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Reports the size of a locally loaded image and smoke-tests it.
# Usage: scripts/ci/smoke-image.sh <agent|cluster-agent|backend|web> <image-ref>
# SMOKE_PORT sets the backend's host port (default 14080).
set -euo pipefail
name="$1"
image="$2"

size=$(docker image inspect "$image" --format '{{.Size}}')
size_mb=$(awk -v b="$size" 'BEGIN { printf "%.1f", b / 1000000 }')
echo "image size: $image = ${size_mb} MB ($size bytes)"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo "| \`$name\` | \`$image\` (linux/amd64) | ${size_mb} MB |" >>"$GITHUB_STEP_SUMMARY"
fi

wait_http() {
  local url="$1"
  for _ in $(seq 1 30); do
    if curl -fs -o /dev/null "$url"; then return 0; fi
    sleep 1
  done
  echo "timed out waiting for $url"
  return 1
}

case "$name" in
  agent | cluster-agent)
    # The 40 MB budget is checked per platform by image-budget.sh.
    docker run --rm "$image" --version
    ;;
  backend)
    # PostgreSQL for the backend, the one-shot migration, a native-module check, then the API.
    port="${SMOKE_PORT:-14080}"
    db_url="postgres://watchlog:watchlog@smoke-postgres:5432/watchlog"
    docker network create smoke-net >/dev/null
    trap 'docker logs smoke-backend 2>/dev/null; docker rm -f smoke-backend smoke-postgres >/dev/null 2>&1; docker network rm smoke-net >/dev/null' EXIT
    docker run -d --name smoke-postgres --network smoke-net -e POSTGRES_USER=watchlog \
      -e POSTGRES_PASSWORD=watchlog -e POSTGRES_DB=watchlog postgres:16-alpine >/dev/null
    for _ in $(seq 1 30); do
      if docker exec smoke-postgres pg_isready -U watchlog -d watchlog >/dev/null 2>&1; then break; fi
      sleep 1
    done
    docker run --rm --network smoke-net -e DATABASE_URL="$db_url" "$image" dist/migrate.js
    docker run --rm "$image" --input-type=module -e "$(cat "$(dirname "$0")/native-check.mjs")"
    # ADR-079: without a secret key the backend refuses to start and says why.
    no_key=$(docker run --rm --network smoke-net -e DATABASE_URL="$db_url" "$image" 2>&1 || true)
    grep -q 'WATCHLOG_SECRET_KEY is not set' <<<"$no_key" || { echo "backend started without a secret key: $no_key"; exit 1; }
    docker run -d --name smoke-backend --network smoke-net -p "$port:4080" \
      -e DATABASE_URL="$db_url" -e WATCHLOG_SECRET_KEY="$(head -c 32 /dev/urandom | base64)" "$image" >/dev/null
    wait_http "http://127.0.0.1:$port/api/v1/health"
    curl -fsS "http://127.0.0.1:$port/api/v1/health"
    echo
    test "$(curl -fsS "http://127.0.0.1:$port/api/v1/setup")" = '{"required":true}'
    # Capture first: `docker logs | grep -q` fails under pipefail when grep exits early (SIGPIPE).
    backend_logs=$(docker logs smoke-backend 2>&1)
    grep -q 'setup code' <<<"$backend_logs" || { echo "setup code not logged"; exit 1; }
    test "$(docker inspect smoke-backend --format '{{.Config.User}}')" = "65532:65532"
    echo "backend migrates, loads native modules, serves the API and asks for first-run setup"
    ;;
  web)
    docker run -d --name smoke-web -p 8080:8080 "$image" >/dev/null
    trap 'docker logs smoke-web; docker rm -f smoke-web >/dev/null' EXIT
    wait_http http://127.0.0.1:8080/
    wait_http http://127.0.0.1:8080/service-map
    wait_http http://127.0.0.1:8080/site.webmanifest
    echo "web serves /, client routes and the manifest"
    ;;
  *)
    echo "unknown image name: $name"
    exit 2
    ;;
esac
