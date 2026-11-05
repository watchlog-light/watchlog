#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Creates the kind test cluster (ADR-063) unless it exists, and waits for its nodes.
set -euo pipefail
cd "$(dirname "$0")"
if ! kind get clusters 2>/dev/null | grep -qx watchlog; then
  kind create cluster --config kind.yaml --wait 120s
fi
kubectl --context kind-watchlog wait --for=condition=Ready node --all --timeout=120s
