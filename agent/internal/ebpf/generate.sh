#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Regenerates the eBPF objects and their Go bindings in the pinned builder (ADR-100).
# Usage: agent/internal/ebpf/generate.sh   (needs Docker; GOPROXY is passed through)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
agent=$(cd "$here/../.." && pwd)
image=watchlog-bpf-builder:1
docker build -q -t "$image" "$here/builder" >/dev/null
docker run --rm -v "$agent:/src" -w /src/internal/ebpf \
  -e GOPROXY="${GOPROXY:-https://proxy.golang.org,direct}" -e GOFLAGS=-mod=mod \
  -e HOME=/tmp -u "$(id -u):$(id -g)" \
  "$image" go generate ./...
