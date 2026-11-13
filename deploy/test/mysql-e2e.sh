#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# MySQL and MariaDB end to end (v0.5 slice 1, SPEC §4.12, ADR-163) on the demo VM, after
# deploy/test/integrations-e2e.sh has started the agents and collectors (same backend,
# same environment variables). MySQL 8.4 on the kind cluster "demo" (namespace mysql-e2e)
# and MariaDB 11.4 on the VM's Docker host (Compose project mysql-e2e):
#   - discovery of both, named by the server ("MySQL 8.4", "MariaDB 11.4");
#   - Kubernetes: WatchLog's generated user, its command run for real through
#     `kubectl exec` (the root password the command asks for at the prompt is given from
#     the pod's own environment), then the test passes with no excess privilege and every
#     tab fills; a wrong password fails as auth_failed, a user without PROCESS as
#     permission_missing naming it; the same server through a Secret: refused until the
#     Role and RoleBinding WatchLog writes are applied;
#   - Docker: WatchLog's user made by an admin, its password in a root-owned 0600 file under
#     the collector's /etc/watchlog/secrets (~/watchlog-e2e-secrets on the VM); MariaDB's
#     performance_schema is off (its default): the reason says so and the statement panels
#     ask for it, while lock waits still read;
#   - the two scenarios of phases/v0.5 on both platforms, each with probable cause's answer:
#       lock: a `locker` opens a transaction, SELECT … FOR UPDATE on the row a `writer`
#             updates, and sleeps 5 min → lock_waits naming the locker; the top cause of
#             the service is application_finding (app_lock_held, the locker as holder);
#       leak: a `leak` holds 36 of max_connections 40 → connections_near_max naming the
#             leak; application_finding (app_pg_held, the leak as holder).
#
#   mysql-e2e.sh up        the servers only (namespace and Compose project), for a look
#   mysql-e2e.sh           everything above, then removes the scenario clients
#   mysql-e2e.sh down      removes what it made
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
ns=mysql-e2e
# The fixtures' folder in the VM (the tilde expands there).
# shellcheck disable=SC2088
dir='~/mysql-e2e'
compose="docker compose -p mysql-e2e -f $dir/compose.yaml"
in_vm() { limactl shell "$vm" bash -c "cd ~ && export PATH=\$HOME/bin:\$PATH && $*"; }
say() { printf '\n== %s\n' "$*"; }

down() {
  in_vm "kubectl --context kind-demo delete namespace $ns --ignore-not-found --wait=false >/dev/null
    kubectl --context kind-demo -n watchlog-e2e delete secret mysql-e2e-password --ignore-not-found >/dev/null
    kubectl --context kind-demo -n watchlog-e2e delete role,rolebinding watchlog-read-mysql-e2e-password --ignore-not-found >/dev/null
    [ -f $dir/compose.yaml ] && $compose --profile scenario down -v --remove-orphans >/dev/null 2>&1 || true
    docker run --rm -v \$HOME/watchlog-e2e-secrets:/s busybox:1.37 rm -f /s/mysql-e2e >/dev/null 2>&1 || true
    rm -rf $dir"
}

up() {
  say "MySQL 8.4 on kind (namespace $ns), MariaDB 11.4 on the VM's Docker host (project mysql-e2e)"
  admin=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
  watchlog=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
  in_vm "docker image inspect mysql:8.4 >/dev/null 2>&1 || docker pull -q mysql:8.4 >/dev/null
    docker image inspect mariadb:11.4 >/dev/null 2>&1 || docker pull -q mariadb:11.4 >/dev/null
    kind load docker-image --name demo mysql:8.4 >/dev/null
    mkdir -p $dir"
  printf '%s\n%s' "$admin" "$watchlog" | limactl shell "$vm" bash -c "cd ~ && export PATH=\$HOME/bin:\$PATH && read -r a && read -r w; \
    kubectl --context kind-demo create namespace $ns --dry-run=client -o yaml | kubectl --context kind-demo apply -f - >/dev/null && \
    kubectl --context kind-demo -n $ns create secret generic mysql-admin --from-literal=password=\"\$a\" --dry-run=client -o yaml | kubectl --context kind-demo apply -f - >/dev/null && \
    kubectl --context kind-demo -n watchlog-e2e create secret generic mysql-e2e-password --from-literal=password=\"\$w\" --dry-run=client -o yaml | kubectl --context kind-demo apply -f - >/dev/null && \
    printf 'MARIADB_ROOT_PASSWORD=%s\nWATCHLOG_PASSWORD=%s\n' \"\$a\" \"\$w\" > $dir/.env && chmod 600 $dir/.env && \
    printf '%s' \"\$w\" | docker run --rm -i -v \$HOME/watchlog-e2e-secrets:/s busybox:1.37 sh -c 'umask 077; cat > /s/mysql-e2e'"
  in_vm "kubectl --context kind-demo -n $ns apply -f - >/dev/null" <<'YAML'
apiVersion: v1
kind: Service
metadata: { name: mysql }
spec:
  clusterIP: None
  selector: { app: mysql }
  ports: [{ port: 3306 }]
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: mysql }
spec:
  serviceName: mysql
  selector: { matchLabels: { app: mysql } }
  template:
    metadata: { labels: { app: mysql } }
    spec:
      containers:
        - name: mysql
          image: mysql:8.4
          args: ["--max-connections=40", "--innodb-buffer-pool-size=64M", "--performance-schema-max-digest-length=1024"]
          env:
            - name: MYSQL_ROOT_PASSWORD
              valueFrom: { secretKeyRef: { name: mysql-admin, key: password } }
            - { name: MYSQL_DATABASE, value: shop }
            - { name: MYSQL_USER, value: app }
            - { name: MYSQL_PASSWORD, value: app-e2e-password }
          ports: [{ containerPort: 3306 }]
          resources: { limits: { memory: 512Mi } }
