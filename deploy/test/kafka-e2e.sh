#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Kafka end to end (v0.5 slice 4, SPEC §4.12, ADR-166) on the demo VM, after
# deploy/test/integrations-e2e.sh has started the agents (with eBPF) and the collectors
# (same backend, same environment variables). Kafka 4.1 as a single KRaft node
# (apache/kafka-native) on the kind cluster "demo" (namespace kafka-e2e, a StatefulSet
# advertising its pod's DNS name) and on the VM's Docker host (Compose project kafka-e2e,
# advertising `kafka:9092`, a name the host-network collector can't resolve: the
# collector dials the container instead, measured in slice 4). On each:
#   - a producer (20 messages/s to "orders", 3 partitions) and an `audit` consumer group
#     (kafka-console-consumer.sh) from the apache/kafka image's CLI;
#   - discovery, the probe with nothing to enter (a PLAINTEXT listener), the Kafka page and
#     its tabs, the brokers, the topic and the group with its member;
#   - lost:   audit consumes for a minute, then `tail /dev/zero` in the same shell grows
#             until its memory limit kills it (OOMKilled; on Kubernetes it crash-loops
#             without consuming again) → the group goes Empty while its lag grows →
#             group_no_members naming audit and how it ended; the top cause of the service
#             is application_finding (an app_group_* headline naming audit);
#   - broker: topic "ledger" with replication factor 1, then the only broker stops
#             (StatefulSet scaled to 0, `docker compose stop kafka`) → the service is
#             unreachable; started again, it connects.
#
#   kafka-e2e.sh up        the brokers, producer and consumer only, for a look
#   kafka-e2e.sh           everything above, then removes the scenario clients
#   kafka-e2e.sh down      removes what it made (only that: never the `watchlog` release or
#                          the watchlog-agent / watchlog-integrations containers)
#
# Images: apache/kafka-native:4.1.1 (the broker) and apache/kafka:4.1.1 (the CLI). Neither
# is mirrored on ECR Public's docker/library; when Docker Hub doesn't answer from the VM,
# load them into the VM's Docker first (pull elsewhere, `docker save --platform
# linux/arm64 … | limactl shell <vm> docker load`). kind gets them as archives on
# demo-worker only, where every fixture pod is pinned (the VM's disk is small).
#   VM (default watchlog-demo), WATCHLOG_URL (default http://127.0.0.1:4080),
#   WATCHLOG_E2E_EMAIL and WATCHLOG_E2E_PASSWORD, as integrations-e2e.sh.
#   CONSUMER_LIMIT (default 192Mi): the audit consumer's memory limit. The JVM console
#   consumer needs about 100 MiB to start; the demo kit's 64 MiB consumer is lighter.
# shellcheck disable=SC2016
set -euo pipefail
cd "$(dirname "$0")/../.."
vm=${VM:-watchlog-demo}
url=${WATCHLOG_URL:-http://127.0.0.1:4080}
ns=kafka-e2e
broker=apache/kafka-native:4.1.1
cli=apache/kafka:4.1.1
limit=${CONSUMER_LIMIT:-192Mi}
# The fixtures' folder in the VM (the tilde expands there).
# shellcheck disable=SC2088
dir='~/kafka-e2e'
compose="docker compose -p kafka-e2e -f $dir/compose.yaml"
in_vm() { limactl shell "$vm" bash -c "cd ~ && export PATH=\$HOME/bin:\$PATH && $*"; }
say() { printf '\n== %s\n' "$*"; }

images() {
  in_vm "for i in $broker $cli; do
      docker image inspect \$i >/dev/null 2>&1 || timeout 300 docker pull -q --platform linux/\$(dpkg --print-architecture) \$i >/dev/null || {
        echo \"\$i is missing in the VM's Docker and Docker Hub doesn't answer: load it first (see the header)\" >&2; exit 1; }
      docker exec demo-worker crictl inspecti docker.io/\$i >/dev/null 2>&1 || {
        docker save --platform linux/\$(dpkg --print-architecture) \$i -o /tmp/kafka-e2e.tar &&
          kind load image-archive --name demo --nodes demo-worker /tmp/kafka-e2e.tar >/dev/null; rm -f /tmp/kafka-e2e.tar; }
    done"
}

down() {
  in_vm "kubectl --context kind-demo delete namespace $ns --ignore-not-found --wait=false >/dev/null
    [ -f $dir/compose.yaml ] && $compose down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf $dir"
}

# The KRaft settings of one combined broker and controller, node 1, as NAME=value lines.
kraft_env() {
  printf '%s\n' \
    "KAFKA_NODE_ID=1" \
    "KAFKA_PROCESS_ROLES=broker,controller" \
    "KAFKA_LISTENERS=PLAINTEXT://:9092,CONTROLLER://:9093" \
    "KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://$1:9092" \
    "KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER" \
    "KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT" \
    "KAFKA_CONTROLLER_QUORUM_VOTERS=1@localhost:9093" \
    "KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1" \
    "KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1" \
    "KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1" \
    "KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS=0" \
    "KAFKA_NUM_PARTITIONS=3"
}
# As Kubernetes env entries (values quoted: some hold commas).
k_env() { kraft_env "$1" | sed -E 's/^([A-Z_]+)=(.*)$/            - { name: \1, value: "\2" }/'; }
# As Compose environment lines.
c_env() { kraft_env "$1" | sed -E 's/^([A-Z_]+)=(.*)$/      \1: "\2"/'; }

heap='KAFKA_HEAP_OPTS: "-Xms16m -Xmx48m -XX:+UseSerialGC -XX:TieredStopAtLevel=1"'
producer() { printf '%s' "/opt/kafka/bin/kafka-topics.sh --bootstrap-server $1 --create --if-not-exists --topic orders --partitions 3 --replication-factor 1 && exec /opt/kafka/bin/kafka-producer-perf-test.sh --topic orders --num-records 100000000 --record-size 100 --throughput 20 --producer-props bootstrap.servers=$1 acks=1"; }
# Consumes for a minute, then `tail` grows until the limit kills it (OOMKilled).
consumer() { printf '%s' "/opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server $1 --topic orders --group audit --consumer-property client.id=audit >/dev/null & sleep 60; exec tail /dev/zero"; }
# On Kubernetes the pod restarts it: it consumes only on its first run (a mark in an
# emptyDir, which lives as long as the pod), so the group keeps no member from the first
# kill on, and the pod crash-loops OOMKilled.
consumer_once() { printf '%s' "[ -e /state/ran ] || { touch /state/ran; /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server $1 --topic orders --group audit --consumer-property client.id=audit >/dev/null & sleep 60; }; exec tail /dev/zero"; }

up() {
  say "Kafka 4.1 (KRaft, one node) on kind (namespace $ns) and on the VM's Docker host (project kafka-e2e)"
  images
  in_vm "mkdir -p $dir"
  in_vm "kubectl --context kind-demo apply -f - >/dev/null" <<YAML
apiVersion: v1
kind: Namespace
metadata: { name: $ns }
---
apiVersion: v1
kind: Service
metadata: { name: kafka, namespace: $ns }
spec:
  clusterIP: None
  publishNotReadyAddresses: true
  selector: { app: kafka }
  ports: [{ name: kafka, port: 9092 }]
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: kafka, namespace: $ns }
spec:
  serviceName: kafka
  replicas: 1
  selector: { matchLabels: { app: kafka } }
  template:
    metadata: { labels: { app: kafka } }
    spec:
      nodeSelector: { kubernetes.io/hostname: demo-worker }
      containers:
        - name: kafka
          image: $broker
          imagePullPolicy: IfNotPresent
          ports: [{ name: kafka, containerPort: 9092 }]
          readinessProbe: { tcpSocket: { port: 9092 }, periodSeconds: 3 }
          resources: { limits: { memory: 384Mi } }
          env:
$(k_env "kafka-0.kafka.$ns.svc.cluster.local")
YAML
  in_vm "cat > $dir/compose.yaml" <<YAML
name: kafka-e2e
services:
  kafka:
    image: $broker
    mem_limit: 384m
    environment:
$(c_env kafka)
  producer:
    image: $cli
    depends_on: [kafka]
    restart: on-failure
    environment:
      $heap
    entrypoint: [sh, -c, '$(producer kafka:9092)']
  audit:
    image: $cli
    depends_on: [kafka]
    profiles: [scenario]
    mem_limit: ${limit/Mi/m}
    restart: "no"
    environment:
      $heap
    entrypoint: [sh, -c, '$(consumer kafka:9092)']
YAML
  in_vm "kubectl --context kind-demo -n $ns rollout status statefulset/kafka --timeout 300s >/dev/null && $compose up -d --quiet-pull kafka producer >/dev/null"
  k_clients 1 0
}

# The Kubernetes producer and consumer, pinned to demo-worker; the consumer starts at the
# given replicas (the scenario scales it up).
k_clients() {
  in_vm "kubectl --context kind-demo -n $ns apply -f - >/dev/null" <<YAML
apiVersion: apps/v1
kind: Deployment
metadata: { name: producer }
spec:
  replicas: $1
  selector: { matchLabels: { app: producer } }
  template:
    metadata: { labels: { app: producer } }
    spec:
      nodeSelector: { kubernetes.io/hostname: demo-worker }
      containers:
        - name: producer
          image: $cli
          imagePullPolicy: IfNotPresent
          command: [sh, -c, '$(producer kafka-0.kafka:9092)']
          env: [{ name: KAFKA_HEAP_OPTS, value: "-Xms16m -Xmx48m -XX:+UseSerialGC -XX:TieredStopAtLevel=1" }]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: audit }
spec:
  replicas: $2
  selector: { matchLabels: { app: audit } }
  template:
    metadata: { labels: { app: audit } }
    spec:
      nodeSelector: { kubernetes.io/hostname: demo-worker }
      containers:
        - name: audit
          image: $cli
          imagePullPolicy: IfNotPresent
          command: [sh, -c, '$(consumer_once kafka-0.kafka:9092)']
          env: [{ name: KAFKA_HEAP_OPTS, value: "-Xms16m -Xmx48m -XX:+UseSerialGC -XX:TieredStopAtLevel=1" }]
          resources: { limits: { memory: $limit } }
          volumeMounts: [{ name: state, mountPath: /state }]
      volumes: [{ name: state, emptyDir: {} }]
YAML
}

