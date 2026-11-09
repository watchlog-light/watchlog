#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# PostgreSQL end to end (v0.3 slice 8, SPEC §4.12, ADR-134) on the demo VM, after
# deploy/test/integrations-e2e.sh has started the agents and collectors (same backend,
# same environment variables). On the kind cluster "demo" and on the VM's Docker host:
#   - the generated pg_monitor role: WatchLog's command run for real through
#     `kubectl exec` and `docker exec` (PostgreSQL 17 with pg_stat_statements), then the
#     connection test passes with no excess privilege and every tab fills;
#   - a wrong password fails as auth_failed, a role without pg_monitor as
#     permission_missing naming it;
#   - Kubernetes: PostgreSQL 13 whose WatchLog password is in a Secret; the test fails
#     until the Role and RoleBinding WatchLog writes are applied, then passes;
#   - Docker: PostgreSQL 16 whose WatchLog password is in a root-owned 0600 file under the
#     collector's /etc/watchlog/secrets (~/watchlog-e2e-secrets on the VM, written by a
#     root container, as the documented sudo commands would);
#   - scripted: connections near max_connections, a lock wait, a long query, and 500
#     tables (the table series stay capped at 100).
# Passwords are random per run, never printed. `postgres-e2e.sh down` removes what it made.
# WATCHLOG_E2E_VM_URL (optional): the backend's VictoriaMetrics, for the series count.
# shellcheck disable=SC2016
set -euo pipefail
cd "$(dirname "$0")/../.."
vm=${VM:-watchlog-demo}
url=${WATCHLOG_URL:-http://127.0.0.1:4080}
ns=pg-e2e
in_vm() { limactl shell "$vm" bash -c "cd ~ && export PATH=\$HOME/bin:\$PATH && $*"; }
say() { printf '\n== %s\n' "$*"; }

down() {
  in_vm "kubectl --context kind-demo delete namespace $ns --ignore-not-found --wait=false >/dev/null
    kubectl --context kind-demo -n watchlog-e2e delete secret pg-e2e-password --ignore-not-found >/dev/null
    kubectl --context kind-demo -n watchlog-e2e delete role,rolebinding watchlog-read-pg-e2e-password --ignore-not-found >/dev/null
    docker rm -f e2e-pg-gen e2e-pg-file >/dev/null 2>&1 || true
    docker run --rm -v \$HOME/watchlog-e2e-secrets:/s postgres:16-alpine rm -f /s/e2e-pg-file"
}
if [ "${1:-}" = down ]; then
  down
  exit 0
fi
: "${WATCHLOG_E2E_EMAIL:?}" "${WATCHLOG_E2E_PASSWORD:?}"

# A previous run's servers, Secret grants and files would make this one pass or fail for
# the wrong reason (a Role left over, a pod still on the old password): start clean.
down
in_vm "kubectl --context kind-demo wait --for=delete namespace/$ns --timeout 180s >/dev/null 2>&1 || true"

say "PostgreSQL on kind (namespace $ns) and on the VM's Docker host"
pg_args='-c shared_preload_libraries=pg_stat_statements -c compute_query_id=on -c max_connections=40 -c superuser_reserved_connections=1'
# Two passwords: the servers' admin one, and WatchLog's for the Secret and file paths.
admin=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
watchlog=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
printf '%s\n%s' "$admin" "$watchlog" | limactl shell "$vm" bash -c "cd ~ && export PATH=\$HOME/bin:\$PATH && read -r a && read -r w; \
  kubectl --context kind-demo create namespace $ns --dry-run=client -o yaml | kubectl --context kind-demo apply -f - >/dev/null && \
  kubectl --context kind-demo -n $ns create secret generic pg-admin --from-literal=password=\"\$a\" --dry-run=client -o yaml | kubectl --context kind-demo apply -f - >/dev/null && \
  kubectl --context kind-demo -n watchlog-e2e create secret generic pg-e2e-password --from-literal=password=\"\$w\" --dry-run=client -o yaml | kubectl --context kind-demo apply -f - >/dev/null && \
  docker rm -f e2e-pg-gen e2e-pg-file >/dev/null 2>&1; \
  docker run -d --name e2e-pg-gen -e POSTGRES_PASSWORD=\"\$a\" postgres:17-alpine $pg_args >/dev/null && \
  docker run -d --name e2e-pg-file -e POSTGRES_PASSWORD=\"\$a\" postgres:16-alpine >/dev/null && \
  printf '%s' \"\$w\" | docker run --rm -i -v \$HOME/watchlog-e2e-secrets:/s postgres:16-alpine sh -c 'umask 077; cat > /s/e2e-pg-file' && \
  printf '%s' \"\$w\" > ~/.pg-e2e-watchlog && chmod 600 ~/.pg-e2e-watchlog"
in_vm "kubectl --context kind-demo -n $ns apply -f - >/dev/null" <<YAML
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: pg-gen }
spec:
  serviceName: pg-gen
  selector: { matchLabels: { app: pg-gen } }
  template:
    metadata: { labels: { app: pg-gen } }
    spec:
      containers:
        - name: postgres
          image: postgres:17-alpine
          args: [$(printf '"%s", ' $pg_args | sed 's/, $//')]
          env:
            - name: POSTGRES_PASSWORD
              valueFrom: { secretKeyRef: { name: pg-admin, key: password } }
          ports: [{ containerPort: 5432 }]
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: pg-ref }
spec:
  serviceName: pg-ref
  selector: { matchLabels: { app: pg-ref } }
  template:
    metadata: { labels: { app: pg-ref } }
    spec:
      containers:
        - name: postgres
          image: postgres:13-alpine
          env:
            - name: POSTGRES_PASSWORD
              valueFrom: { secretKeyRef: { name: pg-admin, key: password } }
          ports: [{ containerPort: 5432 }]