YAML
  # Ready means answering over TCP: the images first run a socket-only server to initialise.
  # The scenario clients are Compose services under the "scenario" profile: `up` starts
  # only MariaDB.
  in_vm "cat > $dir/compose.yaml" <<'YAML'
name: mysql-e2e
x-client: &client
  image: mariadb:11.4
  profiles: [scenario]
  depends_on: [mariadb]
  environment: { MYSQL_PWD: app-e2e-password }
services:
  mariadb:
    image: mariadb:11.4
    command: ["--max-connections=40", "--innodb-buffer-pool-size=64M"]
    environment:
      MARIADB_ROOT_PASSWORD: ${MARIADB_ROOT_PASSWORD}
      MARIADB_DATABASE: shop
      MARIADB_USER: app
      MARIADB_PASSWORD: app-e2e-password
    mem_limit: 384m
  locker:
    <<: *client
    command: ["sh", "-c", "while true; do mariadb -h mariadb -uapp shop -e 'CREATE TABLE IF NOT EXISTS stock (id INT PRIMARY KEY, n INT); INSERT IGNORE INTO stock VALUES (1, 0); BEGIN; SELECT * FROM stock WHERE id = 1 FOR UPDATE; SELECT SLEEP(300); COMMIT'; sleep 1; done"]
  writer:
    <<: *client
    command: ["sh", "-c", "sleep 5; while true; do mariadb -h mariadb -uapp shop -e 'UPDATE stock SET n = n + 1 WHERE id = 1'; sleep 1; done"]
  leak:
    <<: *client
    command: ["sh", "-c", "for i in $$(seq 36); do mariadb -h mariadb -uapp -e 'SELECT SLEEP(3600)' & done; wait"]
YAML
  in_vm "$compose up -d --quiet-pull mariadb >/dev/null && kubectl --context kind-demo -n $ns rollout status statefulset/mysql --timeout 300s >/dev/null"
  ready='for i in $(seq 90); do mysqladmin ping -h127.0.0.1 -uroot -p"$MYSQL_ROOT_PASSWORD" --silent 2>/dev/null && exit 0; sleep 1; done; exit 1'
  ready_maria='for i in $(seq 90); do mariadb-admin ping -h127.0.0.1 -uroot -p"$MARIADB_ROOT_PASSWORD" --silent 2>/dev/null && exit 0; sleep 1; done; exit 1'
  in_vm "kubectl --context kind-demo -n $ns exec statefulset/mysql -- sh -c '$ready' && \
    $compose exec -T mariadb sh -c '$ready_maria'"
  # WatchLog's users made beforehand by an admin: watchlog_ref on MySQL (the Secret path),
  # watchlog_file on MariaDB (the file path), with ADR-163's grants. Never printed.
  in_vm ". $dir/.env && kubectl --context kind-demo -n $ns exec -i statefulset/mysql -- sh -c 'mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" 2>/dev/null' <<SQL
CREATE USER IF NOT EXISTS watchlog_ref@'%' IDENTIFIED BY '\$WATCHLOG_PASSWORD' WITH MAX_USER_CONNECTIONS 2;
GRANT PROCESS, REPLICATION CLIENT ON *.* TO watchlog_ref@'%';
GRANT SELECT ON performance_schema.* TO watchlog_ref@'%';
GRANT SELECT ON mysql.innodb_table_stats TO watchlog_ref@'%';
SQL
    $compose exec -T mariadb sh -c 'mariadb -uroot -p\"\$MARIADB_ROOT_PASSWORD\"' <<SQL
