#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Probable cause end to end (v0.4, ADR-146 to ADR-150) on the demo VM: every failure in
# the v0.4 scenario list, reproducible on demand on the kind cluster "demo" (namespace
# causes-e2e) and on the VM's Docker host (Compose project causes-e2e), and a check of
# the top cause WatchLog gives for each through GET /api/v1/causes (ADR-148).
#
#   causes-e2e.sh up                             the fixtures; monitors their PostgreSQL (and
#                                                rabbitmq-e2e's broker, when it is there)
#   causes-e2e.sh list                           the scenarios, platforms and expected causes
#   causes-e2e.sh trigger <scenario> [kubernetes|docker]   break it (both platforms if unnamed)
#   causes-e2e.sh restore <scenario> [kubernetes|docker]   mend it
#   causes-e2e.sh check [scenario…]              the top cause of each, against SCENARIOS
#   causes-e2e.sh down                           removes only what `up` made
#
# Runs after the agents report with network flows on (eBPF: the service map, HTTP and
# DNS), e.g. WATCHLOG_E2E_FLOWS=true deploy/test/integrations-e2e.sh, which starts the e2e
# agents beside the demo's own. Every fixture is small (busybox, podinfo, postgres:16) and
# labelled app.kubernetes.io/part-of=causes-e2e; nothing of the demo's shop, wl-test or
# fx-* is touched. Exceptions, each undone by `restore`:
#   - node: cordons demo-worker2 and evicts only causes-e2e's pods from it;
#   - node on Docker: stops the Docker agent(s) that report to WATCHLOG_URL's port (the
#     backend under test), never another backend's agent;
#   - rabbitmq-consumer-oom: drives the fixtures of deploy/test/rabbitmq-e2e.sh (run it
#     first); `up` starts its broker, stops its publisher and consumer and empties the
#     queue, so it is quiet until the trigger.
# `up` again applies the fixtures as they are written, so it also restores every scenario.
#
#   WATCHLOG_URL           the backend as seen from this machine (default http://127.0.0.1:4080)
#   WATCHLOG_E2E_EMAIL and WATCHLOG_E2E_PASSWORD   an account in it (`up`, `check`, `down`)
#   WATCHLOG_E2E_KUBE_CLUSTER, WATCHLOG_E2E_DOCKER_CLUSTER
#                          the cluster and fleet (id or name); default the only one of each kind
#   VM                     the Lima VM (default watchlog-demo)
# shellcheck disable=SC2016
set -euo pipefail
cd "$(dirname "$0")/../.."
vm=${VM:-watchlog-demo}
url=${WATCHLOG_URL:-http://127.0.0.1:4080}
ns=causes-e2e
# The fixtures' folder in the VM (the tilde expands there).
# shellcheck disable=SC2088
dir='~/causes-e2e'
compose="docker compose -f $dir/compose.yaml"
in_vm() { limactl shell "$vm" bash -c "cd ~ && export PATH=\$HOME/bin:\$PATH && $*"; }
kc() { in_vm "kubectl --context kind-demo $*"; }
say() { printf '\n== %s\n' "$*"; }

# The scenarios: the one table later slices change. One line each:
#   name  platforms  top cause on kubernetes  on docker  subject on kubernetes  on docker  check
# The expected causes are ADR-150's codes ("-": no form on that platform, ADR-149). The
# subjects are GET /causes?subject=<kind>:<ref> (ADR-148); an application's ref is its name
# and `check` turns it into its id. `check` asserts the top cause when the last column is
# "on" and only reports it when "pending": a slice turns a scenario on with its rules.
SCENARIOS='
dependency-down        kubernetes,docker  dependency_down      dependency_down      workload:causes-e2e/web        compose_service:causes-e2e/web      pending
bad-change             kubernetes,docker  image_pull           bad_change           workload:causes-e2e/release    container:causes-e2e-release-1      pending
oom                    kubernetes,docker  oom_limit            oom_limit            workload:causes-e2e/hog        container:causes-e2e-hog-1          pending
crash                  kubernetes,docker  crash_exit           crash_exit           workload:causes-e2e/crasher    container:causes-e2e-crasher-1      pending
node                   kubernetes,docker  node_or_host         node_or_host         workload:causes-e2e/pinned     compose_service:causes-e2e/api      pending
dns-typo               kubernetes,docker  dns_nxdomain         dns_nxdomain         workload:causes-e2e/typo       compose_service:causes-e2e/typo     pending
cpu-throttle           kubernetes,docker  cpu_throttled        cpu_throttled        workload:causes-e2e/caller     compose_service:causes-e2e/caller   pending
pg-leak                kubernetes,docker  application_finding  application_finding  application:causes-e2e/pg      application:causes-e2e/pg           pending
rabbitmq-consumer-oom  kubernetes,docker  application_finding  application_finding  application:rabbitmq-e2e/rabbitmq  application:rabbitmq-e2e/rabbitmq  pending
slow-change            kubernetes,docker  bad_change           bad_change           workload:causes-e2e/front      compose_service:causes-e2e/front    pending
'

# What each trigger and restore does, for `list` (the functions below do it).
describe() {
  case "$1" in
    dependency-down) echo "kubernetes: scale api to 0 (web calls it) | docker: docker stop causes-e2e-api-1" ;;
    bad-change) echo "kubernetes: set image release to a missing tag (ImagePullBackOff) | docker: re-create release with busybox:1.36 and a command that exits 1" ;;
    oom) echo "both: start hog, which grows 1 MiB/s to its 48 MiB limit and is OOM-killed (exit 137), again and again" ;;
    crash) echo "both: start crasher, which exits 3 after 15 s, again and again" ;;
    node) echo "kubernetes: cordon demo-worker2, evict causes-e2e's pods (pinned stays Pending) | docker: stop the agent that reports to WATCHLOG_URL" ;;
    dns-typo) echo "both: start typo, which calls http://catalgo.invalid:9898 (NXDOMAIN) every 5 s" ;;
    cpu-throttle) echo "both: hot (CPU limit 20m) starts a busy loop; caller's requests to it slow down" ;;
    pg-leak) echo "both: start leak, which opens 37 of pg's 40 connections (92 %) and leaves them idle" ;;
    rabbitmq-consumer-oom) echo "both: start rabbitmq-e2e's publisher and consumer; the consumer is OOM-killed after a minute, orders grows" ;;
    slow-change) echo "kubernetes: roll out slow with podinfo's 1-3 s random delay | docker: re-create slow with it (front calls it)" ;;
  esac
}

