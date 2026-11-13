#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# MongoDB end to end (v0.5 slice 2, SPEC §4.12, ADR-164) on the demo VM, after
# deploy/test/integrations-e2e.sh has started the agents and collectors (same backend,
# same environment variables). MongoDB 8.0 on the kind cluster "demo" (namespace
# mongodb-e2e, a StatefulSet of two members) and MongoDB 7.0 on the VM's Docker host
# (Compose project mongodb-e2e, two services), each a replica set "rs0" with
# authentication on (a key file) whose second member has no vote, so the first stays
# primary when the second goes:
#   - discovery of both, the replica set's members on the service;
#   - Kubernetes: WatchLog's generated user, its command run for real through
#     `kubectl exec` (the root password the command asks for at the prompt is given from
#     the pod's own environment), then the test passes with clusterMonitor and no excess
#     role, and every tab fills, the oplog window included (the optional read on local);
#     a wrong password fails as auth_failed, a user without clusterMonitor as
#     permission_missing naming it; the same server through a Secret: refused until the
#     Role and RoleBinding WatchLog writes are applied;
#   - Docker: WatchLog's user made by an admin with clusterMonitor only, its password in a
#     root-owned 0600 file under the collector's /etc/watchlog/secrets
#     (~/watchlog-e2e-secrets on the VM): the oplog tile says it needs read on local;
#   - the scenarios of phases/v0.5 on both platforms, each with probable cause's answer:
#       scan:   an `analytics` client runs an unindexed find on shop.events in a loop →
#               slow_collscan naming analytics; the top cause of the service is
#               application_finding (app_collscan, analytics as the client);
#       leak:   a `leak` holds about 83 of maxConns 100 (26 clients of three connections each and
#               mongosh's own five; about 94 % with the other member's and WatchLog's) → connections_near_max naming the leak;
#               application_finding (app_pg_held, the leak as holder);
#       member: the second member stops → member_down; application_finding naming it.
#
#   mongodb-e2e.sh up        the servers only (namespace and Compose project), for a look
#   mongodb-e2e.sh           everything above, then removes the scenario clients
#   mongodb-e2e.sh down      removes what it made
#
# Passwords are random per run and never printed, except the app user's, which only
# reaches the fixtures' own database.
#   VM (default watchlog-demo), WATCHLOG_URL (default http://127.0.0.1:4080),
#   WATCHLOG_E2E_EMAIL and WATCHLOG_E2E_PASSWORD, as integrations-e2e.sh.
# shellcheck disable=SC2016
set -euo pipefail
cd "$(dirname "$0")/../.."
vm=${VM:-watchlog-demo}
url=${WATCHLOG_URL:-http://127.0.0.1:4080}
ns=mongodb-e2e
# The fixtures' folder in the VM (the tilde expands there).
# shellcheck disable=SC2088
dir='~/mongodb-e2e'
compose="docker compose -p mongodb-e2e -f $dir/compose.yaml"
in_vm() { limactl shell "$vm" bash -c "cd ~ && export PATH=\$HOME/bin:\$PATH && $*"; }
say() { printf '\n== %s\n' "$*"; }

# The images, from Docker Hub or, when it doesn't answer, its mirror on ECR Public. Kind
# gets 8.0 as an archive (a multi-platform image's `kind load docker-image` can fail), on
# one worker only, where the pods are pinned: the VM's 30 GB disk doesn't hold three
# copies of the 1.3 GB image beside the others.
images() {
  in_vm 'pull() { docker image inspect mongo:$1 >/dev/null 2>&1 && return
      timeout 300 docker pull -q mongo:$1 >/dev/null 2>&1 || {
        docker pull -q public.ecr.aws/docker/library/mongo:$1 >/dev/null && docker tag public.ecr.aws/docker/library/mongo:$1 mongo:$1; }; }
    pull 7.0
    docker image inspect busybox:1.37 >/dev/null 2>&1 || docker pull -q busybox:1.37 >/dev/null
    docker exec demo-worker crictl inspecti docker.io/library/mongo:8.0 >/dev/null 2>&1 || {
      pull 8.0 && docker save --platform linux/$(dpkg --print-architecture) mongo:8.0 -o /tmp/mongo-e2e.tar &&
        kind load image-archive --name demo --nodes demo-worker /tmp/mongo-e2e.tar >/dev/null; rm -f /tmp/mongo-e2e.tar; }'
}

