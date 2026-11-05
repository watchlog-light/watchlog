#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Creates the k3s test cluster on Lima (ADR-063): VM watchlog-k3s-server (server)
# and watchlog-k3s-agent (agent). Writes the kubeconfig context "k3s-watchlog"
# (API server via Lima's forward of 6443 to 127.0.0.1).
#   K3S_VERSION (v1.36.5+k3s1)
set -euo pipefail
cd "$(dirname "$0")"
version=${K3S_VERSION:-v1.36.5+k3s1}
template=../lima/k3s.yaml
# The node IP and interface of the default route (user-v2: eth0, shared by all VMs).
route_field() { limactl shell --workdir /tmp "$1" ip -4 -o route get 1.1.1.1 | awk -v k="$2" '{for (i = 1; i < NF; i++) if ($i == k) print $(i + 1)}'; }

for vm in watchlog-k3s-server watchlog-k3s-agent; do
  limactl list -q | grep -qx "$vm" || limactl create --tty=false --name="$vm" "$template" >/dev/null
  limactl start "$vm" >/dev/null 2>&1 || true
done
server_ip=$(route_field watchlog-k3s-server src)
agent_ip=$(route_field watchlog-k3s-agent src)
iface=$(route_field watchlog-k3s-server dev)
[ -n "$server_ip" ] && [ -n "$agent_ip" ] && [ -n "$iface" ] || { echo "cannot find the VM IPs" >&2; exit 1; }

limactl shell --workdir /tmp watchlog-k3s-server sudo bash -c "
  command -v k3s >/dev/null || curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION='$version' sh -s - server \
    --node-ip $server_ip --flannel-iface $iface --write-kubeconfig-mode 644 >/dev/null"
token=$(limactl shell --workdir /tmp watchlog-k3s-server sudo cat /var/lib/rancher/k3s/server/node-token)
limactl shell --workdir /tmp watchlog-k3s-agent sudo bash -c "
  command -v k3s >/dev/null || curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION='$version' \
    K3S_URL=https://$server_ip:6443 K3S_TOKEN='$token' sh -s - agent --node-ip $agent_ip --flannel-iface $iface >/dev/null"

limactl shell --workdir /tmp watchlog-k3s-server cat /etc/rancher/k3s/k3s.yaml |
  sed -e 's/: default$/: k3s-watchlog/' >"$HOME/.kube/k3s-watchlog.yaml"
# The new file comes first: for duplicate names the first entry wins.
KUBECONFIG="$HOME/.kube/k3s-watchlog.yaml:$HOME/.kube/config" kubectl config view --flatten >"$HOME/.kube/config.merged"
mv "$HOME/.kube/config.merged" "$HOME/.kube/config"
kubectl --context k3s-watchlog wait --for=condition=Ready node --all --timeout=180s