YAML
in_vm "kubectl --context kind-demo -n $ns rollout status statefulset/pg-gen statefulset/pg-ref --timeout 180s >/dev/null"
ready='for i in $(seq 60); do pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1'
in_vm "kubectl --context kind-demo -n $ns exec statefulset/pg-gen -- sh -c '$ready' && \
  kubectl --context kind-demo -n $ns exec statefulset/pg-ref -- sh -c '$ready' && \
  docker exec e2e-pg-gen sh -c '$ready' && docker exec e2e-pg-file sh -c '$ready'"
# pg_stat_statements on the 17s; WatchLog's role, made by an admin beforehand, on the
# servers it reaches through a Secret or a file.
in_vm "kubectl --context kind-demo -n $ns exec statefulset/pg-gen -- psql -U postgres -qc 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements' && \
  docker exec e2e-pg-gen psql -U postgres -qc 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements' && \
  w=\$(cat ~/.pg-e2e-watchlog) && rm -f ~/.pg-e2e-watchlog && \
  kubectl --context kind-demo -n $ns exec statefulset/pg-ref -- psql -U postgres -qc \"CREATE ROLE watchlog_ref LOGIN PASSWORD '\$w'\" -c 'GRANT pg_monitor TO watchlog_ref' && \
  docker exec e2e-pg-file psql -U postgres -qc \"CREATE ROLE watchlog_file LOGIN PASSWORD '\$w'\" -c 'GRANT pg_monitor TO watchlog_file'"

say "connect, test and monitor; the failure cases; reasons"
WATCHLOG_URL=$url VM=$vm NS=$ns DOCKER_HOST_NAME=$(in_vm hostname) python3 - <<'PY'
import http.cookiejar, json, os, re, shlex, subprocess, sys, time, urllib.error, urllib.parse, urllib.request

