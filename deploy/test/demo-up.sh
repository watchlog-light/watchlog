#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Demo environment for development (README, "Demo environment"): one Lima VM with
#   - kind cluster "demo" (context kind-demo): the demo app as namespace shop
#     (deploy/test/k8s/demo/demo.yaml) and the wl-test failure pods
#     (deploy/test/k8s/workloads.yaml), with the agent chart reporting to `pnpm dev`;
#   - a Docker agent reporting to a Docker fleet, with the fx-* containers
#     (unhealthy, exited, OOM-killed, crash-looping, CPU-limited) and a small Compose app.
# Agents and the integrations collectors (in the cluster and on the Docker host) are built
# from this checkout. The demo's Redis and PostgreSQL are ready to monitor: PostgreSQL has a
# `watchlog` role with pg_monitor, its password in a Secret (kind) or a root-owned file
# (Docker), as deploy/test/demo/seed.json references them; `./dev.sh product` passes that
# seed to the backend, so they are monitored with no manual step.
# Idempotent: run it again to update the agents, re-apply the workloads or replace a
# token; it only creates what is missing.
#   --existing   only when the demo VM exists and runs (./dev.sh product): never creates it
#
# Tokens (Settings → Clusters → the cluster → Issue token) come from the environment or
# from ${WATCHLOG_DEMO_ENV:-~/.config/watchlog/demo.env} (keep it mode 600, outside any
# repository):
#   WATCHLOG_DEMO_KUBE_TOKEN     token of the Kubernetes cluster (e.g. kind-demo)
#   WATCHLOG_DEMO_DOCKER_TOKEN   token of the Docker fleet (e.g. my-cluster)
#   WATCHLOG_DEMO_PORT           the dev backend's port on this Mac (default 4080)
# A token can be left out once its agent is installed: the installed one is kept.
#   VM                           the Lima VM's name; unset: the running VM that has the kind
#                                cluster "demo", else watchlog-demo
#   GOPROXY                      for the agent build; default proxy.golang.org, then goproxy.io
# Commands in single quotes run in the VM and expand there.
# shellcheck disable=SC2016
set -euo pipefail
cd "$(dirname "$0")/../.."
repo=$PWD
env_file=${WATCHLOG_DEMO_ENV:-$HOME/.config/watchlog/demo.env}
if [ -f "$env_file" ]; then
  # shellcheck source=/dev/null
  set -a && . "$env_file" && set +a
fi
port=${WATCHLOG_DEMO_PORT:-4080}
existing=false
[ "${1:-}" = --existing ] && existing=true
if [ -z "${VM:-}" ] && command -v limactl >/dev/null; then
  # The running VM with the kind cluster "demo" (several test VMs may exist).
  for v in $(limactl list --format '{{.Name}} {{.Status}}' 2>/dev/null | awk '$2 == "Running" {print $1}'); do
    if limactl shell "$v" bash -c 'PATH=$HOME/bin:$PATH; kind get clusters 2>/dev/null' 2>/dev/null | grep -qx demo; then
      VM=$v
      break
    fi
  done
fi
vm=${VM:-watchlog-demo}
if $existing; then
  if ! command -v limactl >/dev/null || [ "$(limactl list --format '{{.Status}}' "$vm" 2>/dev/null)" != Running ]; then
    echo "no running demo VM ($vm): skipped (deploy/test/demo-up.sh creates one)"
    exit 0
  fi