CREATE USER IF NOT EXISTS watchlog_file@'%' IDENTIFIED BY '\$WATCHLOG_PASSWORD' WITH MAX_USER_CONNECTIONS 2;
GRANT PROCESS, REPLICATION CLIENT, SLAVE MONITOR ON *.* TO watchlog_file@'%';
GRANT SELECT ON performance_schema.* TO watchlog_file@'%';
GRANT SELECT ON mysql.innodb_table_stats TO watchlog_file@'%';
SQL"
  k_clients
}

# The Kubernetes scenario clients, Deployments with the MySQL client image at 0 replicas:
# the scenarios scale them up.
k_clients() {
  in_vm "cat > $dir/clients.yaml && kubectl --context kind-demo -n $ns apply -f $dir/clients.yaml >/dev/null" <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata: { name: locker }
spec:
  replicas: 0
  selector: { matchLabels: { app: locker } }
  template:
    metadata: { labels: { app: locker } }
    spec:
      containers:
        - name: locker
          image: mysql:8.4
          env: [{ name: MYSQL_PWD, value: app-e2e-password }]
          command: ["sh", "-c", "while true; do mysql -h mysql -uapp shop -e 'CREATE TABLE IF NOT EXISTS stock (id INT PRIMARY KEY, n INT); INSERT IGNORE INTO stock VALUES (1, 0); BEGIN; SELECT * FROM stock WHERE id = 1 FOR UPDATE; SELECT SLEEP(300); COMMIT'; sleep 1; done"]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: writer }
spec:
  replicas: 0
  selector: { matchLabels: { app: writer } }
  template:
    metadata: { labels: { app: writer } }
    spec:
      containers:
        - name: writer
          image: mysql:8.4
          env: [{ name: MYSQL_PWD, value: app-e2e-password }]
          command: ["sh", "-c", "sleep 5; while true; do mysql -h mysql -uapp shop -e 'UPDATE stock SET n = n + 1 WHERE id = 1'; sleep 1; done"]
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
      containers:
        - name: leak
          image: mysql:8.4
          env: [{ name: MYSQL_PWD, value: app-e2e-password }]
          command: ["sh", "-c", "for i in $(seq 36); do mysql -h mysql -uapp -e 'SELECT SLEEP(3600)' & done; wait"]
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
# A previous run's servers and grants would make this one pass or fail for the wrong
# reason: start clean.
down
in_vm "kubectl --context kind-demo wait --for=delete namespace/$ns --timeout 180s >/dev/null 2>&1 || true"
up

say "connect, test and monitor; the failure cases; the scenarios and their causes"
WATCHLOG_URL=$url VM=$vm NS=$ns DIR=$dir DOCKER_HOST_NAME=$(in_vm hostname) python3 - <<'PY'
import atexit, http.cookiejar, json, os, re, subprocess, sys, time, urllib.error, urllib.parse, urllib.request

url = os.environ["WATCHLOG_URL"] + "/api/v1"
vm, ns, host, d_ = os.environ["VM"], os.environ["NS"], os.environ["DOCKER_HOST_NAME"], os.environ["DIR"]
compose = f"docker compose -p mysql-e2e -f {d_}/compose.yaml"
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

K, D = ("kubernetes", f"{ns}/mysql"), ("docker", "mysql-e2e/mariadb")
want = {K, D}
def found():
    d = {(x["cluster"]["kind"], x["name"]): x for x in call("GET", "/applications/discovered")["discovered"] if x["type"] == "mysql"}
    return d if want <= set(d) else None
for x in call("GET", "/applications")["applications"]:
    if x["type"] == "mysql" and (x["cluster"]["kind"], x["name"]) in want:
        call("DELETE", f"/applications/{x['id']}")
d = wait(found, 180, 5) or {}
check("MySQL on kind and MariaDB on Docker are discovered", bool(d), str(sorted(d)))
if not d:
    sys.exit(1)
check("MariaDB is told apart by its image", d[D].get("product") == "mariadb", json.dumps(d[D])[:300])

def probe(svc, access):
    return call("POST", "/applications/probes", {"clusterId": svc["cluster"]["id"], "type": "mysql", "target": svc["target"], "access": access})

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
        vm_run(f"kubectl -n {ns} delete deployment locker writer leak --ignore-not-found >/dev/null; {compose} --profile scenario rm -sf locker writer leak >/dev/null 2>&1 || true")
    except Exception as e:  # noqa: BLE001
        print(f"cleanup: {e}")

