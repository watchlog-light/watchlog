#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Phase 1 acceptance #1 (ADR-037): on a fresh Linux host with Docker, `docker compose up`
# (server) + one `docker run` (agent) shows host and container metrics within 60 s.
# Run from a checkout of the repository. Images are built from source until published.
# Then the Docker pages' data (Docker parity): a failing container shows as a problem on
# the overview, its events arrive, hosts report their boot time and disks.
# Optional: PUBLIC_URL (http://<primary IP>:8080), TIMEOUT (60), BACKEND_RUNTIME_IMAGE,
#           GOPROXY (for networks where proxy.golang.org is blocked),
#           KEEP=1 to leave the stack and agent running afterwards.
set -euo pipefail
cd "$(dirname "$0")/../../docker"
TIMEOUT=${TIMEOUT:-60}
ip=$(hostname -I 2>/dev/null | awk '{print $1}')
PUBLIC_URL=${PUBLIC_URL:-http://${ip:-127.0.0.1}:8080}
api=http://127.0.0.1:${WATCHLOG_PORT:-8080}/api/v1
jar=$(mktemp)
log() { echo "[$(date -u +%H:%M:%S)] $*"; }
compose() { docker compose -f compose.yaml -f compose.build.yaml "$@"; }

cleanup() {
  rm -f "$jar"
  if [ "${KEEP:-0}" != 1 ]; then
    docker rm -f watchlog-agent wl-acceptance-fail >/dev/null 2>&1 || true
    docker volume rm watchlog-agent-data watchlog-agent-state >/dev/null 2>&1 || true
    compose down -v >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [ ! -f .env ]; then
  {
    echo "WATCHLOG_DB_PASSWORD=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    echo "WATCHLOG_SECRET_KEY=$(head -c 32 /dev/urandom | base64)"
    echo "WATCHLOG_PUBLIC_URL=$PUBLIC_URL"
    [ -n "${BACKEND_RUNTIME_IMAGE:-}" ] && echo "BACKEND_RUNTIME_IMAGE=$BACKEND_RUNTIME_IMAGE"
  } > .env
fi

log "building images and starting the stack"
compose build --quiet
docker build -q ${GOPROXY:+--build-arg GOPROXY="$GOPROXY"} -t ghcr.io/watchlog-light/agent:latest ../../agent >/dev/null
compose up -d --wait
log "stack is up: $(compose ps --format '{{.Service}}={{.Status}}' | tr '\n' ' ')"

code=$(compose logs backend 2>/dev/null | grep -oE 'setup code [0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}' | tail -1 | awk '{print $3}')
[ -n "$code" ] || { echo "FAIL: no setup code in the backend log"; exit 1; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
curl -fsS -c "$jar" -H 'content-type: application/json' -X POST "$api/setup" \
  -d "{\"code\":\"$code\",\"name\":\"Acceptance\",\"email\":\"admin@example.com\",\"password\":\"acceptance-password\"}" >/dev/null
created=$(curl -fsS -b "$jar" -H 'content-type: application/json' -X POST "$api/clusters" -d '{"name":"fleet","kind":"docker"}')
cid=$(echo "$created" | json "d['cluster']['id']")
install=$(echo "$created" | json "d['install']['dockerRun']")
log "admin created via setup code, fleet $cid; running the install command"

start=$(date +%s)
sh -c "$install" >/dev/null
while true; do
  elapsed=$(( $(date +%s) - start ))
  hosts=$(curl -fsS -b "$jar" "$api/clusters/$cid/docker/hosts" || echo '{"hosts":[]}')
  containers=$(curl -fsS -b "$jar" "$api/clusters/$cid/docker/containers" || echo '{"containers":[]}')
  host_ok=$(echo "$hosts" | json "any(h['cpuUtilization'] is not None and h['memoryUtilization'] is not None for h in d['hosts'])")
  cont_ok=$(echo "$containers" | json "any(c['cpuCores'] is not None and c['memoryBytes'] is not None for c in d['containers'])")
  if [ "$host_ok" = True ] && [ "$cont_ok" = True ]; then
    log "host and container metrics visible after ${elapsed}s"
    echo "$hosts" | json "'  host: ' + ', '.join(f\"{h['name']} cpu={h['cpuUtilization']:.3f} mem={h['memoryUtilization']:.3f} containers={h['containers']}\" for h in d['hosts'])"
    echo "$containers" | json "'  containers: ' + ', '.join(f\"{c['name']}({c['state']})\" for c in d['containers'])"
    if [ "$elapsed" -gt "$TIMEOUT" ]; then echo "FAIL (${elapsed}s > ${TIMEOUT}s)"; exit 1; fi
    echo "PASS (${elapsed}s <= ${TIMEOUT}s)"
    break
  fi
  if [ "$elapsed" -gt $(( TIMEOUT * 3 )) ]; then
    echo "FAIL: no data after ${elapsed}s (host=$host_ok containers=$cont_ok)"
    docker logs watchlog-agent 2>&1 | tail -20 | sed -E 's/wl_ct_[A-Za-z0-9_-]+/<token>/g'
    exit 1
  fi
  sleep 2
done

# Docker parity: a container that keeps failing is a problem on the overview, and its
# events (died) arrive; hosts report their boot time and disks.
docker run -d --name wl-acceptance-fail --restart on-failure busybox:1.37 sh -c 'sleep 2; exit 3' >/dev/null
start=$(date +%s)
while true; do
  elapsed=$(( $(date +%s) - start ))
  overview=$(curl -fsS -b "$jar" "$api/clusters/$cid/overview" || echo '{}')
  events=$(curl -fsS -b "$jar" "$api/clusters/$cid/events?hosts=$(hostname)&kinds=Container" || echo '{"events":[]}')
  hosts=$(curl -fsS -b "$jar" "$api/clusters/$cid/docker/hosts" || echo '{"hosts":[]}')
  problem=$(echo "$overview" | json "any('wl-acceptance-fail' in p['title'] for p in d.get('problems', {}).get('items', []))")
  died=$(echo "$events" | json "any(e['involvedName'] == 'wl-acceptance-fail' and e['reason'] == 'Died' for e in d['events'])")
  boot=$(echo "$hosts" | json "all(h['bootTime'] and h['disks'] for h in d['hosts']) and len(d['hosts']) > 0")
  versions=$(echo "$overview" | json "len(d.get('facts', {}).get('dockerVersions', [])) > 0 and d.get('kind') == 'docker'")
  if [ "$problem" = True ] && [ "$died" = True ] && [ "$boot" = True ] && [ "$versions" = True ]; then
    log "Docker parity data after ${elapsed}s"
    echo "$overview" | json "'  overview: ' + ', '.join(p['title'] for p in d['problems']['items']) + ' · Docker ' + ', '.join(d['facts']['dockerVersions'])"
    echo "$events" | json "'  events: ' + ', '.join(sorted({e['involvedName'] + ' ' + e['reason'] for e in d['events']}))"
    echo "PASS (Docker parity)"
    exit 0
  fi
  if [ "$elapsed" -gt $(( TIMEOUT * 3 )) ]; then
    echo "FAIL: Docker parity after ${elapsed}s (problem=$problem died=$died boot=$boot versions=$versions)"
    exit 1
  fi
  sleep 3
done
