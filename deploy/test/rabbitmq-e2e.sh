#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# RabbitMQ end to end (v0.3 slice 11, SPEC §4.12) on the demo VM, after
# deploy/test/demo-up.sh (or integrations-e2e.sh) started agents with eBPF and the
# integrations collectors for the backend at WATCHLOG_URL. On the kind cluster "demo"
# (namespace rabbitmq-e2e) and on the VM's Docker host (Compose project rabbitmq-e2e):
#   - RabbitMQ 4.1 with its prometheus plugin turned off; monitored through the API, the
#     page says so and gives the command, which is run as shown (kubectl exec / docker
#     exec); then the page fills;
#   - a publisher (perf-test, 20 messages/s to "orders") and a consumer that consumes for
#     a minute and is then OOM-killed (a 384 MiB limit and `tail /dev/zero`): on Docker
#     it stays dead, on Kubernetes it crash-loops;
#   - the queue grows with no consumers, and the reason names the consumer and how it
#     ended.
# `rabbitmq-e2e.sh down` removes what it made.
#   WATCHLOG_URL, WATCHLOG_E2E_EMAIL, WATCHLOG_E2E_PASSWORD   the backend and an account
#   VM                                                        the Lima VM (default watchlog-demo)
# shellcheck disable=SC2016
set -euo pipefail
cd "$(dirname "$0")/../.."
vm=${VM:-watchlog-demo}
url=${WATCHLOG_URL:-http://127.0.0.1:4080}
rabbit=rabbitmq:4.1
perf=pivotalrabbitmq/perf-test:2.25.0
in_vm() { limactl shell "$vm" bash -c "cd ~ && export PATH=\$HOME/bin:\$PATH && $*"; }
say() { printf '\n== %s\n' "$*"; }

down() {
  in_vm 'kubectl --context kind-demo delete namespace rabbitmq-e2e --ignore-not-found --wait=false >/dev/null
    [ -f ~/rabbitmq-e2e/compose.yaml ] && docker compose -f ~/rabbitmq-e2e/compose.yaml down --remove-orphans >/dev/null 2>&1 || true
    rm -rf ~/rabbitmq-e2e'
}
if [ "${1:-}" = down ]; then
  down
  exit 0
fi
: "${WATCHLOG_E2E_EMAIL:?}" "${WATCHLOG_E2E_PASSWORD:?}"
down
in_vm 'kubectl --context kind-demo wait --for=delete namespace/rabbitmq-e2e --timeout 120s >/dev/null 2>&1 || true'

publisher() { printf '%s' "[--uri, amqp://guest:guest@$1, -x, '1', -y, '0', -u, orders, -r, '20', -ad, 'false', -f, persistent]"; }
# Consumes for a minute, then `tail` (PID 1 by then) grows until the limit kills it.
consumer() { printf '%s' "java -jar /perf_test/perf-test.jar --uri amqp://guest:guest@$1 -x 0 -y 1 -u orders -ad false & sleep 60; exec tail /dev/zero"; }

say "images"
# kind's nodes pull them themselves (`kind load` fails on multi-arch images whose other
# platforms aren't in the local store).
in_vm "docker pull -q $rabbit >/dev/null && docker pull -q $perf >/dev/null"

say "Kubernetes: RabbitMQ, a publisher and a consumer that runs out of memory"
in_vm "kubectl --context kind-demo apply -f - >/dev/null" <<YAML
apiVersion: v1
kind: Namespace
metadata: { name: rabbitmq-e2e }
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: rabbitmq, namespace: rabbitmq-e2e }
spec:
  serviceName: rabbitmq
  selector: { matchLabels: { app: rabbitmq } }
  template:
    metadata: { labels: { app: rabbitmq } }
    spec:
      containers:
        - name: rabbitmq
          image: $rabbit
          ports: [{ name: amqp, containerPort: 5672 }, { name: prometheus, containerPort: 15692 }]