def monitor(svc, probe_id):
    a = call("POST", "/applications", {"clusterId": svc["cluster"]["id"], "type": "mysql", "target": svc["target"],
                                         "probeId": probe_id, "defaultAlerts": ["mysql_connections_high", "mysql_long_query"]})["application"]
    monitored.append(a["id"])
    return a

def connected(app_id, label):
    def ok():
        a = call("GET", f"/applications/{app_id}")
        return a if a["application"]["reason"]["code"] == "connected" else None
    a = wait(ok, 120)
    check(f"{label}: connected", bool(a), json.dumps(call("GET", f"/applications/{app_id}")["reasons"])[:300])
    return a

TABS = ("overview", "connections", "queries", "locks", "storage", "replication")
def panels(app_id, tab):
    return call("GET", f"/applications/{app_id}/panels?tab={tab}")["panels"]
def panel(app_id, tab, pid):
    return next(p for p in panels(app_id, tab) if p["id"] == pid)

# 1. Kubernetes, the generated user: WatchLog's command run for real. It asks for root's
#    password at a prompt (exec -it, -p); here the pod's own MYSQL_ROOT_PASSWORD answers.
svc = d[K]
p = probe(svc, {"method": "generated"})
cmd = p["command"]
check("kubernetes: the command uses kubectl exec -it and grants PROCESS",
      cmd.startswith("kubectl exec -it") and "GRANT PROCESS, REPLICATION CLIENT" in cmd, cmd[:80])
first = settle(p, 45)
check("kubernetes: before the command runs, the test waits (auth_failed)",
      first["status"] == "pending" and (first["result"] or {}).get("code") == "auth_failed", json.dumps(first))
vm_run(cmd.replace("exec -it ", "exec -i ").replace('-uroot -p -e', '-uroot -p"$MYSQL_ROOT_PASSWORD" -e'))
call("POST", f"/applications/probes/{p['probe']['id']}/check")
q = passed(p["probe"]["id"], 60)
check("kubernetes: after the command, the test passes with no excess privilege (MySQL 8.4, performance_schema on)",
      bool(q) and q["result"]["code"] == "ok" and not q["result"]["excess"] and q["result"]["version"].startswith("8.4")
      and q["result"]["facts"].get("performance_schema") == "on" and not q["result"]["facts"].get("missing"), json.dumps(q))
k_app = monitor(svc, p["probe"]["id"])["id"]
a = connected(k_app, "kubernetes generated user")
check("kubernetes: the MySQL page", bool(a) and a["page"]["id"] == "mysql" and [t["id"] for t in a["page"]["tabs"]][:6] == list(TABS))
check("kubernetes: the Overview fills", bool(wait(lambda: panel(k_app, "overview", "summary")["state"] == "ok", 90)))
perms = [f"{t}/{x['id']}" for t in TABS for x in panels(k_app, t) if x["state"] == "needs_permission"]
check("kubernetes: the generated user can read every panel", not perms, str(perms))

# 2. A wrong password, and a user without PROCESS.
wrong = settle(probe(svc, {"method": "entered", "username": "app", "password": "not-the-password"}))
check("a wrong password fails as auth_failed", (wrong["result"] or {}).get("code") == "auth_failed", json.dumps(wrong))
noproc = settle(probe(svc, {"method": "entered", "username": "app", "password": "app-e2e-password"}))
check("a user without PROCESS fails as permission_missing, naming it",
      (noproc["result"] or {}).get("code") == "permission_missing" and noproc["result"]["missing"] == ["PROCESS"], json.dumps(noproc))

# 3. Kubernetes, the password in a Secret: refused until the Role and RoleBinding exist.
p = probe(svc, {"method": "reference", "username": "watchlog_ref", "secret": {"name": "mysql-e2e-password", "key": "password"}})
before = settle(p, 45)
check("Secret: before the Role, the test says the collector may not read it",
      (before["result"] or {}).get("code") == "credential_unavailable", json.dumps(before))
for c in p["commands"]:
    vm_run(c)
call("POST", f"/applications/probes/{p['probe']['id']}/check")
check("Secret: after the Role and RoleBinding, the test passes", bool(passed(p["probe"]["id"])))