down() {
  in_vm "kubectl --context kind-demo delete namespace $ns --ignore-not-found --wait=false >/dev/null
    kubectl --context kind-demo -n watchlog-e2e delete secret mongodb-e2e-password --ignore-not-found >/dev/null
    kubectl --context kind-demo -n watchlog-e2e delete role,rolebinding watchlog-read-mongodb-e2e-password --ignore-not-found >/dev/null
    [ -f $dir/compose.yaml ] && $compose --profile scenario down -v --remove-orphans >/dev/null 2>&1 || true
    docker run --rm -v \$HOME/watchlog-e2e-secrets:/s busybox:1.37 rm -f /s/mongodb-e2e >/dev/null 2>&1 || true
    rm -rf $dir"
}

# Each member writes the shared key file (authentication between members) owned by the
# server's user, then starts through the image's entrypoint, which creates root on the
# first start.
# shellcheck disable=SC2089
start='printf "%s" "$MONGO_KEYFILE" > /tmp/keyfile && chmod 400 /tmp/keyfile && chown 999:999 /tmp/keyfile && exec docker-entrypoint.sh mongod --replSet rs0 --keyFile /tmp/keyfile --bind_ip_all --wiredTigerCacheSizeGB 0.25 --maxConns 100'

up() {
  say "MongoDB 8.0 on kind (namespace $ns), MongoDB 7.0 on the VM's Docker host (project mongodb-e2e)"
  admin=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
  watchlog=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
  key=$(head -c 512 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 400)
  images
  in_vm "mkdir -p $dir"
  printf '%s\n%s\n%s' "$admin" "$watchlog" "$key" | limactl shell "$vm" bash -c "cd ~ && export PATH=\$HOME/bin:\$PATH && read -r a && read -r w && read -r k; \
    kubectl --context kind-demo create namespace $ns --dry-run=client -o yaml | kubectl --context kind-demo apply -f - >/dev/null && \
    kubectl --context kind-demo -n $ns create secret generic mongo-admin --from-literal=password=\"\$a\" --from-literal=keyfile=\"\$k\" --dry-run=client -o yaml | kubectl --context kind-demo apply -f - >/dev/null && \
    kubectl --context kind-demo -n watchlog-e2e create secret generic mongodb-e2e-password --from-literal=password=\"\$w\" --dry-run=client -o yaml | kubectl --context kind-demo apply -f - >/dev/null && \
    printf 'MONGO_ROOT_PASSWORD=%s\nWATCHLOG_PASSWORD=%s\nMONGO_KEYFILE=%s\n' \"\$a\" \"\$w\" \"\$k\" > $dir/.env && chmod 600 $dir/.env && \
    printf '%s' \"\$w\" | docker run --rm -i -v \$HOME/watchlog-e2e-secrets:/s busybox:1.37 sh -c 'umask 077; cat > /s/mongodb-e2e'"
  in_vm "kubectl --context kind-demo -n $ns apply -f - >/dev/null" <<YAML
apiVersion: v1
kind: Service
metadata: { name: mongo }
spec:
  clusterIP: None
  publishNotReadyAddresses: true
  selector: { app: mongo }
  ports: [{ port: 27017 }]
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: mongo }
spec:
  serviceName: mongo
  replicas: 2
  podManagementPolicy: Parallel
  selector: { matchLabels: { app: mongo } }
  template:
    metadata: { labels: { app: mongo } }
    spec:
      nodeSelector: { kubernetes.io/hostname: demo-worker }
      containers:
        - name: mongo
          image: mongo:8.0
          imagePullPolicy: IfNotPresent
          command: ["bash", "-c", '$start']
          env:
            - { name: MONGO_INITDB_ROOT_USERNAME, value: root }
            - name: MONGO_INITDB_ROOT_PASSWORD
              valueFrom: { secretKeyRef: { name: mongo-admin, key: password } }
            - name: MONGO_KEYFILE
              valueFrom: { secretKeyRef: { name: mongo-admin, key: keyfile } }
          ports: [{ containerPort: 27017 }]
          resources: { limits: { memory: 512Mi } }