case "${1:-}" in
  down)
    down
    exit 0
    ;;
  up)
    down
    in_vm "kubectl --context kind-demo wait --for=delete namespace/$ns --timeout 180s >/dev/null 2>&1 || true"
    up
    exit 0
    ;;
esac
: "${WATCHLOG_E2E_EMAIL:?}" "${WATCHLOG_E2E_PASSWORD:?}"
# A previous run's brokers and groups would make this one pass or fail for the wrong
# reason: start clean.
down
in_vm "kubectl --context kind-demo wait --for=delete namespace/$ns --timeout 180s >/dev/null 2>&1 || true"
up

say "discover, test and monitor; the page; the lost group and its cause; the broker"
WATCHLOG_URL=$url VM=$vm NS=$ns DIR=$dir python3 - <<'PY'
import atexit, http.cookiejar, json, os, re, subprocess, sys, time, urllib.error, urllib.parse, urllib.request

url = os.environ["WATCHLOG_URL"] + "/api/v1"
vm, ns, d_ = os.environ["VM"], os.environ["NS"], os.environ["DIR"]
compose = f"docker compose -p kafka-e2e -f {d_}/compose.yaml"
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

def call(method, path, body=None, ok=True):
    req = urllib.request.Request(url + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"content-type": "application/json"} if body is not None else {})
    try:
        with opener.open(req, timeout=30) as res:
            raw = res.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        if ok:
            raise
        return json.loads(e.read() or b"{}")