row() { # the table's line for a scenario, or nothing
  printf '%s\n' "$SCENARIOS" | awk -v n="$1" '$1 == n'
}
platforms() { # the platforms to act on: the one named, else the scenario's
  local all
  all=$(row "$1" | awk '{print $2}' | tr , ' ')
  if [ -n "${2:-}" ]; then
    case " $all " in *" $2 "*) echo "$2" ;; *)
      echo "$1 has no $2 form" >&2
      exit 2
      ;;
    esac
  else
    echo "$all"
  fi
}

port=${url##*:}
port=${port%%/*}
# The Docker agents that report to the backend under test: their endpoint's port is its port.
agents_of_backend='for c in $(docker ps -a --format "{{.Names}}"); do
    case $(docker inspect -f "{{.Config.Image}}" "$c") in */agent:*) ;; *) continue ;; esac
    ep=$(docker inspect -f "{{range .Config.Env}}{{println .}}{{end}}" "$c" | sed -n "s/^WATCHLOG_ENDPOINT=//p")
    [ "${ep##*:}" = "'"$port"'" ] && echo "$c"
  done; true'

# kubernetes|docker trigger|restore: one function per scenario.
act_dependency_down() {
  case "$1 $2" in
    "kubernetes trigger") kc "-n $ns scale deploy/api --replicas 0" ;;
    "kubernetes restore") kc "-n $ns scale deploy/api --replicas 1" ;;
    "docker trigger") in_vm "docker stop causes-e2e-api-1 >/dev/null" ;;
    "docker restore") in_vm "docker start causes-e2e-api-1 >/dev/null" ;;
  esac
}
act_bad_change() {
  case "$1 $2" in
    "kubernetes trigger") kc "-n $ns set image deploy/release release=busybox:0.0-causes-e2e-missing" ;;
    "kubernetes restore") kc "-n $ns set image deploy/release release=busybox:1.37" ;;
    "docker trigger") in_vm "RELEASE_IMAGE=busybox:1.36 RELEASE_CMD='echo release 2 starting; exit 1' $compose up -d release 2>&1 | tail -n 2" ;;
    "docker restore") in_vm "$compose up -d release 2>&1 | tail -n 2" ;;
  esac
}
start_stop() { # kubernetes|docker trigger|restore <workload>: replicas 1 or 0, or the profile's container up or removed
  case "$1 $2" in
    "kubernetes trigger") kc "-n $ns scale deploy/$3 --replicas 1" ;;
    "kubernetes restore") kc "-n $ns scale deploy/$3 --replicas 0" ;;
    "docker trigger") in_vm "$compose up -d $3 2>&1 | tail -n 1" ;;
    "docker restore") in_vm "$compose rm -sf $3 2>&1 | tail -n 1" ;;
  esac
}
act_oom() { start_stop "$1" "$2" hog; }
act_crash() { start_stop "$1" "$2" crasher; }
act_dns_typo() { start_stop "$1" "$2" typo; }
act_pg_leak() { start_stop "$1" "$2" leak; }
act_node() {
  case "$1 $2" in
    "kubernetes trigger")
      kc "annotate node demo-worker2 causes-e2e/cordoned=true --overwrite >/dev/null"
      kc "drain demo-worker2 --ignore-daemonsets --delete-emptydir-data --pod-selector app.kubernetes.io/part-of=$ns --timeout 120s"
      ;;
    "kubernetes restore")
      kc "uncordon demo-worker2"
      kc "annotate node demo-worker2 causes-e2e/cordoned- >/dev/null"
      ;;
    "docker trigger")
      in_vm "mkdir -p $dir; a=\$($agents_of_backend); [ -n \"\$a\" ] || { echo 'no Docker agent reports to port $port' >&2; exit 1; }
        echo \"\$a\" >> $dir/stopped-agents; docker stop \$a"
      ;;
    "docker restore")
      in_vm "[ -s $dir/stopped-agents ] && docker start \$(sort -u $dir/stopped-agents) && rm -f $dir/stopped-agents || true"
      ;;
  esac
}
act_cpu_throttle() {
  local f=touch
  [ "$2" = restore ] && f='rm -f'
  case "$1" in
    kubernetes) kc "-n $ns exec deploy/hot -- $f /tmp/busy" ;;
    docker) in_vm "docker exec causes-e2e-hot-1 $f /tmp/busy" ;;
  esac
}
rabbit_ready() {
  case "$1" in
    kubernetes) kc "get namespace rabbitmq-e2e >/dev/null 2>&1" ;;
    docker) in_vm "[ -f ~/rabbitmq-e2e/compose.yaml ]" ;;
  esac || {
    echo "no rabbitmq-e2e fixtures on $1: run deploy/test/rabbitmq-e2e.sh first" >&2
    return 1
  }
}
act_rabbitmq_consumer_oom() {
  rabbit_ready "$1" || return 1
  local purge='rabbitmqctl -q purge_queue orders >/dev/null 2>&1 || true'
  case "$1 $2" in
    "kubernetes trigger")
      kc "-n rabbitmq-e2e scale deploy/publisher deploy/consumer --replicas 1"
      kc "-n rabbitmq-e2e rollout restart deploy/consumer"
      ;;
    "kubernetes restore")
      kc "-n rabbitmq-e2e scale deploy/publisher deploy/consumer --replicas 0"
      kc "-n rabbitmq-e2e exec rabbitmq-0 -- sh -c '$purge'"
      ;;
    "docker trigger") in_vm "docker compose -f ~/rabbitmq-e2e/compose.yaml up -d 2>&1 | tail -n 1" ;;
    "docker restore")
      in_vm "docker compose -f ~/rabbitmq-e2e/compose.yaml stop publisher consumer 2>&1 | tail -n 1
        docker exec rabbitmq-e2e-rabbitmq-1 sh -c '$purge'"
      ;;
  esac
}
act_slow_change() {
  local cmd='["./podinfo","--port=9898"]'
  [ "$2" = trigger ] && cmd='["./podinfo","--port=9898","--random-delay=true","--random-delay-min=1","--random-delay-max=3"]'
  case "$1 $2" in
    kubernetes*) kc "-n $ns patch deploy/slow -p '{\"spec\":{\"template\":{\"spec\":{\"containers\":[{\"name\":\"podinfo\",\"command\":$cmd}]}}}}'" ;;
    "docker trigger") in_vm "SLOW_DELAY=true $compose up -d slow 2>&1 | tail -n 1" ;;
    "docker restore") in_vm "$compose up -d slow 2>&1 | tail -n 1" ;;
  esac
}