YAML
  # The scenario clients are Compose services under the "scenario" profile: `up` starts
  # only the two members.
  in_vm "cat > $dir/compose.yaml" <<YAML
name: mongodb-e2e
x-member: &member
  image: mongo:7.0
  command: ["bash", "-c", '${start//\$/\$\$}']
  environment:
    MONGO_INITDB_ROOT_USERNAME: root
    MONGO_INITDB_ROOT_PASSWORD: \${MONGO_ROOT_PASSWORD}
    MONGO_KEYFILE: \${MONGO_KEYFILE}
  mem_limit: 512m
x-client: &client
  image: mongo:7.0
  profiles: [scenario]
  depends_on: [mongo]
services:
  mongo: *member
  mongo-b: *member
  analytics:
    <<: *client
    command: ["mongosh", "--quiet", "mongodb://app:app-e2e-password@mongo:27017/shop?directConnection=true", "--eval",
      "while (true) { db.events.find({ kind: 'refund', amount: { \$\$gt: 90 } }).toArray(); sleep(200) }"]
  leak:
    <<: *client
    command: ["mongosh", "--quiet", "mongodb://app:app-e2e-password@mongo:27017/shop?directConnection=true", "--eval",
      "const held = []; for (let i = 0; i < 26; i++) { const c = new Mongo('mongodb://app:app-e2e-password@mongo:27017/shop?directConnection=true&maxPoolSize=1'); c.getDB('shop').runCommand({ ping: 1 }); held.push(c) } sleep(3600 * 1000)"]
YAML
  in_vm "$compose up -d --quiet-pull mongo mongo-b >/dev/null && kubectl --context kind-demo -n $ns rollout status statefulset/mongo --timeout 300s >/dev/null"
  # Ready: the entrypoint's first start (root created, standalone) is over and the real
  # server answers with the replica set option.
  ready='for i in $(seq 120); do mongosh --quiet -u root -p "$MONGO_INITDB_ROOT_PASSWORD" --eval "db.adminCommand({getCmdLineOpts:1}).parsed.replication ? quit(0) : quit(1)" >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1'
  in_vm "for p in mongo-0 mongo-1; do kubectl --context kind-demo -n $ns exec \$p -- bash -c '$ready'; done && \
    $compose exec -T mongo bash -c '$ready' && $compose exec -T mongo-b bash -c '$ready'"
  # The replica sets: the second member votes not, so the first stays primary alone.
  initiate() { printf 'try { rs.status() } catch (e) { rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "%s:27017", priority: 2 }, { _id: 1, host: "%s:27017", priority: 0, votes: 0 }] }) } while (!db.hello().isWritablePrimary) sleep(500)' "$1" "$2"; }
  in_vm "kubectl --context kind-demo -n $ns exec mongo-0 -- bash -c 'mongosh --quiet -u root -p \"\$MONGO_INITDB_ROOT_PASSWORD\" --eval '\''$(initiate mongo-0.mongo.$ns.svc.cluster.local mongo-1.mongo.$ns.svc.cluster.local)'\'' >/dev/null' && \
    $compose exec -T mongo bash -c 'mongosh --quiet -u root -p \"\$MONGO_INITDB_ROOT_PASSWORD\" --eval '\''$(initiate mongodb-e2e-mongo-1 mongodb-e2e-mongo-b-1)'\'' >/dev/null'"
  # The app's user and data (200,000 events, no index on kind or amount), and WatchLog's
  # users made beforehand by an admin: watchlog_ref on kind (the Secret path) with
  # clusterMonitor and read on local, watchlog_file on Docker (the file path) with
  # clusterMonitor only. Never printed.
  # slowms 20: a scan of 200,000 small documents takes about 40 ms here, under the default
  # 100 ms (measured in slice 2).
  seed='db.getSiblingDB("shop").setProfilingLevel(0, { slowms: 20 });
