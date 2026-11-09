#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Demo environment for development (README, "Demo environment"): one Lima VM with
#   - kind cluster "demo" (context kind-demo): the demo app as namespace shop
#     (deploy/test/k8s/demo/demo.yaml) and the wl-test failure pods
#     (deploy/test/k8s/workloads.yaml), with the agent chart reporting to `pnpm dev`;
#   - a Docker agent reporting to a Docker fleet, with the fx-* containers
#     (unhealthy, exited, OOM-killed, crash-looping, CPU-limited) and a small Compose app.
# Agents are built from this checkout. Idempotent: run it again to update the agents,
# re-apply the workloads or replace a token; it only creates what is missing.
#
# Tokens (Settings → Clusters → the cluster → Issue token) come from the environment or
# from ${WATCHLOG_DEMO_ENV:-~/.config/watchlog/demo.env} (keep it mode 600, outside any
# repository):
#   WATCHLOG_DEMO_KUBE_TOKEN     token of the Kubernetes cluster (e.g. kind-demo)
#   WATCHLOG_DEMO_DOCKER_TOKEN   token of the Docker fleet (e.g. my-cluster)
#   WATCHLOG_DEMO_PORT           the dev backend's port on this Mac (default 4080)
# A token can be left out once its agent is installed: the installed one is kept.
#   VM=watchlog-demo             the Lima VM's name
#   GOPROXY                      for the agent build (e.g. https://goproxy.io,direct)
# Commands in single quotes run in the VM and expand there.
# shellcheck disable=SC2016
set -euo pipefail
cd "$(dirname "$0")/../.."
repo=$PWD
vm=${VM:-watchlog-demo}
env_file=${WATCHLOG_DEMO_ENV:-$HOME/.config/watchlog/demo.env}
if [ -f "$env_file" ]; then
  # shellcheck source=/dev/null
  set -a && . "$env_file" && set +a
fi
port=${WATCHLOG_DEMO_PORT:-4080}

say() { printf '\n== %s\n' "$*"; }
in_vm() { limactl shell "$vm" bash -c "cd ~ && export PATH=\$HOME/bin:\$PATH && $*"; }

say "VM $vm"
if ! limactl list -q 2>/dev/null | grep -qx "$vm"; then
  limactl create --tty=false --name="$vm" deploy/test/lima/watchlog-test.yaml
fi
[ "$(limactl list --format '{{.Status}}' "$vm")" = Running ] || limactl start --tty=false "$vm"
# The docker group applies from the next login; kind's three nodes need more inotify
# instances than Ubuntu's default (kube-proxy fails with "too many open files").
in_vm 'docker info >/dev/null 2>&1' || { limactl stop "$vm" && limactl start --tty=false "$vm"; }
in_vm 'printf "fs.inotify.max_user_instances=1024\nfs.inotify.max_user_watches=1048576\n" | sudo tee /etc/sysctl.d/99-kind.conf >/dev/null && sudo sysctl -q --system'
# kind, kubectl and helm in ~/bin, pinned (the VM template installs only Docker).
in_vm 'set -e; mkdir -p ~/bin; a=$(dpkg --print-architecture)
  [ -x ~/bin/kind ] || { curl -fsSLo ~/bin/kind "https://kind.sigs.k8s.io/dl/v0.33.0/kind-linux-$a"; chmod +x ~/bin/kind; }
  [ -x ~/bin/kubectl ] || { curl -fsSLo ~/bin/kubectl "https://dl.k8s.io/release/v1.37.0/bin/linux/$a/kubectl"; chmod +x ~/bin/kubectl; }
  [ -x ~/bin/helm ] || { curl -fsSL "https://get.helm.sh/helm-v4.3.1-linux-$a.tar.gz" | tar -xz -C /tmp && mv "/tmp/linux-$a/helm" ~/bin/helm; }'