# PostgreSQL creates WatchLog's pg_monitor role (the admin's password) whenever its data
# starts empty: after a drain or a re-create, the collector still logs in.
pg_init='psql -v ON_ERROR_STOP=1 -U postgres -v p="$POSTGRES_PASSWORD" <<SQL
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE ROLE watchlog LOGIN PASSWORD :'"'p'"';
GRANT pg_monitor TO watchlog;
SQL'

# The fixtures. Clients call their dependency through a Service (kind) or the Compose
# network's name (Docker), so each failure has an edge on the service map. typo's name is
# under .invalid, NXDOMAIN from any resolver: a short name like `catalgo` ends at the
# node's upstream resolver, and some answer SERVFAIL for single labels (Lima's does); a
# full in-cluster name is a search-path miss (ADR-113), never an NXDOMAIN. leak's sessions
# stay idle but send `select 1` every 30 s, so a psql whose server went away exits and the
# container starts again and reconnects.
manifest() {
  local small='{ requests: { cpu: 5m, memory: 8Mi }, limits: { cpu: 50m, memory: 16Mi } }'
  local podinfo='{ requests: { cpu: 5m, memory: 16Mi }, limits: { cpu: 100m, memory: 64Mi } }'
  cat <<YAML
apiVersion: v1
kind: Namespace
metadata: { name: $ns }
YAML
  # name^replicas^image^command^resources^extra pod spec
  for d in \
    "web^1^busybox:1.37^[sh, -c, 'while true; do wget -q -O /dev/null -T 2 http://api:9898/; sleep 1; done']^$small^" \
    "api^1^ghcr.io/stefanprodan/podinfo:6.16.0^[./podinfo, --port=9898]^$podinfo^" \
    "front^1^busybox:1.37^[sh, -c, 'while true; do wget -q -O /dev/null -T 5 http://slow:9898/; sleep 1; done']^$small^" \
    "slow^1^ghcr.io/stefanprodan/podinfo:6.16.0^[./podinfo, --port=9898]^$podinfo^" \
    "caller^1^busybox:1.37^[sh, -c, 'while true; do wget -q -O /dev/null -T 5 http://hot:8080/; sleep 1; done']^$small^" \
    "hot^1^busybox:1.37^[sh, -c, 'echo ok > /tmp/index.html; while true; do if [ -e /tmp/busy ]; then :; else sleep 1; fi; done & exec httpd -f -p 8080 -h /tmp']^{ requests: { cpu: 5m, memory: 8Mi }, limits: { cpu: 20m, memory: 16Mi } }^" \
    "release^1^busybox:1.37^[sh, -c, 'exec sleep 2147483647']^$small^" \
    "hog^0^busybox:1.37^[sh, -c, 'echo loading the catalog; sleep 10; (while true; do head -c 1048576 /dev/zero || exit; sleep 1; done) | tail']^{ requests: { cpu: 5m, memory: 16Mi }, limits: { cpu: 100m, memory: 48Mi } }^" \
    "crasher^0^busybox:1.37^[sh, -c, 'echo importing; sleep 15; echo cannot open /data/input.csv; exit 3']^$small^" \
    "pinned^1^busybox:1.37^[sh, -c, 'exec sleep 2147483647']^$small^nodeSelector: { kubernetes.io/hostname: demo-worker2 }" \
    "typo^0^busybox:1.37^[sh, -c, 'while true; do wget -q -O /dev/null -T 2 http://catalgo.invalid:9898/; sleep 5; done']^$small^" \
    "pg^1^postgres:16-alpine^[docker-entrypoint.sh, postgres, -c, max_connections=40, -c, superuser_reserved_connections=0, -c, shared_buffers=16MB, -c, shared_preload_libraries=pg_stat_statements]^{ requests: { cpu: 10m, memory: 64Mi }, limits: { cpu: 500m, memory: 256Mi } }^" \
    "leak^0^postgres:16-alpine^[sh, -c, 'for i in \$(seq 37); do (while sleep 30; do echo \"select 1;\"; done | psql -h pg -U postgres -q >/dev/null 2>&1) & sleep 0.2; done; wait']^{ requests: { cpu: 10m, memory: 32Mi }, limits: { cpu: 200m, memory: 192Mi } }^"; do
    IFS='^' read -r name replicas image command resources extra <<<"$d"
    local env='' mounts='' cname=$name
    [ "$name" = api ] || [ "$name" = slow ] && cname=podinfo
    case $name in
      pg)
        env='env: [{ name: POSTGRES_PASSWORD, valueFrom: { secretKeyRef: { name: pg-admin, key: password } } }]'
        mounts='volumeMounts: [{ name: init, mountPath: /docker-entrypoint-initdb.d }]'
        extra='volumes: [{ name: init, configMap: { name: pg-init } }]'
        ;;
      leak) env='env: [{ name: PGPASSWORD, valueFrom: { secretKeyRef: { name: pg-admin, key: password } } }]' ;;
    esac
    cat <<YAML
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: $name, namespace: $ns }
spec:
  replicas: $replicas
  selector: { matchLabels: { app: $name } }
  template:
    metadata: { labels: { app: $name, "app.kubernetes.io/part-of": $ns } }
    spec:
      terminationGracePeriodSeconds: 2