db.getSiblingDB("shop").createUser({ user: "app", pwd: "app-e2e-password", roles: [{ role: "readWrite", db: "shop" }] });
db.getSiblingDB("admin").createUser({ user: "nomon", pwd: "nomon-e2e-password", roles: [{ role: "read", db: "shop" }] });
const ev = db.getSiblingDB("shop").events; const kinds = ["order", "refund", "view", "cart"];
for (let b = 0; b < 40; b++) { const docs = []; for (let i = 0; i < 5000; i++) docs.push({ kind: kinds[i % 4], amount: (i * 7919) % 100, at: new Date(), note: "x".repeat(64) }); ev.insertMany(docs) }'
  in_vm ". $dir/.env && kubectl --context kind-demo -n $ns exec -i mongo-0 -- bash -c 'mongosh --quiet -u root -p \"\$MONGO_INITDB_ROOT_PASSWORD\" >/dev/null' <<JS
$seed
db.getSiblingDB('admin').createUser({ user: 'watchlog_ref', pwd: '\$WATCHLOG_PASSWORD', roles: [{ role: 'clusterMonitor', db: 'admin' }, { role: 'read', db: 'local' }] })
JS
    $compose exec -T mongo bash -c 'mongosh --quiet -u root -p \"\$MONGO_INITDB_ROOT_PASSWORD\" >/dev/null' <<JS
$seed
db.getSiblingDB('admin').createUser({ user: 'watchlog_file', pwd: '\$WATCHLOG_PASSWORD', roles: [{ role: 'clusterMonitor', db: 'admin' }] })
JS"
  k_clients
}

# The Kubernetes scenario clients, Deployments with the server's image at 0 replicas: the
# scenarios scale them up.
k_clients() {
  in_vm "cat > $dir/clients.yaml && kubectl --context kind-demo -n $ns apply -f $dir/clients.yaml >/dev/null" <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata: { name: analytics }
spec:
  replicas: 0
  selector: { matchLabels: { app: analytics } }
  template:
    metadata: { labels: { app: analytics } }
    spec:
      nodeSelector: { kubernetes.io/hostname: demo-worker }
      containers:
        - name: analytics
          image: mongo:8.0
          imagePullPolicy: IfNotPresent
          command: ["mongosh", "--quiet", "mongodb://app:app-e2e-password@mongo-0.mongo:27017/shop?directConnection=true", "--eval",
            "while (true) { db.events.find({ kind: 'refund', amount: { $gt: 90 } }).toArray(); sleep(200) }"]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: leak }
spec:
  replicas: 0
  selector: { matchLabels: { app: leak } }
  template:
    metadata: { labels: { app: leak } }
    spec:
      nodeSelector: { kubernetes.io/hostname: demo-worker }
      containers:
        - name: leak
          image: mongo:8.0
          imagePullPolicy: IfNotPresent
          command: ["mongosh", "--quiet", "mongodb://app:app-e2e-password@mongo-0.mongo:27017/shop?directConnection=true", "--eval",
            "const held = []; for (let i = 0; i < 26; i++) { const c = new Mongo('mongodb://app:app-e2e-password@mongo-0.mongo:27017/shop?directConnection=true&maxPoolSize=1'); c.getDB('shop').runCommand({ ping: 1 }); held.push(c) } sleep(3600 * 1000)"]
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
# A previous run's servers and users would make this one pass or fail for the wrong
# reason: start clean.
down
in_vm "kubectl --context kind-demo wait --for=delete namespace/$ns --timeout 180s >/dev/null 2>&1 || true"
up

say "connect, test and monitor; the failure cases; the scenarios and their causes"
WATCHLOG_URL=$url VM=$vm NS=$ns DIR=$dir python3 - <<'PY'
import atexit, http.cookiejar, json, os, re, shlex, subprocess, sys, time, urllib.error, urllib.parse, urllib.request

url = os.environ["WATCHLOG_URL"] + "/api/v1"
vm, ns, d_ = os.environ["VM"], os.environ["NS"], os.environ["DIR"]
compose = f"docker compose -p mongodb-e2e -f {d_}/compose.yaml --env-file {d_}/.env"
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

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
        # The command holds a password: only its start is shown.
        raise RuntimeError(f"{cmd[:60]}…: {r.stderr.strip()[:300]}")
    return r.stdout

