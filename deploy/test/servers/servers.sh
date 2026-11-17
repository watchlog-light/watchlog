#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Servers test VMs (ADR-207 to ADR-210), one distro at a time, every step bounded:
#   servers.sh up <distro>        create and start wl-srv-<distro> (Lima template ubuntu-24.04,
#                                 debian-12, rocky-9, rocky-8 …), install the test stacks (root
#                                 inside the VM only), print the VM's name
#   servers.sh measure <distro> [crash|oom]   run measure.sh there; prints its output
#   servers.sh shell <distro> <command…>      a command in the VM as root (tests)
#   servers.sh stop <distro>      stop the VM;  servers.sh delete <distro>  delete it
# Needs limactl, Go and a JDK (javac, jar) on this machine.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
vm() { echo "wl-srv-${1:?distro}"; }
# A command that may not take longer than $1 seconds (macOS has no timeout(1)).
bounded() { local s=$1; shift; perl -e 'alarm shift; exec @ARGV or die "exec: $!"' "$s" "$@"; }
in_vm() { local name=$1; shift; bounded "${BOUND:-600}" limactl shell "$name" sudo bash -c "$*"; }

build_apps() {
  local out=$1 arch
  arch=$(limactl list --format '{{.Arch}}' "$2" 2>/dev/null || echo aarch64)
  case "$arch" in aarch64 | arm64) arch=arm64 ;; *) arch=amd64 ;; esac
  mkdir -p "$out"
  cp "$here"/apps/*.js "$here"/apps/*.py "$out/"
  (cd "$here/apps" && CGO_ENABLED=0 GOOS=linux GOARCH=$arch go build -trimpath -o "$out/orders" orders.go)
  local j
  j=$(mktemp -d)
  javac -d "$j" --release 11 "$here/apps/Billing.java"
  (cd "$j" && printf 'Main-Class: Billing\n' >m && jar cfm "$out/billing.jar" m Billing.class)
  rm -rf "$j"
}

cmd=${1:?up|measure|shell|stop|delete}
distro=${2:?distro}
name=$(vm "$distro")
case "$cmd" in
up)
  if ! limactl list -q | grep -qx "$name"; then
    # The distro's own template: 4 CPUs, 4 GiB, 20 GiB, no mounts, no ports forwarded.
    bounded 600 limactl create --tty=false --name="$name" "template:$distro" \
      --set '.cpus=4 | .memory="4GiB" | .disk="20GiB" | .mounts=[] | .containerd.system=false | .containerd.user=false | .portForwards=[{"guestIP":"0.0.0.0","guestPortRange":[1,65535],"ignore":true},{"guestIP":"127.0.0.1","guestPortRange":[1,65535],"ignore":true}]' >/dev/null
  fi
  [ "$(limactl list --format '{{.Status}}' "$name")" = Running ] || bounded 600 limactl start --tty=false "$name" >/dev/null
  apps=$(mktemp -d)
  build_apps "$apps" "$name"
  limactl shell "$name" bash -c 'rm -rf ~/wl-apps ~/wl-servers && mkdir -p ~/wl-apps ~/wl-servers'
  for f in "$apps"/*; do limactl copy "$f" "$name:wl-apps/"; done
  for f in "$here"/stacks.sh "$here"/measure.sh; do limactl copy "$f" "$name:wl-servers/"; done
  rm -rf "$apps"
  in_vm "$name" 'install -d -m 755 /opt/wl-apps && cp ~'"$(limactl shell "$name" whoami)"'/wl-apps/* /opt/wl-apps/ && chmod +x /opt/wl-apps/orders && bash ~'"$(limactl shell "$name" whoami)"'/wl-servers/stacks.sh'
  echo "$name"
  ;;
measure)
  BOUND=300 in_vm "$name" "bash ~$(limactl shell "$name" whoami)/wl-servers/measure.sh ${3:-}"
  ;;
shell)
  shift 2
  in_vm "$name" "$*"
  ;;
stop) bounded 300 limactl stop "$name" >/dev/null ;;
delete) bounded 300 limactl delete -f "$name" >/dev/null ;;
*) echo "unknown command $cmd" >&2; exit 2 ;;
esac
