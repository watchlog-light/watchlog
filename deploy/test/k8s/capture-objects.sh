#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Captures the API objects the cluster-agent watches (ADR-052) as list JSON, for
# cluster-agent fixtures: capture-objects.sh <layout> <kube-context>
# Writes agent/internal/k8s/testdata/<layout>/<resource>.json. The test clusters
# hold no Secrets of interest; Secrets and ConfigMaps are never captured.
set -euo pipefail
layout=$1 ctx=$2
here=$(cd "$(dirname "$0")" && pwd)
out=$here/../../../agent/internal/k8s/testdata/$layout
rm -rf "$out" && mkdir -p "$out"
for r in nodes namespaces pods deployments.apps replicasets.apps statefulsets.apps daemonsets.apps \
  jobs.batch cronjobs.batch horizontalpodautoscalers.autoscaling persistentvolumeclaims events.events.k8s.io \
  services endpointslices.discovery.k8s.io; do
  kubectl --context "$ctx" get "$r" -A -o json >"$out/${r%%.*}.json"
done
kubectl --context "$ctx" version -o json | python3 -c 'import json,sys; print(json.load(sys.stdin)["serverVersion"]["gitVersion"])' >"$out/k8s-version.txt"
du -sh "$out"