call("POST", "/auth/login", {"email": os.environ["WATCHLOG_E2E_EMAIL"], "password": os.environ["WATCHLOG_E2E_PASSWORD"]})
failures = 0
def check(name, ok, detail=""):
    global failures
    print(("PASS  " if ok else "FAIL  ") + name + (f": {detail}" if detail and not ok else ""))
    failures += 0 if ok else 1

def wait(fn, timeout=120, every=3):
    deadline = time.time() + timeout
    v = fn()
    while not v and time.time() < deadline:
        time.sleep(every)
        v = fn()
    return v

# The scenario clients run the server's image (for mongosh): discovery offers them too
# (slice 2's note); only the servers are wanted here.
K, D = ("kubernetes", f"{ns}/mongo"), ("docker", "mongodb-e2e/mongo")
want = {K, D}
def found():
    d = {(x["cluster"]["kind"], x["name"]): x for x in call("GET", "/applications/discovered")["discovered"] if x["type"] == "mongodb"}
    return d if want <= set(d) else None
for x in call("GET", "/applications")["applications"]:
    if x["type"] == "mongodb" and (x["cluster"]["kind"], x["name"]) in want:
        call("DELETE", f"/applications/{x['id']}")
d = wait(found, 180, 5) or {}
check("MongoDB 8.0 on kind and 7.0 on Docker are discovered", bool(d), str(sorted(d)))
if not d:
    sys.exit(1)
check("kind: both members of the StatefulSet", d[K]["members"] == 2, json.dumps(d[K])[:300])

def probe(svc, access):
    return call("POST", "/applications/probes", {"clusterId": svc["cluster"]["id"], "type": "mongodb", "target": svc["target"], "access": access})

def settle(p, timeout=90):
    pid = p["probe"]["id"]
    def done():
        q = call("GET", f"/applications/probes/{pid}")["probe"]
        return q if q["status"] == "ok" or (q["result"] and q["result"]["code"] != "unreachable" and q["attempts"] >= 2) else None
    return wait(done, timeout) or call("GET", f"/applications/probes/{pid}")["probe"]

def passed(pid, timeout=90):
    return wait(lambda: (lambda x: x if x["status"] == "ok" else None)(call("GET", f"/applications/probes/{pid}")["probe"]), timeout)

monitored = []
@atexit.register
def cleanup():
    for m in monitored:
        call("DELETE", f"/applications/{m}", ok=False)
    try:
        vm_run(f"kubectl -n {ns} delete deployment analytics leak --ignore-not-found >/dev/null; kubectl -n {ns} scale statefulset mongo --replicas 2 >/dev/null; "
               f"{compose} --profile scenario rm -sf analytics leak >/dev/null 2>&1 || true; {compose} up -d mongo-b >/dev/null 2>&1 || true")
    except Exception as e:  # noqa: BLE001
        print(f"cleanup: {e}")

def monitor(svc, probe_id):
    a = call("POST", "/applications", {"clusterId": svc["cluster"]["id"], "type": "mongodb", "target": svc["target"],
                                         "probeId": probe_id, "defaultAlerts": ["mongodb_slow_ops", "mongodb_member_down"]})["application"]
    monitored.append(a["id"])
    return a

def connected(app_id, label):
    def ok():
        a = call("GET", f"/applications/{app_id}")
        return a if a["application"]["reason"]["code"] == "connected" else None
    a = wait(ok, 120)
    check(f"{label}: connected", bool(a), json.dumps(call("GET", f"/applications/{app_id}")["reasons"])[:300])
    return a

TABS = ("overview", "operations", "storage")
def panels(app_id, tab):
    return call("GET", f"/applications/{app_id}/panels?tab={tab}")["panels"]
def panel(app_id, tab, pid):
    return next(p for p in panels(app_id, tab) if p["id"] == pid)

# 1. Kubernetes, the generated user: WatchLog's command run for real. mongosh asks for
#    root's password at a prompt (exec -it, -p); here the pod's own environment answers.
svc = d[K]
p = probe(svc, {"method": "generated"})
cmd = p["command"]
check("kubernetes: the command uses kubectl exec -it, mongosh and clusterMonitor",
      cmd.startswith("kubectl exec -it") and "mongosh" in cmd and '"clusterMonitor"' in cmd, cmd[:80])
