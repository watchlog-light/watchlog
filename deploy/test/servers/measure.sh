#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# What the server agent will see on this machine (Servers slice 1, ADR-208 to ADR-210), as
# root inside a throwaway test VM. Prints facts only; command lines are the test stacks'
# own and stay in the VM's output.
#   measure.sh [crash|oom]   also make orders crash (exit 3) or hit its MemoryMax
set -uo pipefail
say() { printf '\n## %s\n' "$*"; }

say "system"
. /etc/os-release
echo "os: $PRETTY_NAME"
echo "kernel: $(uname -r) $(uname -m)"
echo "systemd: $(systemctl --version | head -1)"
echo "cgroup: $(stat -fc %T /sys/fs/cgroup) ($( [ -f /sys/fs/cgroup/cgroup.controllers ] && echo v2 || echo v1/hybrid))"
echo "btf: $( [ -r /sys/kernel/btf/vmlinux ] && echo yes || echo no)"
echo "docker: $(docker version --format '{{.Server.Version}} {{.Server.Os}}' 2>/dev/null || echo none)"
echo "docker socket: $(ls -l /var/run/docker.sock 2>/dev/null | awk '{print $1, $3, $4, $NF}')"

say "services (loaded, not inactive)"
systemctl list-units --type=service --all --no-legend --plain | awk '$3 != "inactive" {print $1, $3, $4}' | tee /tmp/units.txt | head -80
echo "count: $(wc -l </tmp/units.txt) (running: $(grep -c ' running' /tmp/units.txt), failed: $(grep -c ' failed' /tmp/units.txt))"

say "the test stacks: unit, cgroup, process tree (pid ppid comm, args shortened)"
for pat in nginx php-fpm 'PM2' 'api.js' supervisord worker.py gunicorn billing.jar postgres mariadbd redis-server orders; do
  pids=$(pgrep -f -- "$pat" | head -6)
  [ -z "$pids" ] && { echo "-- $pat: none"; continue; }
  echo "-- $pat"
  for p in $pids; do
    cg=$(awk -F: '$1=="0" || $2 ~ /pids|memory/ {print $3; exit}' /proc/$p/cgroup 2>/dev/null)
    printf '   %s %s %-16s %s | cgroup %s\n' "$p" "$(awk '{print $4}' /proc/$p/stat)" "$(cat /proc/$p/comm)" \
      "$(tr '\0' ' ' </proc/$p/cmdline | cut -c1-70)" "$cg"
  done
done

say "pm2's pid files (the app names without reading environments)"
ls -l /home/*/.pm2/pids/ /root/.pm2/pids/ 2>/dev/null

say "supervisord's programs (from its configuration)"
grep -h '^\[program:' /etc/supervisor/conf.d/*.conf /etc/supervisord.d/*.ini 2>/dev/null

say "unit properties (D-Bus via systemctl show)"
for u in orders.service shop.service nginx.service; do
  systemctl show "$u" -p ActiveState -p SubState -p NRestarts -p ExecMainCode -p ExecMainStatus \
    -p MemoryMax -p CPUQuotaPerSecUSec -p ControlGroup --no-pager | paste -sd' ' -
done

case "${1:-}" in
crash)
  say "crash: orders exits 3"
  curl -s -m 2 localhost:8091/crash >/dev/null; sleep 3
  systemctl show orders.service -p NRestarts -p ExecMainCode -p ExecMainStatus -p ActiveState | paste -sd' ' -
  ;;
oom)
  say "oom: orders grows past MemoryMax=200M"
  cg=$(systemctl show orders.service -p ControlGroup --value)
  curl -s -m 10 localhost:8091/grow >/dev/null; sleep 3
  cat /sys/fs/cgroup$cg/memory.events 2>/dev/null || cat /sys/fs/cgroup/memory$cg/memory.oom_control 2>/dev/null
  journalctl -k --since -1min --no-pager | grep -iE 'oom|killed process' | tail -3
  systemctl show orders.service -p NRestarts -p ExecMainCode -p ExecMainStatus -p Result | paste -sd' ' -
  ;;
esac

say "counts"
echo "processes: $(ls -d /proc/[0-9]* | wc -l), user-space: $(ps -e -o pid=,ppid= | awk '$2 != 2 && $1 != 2' | wc -l)"
echo "distinct executables: $(for p in /proc/[0-9]*; do readlink $p/exe 2>/dev/null; done | sort -u | wc -l)"