# 4. Docker, MariaDB with the password in a file on the host.
f_svc = d[D]
p = probe(f_svc, {"method": "reference", "username": "watchlog_file", "file": "mysql-e2e"})
check("File: WatchLog shows the mount", p.get("mount") == "-v /etc/watchlog/secrets:/etc/watchlog/secrets:ro")
ok = passed(p["probe"]["id"], 60)
check("File: the test passes (MariaDB 11.4, performance_schema off)",
      bool(ok) and ok["result"]["version"].startswith("11.4") and ok["result"]["facts"].get("performance_schema") == "off", json.dumps(ok))
d_app = monitor(f_svc, p["probe"]["id"])["id"]
a = connected(d_app, "docker file user")
check("docker: the list names MariaDB", bool(a) and a["application"].get("product") == "mariadb", json.dumps((a or {}).get("application", {}))[:300])
def perf_off():
    return "performance_schema_off" in {r["code"] for r in call("GET", f"/applications/{d_app}")["reasons"]} or None
check("docker: MariaDB without performance_schema says so", bool(wait(perf_off, 90)))
check("docker: the statements panel asks for performance_schema",
      bool(wait(lambda: panel(d_app, "queries", "top")["state"] == "needs_permission", 60)))

# 5. The scenarios, on both platforms.
def reason(app_id, code):
    return next((r for r in call("GET", f"/applications/{app_id}")["reasons"] if r["code"] == code), None)
def top_cause(app_id, cluster_id):
    c = call("GET", f"/causes?cluster={cluster_id}&subject=application:{app_id}", ok=False)
    return (c.get("causes") or [None])[0]

k_cluster, d_cluster = d[K]["cluster"]["id"], d[D]["cluster"]["id"]
def scale(names, n):
    vm_run(f"kubectl -n {ns} scale deployment {' '.join(names)} --replicas={n} >/dev/null")
def compose_up(names):
    vm_run(f"{compose} --profile scenario up -d --quiet-pull {' '.join(names)} >/dev/null")
def compose_rm(names):
    vm_run(f"{compose} --profile scenario rm -sf {' '.join(names)} >/dev/null")

def scenario(label, app_id, cluster_id, code, holder, headline, timeout=240):
    r = wait(lambda: (lambda x: x if x and x["facts"].get("holder" if code == "lock_waits" else "top", "") and holder in str(x["facts"].get("holder" if code == "lock_waits" else "top")) else None)(reason(app_id, code)), timeout, 5)
    check(f"{label}: {code} names {holder}", bool(r), json.dumps(call("GET", f"/applications/{app_id}")["reasons"])[:400])
    def cause():
        c = call("GET", "/causes?" + urllib.parse.urlencode({"cluster": cluster_id, "subject": f"application:{app_id}"}), ok=False)
        top = (c.get("causes") or [None])[0]
        return c if top and top.get("rule", top.get("code")) == "application_finding" and (c.get("headline") or {}).get("code") == headline else None
    c = wait(cause, 120, 5)
    check(f"{label}: the top cause is application_finding ({headline}), {holder} as the holder",
          bool(c) and holder in json.dumps(c.get("headline", {})),
          json.dumps(call("GET", "/causes?" + urllib.parse.urlencode({"cluster": cluster_id, "subject": f"application:{app_id}"}), ok=False))[:500])

# The lock: the locker holds the row the writer updates.
scale(["locker", "writer"], 1)
compose_up(["locker", "writer"])
scenario("kubernetes lock", k_app, k_cluster, "lock_waits", f"{ns}/locker", "app_lock_held")
scenario("docker lock", d_app, d_cluster, "lock_waits", "mysql-e2e-locker-1", "app_lock_held")
def blocking(app_id):
    b = panel(app_id, "locks", "blocking")
    return b if b["state"] == "ok" and b["rows"] else None
for label, app_id in (("kubernetes", k_app), ("docker", d_app)):
    b = wait(lambda: blocking(app_id), 60)
    check(f"{label}: Locks shows the waiting and the blocking session, and the table", bool(b) and "shop.stock" in json.dumps(b), json.dumps(b)[:300])
scale(["locker", "writer"], 0)
compose_rm(["locker", "writer"])

# The leak: 36 of max_connections 40.
scale(["leak"], 1)
compose_up(["leak"])
scenario("kubernetes leak", k_app, k_cluster, "connections_near_max", f"{ns}/leak", "app_pg_held")
scenario("docker leak", d_app, d_cluster, "connections_near_max", "mysql-e2e-leak-1", "app_pg_held")
scale(["leak"], 0)
compose_rm(["leak"])

print(f"\n{failures} failed" if failures else "\nall passed")
sys.exit(1 if failures else 0)
PY