def vm_run(cmd):
    cmd = re.sub(r"^kubectl ", "kubectl --context kind-demo ", cmd)
    r = subprocess.run(["limactl", "shell", vm, "bash", "-c", "cd ~ && export PATH=$HOME/bin:$PATH && " + cmd],
                       capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise RuntimeError(f"{cmd[:80]}: {r.stderr.strip()[:300]}")
    return r.stdout

call("POST", "/auth/login", {"email": os.environ["WATCHLOG_E2E_EMAIL"], "password": os.environ["WATCHLOG_E2E_PASSWORD"]})
failures = 0
def check(name, ok, detail=""):
    global failures
    print(("PASS  " if ok else "FAIL  ") + name + (f": {detail}" if detail and not ok else ""), flush=True)
    failures += 0 if ok else 1

def wait(fn, timeout=120, every=5):
    deadline = time.time() + timeout
    v = fn()
    while not v and time.time() < deadline:
        time.sleep(every)
        v = fn()
    return v

# The CLI containers run apache/kafka: discovery may offer them too (slice 2's note); only
# the brokers are wanted here.
K, D = ("kubernetes", f"{ns}/kafka"), ("docker", "kafka-e2e/kafka")
want = {K: "kubernetes", D: "docker"}
for x in call("GET", "/applications")["applications"]:
    if x["type"] == "kafka" and (x["cluster"]["kind"], x["name"]) in want:
        call("DELETE", f"/applications/{x['id']}")
def found():
    d = {(x["cluster"]["kind"], x["name"]): x for x in call("GET", "/applications/discovered")["discovered"] if x["type"] == "kafka"}
    return d if set(want) <= set(d) else None
d = wait(found, 240) or {}
check("Kafka on kind and on Docker is discovered (port 9092)",
      bool(d) and all(d[k]["port"] == 9092 for k in want), str(sorted(d)))
if not d:
    sys.exit(1)

def settle(pid, timeout=90):
    def done():
        q = call("GET", f"/applications/probes/{pid}")["probe"]
        return q if q["status"] == "ok" or (q["result"] and q["result"]["code"] != "unreachable" and q["attempts"] >= 2) else None
    return wait(done, timeout, 3) or call("GET", f"/applications/probes/{pid}")["probe"]

monitored = []
@atexit.register
def cleanup():
    for m in monitored:
        call("DELETE", f"/applications/{m}", ok=False)
    try:
        vm_run(f"kubectl -n {ns} delete deployment audit producer --ignore-not-found >/dev/null; kubectl -n {ns} scale statefulset kafka --replicas 1 >/dev/null; "
               f"{compose} --profile scenario rm -sf audit producer >/dev/null 2>&1 || true")
    except Exception as e:  # noqa: BLE001
        print(f"cleanup: {e}")

TABS = ("overview", "topics", "consumer_groups", "brokers")
apps = {}
for key, label in want.items():
    svc = d[key]
    p = call("POST", "/applications/probes", {"clusterId": svc["cluster"]["id"], "type": "kafka", "target": svc["target"], "access": {"method": "none"}})
    q = settle(p["probe"]["id"])
    r = q.get("result") or {}
    check(f"{label}: the test passes on the PLAINTEXT listener (4.1, one broker)",
          q["status"] == "ok" and r.get("code") == "ok" and str(r.get("version", "")).startswith("4.") and r.get("facts", {}).get("brokers") == 1,
          json.dumps(q)[:400])
    apps[label] = a = call("POST", "/applications", {"clusterId": svc["cluster"]["id"], "type": "kafka", "target": svc["target"], "probeId": p["probe"]["id"]})["application"]["id"]
    monitored.append(a)

def app(label):
    return call("GET", f"/applications/{apps[label]}")
def reasons(label):
    return {r["code"]: r for r in app(label)["reasons"]}
def panels(label, tab):
    return {p["id"]: p for p in call("GET", f"/applications/{apps[label]}/panels?tab={tab}")["panels"]}

for label in apps:
    a = wait(lambda: (lambda x: x if x["application"]["reason"]["code"] == "connected" else None)(app(label)), 120)
    check(f"{label}: connected (on Docker through the advertised kafka:9092's container)", bool(a), json.dumps(app(label)["reasons"])[:300])
    check(f"{label}: the Kafka page and its tabs",
          bool(a) and a["page"]["id"] == "kafka" and [t["id"] for t in a["page"]["tabs"]][:4] == list(TABS),
          json.dumps(a and a["page"]["tabs"])[:300])
    s = wait(lambda: (lambda p: p if p["state"] == "ok" else None)(panels(label, "overview")["stats"]), 120)
    check(f"{label}: the Overview fills", bool(s), json.dumps(panels(label, "overview")["stats"])[:300])
    t = wait(lambda: any("orders" in json.dumps(r) for r in panels(label, "topics")["topics"].get("rows", [])), 120)
    check(f"{label}: orders in the topics table", bool(t))
    b = panels(label, "brokers")["brokers"]
    check(f"{label}: one broker, the controller", len(b.get("rows", [])) == 1, json.dumps(b)[:300])
    for tab in TABS:
        bad = [p for p, x in panels(label, tab).items() if x["state"] in ("error", "needs_permission")]
        check(f"{label}: {tab} has no failed or refused panel", not bad, str(bad))

# The lost group: audit consumes, then runs out of memory.
vm_run(f"kubectl -n {ns} scale deployment audit --replicas 1 >/dev/null; {compose} --profile scenario up -d --quiet-pull --no-deps audit >/dev/null")
who = {"kubernetes": f"{ns}/audit", "docker": "kafka-e2e-audit-1"}
for label in apps:
    m = wait(lambda: any("audit" in json.dumps(r) for r in panels(label, "consumer_groups")["members"].get("rows", [])), 180)
    check(f"{label}: audit is a member of its group, with its workload or container", bool(m) and who[label] in json.dumps(panels(label, "consumer_groups")["members"]),
          json.dumps(panels(label, "consumer_groups")["members"])[:300])
k_cluster, d_cluster = d[K]["cluster"]["id"], d[D]["cluster"]["id"]
for label, cluster in (("kubernetes", k_cluster), ("docker", d_cluster)):
    got = wait(lambda: (lambda r: r if r and r["facts"].get("group") == "audit" else None)(reasons(label).get("group_no_members")), 900, 15)
    check(f"{label}: group audit has no members and its lag grows", bool(got), json.dumps(list(reasons(label))))
    if got:
        check(f"{label}: names audit and how it ended ({got['facts'].get('member')}, {got['facts'].get('how')})",
              got["facts"].get("member") == who[label] and "OOMKilled" in (got["facts"].get("how") or ""), json.dumps(got))
        check(f"{label}: links to it", any(l["name"] == who[label] for l in got.get("links", [])), json.dumps(got.get("links")))
    def cause():
        c = call("GET", "/causes?" + urllib.parse.urlencode({"cluster": cluster, "subject": f"application:{apps[label]}"}), ok=False)
        top = (c.get("causes") or [None])[0]
        h = c.get("headline") or {}
        return c if top and top.get("rule", top.get("code")) == "application_finding" and str(h.get("code", "")).startswith("app_group_") else None
    c = wait(cause, 180, 10)
    check(f"{label}: the top cause is application_finding, an app_group_* headline naming audit",
          bool(c) and who[label] in json.dumps(c.get("headline", {})),
          json.dumps(call("GET", "/causes?" + urllib.parse.urlencode({"cluster": cluster, "subject": f"application:{apps[label]}"}), ok=False))[:500])
vm_run(f"kubectl -n {ns} scale deployment audit --replicas 0 >/dev/null; {compose} --profile scenario rm -sf audit >/dev/null")

# The broker: a topic with replication factor 1, then its only broker stops.
vm_run(f"kubectl -n {ns} exec deploy/producer -- /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka-0.kafka:9092 --create --if-not-exists --topic ledger --partitions 3 --replication-factor 1 >/dev/null; "
       f"{compose} exec -T producer /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:9092 --create --if-not-exists --topic ledger --partitions 3 --replication-factor 1 >/dev/null")
for label in apps:
    check(f"{label}: ledger listed", bool(wait(lambda: "ledger" in json.dumps(panels(label, "topics")["topics"]), 120)))
vm_run(f"kubectl -n {ns} scale statefulset kafka --replicas 0 >/dev/null; {compose} stop kafka >/dev/null")
for label in apps:
    a = wait(lambda: (lambda x: x if x["application"]["reason"]["code"] in ("unreachable", "member_down") else None)(app(label)), 180)
    check(f"{label}: with its only broker stopped, the service is unreachable", bool(a), json.dumps(app(label)["application"]["reason"]))
vm_run(f"kubectl -n {ns} scale statefulset kafka --replicas 1 >/dev/null; kubectl -n {ns} rollout status statefulset/kafka --timeout 300s >/dev/null; {compose} start kafka >/dev/null")
for label in apps:
    a = wait(lambda: (lambda x: x if x["application"]["reason"]["code"] == "connected" else None)(app(label)), 240)
    check(f"{label}: started again, it connects", bool(a), json.dumps(app(label)["application"]["reason"]))

metrics = call("GET", "/applications/metrics")["metrics"]
for label, aid in apps.items():
    km = metrics.get(aid, {}).get("keyMetrics", [])
    check(f"{label}: the list row has its numbers", any(k.get("value") is not None for k in km), json.dumps(km))

print(f"\n{failures} failed" if failures else "\nall passed")
sys.exit(1 if failures else 0)
PY