---
apiVersion: v1
kind: Service
metadata: { name: rabbitmq, namespace: rabbitmq-e2e }
spec: { selector: { app: rabbitmq }, ports: [{ name: amqp, port: 5672 }] }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: publisher, namespace: rabbitmq-e2e }
spec:
  selector: { matchLabels: { app: publisher } }
  template:
    metadata: { labels: { app: publisher } }
    spec:
      containers:
        - { name: publisher, image: $perf, args: $(publisher rabbitmq.rabbitmq-e2e) }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: consumer, namespace: rabbitmq-e2e }
spec:
  selector: { matchLabels: { app: consumer } }
  template:
    metadata: { labels: { app: consumer } }
    spec:
      containers:
        - name: consumer
          image: $perf
          command: [sh, -c, '$(consumer rabbitmq.rabbitmq-e2e)']
          resources: { limits: { memory: 384Mi } }
YAML
in_vm 'kubectl --context kind-demo -n rabbitmq-e2e rollout status statefulset/rabbitmq --timeout 300s >/dev/null &&
  until kubectl --context kind-demo -n rabbitmq-e2e logs rabbitmq-0 2>/dev/null | grep -q "Server startup complete"; do sleep 3; done &&
  kubectl --context kind-demo -n rabbitmq-e2e exec rabbitmq-0 -- rabbitmq-plugins disable rabbitmq_prometheus >/dev/null'

say "Docker: the same in Compose project rabbitmq-e2e"
in_vm "mkdir -p ~/rabbitmq-e2e && cat > ~/rabbitmq-e2e/compose.yaml" <<YAML
name: rabbitmq-e2e
services:
  rabbitmq:
    image: $rabbit
    hostname: rabbitmq
  publisher:
    image: $perf
    depends_on: [rabbitmq]
    restart: on-failure
    command: $(publisher rabbitmq)
  consumer:
    image: $perf
    depends_on: [rabbitmq]
    mem_limit: 384m
    restart: "no"
    entrypoint: [sh, -c, '$(consumer rabbitmq)']
YAML
in_vm 'docker compose -f ~/rabbitmq-e2e/compose.yaml up -d rabbitmq >/dev/null 2>&1 &&
  until docker logs rabbitmq-e2e-rabbitmq-1 2>&1 | grep -q "Server startup complete"; do sleep 3; done &&
  docker exec -u rabbitmq rabbitmq-e2e-rabbitmq-1 rabbitmq-plugins disable rabbitmq_prometheus >/dev/null &&
  docker compose -f ~/rabbitmq-e2e/compose.yaml up -d >/dev/null 2>&1'

say "discover, monitor, and what the pages say"
WATCHLOG_URL=$url VM=$vm python3 - <<'PY'
import http.cookiejar, json, os, subprocess, sys, time, urllib.request

url = os.environ["WATCHLOG_URL"] + "/api/v1"
vm = os.environ["VM"]
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

def call(method, path, body=None):
    req = urllib.request.Request(url + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"content-type": "application/json"} if body is not None else {})
    with opener.open(req, timeout=60) as res:
        raw = res.read()
        return json.loads(raw) if raw else None

call("POST", "/auth/login", {"email": os.environ["WATCHLOG_E2E_EMAIL"], "password": os.environ["WATCHLOG_E2E_PASSWORD"]})
failures = 0
def check(name, ok, detail=""):
    global failures
    print(("PASS  " if ok else "FAIL  ") + name + (f": {detail}" if detail and not ok else ""), flush=True)
    failures += 0 if ok else 1

def wait(fn, timeout, every=10):
    deadline = time.time() + timeout
    while True:
        got = fn()
        if got or time.time() > deadline:
            return got
        time.sleep(every)

ALERTS = ["rabbitmq_queue_unconsumed", "rabbitmq_alarm", "rabbitmq_unacked_high", "rabbitmq_node_down", "rabbitmq_dead_letters"]
want = {("kubernetes", "rabbitmq-e2e/rabbitmq"): "k8s", ("docker", "rabbitmq-e2e/rabbitmq"): "docker"}
for a in call("GET", "/applications")["applications"]:
    if a["type"] == "rabbitmq" and (a["cluster"]["kind"], a["name"]) in want:
        call("DELETE", f"/applications/{a['id']}")
