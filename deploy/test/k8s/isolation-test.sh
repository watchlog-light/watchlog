#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Host isolation on kind (ADR-121): the Kubernetes nodes are containers on a machine that
# also runs other processes and containers, and nothing of that machine may appear in
# WatchLog.
#   (a) a kind cluster whose node containers are limited (docker update --cpus/--memory),
#       with the watchlog chart from this checkout and nodeMetricsScope=cgroup;
#   (b) TCP connections and DNS lookups from a process on the machine and from a plain
#       Docker container: no edge, source, destination or DNS row from them, the agents'
#       pod filter counts them, and the demo app's edges are there;
#   (c) node capacity is the containers' limits, and no host disk, device, interface,
#       filesystem size, boot time or host name appears in the node API or node series.
# Run it where Docker, kind, kubectl, helm and python3 are, e.g. in a Lima VM:
#   limactl shell <vm> bash deploy/test/k8s/isolation-test.sh
# Images are built from this checkout and never pushed (ADR-043).
#   KIND_CLUSTER (watchlog-iso)   cluster name; created and deleted unless KEEP=1
#   SKIP_BUILD=1                  use the images already built (tag iso)
#   NODE_CPUS (2), NODE_MEMORY (3g)  the node containers' limits
#   GOPROXY, BACKEND_RUNTIME_IMAGE   as for e2e.sh (README, Checks)
set -euo pipefail
cd "$(dirname "$0")/../../.."
repo=$PWD
name=${KIND_CLUSTER:-watchlog-iso}
ctx=kind-$name
ns=watchlog
tag=iso
cpus=${NODE_CPUS:-2}
memory=${NODE_MEMORY:-3g}
email=admin@example.com
password=$(head -c 18 /dev/urandom | base64 | tr -d '/+=')
outsider_port=18555
outsider=wl-iso-outsider
demo_ns=wl-iso-demo
tmp=$(mktemp -d)
pids=()

say() { printf '\n== %s\n' "$*"; }
cleanup() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  docker rm -f "$outsider" >/dev/null 2>&1 || true
  if [ "${KEEP:-}" = 1 ]; then
    echo "kept: kind cluster $name (kubectl --context $ctx); admin $email, password in Secret watchlog-admin"
  else
    kind delete cluster --name "$name" >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

if [ "${SKIP_BUILD:-}" != 1 ]; then
  say "images from this checkout (tag $tag)"
  docker build -q -t ghcr.io/watchlog-light/backend:$tag -f backend/Dockerfile \
    --build-arg RUNTIME_IMAGE="${BACKEND_RUNTIME_IMAGE:-gcr.io/distroless/nodejs24-debian12:nonroot}" . >/dev/null
  docker build -q -t ghcr.io/watchlog-light/web:$tag -f web/Dockerfile . >/dev/null
  docker build -q ${GOPROXY:+--build-arg GOPROXY="$GOPROXY"} -t ghcr.io/watchlog-light/agent:$tag --target agent agent >/dev/null
  docker build -q ${GOPROXY:+--build-arg GOPROXY="$GOPROXY"} -t ghcr.io/watchlog-light/cluster-agent:$tag --target cluster-agent agent >/dev/null
fi

say "(a) kind cluster $name, node containers limited to $cpus CPUs and $memory"
kind delete cluster --name "$name" >/dev/null 2>&1 || true
sed "s/^name: watchlog$/name: $name/" deploy/test/k8s/kind.yaml | kind create cluster --config - --wait 180s
nodes=$(kind get nodes --name "$name" | sort)
for n in $nodes; do docker update --cpus "$cpus" --memory "$memory" --memory-swap "$memory" "$n" >/dev/null; done
for i in backend web agent cluster-agent; do kind load docker-image --name "$name" "ghcr.io/watchlog-light/$i:$tag" >/dev/null; done

