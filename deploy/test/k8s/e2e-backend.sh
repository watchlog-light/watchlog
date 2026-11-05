#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Starts a throwaway backend for Kubernetes e2e runs: database watchlog_e2e on the
# dev infrastructure (pnpm infra:up), port 4091, admin from env. Creates a cluster
# and writes CLUSTER_ID, TOKEN and ENDPOINT to $E2E_DIR/e2e.env. E2E_VM_URL overrides
# the VictoriaMetrics URL (default: the dev infrastructure on :8428).
#   e2e-backend.sh start | stop
# Until the Kubernetes install flow exists (Phase 2 slice 5) the cluster is created
# as a Docker fleet through the API and switched to kind 'kubernetes' in SQL.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$here/../../..
dir=${E2E_DIR:-${TMPDIR:-/tmp}/watchlog-e2e}
port=${E2E_PORT:-4091}
db=watchlog_e2e
psql() { docker exec watchlog-dev-postgres-1 psql -U watchlog -d "$1" -qtA -c "$2"; }
mkdir -p "$dir"

if [ "${1:-start}" = stop ]; then
  [ -f "$dir/backend.pid" ] && kill "$(cat "$dir/backend.pid")" 2>/dev/null || true
  rm -f "$dir/backend.pid"
  exit 0
fi

psql watchlog "DROP DATABASE IF EXISTS $db WITH (FORCE)" >/dev/null
psql watchlog "CREATE DATABASE $db" >/dev/null
export DATABASE_URL=postgres://watchlog:watchlog@127.0.0.1:54320/$db VICTORIAMETRICS_URL=${E2E_VM_URL:-http://127.0.0.1:8428}
export PORT=$port WATCHLOG_ADMIN_EMAIL=e2e@example.com WATCHLOG_ADMIN_PASSWORD=e2e-password-1234
export WATCHLOG_SECRET_KEY=${WATCHLOG_SECRET_KEY:-$(head -c 32 /dev/urandom | base64)}
cd "$root/backend"
npx tsx src/migrate.ts >/dev/null
nohup npx tsx src/server.ts >"$dir/backend.log" 2>&1 &
echo $! >"$dir/backend.pid"
api=http://127.0.0.1:$port/api/v1
for _ in $(seq 60); do curl -fs -o /dev/null "$api/health" && break; sleep 1; done
curl -fs -c "$dir/cookies" -H 'content-type: application/json' -X POST "$api/auth/login" \
  -d "{\"email\":\"$WATCHLOG_ADMIN_EMAIL\",\"password\":\"$WATCHLOG_ADMIN_PASSWORD\"}" >/dev/null
created=$(curl -fs -b "$dir/cookies" -H 'content-type: application/json' -X POST "$api/clusters" -d '{"name":"kind","kind":"docker"}')
id=$(echo "$created" | python3 -c 'import json,sys; print(json.load(sys.stdin)["cluster"]["id"])')
token=$(echo "$created" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"]["value"])')
psql "$db" "UPDATE clusters SET kind = 'kubernetes' WHERE id = '$id'" >/dev/null
printf 'CLUSTER_ID=%s\nTOKEN=%s\nENDPOINT=http://127.0.0.1:%s\n' "$id" "$token" "$port" >"$dir/e2e.env"
echo "e2e backend on :$port, cluster $id (env in $dir/e2e.env)"