first = settle(p, 45)
check("kubernetes: before the command runs, the test waits (auth_failed)",
      first["status"] == "pending" and (first["result"] or {}).get("code") == "auth_failed", json.dumps(first))
inner = cmd.split(" -- ", 1)[1].replace(" -p --authenticationDatabase", ' -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase')
# Single-quoted for the VM's shell, so the password variable expands in the pod, not there.
vm_run(f"kubectl exec -i -n {ns} mongo-0 -- bash -c {shlex.quote(inner)}")
call("POST", f"/applications/probes/{p['probe']['id']}/check")
q = passed(p["probe"]["id"], 60)
check("kubernetes: after the command, the test passes with no excess role (8.0, replica set rs0)",
      bool(q) and q["result"]["code"] == "ok" and not q["result"]["excess"] and q["result"]["version"].startswith("8.0")
      and q["result"]["facts"].get("replica_set") == "rs0", json.dumps(q))
k_app = monitor(svc, p["probe"]["id"])["id"]
a = connected(k_app, "kubernetes generated user")
check("kubernetes: the MongoDB page", bool(a) and a["page"]["id"] == "mongodb" and [t["id"] for t in a["page"]["tabs"]][:3] == list(TABS))
check("kubernetes: the Overview fills", bool(wait(lambda: panel(k_app, "overview", "summary")["state"] == "ok", 120)))
check("kubernetes: the oplog window is read with clusterMonitor alone",
      bool(wait(lambda: next(t for t in panel(k_app, "overview", "summary")["tiles"] if t["id"] == "oplog")["value"] is not None, 90)))
perms = [f"{t}/{x['id']}" for t in TABS for x in panels(k_app, t) if x["state"] == "needs_permission"]
check("kubernetes: the generated user can read every panel", not perms, str(perms))

# 2. A wrong password, and a user without clusterMonitor.
wrong = settle(probe(svc, {"method": "entered", "username": "watchlog", "password": "not-the-password"}))
check("a wrong password fails as auth_failed", (wrong["result"] or {}).get("code") == "auth_failed", json.dumps(wrong))
# In admin, where the collector authenticates (the app user is in shop: auth_failed there).
nomon = settle(probe(svc, {"method": "entered", "username": "nomon", "password": "nomon-e2e-password"}))
check("a user without clusterMonitor fails as permission_missing, naming it",
      (nomon["result"] or {}).get("code") == "permission_missing" and nomon["result"]["missing"] == ["clusterMonitor"], json.dumps(nomon))

# 3. Kubernetes, the password in a Secret: refused until the Role and RoleBinding exist.
p = probe(svc, {"method": "reference", "username": "watchlog_ref", "secret": {"name": "mongodb-e2e-password", "key": "password"}})
before = settle(p, 45)
check("Secret: before the Role, the test says the collector may not read it",
      (before["result"] or {}).get("code") == "credential_unavailable", json.dumps(before))
for c in p["commands"]:
    vm_run(c)
call("POST", f"/applications/probes/{p['probe']['id']}/check")
check("Secret: after the Role and RoleBinding, the test passes", bool(passed(p["probe"]["id"])))

# 4. Docker, MongoDB 7.0 with the password in a file on the host.
f_svc = d[D]
p = probe(f_svc, {"method": "reference", "username": "watchlog_file", "file": "mongodb-e2e"})
check("File: WatchLog shows the mount", p.get("mount") == "-v /etc/watchlog/secrets:/etc/watchlog/secrets:ro")
ok = passed(p["probe"]["id"], 60)
check("File: the test passes (7.0)", bool(ok) and ok["result"]["version"].startswith("7.0"), json.dumps(ok))
d_app = monitor(f_svc, p["probe"]["id"])["id"]
connected(d_app, "docker file user")
check("docker: the members table lists both members",
      bool(wait(lambda: len(panel(d_app, "overview", "members").get("rows", [])) == 2, 120)))

