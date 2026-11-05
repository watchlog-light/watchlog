#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Phase 1 acceptance #2: agent ≤ 64 MB RSS with 30 containers (ADR-037).
# Run on the Docker host where the agent container (watchlog-agent) is running.
# Starts exactly 30 labelled test containers, samples the agent's VmRSS every 5 s,
# and removes only the containers it created.
# Optional: DURATION (600), LIMIT_MB (64), AGENT (watchlog-agent)
set -euo pipefail
DURATION=${DURATION:-600} LIMIT_MB=${LIMIT_MB:-64} AGENT=${AGENT:-watchlog-agent}
LABEL=watchlog.test=rss
project=wlrss

cleanup() {
  docker compose -p "$project" -f - down --remove-orphans >/dev/null 2>&1 <<<"$COMPOSE" || true
  docker ps -aq --filter "label=$LABEL" | xargs -r docker rm -f >/dev/null
}
COMPOSE=$(cat <<'YAML'
services:
  web:
    image: nginx:1.29-alpine
    labels: [watchlog.test=rss]
  cache:
    image: redis:7-alpine
    labels: [watchlog.test=rss]
    mem_limit: 64m
  writer:
    image: busybox:1.37
    labels: [watchlog.test=rss]
    command: ["sh", "-c", "while true; do dd if=/dev/zero of=/tmp/x bs=1M count=8 2>/dev/null; sleep 5; done"]
YAML
)
trap cleanup EXIT

run() { docker run -d --label "$LABEL" "$@" >/dev/null; }
for i in $(seq 1 20); do run --name "rss-idle-$i" busybox:1.37 sleep 86400; done
for i in $(seq 1 4); do run --name "rss-healthy-$i" --health-cmd true --health-interval 5s busybox:1.37 sleep 86400; done
for i in $(seq 1 2); do run --name "rss-unhealthy-$i" --health-cmd false --health-interval 5s busybox:1.37 sleep 86400; done
run --name rss-crashloop --restart always busybox:1.37 sh -c "sleep 3; exit 1"
docker compose -p "$project" -f - up -d --quiet-pull >/dev/null 2>&1 <<<"$COMPOSE"
total=$(docker ps -aq --filter "label=$LABEL" | wc -l | tr -d ' ')
echo "test containers: $total (plus the agent and anything else already running)"

pid=$(docker inspect -f '{{.State.Pid}}' "$AGENT")
samples=()
end=$(( $(date +%s) + DURATION ))
while [ "$(date +%s)" -lt "$end" ]; do
  pid=$(docker inspect -f '{{.State.Pid}}' "$AGENT")
  kb=$(awk '/^VmRSS:/ {print $2}' "/proc/$pid/status" 2>/dev/null || echo 0)
  samples+=("$kb")
  sleep 5
done
restarts=$(docker inspect -f '{{.RestartCount}}' "$AGENT")
printf '%s\n' "${samples[@]}" | sort -n | awk -v limit="$LIMIT_MB" -v restarts="$restarts" '
  { v[NR] = $1 }
  END {
    p50 = v[int((NR + 1) / 2)] / 1024; max = v[NR] / 1024
    printf "agent RSS over %d samples: p50 %.1f MB, max %.1f MB (limit %d MB), agent restarts %d\n", NR, p50, max, limit, restarts
    if (max > limit || restarts > 0) { print "FAIL"; exit 1 }
    print "PASS"
  }'
