#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# The server install on a test VM (ADR-209), every step bounded (servers.sh up <distro> first):
# the script installs, the units run as watchlog with only the measured capabilities, the
# installed agent sees services, process groups, a real crash's exit code and a real OOM kill
# from eBPF, --upgrade keeps the configuration, --uninstall leaves nothing; then the deb or
# rpm is installed with the token in the environment, removed and purged. Root inside the
# VM only (the owner's exception: testing the installer and packages).
#   deploy/test/servers/install-test.sh <distro>
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
distro=${1:?distro}
vm="wl-srv-$distro"
bounded() { local s=$1; shift; perl -e 'alarm shift; exec @ARGV or die "exec: $!"' "$s" "$@"; }
in_vm() { bounded "${BOUND:-300}" limactl shell "$vm" sudo bash -c "$*"; }
fails=0
check() { # name, got, want ("~text" = contains)
  local ok=no
  if [[ "$3" == ~* ]]; then [[ "$2" == *"${3#\~}"* ]] && ok=yes; else [ "$2" = "$3" ] && ok=yes; fi
  if [ $ok = yes ]; then echo "PASS  $1"; else echo "FAIL  $1 — got: $(head -c 300 <<<"$2") / want: $3"; fails=$((fails + 1)); fi
}

arch=$(limactl list --format '{{.Arch}}' "$vm")
case "$arch" in aarch64) arch=arm64 ;; x86_64) arch=amd64 ;; esac
dist=$(mktemp -d)
echo "== building the assets for $arch"
GOPROXY=${GOPROXY:-'https://proxy.golang.org|https://goproxy.io,direct'} \
  bounded 290 "$root/deploy/linux/build.sh" 0.9.0-test "$dist" "$arch" >/dev/null || { echo "build failed"; exit 1; }
