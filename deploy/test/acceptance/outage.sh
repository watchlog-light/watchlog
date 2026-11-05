#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Phase 1 acceptance #3: killing the backend for 5 minutes loses no data (ADR-037).
# The agent must already be running. Required environment:
#   STOP_CMD   command that stops the backend      (e.g. "docker compose stop backend")
#   START_CMD  command that starts it again        (e.g. "docker compose start backend")
#   MATCH      series selector for this agent      (e.g. 'watchlog_node_load1{cluster_id="…",host="…"}')
# Optional: VM_URL (http://127.0.0.1:8428), WARMUP (120), OUTAGE (300), RECOVERY (180), INTERVAL (15),
#           VM_NETWORK (watchlog_default; used when Node.js is not installed on the host)
set -euo pipefail
: "${STOP_CMD:?}" "${START_CMD:?}" "${MATCH:?}"
VM_URL=${VM_URL:-http://127.0.0.1:8428}
WARMUP=${WARMUP:-120} OUTAGE=${OUTAGE:-300} RECOVERY=${RECOVERY:-180} INTERVAL=${INTERVAL:-15}
here=$(cd "$(dirname "$0")" && pwd)

log() { echo "[$(date -u +%H:%M:%S)] $*"; }
start=$(date +%s)
log "warm-up ${WARMUP}s"
sleep "$WARMUP"
log "stopping the backend for ${OUTAGE}s"
outage_start=$(date +%s)
eval "$STOP_CMD"
sleep "$OUTAGE"
log "starting the backend"
eval "$START_CMD"
outage_end=$(date +%s)
log "recovery ${RECOVERY}s (agent replays its buffer at <= 1 req/s)"
sleep "$RECOVERY"
end=$(( $(date +%s) - 2 * INTERVAL ))
log "outage window $(date -u -r "$outage_start" +%H:%M:%S 2>/dev/null || date -u -d "@$outage_start" +%H:%M:%S)–$(date -u -r "$outage_end" +%H:%M:%S 2>/dev/null || date -u -d "@$outage_end" +%H:%M:%S) UTC; checking ${start}…${end}"
max_gap=$(awk -v i="$INTERVAL" 'BEGIN { print i * 1.5 }')
if command -v node >/dev/null; then
  node "$here/check-gaps.mjs" --vm "$VM_URL" --match "$MATCH" --from "$start" --to "$end" --max-gap "$max_gap"
else
  # No Node.js on the host: run the checker in a container on the stack's network.
  docker run --rm --network "${VM_NETWORK:-watchlog_default}" -v "$here:/acceptance:ro" node:24-alpine \
    node /acceptance/check-gaps.mjs --vm "$VM_URL" --match "$MATCH" --from "$start" --to "$end" --max-gap "$max_gap"
fi
