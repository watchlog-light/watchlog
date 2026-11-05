#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Fails when an agent image's filesystem exceeds the 40 MB budget (SPEC §6.1) on any
# platform, and reports the headroom. The input is the image exported with
# `--output type=tar` (one directory per platform for a multi-platform build): the
# uncompressed size of what runs, the same on every Docker setup. Docker's own
# `.Size` differs between image stores (the containerd store adds the compressed blobs).
# Usage: scripts/ci/image-budget.sh <agent|cluster-agent> <exported.tar>
set -euo pipefail
name="$1"
tar="$2"
budget=$((40 * 1000 * 1000))

# Regular files' sizes, by platform directory ("linux_amd64/...") or "single".
sizes=$(tar -tvf "$tar" | awk '
  substr($1, 1, 1) == "-" {
    path = $NF
    platform = (path ~ /^(\.\/)?linux_[a-z0-9]+\//) ? path : "single"
    sub(/^\.\//, "", platform); sub(/\/.*/, "", platform)
    total[platform] += $3
  }
  END { for (p in total) print p, total[p] }' | sort)

fail=0
while read -r platform bytes; do
  mb=$(awk -v b="$bytes" 'BEGIN { printf "%.1f", b / 1e6 }')
  headroom=$(awk -v b="$bytes" -v m="$budget" 'BEGIN { printf "%.1f", (m - b) / 1e6 }')
  echo "$name $platform: $mb MB of 40 MB ($headroom MB headroom)"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "| \`$name\` | $platform | $mb MB | $headroom MB |" >>"$GITHUB_STEP_SUMMARY"
  fi
  if [ "$bytes" -gt "$budget" ]; then
    echo "$name image on $platform exceeds the 40 MB budget"
    fail=1
  fi
done <<<"$sizes"
[ -n "$sizes" ] || { echo "no files in $tar"; exit 1; }
exit "$fail"