# The Mac as the VM and its containers reach it: pods resolve no Lima names, so the IP.
host_ip=$(in_vm 'getent ahostsv4 host.lima.internal | awk "NR==1{print \$1}"')
endpoint="http://$host_ip:$port"
if ! in_vm "curl -s -o /dev/null -m 5 $endpoint/api/v1/health"; then
  echo "the dev backend is not reachable at $endpoint from the VM: start \`pnpm dev\` first" >&2
  exit 1
fi

say "agent images from this checkout"
in_vm "cd '$repo/agent' && docker build -q ${GOPROXY:+--build-arg GOPROXY=$GOPROXY} -t ghcr.io/watchlog-light/agent:demo --target agent . >/dev/null \
  && docker build -q ${GOPROXY:+--build-arg GOPROXY=$GOPROXY} -t ghcr.io/watchlog-light/cluster-agent:demo --target cluster-agent . >/dev/null \
  && docker build -q ${GOPROXY:+--build-arg GOPROXY=$GOPROXY} -t ghcr.io/watchlog-light/integrations:demo --target integrations . >/dev/null"

say "kind cluster demo (context kind-demo)"
in_vm "kind get clusters 2>/dev/null | grep -qx demo || sed 's/^name: watchlog\$/name: demo/' '$repo/deploy/test/k8s/kind.yaml' | kind create cluster --config - --wait 180s"
in_vm 'kubectl --context kind-demo wait --for=condition=Ready node --all --timeout=180s >/dev/null'
in_vm 'for i in agent cluster-agent integrations; do kind load docker-image --name demo ghcr.io/watchlog-light/$i:demo >/dev/null; done'

say "workloads: the demo app (shop) and the failure pods (wl-test)"
in_vm "sed 's/wl-demo/shop/g' '$repo/deploy/test/k8s/demo/demo.yaml' | kubectl --context kind-demo apply -f - >/dev/null"
in_vm "kubectl --context kind-demo apply -f '$repo/deploy/test/k8s/workloads.yaml' >/dev/null"

say "agent chart → $endpoint"
in_vm 'kubectl --context kind-demo create namespace watchlog --dry-run=client -o yaml | kubectl --context kind-demo apply -f - >/dev/null
  kubectl --context kind-demo label namespace watchlog pod-security.kubernetes.io/enforce=privileged --overwrite >/dev/null'
values="--set watchlog.endpoint=$endpoint --set image.tag=demo --set image.pullPolicy=Never"
if [ -n "${WATCHLOG_DEMO_KUBE_TOKEN:-}" ]; then
  # The token goes through stdin, never onto a command line in the VM.
  printf '%s' "$WATCHLOG_DEMO_KUBE_TOKEN" | limactl shell "$vm" bash -c "cd ~ && export PATH=\$HOME/bin:\$PATH && t=\$(cat) && helm --kube-context kind-demo upgrade --install watchlog-agent '$repo/deploy/helm/watchlog-agent' -n watchlog $values --set-string watchlog.clusterToken=\"\$t\" --wait --timeout 5m >/dev/null"
elif in_vm 'helm --kube-context kind-demo status watchlog-agent -n watchlog >/dev/null 2>&1'; then
  in_vm "helm --kube-context kind-demo upgrade watchlog-agent '$repo/deploy/helm/watchlog-agent' -n watchlog --reuse-values $values --wait --timeout 5m >/dev/null"
else
  echo "no WATCHLOG_DEMO_KUBE_TOKEN and no agent installed yet (see the header)" >&2
  exit 1
fi
# Same tag, new image: restart onto it.
in_vm 'kubectl --context kind-demo -n watchlog rollout restart deploy,ds >/dev/null && kubectl --context kind-demo -n watchlog rollout status deploy,ds --timeout 5m >/dev/null'

