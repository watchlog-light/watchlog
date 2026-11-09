#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Deploys agents.yaml to a kind cluster (Phase 2 slice 4 tests, before the Helm
# charts). Binaries are cross-compiled on the host and wrapped in minimal
# FROM-scratch images, loaded with `kind load` (no registry, ADR-043).
#   agents-up.sh <token> <endpoint reachable from pods, e.g. http://host.docker.internal:4091>
# KIND_CLUSTER (watchlog), KUBE_CONTEXT (kind-watchlog).
set -euo pipefail
token=$1 endpoint=$2
cluster=${KIND_CLUSTER:-watchlog}
ctx=${KUBE_CONTEXT:-kind-$cluster}
here=$(cd "$(dirname "$0")" && pwd)
arch=$(docker version -f '{{.Server.Arch}}')
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
k() { kubectl --context "$ctx" "$@"; }

cd "$here/../../../agent"
for cmd in watchlog-agent watchlog-cluster-agent watchlog-integrations; do
  CGO_ENABLED=0 GOOS=linux GOARCH=$arch go build -trimpath -ldflags "-s -w" -o "$work/$cmd" "./cmd/$cmd"
done
echo 'nonroot:x:65532:65532:nonroot:/nonexistent:/sbin/nologin' >"$work/passwd"
echo 'nonroot:x:65532:' >"$work/group"
cat >"$work/Dockerfile" <<'DOCKERFILE'
FROM scratch
ARG BIN
COPY passwd /etc/passwd
COPY group /etc/group
COPY ${BIN} /usr/local/bin/entry
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/entry"]
DOCKERFILE
for pair in agent:watchlog-agent cluster-agent:watchlog-cluster-agent integrations:watchlog-integrations; do
  docker build -q -t "ghcr.io/watchlog-light/${pair%%:*}:dev" --build-arg "BIN=${pair#*:}" "$work" >/dev/null
  kind load docker-image "ghcr.io/watchlog-light/${pair%%:*}:dev" --name "$cluster" >/dev/null
done

# Pod map TLS (ADR-066): a test CA and the cluster-agent's service certificate.
svc=watchlog-cluster-agent.watchlog.svc
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 7 -subj "/CN=watchlog-test-ca" \
  -keyout "$work/ca.key" -out "$work/ca.crt" 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=$svc" \
  -keyout "$work/tls.key" -out "$work/tls.csr" 2>/dev/null
printf 'subjectAltName=DNS:%s,DNS:%s.cluster.local\n' "$svc" "$svc" >"$work/san.ext"
openssl x509 -req -in "$work/tls.csr" -CA "$work/ca.crt" -CAkey "$work/ca.key" -CAcreateserial -days 7 \
  -extfile "$work/san.ext" -out "$work/tls.crt" 2>/dev/null

k apply -f <(sed -n '1,/^---$/p' "$here/agents.yaml" | sed '$d') >/dev/null # the namespace first
apply_secret() { k -n watchlog create secret generic "$1" "${@:2}" --dry-run=client -o yaml | k apply -f - >/dev/null; }
apply_secret watchlog-podmap-tls --from-file="$work/tls.crt" --from-file="$work/tls.key"
apply_secret watchlog-podmap-ca --from-file="$work/ca.crt"
apply_secret watchlog-agent --from-literal=token="$token" --from-literal=endpoint="$endpoint"
k apply -f "$here/agents.yaml" >/dev/null
k -n watchlog rollout restart deployment/watchlog-cluster-agent daemonset/watchlog-agent >/dev/null
k -n watchlog rollout status deployment/watchlog-cluster-agent --timeout=120s
k -n watchlog rollout status daemonset/watchlog-agent --timeout=120s
