#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# The MCP server end to end with real clients (v0.2 slice 6, ADR-127): the SDK client in
# both protocol generations, Claude Desktop's path (`npx mcp-remote` over stdio), Claude
# Code (`claude -p`) and Cursor when its CLI is installed, against a kind cluster and a
# Docker host. The checks are in backend/scripts/mcp-e2e.ts.
#
# Needs WatchLog running with both reporting: `pnpm dev` and deploy/test/demo-up.sh.
#   WATCHLOG_URL           the backend (default http://localhost:4080)
#   WATCHLOG_E2E_EMAIL and WATCHLOG_E2E_PASSWORD, or WATCHLOG_E2E_COOKIE: an account
#   WATCHLOG_E2E_KUBE / WATCHLOG_E2E_DOCKER   cluster names (default: the reporting ones)
#   VM                     the demo's Lima VM (default watchlog-demo): its fx-oom and
#                          fx-exited containers are run again first, so their OOM kill
#                          and exit are recent (problems fade after a while)
#   CLAUDE=0               skip Claude Code (it runs on your Claude account)
#   WATCHLOG_E2E_OUT       where the Claude Code transcripts go (default: a temp folder)
set -euo pipefail
cd "$(dirname "$0")/../../.."
vm=${VM:-watchlog-demo}

if command -v limactl >/dev/null && [ "$(limactl list --format '{{.Status}}' "$vm" 2>/dev/null)" = Running ]; then
  echo "== fresh OOM kill and exit on the Docker host ($vm)"
  limactl shell "$vm" bash -c 'docker start fx-oom fx-exited >/dev/null 2>&1 || docker restart fx-oom fx-exited >/dev/null'
  # The containers die within seconds; the agent's next inventory reports them.
  sleep 45
fi

echo "== MCP clients"
exec pnpm -C backend -s exec tsx scripts/mcp-e2e.ts
