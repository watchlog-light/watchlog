#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Prints the Go build tags for the integrations collector (ADR-232): `ee` when ee/collector is
# there, after writing the go.work that joins it to agent/ (go.work is ignored by git); nothing
# without ee/, so `go build` is the core's alone.
#   tags=$(scripts/ee-go.sh) && (cd agent && go build -tags "$tags" ./cmd/watchlog-integrations)
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f ee/collector/go.mod ]; then
  exit 0
fi
if [ ! -f go.work ]; then
  go work init ./agent ./ee/collector >&2
fi
echo ee