# 5. The scenarios, on both platforms.
def reason(app_id, code):
    return next((r for r in call("GET", f"/applications/{app_id}")["reasons"] if r["code"] == code), None)

k_cluster, d_cluster = d[K]["cluster"]["id"], d[D]["cluster"]["id"]
def scale(names, n):
    vm_run(f"kubectl -n {ns} scale deployment {' '.join(names)} --replicas={n} >/dev/null")
def compose_up(names):
    vm_run(f"{compose} --profile scenario up -d --quiet-pull --no-deps {' '.join(names)} >/dev/null")
def compose_rm(names):
    vm_run(f"{compose} --profile scenario rm -sf {' '.join(names)} >/dev/null")

def scenario(label, app_id, cluster_id, code, key, holder, headline, timeout=300):
    r = wait(lambda: (lambda x: x if x and holder in str(x["facts"].get(key, "")) else None)(reason(app_id, code)), timeout, 5)
    check(f"{label}: {code} names {holder}", bool(r), json.dumps(call("GET", f"/applications/{app_id}")["reasons"])[:400])
    def cause():
        c = call("GET", "/causes?" + urllib.parse.urlencode({"cluster": cluster_id, "subject": f"application:{app_id}"}), ok=False)
        top = (c.get("causes") or [None])[0]
        return c if top and top.get("rule", top.get("code")) == "application_finding" and (c.get("headline") or {}).get("code") == headline else None
    c = wait(cause, 120, 5)
    check(f"{label}: the top cause is application_finding ({headline}), {holder} as the client",
          bool(c) and holder in json.dumps(c.get("headline", {})),
          json.dumps(call("GET", "/causes?" + urllib.parse.urlencode({"cluster": cluster_id, "subject": f"application:{app_id}"}), ok=False))[:500])

# The scan: analytics runs an unindexed find on shop.events in a loop.
scale(["analytics"], 1)
compose_up(["analytics"])
scenario("kubernetes scan", k_app, k_cluster, "slow_collscan", "holder", f"{ns}/analytics", "app_collscan")
scenario("docker scan", d_app, d_cluster, "slow_collscan", "holder", "mongodb-e2e-analytics-1", "app_collscan")
for label, app_id in (("kubernetes", k_app), ("docker", d_app)):
    s = wait(lambda: (lambda x: x if x["state"] == "ok" and "COLLSCAN" in json.dumps(x) else None)(panel(app_id, "operations", "slow")), 60)
    check(f"{label}: Operations lists the scan's shape on shop.events", bool(s) and "{amount: {$gt: ?}, kind: ?}" in json.dumps(s), json.dumps(s)[:300])
scale(["analytics"], 0)
compose_rm(["analytics"])

# The leak: about 94 of maxConns 100 (measured: 3 connections per client, 5 for mongosh,
# about 11 for the other member and the collector). At maxConns 60 the band between 90 %
# and refusing the collector was 6 connections: the leak filled it and the collector got EOF.
scale(["leak"], 1)
compose_up(["leak"])
scenario("kubernetes leak", k_app, k_cluster, "connections_near_max", "top", f"{ns}/leak", "app_pg_held")
scenario("docker leak", d_app, d_cluster, "connections_near_max", "top", "mongodb-e2e-leak-1", "app_pg_held")
scale(["leak"], 0)
compose_rm(["leak"])

# The member: the second member stops; the first stays primary (the second has no vote).
vm_run(f"kubectl -n {ns} scale statefulset mongo --replicas 1 >/dev/null; {compose} stop mongo-b >/dev/null")
for label, app_id, member in (("kubernetes", k_app, "mongo-1"), ("docker", d_app, "mongodb-e2e-mongo-b-1")):
    r = wait(lambda: (lambda x: x if x and x["facts"].get("member") == member else None)(reason(app_id, "member_down")), 180, 5)
    check(f"{label}: member_down names {member}", bool(r), json.dumps(call("GET", f"/applications/{app_id}")["reasons"])[:300])
    check(f"{label}: the set keeps its primary", reason(app_id, "no_primary") is None)

print(f"\n{failures} failed" if failures else "\nall passed")
sys.exit(1 if failures else 0)
PY