def discovered():
    found = {(d["cluster"]["kind"], d["name"]): d for d in call("GET", "/applications/discovered")["discovered"] if d["type"] == "rabbitmq"}
    return found if all(k in found for k in want) else None
found = wait(discovered, 240) or {}
apps = {}
for key, label in want.items():
    d = found.get(key)
    check(f"discovered {key[0]} {key[1]} as RabbitMQ (port {d and d['port']})", bool(d) and d["port"] == 5672, str(sorted(found)))
    if d:
        apps[label] = call("POST", "/applications", {"clusterId": d["cluster"]["id"], "type": "rabbitmq", "target": d["target"], "defaultAlerts": ALERTS})["application"]["id"]
if failures:
    sys.exit(1)

def reasons(label):
    return {r["code"]: r for r in call("GET", f"/applications/{apps[label]}")["reasons"]}
def tab(label, t):
    return {p["id"]: p for p in call("GET", f"/applications/{apps[label]}/panels?tab={t}")["panels"]}

for label in apps:
    got = wait(lambda: "prometheus_plugin_off" in reasons(label), 180)
    cmd = (reasons(label).get("prometheus_plugin_off", {}).get("facts", {}).get("command") or "")
    want_cmd = "kubectl exec -n rabbitmq-e2e rabbitmq-0 -- rabbitmq-plugins enable rabbitmq_prometheus" if label == "k8s" else "docker exec rabbitmq-e2e-rabbitmq-1 rabbitmq-plugins enable rabbitmq_prometheus"
    check(f"{label}: the plugin is off, with the command", cmd == want_cmd, cmd)
    if cmd:
        shell = "export PATH=$HOME/bin:$PATH && cmd=$(cat) && " + ('eval "kubectl --context kind-demo ${cmd#kubectl }"' if label == "k8s" else 'eval "$cmd"')
        run = subprocess.run(["limactl", "shell", vm, "bash", "-c", shell], input=cmd, text=True, capture_output=True)
        check(f"{label}: the command runs as shown", run.returncode == 0, run.stderr[-300:])
    got = wait(lambda: "prometheus_plugin_off" not in reasons(label) and tab(label, "overview")["summary"]["state"] == "ok", 180)
    check(f"{label}: then the page fills", bool(got), json.dumps(list(reasons(label))))

for label in apps:
    got = wait(lambda: any(r["facts"].get("queue") == "orders" for r in [reasons(label).get("queue_no_consumers", {"facts": {}})]), 900, 15)
    r = reasons(label).get("queue_no_consumers")
    check(f"{label}: orders grows with no consumers", bool(got), json.dumps(list(reasons(label))))
    if r:
        who = "rabbitmq-e2e/consumer" if label == "k8s" else "rabbitmq-e2e-consumer-1"
        check(f"{label}: names the consumer and how it ended ({r['facts'].get('consumer')}, {r['facts'].get('how')})",
              r["facts"].get("consumer") == who and "OOMKilled" in (r["facts"].get("how") or ""), json.dumps(r))
        check(f"{label}: links to it", any(l["name"] == who for l in r.get("links", [])), json.dumps(r.get("links")))
    rows = tab(label, "overview")["queues"]["rows"]
    check(f"{label}: orders in the queues table", any(x["cells"][0] == "orders" for x in rows), json.dumps(rows[:3]))
    for t in ("overview", "queues", "rates", "resources"):
        ps = call("GET", f"/applications/{apps[label]}/panels?tab={t}")["panels"]
        check(f"{label}: {t} has no failed panel", all(p["state"] != "error" for p in ps), json.dumps([p["id"] for p in ps if p["state"] == "error"]))

metrics = call("GET", "/applications/metrics")["metrics"]
for label, aid in apps.items():
    km = {k["id"]: k["value"] for k in metrics.get(aid, {}).get("keyMetrics", [])}
    check(f"{label}: list row (ready {km.get('ready')})", (km.get("ready") or 0) > 0, json.dumps(km))
for aid in apps.values():
    call("DELETE", f"/applications/{aid}")
print(f"\n{failures} failed" if failures else "\nall passed")
sys.exit(1 if failures else 0)
PY