YAML
    if [ -n "$extra" ]; then echo "      $extra"; fi
    cat <<YAML
      containers:
        - name: $cname
          image: $image
          imagePullPolicy: IfNotPresent
          command: $command
          resources: $resources
YAML
    if [ -n "$env" ]; then echo "          $env"; fi
    if [ -n "$mounts" ]; then echo "          $mounts"; fi
  done
  cat <<YAML
---
apiVersion: v1
kind: ConfigMap
metadata: { name: pg-init, namespace: $ns }
data:
  watchlog.sh: |
$(printf '%s\n' "$pg_init" | sed 's/^/    /')
YAML
  for s in api:9898 slow:9898 hot:8080 pg:5432; do
    cat <<YAML
---
apiVersion: v1
kind: Service
metadata: { name: ${s%%:*}, namespace: $ns }
spec: { selector: { app: ${s%%:*} }, ports: [{ port: ${s##*:} }] }
YAML
  done
}

compose_file() {
  cat <<'YAML'
# causes-e2e.sh: the Docker host's fixtures (Compose project causes-e2e). The services in
# profile "scenario" start only when a trigger names them.
name: causes-e2e
x-small: &small
  image: busybox:1.37
  mem_limit: 16m
  cpus: 0.05
  restart: unless-stopped
services:
  web:
    <<: *small
    command: [sh, -c, 'while true; do wget -q -O /dev/null -T 2 http://api:9898/; sleep 1; done']
  api:
    image: ghcr.io/stefanprodan/podinfo:6.16.0
    command: [./podinfo, --port=9898]
    mem_limit: 64m
    restart: unless-stopped
  front:
    <<: *small
    command: [sh, -c, 'while true; do wget -q -O /dev/null -T 5 http://slow:9898/; sleep 1; done']
  slow:
    image: ghcr.io/stefanprodan/podinfo:6.16.0
    command: [./podinfo, --port=9898, '--random-delay=${SLOW_DELAY:-false}', --random-delay-min=1, --random-delay-max=3]
    mem_limit: 64m
    restart: unless-stopped
  caller:
    <<: *small
    command: [sh, -c, 'while true; do wget -q -O /dev/null -T 5 http://hot:8080/; sleep 1; done']
  hot:
    <<: *small
    cpus: 0.02
    command: [sh, -c, 'echo ok > /tmp/index.html; while true; do if [ -e /tmp/busy ]; then :; else sleep 1; fi; done & exec httpd -f -p 8080 -h /tmp']
  release:
    <<: *small
    image: ${RELEASE_IMAGE:-busybox:latest}
    command: [sh, -c, '${RELEASE_CMD:-exec sleep 2147483647}']
  pg:
    image: postgres:16-alpine
    env_file: [pg.env]
    volumes: [./initdb:/docker-entrypoint-initdb.d:ro]
    command: [postgres, -c, max_connections=40, -c, superuser_reserved_connections=0, -c, shared_buffers=16MB, -c, shared_preload_libraries=pg_stat_statements]
    mem_limit: 256m
    restart: unless-stopped
  hog:
    <<: *small
    profiles: [scenario]
    mem_limit: 48m
    command: [sh, -c, 'echo loading the catalog; sleep 10; (while true; do head -c 1048576 /dev/zero || exit; sleep 1; done) | tail']
  crasher:
    <<: *small
    profiles: [scenario]
    command: [sh, -c, 'echo importing; sleep 15; echo cannot open /data/input.csv; exit 3']
  typo:
    <<: *small
    profiles: [scenario]
    command: [sh, -c, 'while true; do wget -q -O /dev/null -T 2 http://catalgo.invalid:9898/; sleep 5; done']
  leak:
    image: postgres:16-alpine
    profiles: [scenario]
    env_file: [pg.env]
    mem_limit: 192m
    restart: unless-stopped
    command: [sh, -c, 'for i in $$(seq 37); do (while sleep 30; do echo "select 1;"; done | psql -h pg -U postgres -q >/dev/null 2>&1) & sleep 0.2; done; wait']
YAML
}

# The API side (`up` monitors, `check` asserts, `down` unmonitors), in Python as the other
# e2e scripts. $1: monitor | check | unmonitor; the rest: scenario names.
api() {
  : "${WATCHLOG_E2E_EMAIL:?}" "${WATCHLOG_E2E_PASSWORD:?}"
  WATCHLOG_URL=$url VM=$vm SCENARIOS=$SCENARIOS DOCKER_HOST_NAME=$(in_vm hostname) python3 - "$@" <<'PY'
import http.cookiejar, json, os, subprocess, sys, time, urllib.error, urllib.parse, urllib.request

url = os.environ["WATCHLOG_URL"] + "/api/v1"
vm, host = os.environ["VM"], os.environ["DOCKER_HOST_NAME"]
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

def call(method, path, body=None, raw=False):
    req = urllib.request.Request(url + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"content-type": "application/json"} if body is not None else {})
    try:
        with opener.open(req, timeout=60) as res:
            data = res.read()
            return (res.status, json.loads(data) if data else None) if raw else (json.loads(data) if data else None)
    except urllib.error.HTTPError as e:
        if not raw:
            raise
        data = e.read()
        try:
            return e.code, json.loads(data) if data else None
        except ValueError:
            return e.code, None

def wait(fn, timeout, every=5):
    deadline = time.time() + timeout
    while True:
        got = fn()
        if got or time.time() > deadline:
            return got
        time.sleep(every)

call("POST", "/auth/login", {"email": os.environ["WATCHLOG_E2E_EMAIL"], "password": os.environ["WATCHLOG_E2E_PASSWORD"]})
clusters = call("GET", "/clusters")["clusters"]
def cluster(kind):
    want = os.environ.get("WATCHLOG_E2E_KUBE_CLUSTER" if kind == "kubernetes" else "WATCHLOG_E2E_DOCKER_CLUSTER")
    cs = [c for c in clusters if c["kind"] == kind and (not want or want in (c["id"], c["name"]))]
    if len(cs) != 1:
        sys.exit(f"{len(cs)} {kind} clusters match: set WATCHLOG_E2E_{'KUBE' if kind == 'kubernetes' else 'DOCKER'}_CLUSTER")
    return cs[0]

# The applications this script monitors: (type, name, default alerts).
APPS = [("postgres", "causes-e2e/pg", ["postgres_connections_high"]),
        ("rabbitmq", "rabbitmq-e2e/rabbitmq", ["rabbitmq_queue_unconsumed", "rabbitmq_node_down"])]
def monitored(kind):
    cid = cluster(kind)["id"]
    return {(a["type"], a["name"]): a for a in call("GET", "/applications")["applications"] if a["cluster"]["id"] == cid}

mode, args = sys.argv[1], sys.argv[2:]
if mode == "monitor":
    pg_password = subprocess.run(["limactl", "shell", vm, "bash", "-c", "cat ~/causes-e2e/pg-password"],
                                 capture_output=True, text=True, check=True).stdout.strip()
    for kind in ("kubernetes", "docker"):
        cid = cluster(kind)["id"]
        have = monitored(kind)
        for typ, name, alerts in APPS:
            if (typ, name) in have:
                print(f"{kind} {name}: monitored already")
                continue
            if name.startswith("rabbitmq-e2e") and kind not in args:
                continue  # no rabbitmq-e2e fixtures on that platform
            def found():
                return next((d for d in call("GET", "/applications/discovered")["discovered"]
                             if d["cluster"]["id"] == cid and d["type"] == typ and d["name"] == name), None)
            d = wait(found, 240)
            if not d:
                print(f"{kind} {name}: not discovered in 4 minutes", file=sys.stderr)
                sys.exit(1)
            body = {"clusterId": cid, "type": typ, "target": d["target"], "defaultAlerts": alerts}
            if typ == "postgres":
                p = {"clusterId": cid, "type": typ, "target": d["target"],
                     "access": {"method": "entered", "username": "watchlog", "password": pg_password}}
                if d["target"]["kind"] == "address":
                    p["collectorHost"] = host
                probe = call("POST", "/applications/probes", p)["probe"]
                ok = wait(lambda: (lambda q: q if q["status"] == "ok" else None)(call("GET", f"/applications/probes/{probe['id']}")["probe"]), 120)
                if not ok:
                    print(f"{kind} {name}: the connection test did not pass: {json.dumps(call('GET', '/applications/probes/' + probe['id']))[:300]}", file=sys.stderr)
                    sys.exit(1)
                body["probeId"] = probe["id"]
            call("POST", "/applications", body)
            print(f"{kind} {name}: monitored")
elif mode == "unmonitor":
    for kind in ("kubernetes", "docker"):
        for (typ, name), a in monitored(kind).items():
            if (typ, name) in {(t, n) for t, n, _ in APPS}:
                call("DELETE", f"/applications/{a['id']}")
                print(f"{kind} {name}: no longer monitored")
elif mode == "check":
    rows = [l.split() for l in os.environ["SCENARIOS"].strip().splitlines()]
    if args:
        unknown = set(args) - {r[0] for r in rows}
        if unknown:
            sys.exit(f"unknown scenario: {' '.join(sorted(unknown))}")
        rows = [r for r in rows if r[0] in args]
    failures = pending = 0
    for name, plats, k_cause, d_cause, k_subj, d_subj, state in rows:
        for kind in plats.split(","):
            expected, subject = (k_cause, k_subj) if kind == "kubernetes" else (d_cause, d_subj)
            c = cluster(kind)
            label = f"{name} on {kind}"
            if subject.startswith("application:"):
                a = next((x for x in monitored(kind).values() if x["name"] == subject.split(":", 1)[1]), None)
                if not a:
                    print(f"FAIL  {label}: {subject} is not monitored (run `up`)")
                    failures += 1
                    continue
                subject = f"application:{a['id']}"
            q = urllib.parse.urlencode({"cluster": c["id"], "subject": subject})
            status, body = call("GET", f"/causes?{q}", raw=True)
            if status == 404 and str((body or {}).get("detail", "")).startswith("No route for"):
                print(f"PENDING  {label}: expects {expected} (route not built)")
                pending += 1
                continue
            if status != 200:
                print(f"FAIL  {label}: GET /causes answered {status}: {json.dumps(body)[:300]}")
                failures += 1
                continue
            causes = body.get("causes") or []
            top = causes[0]["code"] if causes else "none"
            strength = causes[0].get("strength", "") if causes else ""
            if state != "on":
                print(f"PENDING  {label}: top cause {top} {strength}, expects {expected} (not asserted yet)")
                pending += 1
            elif top == expected:
                print(f"PASS  {label}: {top} ({strength})")
            else:
                print(f"FAIL  {label}: top cause {top}, expects {expected}: {json.dumps(causes)[:400]}")
                failures += 1
    print(f"\n{failures} failed, {pending} pending" if failures else f"\nall asserted passed, {pending} pending")
    sys.exit(1 if failures else 0)
PY
}

cmd=${1:-}
[ $# -gt 0 ] && shift
case "$cmd" in
  list)
    printf '%-22s %-18s %-20s %-20s %s\n' scenario platforms kubernetes docker check
    printf '%s\n' "$SCENARIOS" | awk 'NF {printf "%-22s %-18s %-20s %-20s %s\n", $1, $2, $3, $4, $7}'
    echo
    for s in $(printf '%s\n' "$SCENARIOS" | awk 'NF {print $1}'); do
      printf '%-22s %s\n' "$s" "$(describe "$s")"
    done
    ;;
  up)
    say "kind: namespace $ns"
    in_vm "mkdir -p $dir && chmod 700 $dir && { [ -s $dir/pg-password ] || (umask 077; head -c 18 /dev/urandom | base64 | tr -dc A-Za-z0-9 > $dir/pg-password); }
      (umask 077; p=\$(cat $dir/pg-password); printf 'POSTGRES_PASSWORD=%s\nPGPASSWORD=%s\n' \"\$p\" \"\$p\" > $dir/pg.env)"
    manifest | kc "apply -f - >/dev/null"
    kc "-n $ns create secret generic pg-admin --from-file=password=\$HOME/causes-e2e/pg-password --dry-run=client -o yaml | kubectl --context kind-demo apply -f - >/dev/null"
    say "Docker: Compose project causes-e2e"
    compose_file | in_vm "cat > $dir/compose.yaml"
    printf '%s\n' "$pg_init" | in_vm "mkdir -p $dir/initdb && cat > $dir/initdb/watchlog.sh"
    in_vm "docker pull -q busybox:1.37 >/dev/null && docker pull -q busybox:1.36 >/dev/null && $compose up -d --quiet-pull 2>&1 | tail -n 1"
    say "PostgreSQL: a pg_monitor role watchlog, with the fixture's password"
    sql="SET client_min_messages = warning;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'watchlog') THEN CREATE ROLE watchlog LOGIN; END IF; END \$\$;
ALTER ROLE watchlog PASSWORD :'p';
GRANT pg_monitor TO watchlog;"
    ready='for i in $(seq 90); do pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1'
    kc "-n $ns rollout status deploy/pg --timeout 180s >/dev/null"
    kc "-n $ns exec deploy/pg -- sh -c '$ready'"
    in_vm "docker exec causes-e2e-pg-1 sh -c '$ready'"
    printf '%s' "$sql" | limactl shell "$vm" bash -c "cd ~ && export PATH=\$HOME/bin:\$PATH && sql=\$(cat) && p=\$(cat causes-e2e/pg-password) &&
      printf '%s' \"\$sql\" | kubectl --context kind-demo -n $ns exec -i deploy/pg -- psql -q -U postgres -v ON_ERROR_STOP=1 -v p=\"\$p\" >/dev/null &&
      printf '%s' \"\$sql\" | docker exec -i causes-e2e-pg-1 psql -q -U postgres -v ON_ERROR_STOP=1 -v p=\"\$p\" >/dev/null"
    say "rabbitmq-e2e (deploy/test/rabbitmq-e2e.sh): quiet until the trigger"
    rabbit=()
    for p in kubernetes docker; do
      rabbit_ready $p 2>/dev/null || continue
      [ $p = docker ] && in_vm 'docker compose -f ~/rabbitmq-e2e/compose.yaml up -d rabbitmq >/dev/null 2>&1
        for _ in $(seq 60); do docker exec rabbitmq-e2e-rabbitmq-1 rabbitmq-diagnostics -q check_running >/dev/null 2>&1 && break; sleep 2; done'
      act_rabbitmq_consumer_oom $p restore >/dev/null
      rabbit+=("$p")
    done
    echo "rabbitmq-e2e on: ${rabbit[*]:-none (rabbitmq-consumer-oom needs deploy/test/rabbitmq-e2e.sh)}"
    kc "-n $ns rollout status deploy --timeout 180s >/dev/null"
    if [ -n "${WATCHLOG_E2E_EMAIL:-}" ]; then
      say "monitored applications"
      api monitor ${rabbit[@]+"${rabbit[@]}"}
    else
      echo "WATCHLOG_E2E_EMAIL unset: the applications are not monitored"
    fi
    in_vm "kubectl --context kind-demo -n $ns get pods --no-headers; docker ps -a --filter label=com.docker.compose.project=causes-e2e --format '{{.Names}}\t{{.Status}}'"
    ;;
  trigger | restore)
    s=${1:?scenario (see list)}
    [ -n "$(row "$s")" ] || {
      echo "unknown scenario $s (see list)" >&2
      exit 2
    }
    ps=$(platforms "$s" "${2:-}")
    for p in $ps; do
      say "$cmd $s on $p"
      "act_${s//-/_}" "$p" "$cmd"
    done
    ;;
  check)
    api check "$@"
    ;;
  down)
    if [ -n "${WATCHLOG_E2E_EMAIL:-}" ]; then
      api unmonitor
    fi
    in_vm "kubectl --context kind-demo get node demo-worker2 -o jsonpath='{.metadata.annotations}' 2>/dev/null | grep -q causes-e2e/cordoned &&
        { kubectl --context kind-demo uncordon demo-worker2 >/dev/null; kubectl --context kind-demo annotate node demo-worker2 causes-e2e/cordoned- >/dev/null; } || true
      [ -s $dir/stopped-agents ] && docker start \$(sort -u $dir/stopped-agents) >/dev/null || true
      kubectl --context kind-demo delete namespace $ns --ignore-not-found --wait=false >/dev/null
      [ -f $dir/compose.yaml ] && $compose --profile scenario down --volumes --remove-orphans >/dev/null 2>&1 || true
      rm -rf $dir"
    ;;
  *)
    sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 2
    ;;
esac
