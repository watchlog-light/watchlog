#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Removes the demo environment of demo-up.sh from its Lima VM: the kind cluster "demo",
# the Docker agent and its state volume, the fx-* containers and the Compose app.
# The VM stays (it may hold other test clusters); --vm deletes the VM as well.
#   VM=watchlog-demo   the Lima VM's name
# Commands in single quotes run in the VM and expand there.
# shellcheck disable=SC2016
set -euo pipefail
vm=${VM:-watchlog-demo}
if ! limactl list -q 2>/dev/null | grep -qx "$vm"; then
  echo "no VM $vm: nothing to remove"
  exit 0
fi
if [ "${1:-}" = --vm ]; then
  limactl delete -f "$vm"
  echo "VM $vm deleted"
  exit 0
fi
[ "$(limactl list --format '{{.Status}}' "$vm")" = Running ] || limactl start --tty=false "$vm"
limactl shell "$vm" bash -c 'cd ~ && export PATH=$HOME/bin:$PATH
  kind delete cluster --name demo 2>/dev/null || true
  docker rm -f watchlog-agent fx-unhealthy fx-exited fx-oom fx-crashloop fx-limited >/dev/null 2>&1 || true
  docker volume rm watchlog-agent-state >/dev/null 2>&1 || true
  [ -f ~/demo-compose/compose.yaml ] && docker compose -f ~/demo-compose/compose.yaml down -v >/dev/null 2>&1 || true
  rm -rf ~/demo-compose'
echo "demo removed from $vm (the VM stays; --vm deletes it)"
