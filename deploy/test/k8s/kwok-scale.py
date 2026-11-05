#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Prints manifests for the cluster-agent scale test (ADR-058): N fake kwok nodes and
# D Deployments of R replicas in 50 namespaces, pinned to the fake nodes. Needs the
# kwok controller and its stage-fast stages installed.
#   kwok-scale.py [nodes] [deployments] [replicas] | kubectl create -f -
import json
import sys

nodes, deployments, replicas = (int(a) for a in (sys.argv[1:] + ["500", "1500", "10"][len(sys.argv) - 1:]))
docs = []
for ns in range(50):
    docs.append({"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": f"scale-{ns:02d}"}})
for i in range(nodes):
    name = f"kwok-node-{i:03d}"
    res = {"cpu": "32", "memory": "256Gi", "pods": "110"}
    docs.append({"apiVersion": "v1", "kind": "Node",
                 "metadata": {"name": name, "annotations": {"node.alpha.kubernetes.io/ttl": "0", "kwok.x-k8s.io/node": "fake"},
                              "labels": {"kubernetes.io/hostname": name, "kubernetes.io/os": "linux", "type": "kwok",
                                         "node-role.kubernetes.io/worker": ""}},
                 "spec": {"taints": [{"effect": "NoSchedule", "key": "kwok.x-k8s.io/node", "value": "fake"}]},
                 "status": {"allocatable": res, "capacity": res,
                            "nodeInfo": {"kubeletVersion": "fake", "kernelVersion": "6.8.0", "osImage": "kwok",
                                         "containerRuntimeVersion": "fake://", "architecture": "amd64", "operatingSystem": "linux"}}})
for d in range(deployments):
    app = f"app-{d:04d}"
    docs.append({"apiVersion": "apps/v1", "kind": "Deployment",
                 "metadata": {"name": app, "namespace": f"scale-{d % 50:02d}", "labels": {"app": app, "team": f"team-{d % 20}"}},
                 "spec": {"replicas": replicas, "selector": {"matchLabels": {"app": app}},
                          "template": {"metadata": {"labels": {"app": app, "team": f"team-{d % 20}", "version": "v1"}},
                                       "spec": {"nodeSelector": {"type": "kwok"},
                                                "tolerations": [{"key": "kwok.x-k8s.io/node", "operator": "Exists", "effect": "NoSchedule"}],
                                                "containers": [{"name": "app", "image": "registry.example/app:1.0",
                                                                "env": [{"name": "SECRET_LIKE", "value": "must-not-be-shipped"}],
                                                                "resources": {"requests": {"cpu": "10m", "memory": "16Mi"},
                                                                              "limits": {"memory": "64Mi"}}},
                                                               {"name": "sidecar", "image": "registry.example/sidecar:1.0"}]}}}})
print("\n---\n".join(json.dumps(d) for d in docs))
