#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Run as root on a Kubernetes node: writes a tar of the kubepods cgroup tree to
# stdout, keeping only the files the agent's container collector reads, plus the
# cgroup mount lines and /proc/<pid>/comm of each container cgroup's first process
# (tells pod sandboxes, "pause", from containers). Used for agent fixtures (ADR-050).
set -eu
out=$(mktemp -d)
root=/sys/fs/cgroup
copy() {
  [ -r "$1" ] || return 0
  mkdir -p "$out$(dirname "$1")"
  cat "$1" >"$out$1" 2>/dev/null || rm -f "$out$1"
}
if [ -f "$root/cgroup.controllers" ]; then
  copy "$root/cgroup.controllers"
  find "$root/" -type d -path '*kubepods*' | while read -r d; do
    for f in cpu.stat cpu.max memory.current memory.stat memory.max io.stat cgroup.procs; do copy "$d/$f"; done
    pid=$(head -n1 "$d/cgroup.procs" 2>/dev/null || true)
    if [ -n "$pid" ]; then copy "/proc/$pid/comm"; fi
  done
else
  for c in cpu cpuacct memory blkio; do
    find "$root/$c/" -type d -path '*kubepods*' | while read -r d; do
      for f in cpu.stat cpu.cfs_quota_us cpu.cfs_period_us cpuacct.usage memory.usage_in_bytes \
        memory.stat memory.limit_in_bytes blkio.throttle.io_service_bytes cgroup.procs; do copy "$d/$f"; done
      pid=$(head -n1 "$d/cgroup.procs" 2>/dev/null || true)
      if [ -n "$pid" ]; then copy "/proc/$pid/comm"; fi
    done
  done
fi
grep cgroup /proc/self/mountinfo >"$out/mountinfo-cgroup.txt" || true
tar -C "$out" -cf - .
rm -rf "$out"
