#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Single-node k3s on an existing Lima VM, for fixture layouts (ADR-063):
#   k3s-single.sh <vm> <kube-context> [k3s server flags...]
# e.g. on watchlog-cgv1 (cgroup v1), or with --docker (Docker Engine via cri-dockerd).
# Re-installs k3s when it is already there. K3S_VERSION (v1.36.5+k3s1).
set -euo pipefail
vm=$1 ctx=$2
shift 2
version=${K3S_VERSION:-v1.36.5+k3s1}
limactl start "$vm" >/dev/null 2>&1 || true
limactl shell --workdir /tmp "$vm" sudo bash -c "
  if command -v k3s-uninstall.sh >/dev/null; then k3s-uninstall.sh >/dev/null 2>&1; fi
  curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION='$version' sh -s - server --write-kubeconfig-mode 644 $* >/dev/null"
limactl shell --workdir /tmp "$vm" cat /etc/rancher/k3s/k3s.yaml | sed -e "s/: default\$/: $ctx/" >"$HOME/.kube/$ctx.yaml"
# The new file comes first: for duplicate names the first entry wins.
KUBECONFIG="$HOME/.kube/$ctx.yaml:$HOME/.kube/config" kubectl config view --flatten >"$HOME/.kube/config.merged"
mv "$HOME/.kube/config.merged" "$HOME/.kube/config"
kubectl --context "$ctx" wait --for=condition=Ready node --all --timeout=240s