# The chart directory may be read-only (a VM's mount of the checkout): build its
# dependency in a copy.
cp -R deploy/helm "$tmp/helm"
helm dependency build "$tmp/helm/watchlog" >/dev/null
helm --kube-context "$ctx" upgrade --install watchlog "$tmp/helm/watchlog" -n "$ns" --create-namespace \
  --set admin.email="$email" --set admin.password="$password" \
  --set image.tag=$tag --set image.pullPolicy=Never \
  --set watchlog-agent.image.tag=$tag --set watchlog-agent.image.pullPolicy=Never \
  --set watchlog-agent.agent.nodeMetricsScope=cgroup \
  --wait --timeout 8m >/dev/null
sed "s/wl-demo/$demo_ns/g" deploy/test/k8s/demo/demo.yaml | kubectl --context "$ctx" apply -f - >/dev/null
kubectl --context "$ctx" -n "$demo_ns" wait --for=condition=Ready pods --all --timeout=300s >/dev/null

say "(b) traffic from outside the cluster: this machine and a plain Docker container"
bridge=$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')
python3 deploy/test/k8s/outsider.py serve $outsider_port &
pids+=($!)
sleep 1
resolver=$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf)
python3 deploy/test/k8s/outsider.py load --tcp "127.0.0.1:$outsider_port" --dns "$resolver" \
  --rate 50 --dns-rate 10 --duration 1200 >/dev/null &
pids+=($!)
docker rm -f "$outsider" >/dev/null 2>&1 || true
docker run -d --name "$outsider" busybox:latest sh -c \
  "while true; do wget -q -T 2 -O /dev/null http://$bridge:$outsider_port/ ; nslookup outsider.isolation.invalid >/dev/null 2>&1; sleep 0.1; done" >/dev/null
outsider_ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$outsider")
echo "listener :$outsider_port on this machine; outsiders: this machine and $outsider ($outsider_ip)"

# What must never appear: this machine's addresses and networks, its own interfaces and
# block devices (those the nodes do not have too), its host name.
first=$(echo "$nodes" | head -1)
node_ifaces=$(docker exec "$first" sh -c "sed -n 's/^ *\([^:]*\):.*/\1/p' /proc/1/net/dev" | sort -u | paste -sd, -)
kind_net=$(docker inspect -f '{{.NetworkSettings.Networks.kind.IPAddress}}' "$first")
forbidden=()
for ip in $(hostname -I) "$bridge" "$outsider_ip"; do
  case $ip in *:*) continue ;; esac
  # The kind network's gateway: the nodes' own addresses are in it.
  [ "${ip%.*}" = "${kind_net%.*}" ] && continue
  forbidden+=("$ip" "${ip%.*}.")
done
for i in $(ls /sys/class/net); do
  case ",$node_ifaces," in *",$i,"*) ;; *) forbidden+=("$i") ;; esac
done
for d in $(lsblk -dno NAME 2>/dev/null); do forbidden+=("$d"); done
forbidden+=("$(hostname)")
starts="{"
for n in $nodes; do
  s=$(date -d "$(docker inspect -f '{{.State.StartedAt}}' "$n")" +%s)
  starts="$starts\"$n\": $s,"
done
starts="${starts%,}}"
host_boot=$(awk '/^btime/{print $2}' /proc/stat)
echo "forbidden: $(IFS=,; echo "${forbidden[*]}")"
echo "node interfaces: $node_ifaces"

say "waiting 90 s for the agents to report"
sleep 90
kubectl --context "$ctx" -n "$ns" port-forward svc/watchlog-web 18081:8080 >/dev/null 2>&1 &
pids+=($!)
kubectl --context "$ctx" -n "$ns" port-forward svc/watchlog-victoriametrics 18428:8428 >/dev/null 2>&1 &
pids+=($!)
sleep 3

say "(b) and (c) checks"
python3 deploy/test/k8s/isolation-check.py --context "$ctx" --url http://127.0.0.1:18081 \
  --vm-url http://127.0.0.1:18428 --email "$email" --password "$password" --demo-ns "$demo_ns" \
  --cpus "$cpus" --memory-bytes "$(numfmt --from=iec "${memory^^}")" --outsider-port $outsider_port \
  --forbidden "$(IFS=,; echo "${forbidden[*]}")" --node-starts "$starts" --host-boot "$host_boot" \
  --node-ifaces "$node_ifaces"