url = os.environ["WATCHLOG_URL"] + "/api/v1"
vm, ns, host = os.environ["VM"], os.environ["NS"], os.environ["DOCKER_HOST_NAME"]
vm_url = os.environ.get("WATCHLOG_E2E_VM_URL", "")
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
    # WatchLog's commands name no kubectl context: the demo's is added here.
    cmd = re.sub(r"^kubectl ", "kubectl --context kind-demo ", cmd)
    r = subprocess.run(["limactl", "shell", vm, "bash", "-c", "export PATH=$HOME/bin:$PATH && " + cmd],
                       capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        # The command holds a password: only its start is shown.
        raise RuntimeError(f"{cmd.split(' -c')[0]}…: {r.stderr.strip()[:300]}")
    return r.stdout

def psql(where, sql, db="postgres", background=False):
    """psql as the admin, inside the pod or container, over its local socket."""
    run = f"psql -U postgres -d {db} -qc {shlex.quote(sql)}"
    if background:
        run = f"({run} >/dev/null 2>&1 </dev/null &)"
    if where.startswith("docker:"):
        return vm_run(f"docker exec {where[7:]} sh -c {shlex.quote(run)}")
    return vm_run(f"kubectl exec -n {ns} statefulset/{where} -- sh -c {shlex.quote(run)}")

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

# The four PostgreSQL servers, found by the agents.
want = {("kubernetes", f"{ns}/pg-gen"), ("kubernetes", f"{ns}/pg-ref"), ("docker", "e2e-pg-gen"), ("docker", "e2e-pg-file")}
def found():
    d = {(x["cluster"]["kind"], x["name"]): x for x in call("GET", "/applications/discovered")["discovered"] if x["type"] == "postgres"}
    return d if want <= set(d) else None
# A previous run that stopped early may have left its services monitored, so they aren't
# "discovered" any more: remove them first.
for x in call("GET", "/applications")["applications"]:
    if x["type"] == "postgres" and (x["cluster"]["kind"], x["name"]) in want:
        call("DELETE", f"/applications/{x['id']}")
d = wait(found, 180, 5) or {}
check("the four PostgreSQL servers are discovered", bool(d), str(sorted(d)))
if not d:
    sys.exit(1)

def probe(svc, access):
    body = {"clusterId": svc["cluster"]["id"], "type": "postgres", "target": svc["target"], "access": access}
    if svc["target"]["kind"] == "address":
        body["collectorHost"] = host
    return call("POST", "/applications/probes", body)

def settle(p, timeout=90):
    pid = p["probe"]["id"]
    def done():
        q = call("GET", f"/applications/probes/{pid}")["probe"]
        return q if q["status"] == "ok" or (q["result"] and q["result"]["code"] != "unreachable" and q["attempts"] >= 2) else None
    return wait(done, timeout) or call("GET", f"/applications/probes/{pid}")["probe"]

def passed(pid, timeout=90):
    return wait(lambda: (lambda x: x if x["status"] == "ok" else None)(call("GET", f"/applications/probes/{pid}")["probe"]), timeout)

monitored = []
import atexit
@atexit.register
def unmonitor():
    for m in monitored:
        call("DELETE", f"/applications/{m}", ok=False)
def monitor(svc, probe_id):
    a = call("POST", "/applications", {"clusterId": svc["cluster"]["id"], "type": "postgres", "target": svc["target"],
                                         "probeId": probe_id, "defaultAlerts": ["postgres_connections_high", "postgres_long_query"]})["application"]
    monitored.append(a["id"])
    return a

def connected(app_id, label):
    def ok():
        a = call("GET", f"/applications/{app_id}")
        return a if a["application"]["reason"]["code"] == "connected" else None
    a = wait(ok, 120)
    check(f"{label}: connected", bool(a), json.dumps(call('GET', f'/applications/{app_id}')['reasons'])[:300])
    return a

TABS = ("overview", "connections", "queries", "locks", "replication", "tables", "vacuum")
def page_ok(app_id, label):
    a = connected(app_id, label)
    check(f"{label}: the PostgreSQL page", bool(a) and a["page"]["id"] == "postgres")
    def filled():
        ps = call("GET", f"/applications/{app_id}/panels?tab=overview")["panels"]
        s = next(p for p in ps if p["id"] == "summary")
        return ps if s["state"] == "ok" else None
    check(f"{label}: the Overview fills", bool(wait(filled, 90)))
    # A heavy scrape (every 30 s) brings the statements and tables.
    def tables():
        ps = call("GET", f"/applications/{app_id}/panels?tab=tables")["panels"]
        return ps if next(p for p in ps if p["id"] == "size")["state"] == "ok" else None
    check(f"{label}: Tables and storage fills", bool(wait(tables, 90)))
    perms = [f"{t}/{p['id']}" for t in TABS
             for p in call("GET", f"/applications/{app_id}/panels?tab={t}")["panels"] if p["state"] == "needs_permission"]
    check(f"{label}: the generated role can read every panel", not perms, str(perms))

# 1. The generated pg_monitor role, on Kubernetes and Docker: the command, run for real.
for key, via in [(("kubernetes", f"{ns}/pg-gen"), "kubectl exec"), (("docker", "e2e-pg-gen"), "docker exec")]:
    svc = d[key]
    p = probe(svc, {"method": "generated"})
    cmd = p["command"]
    check(f"{key[0]}: the command uses {via} and grants pg_monitor",
          cmd.startswith(via) and "GRANT pg_monitor TO" in cmd, cmd.split(" -c")[0])
    first = settle(p, 45)
    check(f"{key[0]}: before the command runs, the test waits (auth_failed)",
          first["status"] == "pending" and (first["result"] or {}).get("code") == "auth_failed", json.dumps(first))
    vm_run(cmd)
    call("POST", f"/applications/probes/{p['probe']['id']}/check")
    q = passed(p["probe"]["id"], 60)
    check(f"{key[0]}: after the command, the test passes with no excess privilege",
          bool(q) and q["result"]["code"] == "ok" and not q["result"]["excess"]
          and q["result"]["facts"].get("pg_stat_statements") == "installed", json.dumps(q))
    a = monitor(svc, p["probe"]["id"])
    page_ok(a["id"], f"{key[0]} generated role")

# 2. A wrong password, and a role without pg_monitor (Kubernetes 17).
k_gen = d[("kubernetes", f"{ns}/pg-gen")]
wrong = settle(probe(k_gen, {"method": "entered", "username": "watchlog", "password": "not-the-password"}))
check("a wrong password fails as auth_failed", (wrong["result"] or {}).get("code") == "auth_failed", json.dumps(wrong))
psql("pg-gen", "DROP ROLE IF EXISTS nomon; CREATE ROLE nomon LOGIN PASSWORD 'a-password-for-e2e'")
nomon = settle(probe(k_gen, {"method": "entered", "username": "nomon", "password": "a-password-for-e2e"}))
check("a role without pg_monitor fails as permission_missing, naming it",
      (nomon["result"] or {}).get("code") == "permission_missing" and nomon["result"]["missing"] == ["pg_monitor"], json.dumps(nomon))

# 3. Kubernetes: the password in a Secret; refused until the Role and RoleBinding exist.
k_ref = d[("kubernetes", f"{ns}/pg-ref")]
p = probe(k_ref, {"method": "reference", "username": "watchlog_ref", "secret": {"name": "pg-e2e-password", "key": "password"}})
before = settle(p, 45)
check("Secret: before the Role, the test says the collector may not read it",
      (before["result"] or {}).get("code") == "credential_unavailable" and "may not read" in (before["result"]["error"] or ""), json.dumps(before))
for c in p["commands"]:
    vm_run(c)
call("POST", f"/applications/probes/{p['probe']['id']}/check")
after = passed(p["probe"]["id"])
check("Secret: after the Role and RoleBinding, the test passes (PostgreSQL 13)",
      bool(after) and after["result"]["version"].startswith("13"), json.dumps(call("GET", f"/applications/probes/{p['probe']['id']}")))
a = monitor(k_ref, p["probe"]["id"])
if connected(a["id"], "Secret: the service with the password from the Secret"):
    def no_sessions_note():
        ps = call("GET", f"/applications/{a['id']}/panels?tab=connections")["panels"]
        n = next(x for x in ps if x["id"] == "new")
        return n if (n.get("note") or {}).get("key", "").endswith("noSessions") else None
    check("PostgreSQL 13: the new-connections panel says sessions need 14+", bool(wait(no_sessions_note, 60)))
    def statements_reason():
        return "statements_unavailable" in {r["code"] for r in call("GET", f"/applications/{a['id']}")["reasons"]} or None
    check("PostgreSQL 13 without pg_stat_statements: the page says so", bool(wait(statements_reason, 90)))

# 4. Docker: the password in a file on the host.
f_svc = d[("docker", "e2e-pg-file")]
p = probe(f_svc, {"method": "reference", "username": "watchlog_file", "file": "e2e-pg-file"})
check("File: WatchLog shows the mount", p.get("mount") == "-v /etc/watchlog/secrets:/etc/watchlog/secrets:ro")
ok = passed(p["probe"]["id"], 60)
check("File: the test passes with the password from the file", bool(ok), json.dumps(call("GET", f"/applications/probes/{p['probe']['id']}")))
a = monitor(f_svc, p["probe"]["id"])
connected(a["id"], "File: the service with the password from the file")

# 5. Scripted on the Kubernetes 17 server: 500 tables, connections near the limit, a lock
#    wait and a long query.
k_app = monitored[0]
psql("pg-gen", "DROP DATABASE IF EXISTS many")
psql("pg-gen", "CREATE DATABASE many")
psql("pg-gen", "DO $$ BEGIN FOR i IN 1..500 LOOP EXECUTE format('CREATE TABLE t%s (id int)', i); "
               "EXECUTE format('INSERT INTO t%s SELECT generate_series(1, 10)', i); END LOOP; END $$", db="many")
# The table series, before the connections below fill the server: reading another
# database's tables takes a second connection.
if vm_url:
    def series():
        q = urllib.parse.quote(f'count(watchlog_postgres_table_size_bytes{{service="{k_app}"}})')
        with urllib.request.urlopen(f"{vm_url}/api/v1/query?query={q}", timeout=30) as r:
            res = json.loads(r.read())["data"]["result"]
        n = int(float(res[0]["value"][1])) if res else 0
        return n if n >= 100 else None
    n = wait(series, 120, 10)
    check("500 tables: the table series stay capped at 100", n == 100, str(n))

# max_connections 40, 1 reserved: 35 sleeping sessions and the lock pair are 37 (92 %),
# and WatchLog's role still gets in.
sleepers = "for i in $(seq 35); do (psql -U postgres -qc 'SELECT pg_sleep(180)' >/dev/null 2>&1 </dev/null &); done"
vm_run(f"kubectl exec -n {ns} statefulset/pg-gen -- sh -c {shlex.quote(sleepers)}")
psql("pg-gen", "BEGIN; LOCK TABLE t1 IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(180); COMMIT", db="many", background=True)
time.sleep(1)
psql("pg-gen", "SELECT count(*) FROM t1", db="many", background=True)
def reasons():
    codes = {r["code"] for r in call("GET", f"/applications/{k_app}")["reasons"]}
    return codes if {"connections_near_max", "lock_waits"} <= codes else None
got = wait(reasons, 120, 5)
check("connections near max_connections and a lock wait are reasons", bool(got),
      str({r['code'] for r in call('GET', f'/applications/{k_app}')['reasons']}))
def blocking():
    ps = call("GET", f"/applications/{k_app}/panels?tab=locks")["panels"]
    b = next(x for x in ps if x["id"] == "blocking")
    return b if b["state"] == "ok" and b["rows"] else None
b = wait(blocking, 90)
check("Locks: blocking right now shows the waiting and the blocking session", bool(b), json.dumps(b)[:300])
def long_query():
    ps = call("GET", f"/applications/{k_app}/panels?tab=overview")["panels"]
    t = next(x for x in next(p for p in ps if p["id"] == "summary")["tiles"] if x["id"] == "longest")
    return t if (t["value"] or 0) >= 60 else None
check("the longest query passes a minute", bool(wait(long_query, 120, 5)))
print(f"\n{failures} failed" if failures else "\nall passed")
sys.exit(1 if failures else 0)
PY
