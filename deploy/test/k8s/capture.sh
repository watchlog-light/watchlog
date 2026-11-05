#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Captures node-mode fixtures from a running test cluster (ADR-050):
#   capture.sh <layout> <kube-context> <node-exec>
# <node-exec> runs a root shell on a node, with {node} (node name) or {vm} (Lima VM
# name: the node name without "lima-") as placeholders, e.g.
#   'docker exec -i {node}'                       (kind)
#   'limactl shell --workdir /tmp {vm} sudo'      (k3s / kubeadm on Lima)
# Writes agent/internal/collectors/containers/testdata/k8s/<layout>/: per node the
# kubepods cgroup tree and /stats/summary, and pods.json (ground truth: pod UID,
# QoS class, container IDs and limits; nothing else from the pod specs).
set -euo pipefail
layout=$1 ctx=$2 exec_tpl=$3
here=$(cd "$(dirname "$0")" && pwd)
out=$here/../../../agent/internal/collectors/containers/testdata/k8s/$layout
rm -rf "$out" && mkdir -p "$out"
k() { kubectl --context "$ctx" "$@"; }

for node in $(k get nodes -o jsonpath='{.items[*].metadata.name}'); do
  cmd=${exec_tpl//\{node\}/$node}
  cmd=${cmd//\{vm\}/${node#lima-}}
  mkdir -p "$out/$node"
  # shellcheck disable=SC2086
  $cmd sh -s <"$here/capture-node.sh" | tar -C "$out/$node" -xf -
  k get --raw "/api/v1/nodes/$node/proxy/stats/summary" | python3 -m json.tool --indent 1 >"$out/$node/summary.json"
  echo "$node: $(find "$out/$node" -type f | wc -l | tr -d ' ') files"
done

k get pods -A -o json | python3 -c '
import json, sys
pods = []
for p in json.load(sys.stdin)["items"]:
    st = p.get("status", {})
    limits = {(init, c["name"]): c.get("resources", {}).get("limits", {})
              for init, key in ((False, "containers"), (True, "initContainers"))
              for c in p["spec"].get(key, [])}
    pods.append({
        "namespace": p["metadata"]["namespace"], "name": p["metadata"]["name"],
        "uid": p["metadata"]["uid"], "node": p["spec"].get("nodeName"),
        # Static pods: the cgroup carries this config hash, not the UID of the mirror pod.
        "mirror": p["metadata"].get("annotations", {}).get("kubernetes.io/config.mirror"),
        "qosClass": st.get("qosClass"), "phase": st.get("phase"),
        "containers": [{"name": c["name"], "containerID": c.get("containerID"),
                        "state": next(iter(c.get("state", {})), None), "init": init,
                        "limits": limits.get((init, c["name"]), {})}
                       for init, key in ((False, "containerStatuses"), (True, "initContainerStatuses"))
                       for c in st.get(key, [])],
    })
json.dump(sorted(pods, key=lambda p: (p["namespace"], p["name"])), sys.stdout, indent=1)
print()' >"$out/pods.json"
k version -o json | python3 -c 'import json,sys; v=json.load(sys.stdin)["serverVersion"]; print(v["gitVersion"])' >"$out/k8s-version.txt"
k get nodes -o jsonpath='{range .items[*]}{.metadata.name} {.status.nodeInfo.containerRuntimeVersion} {.status.nodeInfo.kernelVersion}{"\n"}{end}' >"$out/nodes.txt"
du -sh "$out"
