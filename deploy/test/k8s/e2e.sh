#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# End-to-end test on kind (ADR-065, ADR-086): build the four images, load them into a
# kind cluster, `helm install` the watchlog chart with alert channels pointing at
# in-cluster mocks (alert-mocks.sh), apply the test workloads and run
# acceptance.py (Phase 2: P0 views against kubectl, CrashLoopBackOff and OOMKilled
# within 30 s), alert-acceptance.py (Phase 3: one firing and one resolve message
# per channel) and servicemap-acceptance.py (Phase 4: the demo app's edges within
# 2 min, a dependency scaled to 0 fires the failed-connections rule). Images are never
# pushed (ADR-043).
#   KIND_CLUSTER (watchlog-e2e)   reuse an existing kind cluster with this name
#   SKIP_BUILD=1                  use images already present locally (tag dev)
#   KEEP=1                        leave the cluster running afterwards
#   E2E_PASSWORD                  admin password (default: random, kept in Secret watchlog-admin)
set -euo pipefail
cd "$(dirname "$0")/../../.."
name=${KIND_CLUSTER:-watchlog-e2e}
ctx=kind-$name
ns=watchlog
email=admin@example.com
password=${E2E_PASSWORD:-$(head -c 18 /dev/urandom | base64 | tr -d '/+=')}
images=(backend web agent cluster-agent)

if [ "${SKIP_BUILD:-}" != 1 ]; then
  docker build -q -t ghcr.io/watchlog-light/backend:dev -f backend/Dockerfile \
    --build-arg RUNTIME_IMAGE="${BACKEND_RUNTIME_IMAGE:-gcr.io/distroless/nodejs24-debian12:nonroot}" . >/dev/null
  docker build -q -t ghcr.io/watchlog-light/web:dev -f web/Dockerfile . >/dev/null
  docker build -q ${GOPROXY:+--build-arg GOPROXY="$GOPROXY"} -t ghcr.io/watchlog-light/agent:dev --target agent agent >/dev/null
  docker build -q ${GOPROXY:+--build-arg GOPROXY="$GOPROXY"} -t ghcr.io/watchlog-light/cluster-agent:dev --target cluster-agent agent >/dev/null
fi
created=0
if ! kind get clusters | grep -qx "$name"; then
  sed "s/^name: watchlog$/name: $name/" deploy/test/k8s/kind.yaml | kind create cluster --config - --wait 120s
  created=1
fi
cleanup() {
  [ -n "${pf:-}" ] && kill "$pf" 2>/dev/null || true
  if [ "$created" = 1 ] && [ "${KEEP:-}" != 1 ]; then kind delete cluster --name "$name"; fi
  if [ "${KEEP:-}" = 1 ]; then
    echo "kept: kubectl --context $ctx -n $ns port-forward svc/watchlog-web 8080; sign in as $email" \
      "(password in Secret watchlog-admin)"
  fi
}
trap cleanup EXIT
for i in "${images[@]}"; do kind load docker-image --name "$name" "ghcr.io/watchlog-light/$i:dev" >/dev/null; done

kubectl --context "$ctx" apply -f deploy/test/k8s/workloads.yaml >/dev/null
deploy/test/k8s/alert-mocks.sh "$ctx"
port=18080
helm dependency build deploy/helm/watchlog >/dev/null
helm --kube-context "$ctx" upgrade --install watchlog deploy/helm/watchlog -n "$ns" --create-namespace \
  --set admin.email="$email" --set admin.password="$password" \
  --set alerting.telegramApiUrl=http://mock-channels.wl-alert-mocks:8080 \
  --wait --timeout 6m
# A reused cluster keeps pods whose image tag (dev) did not change: restart them on the
# freshly loaded images.
if [ "$created" = 0 ]; then
  kubectl --context "$ctx" -n "$ns" rollout restart deploy,ds >/dev/null
  kubectl --context "$ctx" -n "$ns" rollout status deploy,ds --timeout 5m >/dev/null
fi

# Let agents report and the test pods fail a few times (the crashloop pod's back-off).
sleep 90
kubectl --context "$ctx" -n "$ns" port-forward svc/watchlog-web "$port:8080" >/dev/null 2>&1 &
pf=$!
sleep 3
rc=0
python3 deploy/test/k8s/acceptance.py --context "$ctx" --url "http://127.0.0.1:$port" \
  --email "$email" --password "$password" || rc=1
python3 deploy/test/k8s/alert-acceptance.py --context "$ctx" --url "http://127.0.0.1:$port" \
  --email "$email" --password "$password" || rc=1
python3 deploy/test/k8s/servicemap-acceptance.py --context "$ctx" --url "http://127.0.0.1:$port" \
  --email "$email" --password "$password" || rc=1
exit $rc