say "Docker fleet: fx-* containers, a Compose app, the Docker agent"
in_vm '
  have() { docker inspect "$1" >/dev/null 2>&1; }
  have fx-unhealthy || docker run -d --name fx-unhealthy --health-cmd "wget -q -O /dev/null http://127.0.0.1:81/ || exit 1" \
    --health-interval 10s --health-retries 2 busybox:latest sleep infinity >/dev/null
  have fx-exited || docker run -d --name fx-exited busybox:latest sh -c "sleep 2; exit 1" >/dev/null
  have fx-oom || docker run -d --name fx-oom --memory 16m busybox:latest sh -c "sleep 5; head -c 64m /dev/zero | tail" >/dev/null
  have fx-crashloop || docker run -d --name fx-crashloop --restart always busybox:latest sh -c "sleep 20; exit 2" >/dev/null
  have fx-limited || docker run -d --name fx-limited --cpus 0.2 busybox:latest sh -c "while true; do :; done" >/dev/null
  mkdir -p ~/demo-compose && cat > ~/demo-compose/compose.yaml <<COMPOSE
name: storefront
services:
  web:
    image: nginx:1.27-alpine
    ports: ["127.0.0.1:18090:80"]
  cache:
    image: redis:7-alpine
  probe:
    image: busybox:latest
    command: [sh, -c, "while true; do wget -q -O /dev/null http://web/ ; sleep 2; done"]
COMPOSE
  docker compose -f ~/demo-compose/compose.yaml up -d --quiet-pull >/dev/null 2>&1'
docker_agent() { # token via stdin
  limactl shell "$vm" bash -c "cd ~ && t=\$(cat) && docker rm -f watchlog-agent >/dev/null 2>&1; docker run -d --name watchlog-agent --restart unless-stopped \
    --pid host --user 0:65532 --cap-drop ALL --cap-add BPF --cap-add PERFMON --security-opt no-new-privileges \
    -v /var/run/docker.sock:/var/run/docker.sock:ro -v /proc:/host/proc:ro -v /sys:/host/sys:ro -v /:/host/root:ro,rslave \
    -v watchlog-agent-state:/var/lib/watchlog-agent -e WATCHLOG_TOKEN=\"\$t\" -e WATCHLOG_ENDPOINT=$endpoint \
    ghcr.io/watchlog-light/agent:demo --mode=docker >/dev/null"
}
if [ -n "${WATCHLOG_DEMO_DOCKER_TOKEN:-}" ]; then
  printf '%s' "$WATCHLOG_DEMO_DOCKER_TOKEN" | docker_agent
elif in_vm 'docker inspect watchlog-agent >/dev/null 2>&1'; then
  # Keep its token; restart onto the new image.
  limactl shell "$vm" bash -c "cd ~ && docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' watchlog-agent | sed -n 's/^WATCHLOG_TOKEN=//p'" | docker_agent
else
  echo "no WATCHLOG_DEMO_DOCKER_TOKEN and no Docker agent yet (see the header)" >&2
  exit 1
fi

say "reporting"
for i in $(seq 1 24); do
  k=$(in_vm 'kubectl --context kind-demo -n watchlog logs ds/watchlog-agent --tail=50 2>/dev/null | grep -c "rejected the token\|unreachable" || true')
  d=$(in_vm 'docker logs --tail 50 watchlog-agent 2>&1 | grep -c "rejected the token\|unreachable" || true')
  [ "$k" = 0 ] && [ "$d" = 0 ] && [ "$i" -ge 3 ] && break
  sleep 5
done
in_vm 'kubectl --context kind-demo get pods -A --no-headers | awk "{print \$1}" | sort | uniq -c'
in_vm 'docker ps --format "{{.Names}}\t{{.Status}}" | grep -E "^(watchlog-agent|fx-|storefront)"'
echo
echo "Demo up. Both report to $endpoint; open http://localhost:4088 and pick the cluster and the fleet."
echo "kubectl: limactl shell $vm kubectl --context kind-demo …   ·   down: deploy/test/demo-down.sh"