limactl shell "$vm" bash -c 'rm -rf ~/wl-dist && mkdir -p ~/wl-dist'
for f in "$dist"/*; do limactl copy "$f" "$vm:wl-dist/"; done
rm -rf "$dist"
home=$(limactl shell "$vm" bash -c 'echo $HOME')

echo "== the script"
in_vm "bash $home/wl-dist/install.sh --uninstall >/dev/null 2>&1; WATCHLOG_INSTALL_FROM=$home/wl-dist sh $home/wl-dist/install.sh --token wl_ct_testtokentesttoken --url http://127.0.0.1:9 --hostname test-server" >/tmp/wl-install.out 2>&1
out=$(cat /tmp/wl-install.out)
check "install: checksum verified" "$out" "~Checksum verified."
check "install: both units running" "$(in_vm 'systemctl is-active watchlog-agent watchlog-integrations | paste -sd" " -')" "active active"
pid=$(in_vm 'systemctl show -p MainPID --value watchlog-agent')
check "the agent runs as watchlog, not root" "$(in_vm "ps -o user= -p $pid")" "watchlog"
caps=$(in_vm "grep CapEff /proc/$pid/status | awk '{print \$2}'")
# CAP_DAC_READ_SEARCH 2, CAP_SYS_PTRACE 19, CAP_SYS_RESOURCE 24, CAP_PERFMON 38, CAP_BPF 39
check "the agent has exactly the measured capabilities" "$caps" "000000c001080004"
ipid=$(in_vm 'systemctl show -p MainPID --value watchlog-integrations')
check "the integrations collector has none" "$(in_vm "grep CapEff /proc/$ipid/status | awk '{print \$2}'")" "0000000000000000"
check "the token file is 0640 root:watchlog" "$(in_vm 'stat -c "%a %U:%G" /etc/watchlog/agent.env')" "640 root:watchlog"
check "the token isn't in the install's output" "$(grep -c testtokentesttoken /tmp/wl-install.out)" "0"
sleep 3
journal=$(in_vm 'journalctl -u watchlog-agent --no-pager -n 60')
check "eBPF exits loaded (no 'exits from eBPF are off')" "$(grep -c 'exits from eBPF are off' <<<"$journal")" "0"
check "systemd reachable (no 'services are off')" "$(grep -c 'services are off' <<<"$journal")" "0"

echo "== what the installed agent sees, with a real crash and a real OOM kill"
# A process started by hand doesn't survive the VM's reboot: start the jar again.
in_vm 'pgrep -x java >/dev/null || su - app -c "nohup java -jar /opt/wl-apps/billing.jar >/tmp/billing.log 2>&1 &"; sleep 2' >/dev/null
caps_list="CAP_BPF CAP_PERFMON CAP_SYS_PTRACE CAP_DAC_READ_SEARCH CAP_SYS_RESOURCE"
BOUND=120 in_vm "rm -f /tmp/once.txt; (systemd-run --quiet --wait --pipe --uid=watchlog --gid=watchlog -p 'AmbientCapabilities=$caps_list' -p NoNewPrivileges=yes \
    /usr/bin/watchlog-agent --mode=server --once --once-wait=20s --host-proc=/proc --host-sys=/sys --host-root=/ >/tmp/once.txt 2>/tmp/once.err &) ; sleep 6;
  curl -s -m 2 localhost:8091/crash >/dev/null; sleep 4; curl -s -m 15 localhost:8091/grow >/dev/null; sleep 18; true"
once=$(in_vm 'cat /tmp/once.txt')
check "services: orders.service is listed" "$(grep -c 'watchlog_service_state{unit="orders.service"' <<<"$once")" "1"
check "services: orders' crash, exit 3, counted from eBPF" "$(grep 'watchlog_service_exits_total{unit="orders.service",exit="error"' <<<"$once" | awk '{print $2}')" "1"
check "services: orders' OOM kill counted from eBPF" "$(grep 'watchlog_service_oom_kills_total{unit="orders.service"' <<<"$once" | awk '{print $2}')" "1"
check "process groups: pm2's api and mailer, by pm2's pid files" "$(grep -cE 'watchlog_process_group_instances\{group="(api|mailer)",unit="pm2-' <<<"$once")" "2"
check "process groups: PHP-FPM's pool www" "$(grep -c 'watchlog_process_group_instances{group="pool www"' <<<"$once")" "1"
check "process groups: the jar started by hand" "$(grep -c 'watchlog_process_group_instances{group="billing.jar",unit=""' <<<"$once")" "1"
check "listening ports: nginx on 80" "$(grep -c 'watchlog_listen_info{source="service",workload="nginx.service",proto="tcp",port="80"' <<<"$once")" "1"
check "no command line or pid in any label" "$(grep -cE '/opt/wl-apps|--workers|pid=' <<<"$once")" "0"
echo "   series in all: $(grep -c '^watchlog_' <<<"$once"), services: $(grep -c '^watchlog_service_' <<<"$once"), process groups: $(grep -c '^watchlog_process_group_' <<<"$once")"

echo "== upgrade and uninstall"
in_vm "WATCHLOG_INSTALL_FROM=$home/wl-dist sh $home/wl-dist/install.sh --upgrade" >/tmp/wl-upgrade.out 2>&1
check "upgrade: the configuration kept" "$(in_vm 'grep -c testtokentesttoken /etc/watchlog/agent.env')" "1"
check "upgrade: running again" "$(in_vm 'systemctl is-active watchlog-agent')" "active"
in_vm "sh $home/wl-dist/install.sh --uninstall" >/dev/null 2>&1
check "uninstall: nothing left" "$(in_vm 'ls /usr/bin/watchlog-* /etc/watchlog /etc/systemd/system/watchlog-* 2>/dev/null | wc -l; id watchlog >/dev/null 2>&1 && echo user-left')" "0"

echo "== the package"
if in_vm 'command -v dpkg >/dev/null'; then
  pkg=$(in_vm "ls $home/wl-dist/*.deb | head -1")
  in_vm "WATCHLOG_TOKEN=wl_ct_testtokentesttoken WATCHLOG_URL=http://127.0.0.1:9 apt-get install -y -qq $pkg" >/dev/null 2>&1
  check "deb: installed and running" "$(in_vm 'systemctl is-active watchlog-agent watchlog-integrations | paste -sd" " -')" "active active"
  in_vm 'apt-get remove -y -qq watchlog-agent' >/dev/null 2>&1
  check "deb remove: stopped, configuration kept" "$(in_vm 'systemctl is-active watchlog-agent; test -f /etc/watchlog/agent.env && echo kept')" "$(printf 'inactive\nkept')"
  in_vm 'apt-get purge -y -qq watchlog-agent' >/dev/null 2>&1
else
  pkg=$(in_vm "ls $home/wl-dist/*.rpm | head -1")
  in_vm "WATCHLOG_TOKEN=wl_ct_testtokentesttoken WATCHLOG_URL=http://127.0.0.1:9 dnf install -y -q $pkg" >/dev/null 2>&1
  check "rpm: installed and running" "$(in_vm 'systemctl is-active watchlog-agent watchlog-integrations | paste -sd" " -')" "active active"
  in_vm 'dnf remove -y -q watchlog-agent' >/dev/null 2>&1
fi
check "package removed: nothing left" "$(in_vm 'ls /usr/bin/watchlog-* /etc/watchlog 2>/dev/null | wc -l; id watchlog >/dev/null 2>&1 && echo user-left')" "0"

echo "$fails check(s) failed"
exit "$fails"