fi

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
# The Go module proxy: proxy.golang.org, and goproxy.io when it fails ("|": on any error).
# Some networks get 403 for the zips proxy.golang.org serves from Google Cloud Storage;
# a build that needs a new module then fails at `go mod download`, while one with every
# module in Docker's cache still works, so an older VM breaks first.
GOPROXY=${GOPROXY:-https://proxy.golang.org|https://goproxy.io,direct}
in_vm "cd '$repo/agent' && docker build -q --build-arg GOPROXY='$GOPROXY' -t ghcr.io/watchlog-light/agent:demo --target agent . >/dev/null \
  && docker build -q --build-arg GOPROXY='$GOPROXY' -t ghcr.io/watchlog-light/cluster-agent:demo --target cluster-agent . >/dev/null \
  && docker build -q --build-arg GOPROXY='$GOPROXY' -t ghcr.io/watchlog-light/integrations:demo --target integrations . >/dev/null"

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
  db:
    image: postgres:16-alpine
    environment: [POSTGRES_PASSWORD=demo]
    command: [postgres, -c, shared_preload_libraries=pg_stat_statements, -c, compute_query_id=on]
  orders:
    image: postgres:16-alpine
    environment: [PGPASSWORD=demo]
    command: [sh, -c, "while true; do psql -h db -U postgres -qc \"create table if not exists orders (id bigserial primary key, item int, at timestamptz default now()); insert into orders (item) select g from generate_series(1, 20) g; select count(*) from orders where at > now() - make_interval(mins => 1); delete from orders where at < now() - make_interval(mins => 5)\" >/dev/null 2>&1; sleep 2; done"]
  sessions:
    image: redis:7-alpine
    command: [sh, -c, "while true; do redis-cli -h cache SET session:42 v EX 300 >/dev/null; redis-cli -h cache GET session:42 >/dev/null; redis-cli -h cache GET session:7 >/dev/null; sleep 1; done"]
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

say "integrations collector on the Docker host (the command WatchLog shows, with the agent's token and endpoint)"
# /etc/watchlog/secrets as the docs have it (root-owned, 0700), made by a root container
# instead of sudo, so the command WatchLog shows finds the same files.
in_vm 'docker run --rm -v /etc/watchlog/secrets:/s busybox:latest chmod 0700 /s
  e() { docker inspect --format "{{range .Config.Env}}{{println .}}{{end}}" watchlog-agent | sed -n "s/^$1=//p"; }
  export WATCHLOG_TOKEN="$(e WATCHLOG_TOKEN)" WATCHLOG_ENDPOINT="$(e WATCHLOG_ENDPOINT)"
  docker rm -f watchlog-integrations >/dev/null 2>&1
  docker run -d --name watchlog-integrations --restart unless-stopped \
    --network host --user 0:0 --cap-drop ALL --read-only \
    --tmpfs /var/lib/watchlog-integrations --security-opt no-new-privileges \
    -v /etc/watchlog/secrets:/etc/watchlog/secrets:ro \
    -e WATCHLOG_TOKEN -e WATCHLOG_ENDPOINT -e WATCHLOG_HOSTNAME="$(hostname)" \
    ghcr.io/watchlog-light/integrations:demo --mode=docker >/dev/null'

say "PostgreSQL ready to monitor: a pg_monitor role, its password where the seed points"
ready='for i in $(seq 90); do pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1'
role() { # the statements, given the password on stdin
  printf '%s' "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'watchlog') THEN CREATE ROLE watchlog LOGIN; END IF; END \$\$;
ALTER ROLE watchlog PASSWORD :'p';
GRANT pg_monitor TO watchlog;"
}
# kind: the password in the Secret watchlog/shop-postgres-watchlog, readable by the collector
# through a Role for that one Secret (the commands WatchLog shows for option c).
in_vm "kubectl --context kind-demo -n shop rollout status statefulset/postgres --timeout 180s >/dev/null
  kubectl --context kind-demo -n shop exec statefulset/postgres -- sh -c '$ready'
  kubectl --context kind-demo -n watchlog get secret shop-postgres-watchlog >/dev/null 2>&1 ||
    kubectl --context kind-demo -n watchlog create secret generic shop-postgres-watchlog --from-literal=password=\$(head -c 18 /dev/urandom | base64 | tr -dc A-Za-z0-9) >/dev/null
  kubectl --context kind-demo -n watchlog create role watchlog-read-shop-postgres-watchlog --verb=get --resource=secrets --resource-name=shop-postgres-watchlog --dry-run=client -o yaml | kubectl --context kind-demo apply -f - >/dev/null
  kubectl --context kind-demo -n watchlog create rolebinding watchlog-read-shop-postgres-watchlog --role=watchlog-read-shop-postgres-watchlog --serviceaccount=watchlog:watchlog-agent-integrations --dry-run=client -o yaml | kubectl --context kind-demo apply -f - >/dev/null"
role | limactl shell "$vm" bash -c "cd ~ && export PATH=\$HOME/bin:\$PATH && sql=\$(cat) &&
  p=\$(kubectl --context kind-demo -n watchlog get secret shop-postgres-watchlog -o jsonpath='{.data.password}' | base64 -d) &&
  printf '%s' \"\$sql\" | kubectl --context kind-demo -n shop exec -i statefulset/postgres -- psql -q -U postgres -v ON_ERROR_STOP=1 -v p=\"\$p\" >/dev/null"
# Docker: the Compose app's db, the password in a root-owned file in /etc/watchlog/secrets.
in_vm "docker exec storefront-db-1 sh -c '$ready'
  docker run --rm -v /etc/watchlog/secrets:/s busybox:latest sh -c '[ -s /s/storefront-db ] || { umask 077; head -c 18 /dev/urandom | base64 | tr -dc A-Za-z0-9 > /s/storefront-db; }'"
role | limactl shell "$vm" bash -c "cd ~ && sql=\$(cat) &&
  p=\$(docker run --rm -v /etc/watchlog/secrets:/s:ro busybox:latest cat /s/storefront-db) &&
  printf '%s' \"\$sql\" | docker exec -i storefront-db-1 psql -q -U postgres -v ON_ERROR_STOP=1 -v p=\"\$p\" >/dev/null"

say "reporting"
for i in $(seq 1 24); do
  k=$(in_vm 'kubectl --context kind-demo -n watchlog logs ds/watchlog-agent --tail=50 2>/dev/null | grep -c "rejected the token\|unreachable" || true')
  d=$(in_vm 'docker logs --tail 50 watchlog-agent 2>&1 | grep -c "rejected the token\|unreachable" || true')
  [ "$k" = 0 ] && [ "$d" = 0 ] && [ "$i" -ge 3 ] && break
  sleep 5
done
in_vm 'kubectl --context kind-demo get pods -A --no-headers | awk "{print \$1}" | sort | uniq -c'
in_vm 'docker ps --format "{{.Names}}\t{{.Status}}" | grep -E "^(watchlog-agent|watchlog-integrations|fx-|storefront)"'
in_vm 'kubectl --context kind-demo -n watchlog get deploy watchlog-agent-integrations --no-headers 2>/dev/null || echo "no integrations collector in the cluster: is integrations.enabled false?"'
echo
echo "Demo up. Both report to $endpoint; open http://localhost:4088 and pick the cluster and the fleet."
echo "kubectl: limactl shell $vm kubectl --context kind-demo …   ·   down: deploy/test/demo-down.sh"
