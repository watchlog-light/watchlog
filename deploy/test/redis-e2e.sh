#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Redis end to end (v0.3 slice 7, SPEC §4.12, ADR-134) on the demo VM, after
# deploy/test/integrations-e2e.sh has started the agents and collectors (same backend,
# same environment variables). On the kind cluster "demo" and on the VM's Docker host:
#   - the generated ACL user: WatchLog's command run for real through `kubectl exec` and
#     `docker exec`, then the connection test passes and the Redis page fills;
#   - a wrong password fails as auth_failed, a user without +info as permission_missing;
#   - Kubernetes: a requirepass Redis whose password is in a Secret; the test fails until
#     the Role and RoleBinding WatchLog writes are applied, then passes;
#   - Docker: a requirepass Redis whose password is in a root-owned 0600 file under the
#     collector's /etc/watchlog/secrets (~/watchlog-e2e-secrets on the VM, written by a
#     root container, as the documented sudo commands would);
#   - memory near maxmemory and evictions, scripted, appear as reasons.
# Passwords are random per run, never printed. `redis-e2e.sh down` removes what it made.
# shellcheck disable=SC2016
set -euo pipefail
cd "$(dirname "$0")/../.."
vm=${VM:-watchlog-demo}
url=${WATCHLOG_URL:-http://127.0.0.1:4080}
ns=redis-e2e
in_vm() { limactl shell "$vm" bash -c "cd ~ && export PATH=\$HOME/bin:\$PATH && $*"; }
say() { printf '\n== %s\n' "$*"; }

down() {
  in_vm "kubectl --context kind-demo delete namespace $ns --ignore-not-found --wait=false >/dev/null
    kubectl --context kind-demo -n watchlog-e2e delete secret redis-e2e-password --ignore-not-found >/dev/null
    kubectl --context kind-demo -n watchlog-e2e delete role,rolebinding watchlog-read-redis-e2e-password --ignore-not-found >/dev/null
    docker rm -f e2e-redis-acl e2e-redis-file >/dev/null 2>&1 || true
    docker run --rm -v \$HOME/watchlog-e2e-secrets:/s redis:7.2-alpine rm -f /s/e2e-redis-file"
}
if [ "${1:-}" = down ]; then
  down
  exit 0
fi
: "${WATCHLOG_E2E_EMAIL:?}" "${WATCHLOG_E2E_PASSWORD:?}"

say "Redis on kind (namespace $ns) and on the VM's Docker host"
password=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
printf '%s' "$password" | limactl shell "$vm" bash -c "cd ~ && export PATH=\$HOME/bin:\$PATH && p=\$(cat) && \
  kubectl --context kind-demo create namespace $ns --dry-run=client -o yaml | kubectl --context kind-demo apply -f - >/dev/null && \
  kubectl --context kind-demo -n $ns create secret generic redis-auth --from-literal=password=\"\$p\" --dry-run=client -o yaml | kubectl --context kind-demo apply -f - >/dev/null && \
  kubectl --context kind-demo -n watchlog-e2e create secret generic redis-e2e-password --from-literal=password=\"\$p\" --dry-run=client -o yaml | kubectl --context kind-demo apply -f - >/dev/null && \
  docker rm -f e2e-redis-acl e2e-redis-file >/dev/null 2>&1; \
  docker run -d --name e2e-redis-acl redis:7.2-alpine >/dev/null && \
  docker run -d --name e2e-redis-file redis:7.2-alpine redis-server --requirepass \"\$p\" >/dev/null && \
  printf '%s' \"\$p\" | docker run --rm -i -v \$HOME/watchlog-e2e-secrets:/s redis:7.2-alpine sh -c 'umask 077; cat > /s/e2e-redis-file'"
in_vm "kubectl --context kind-demo -n $ns apply -f - >/dev/null" <<YAML
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: redis-acl }
spec:
  serviceName: redis-acl
  selector: { matchLabels: { app: redis-acl } }
  template:
    metadata: { labels: { app: redis-acl } }
    spec:
      containers:
        - name: redis
          image: redis:7.2-alpine
          ports: [{ containerPort: 6379 }]
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: redis-auth }
spec:
  serviceName: redis-auth
  selector: { matchLabels: { app: redis-auth } }
  template:
    metadata: { labels: { app: redis-auth } }
    spec:
      containers:
        - name: redis
          image: redis:7.2-alpine
          args: ["--requirepass", "\$(REDIS_PASSWORD)"]
          env:
            - name: REDIS_PASSWORD
              valueFrom: { secretKeyRef: { name: redis-auth, key: password } }
          ports: [{ containerPort: 6379 }]
YAML
in_vm "kubectl --context kind-demo -n $ns rollout status statefulset/redis-acl statefulset/redis-auth --timeout 180s >/dev/null"

say "connect, test and monitor; the failure cases; reasons"
WATCHLOG_URL=$url VM=$vm NS=$ns DOCKER_HOST_NAME=$(in_vm hostname) python3 - <<'PY'
import http.cookiejar, json, os, re, shlex, subprocess, sys, time, urllib.error, urllib.request

url = os.environ["WATCHLOG_URL"] + "/api/v1"
vm, ns, host = os.environ["VM"], os.environ["NS"], os.environ["DOCKER_HOST_NAME"]
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
                       capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise RuntimeError(f"{cmd.split(' --')[0]}…: {r.stderr.strip()[:300]}")
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

# The four Redis servers, found by the agents.
want = {("kubernetes", f"{ns}/redis-acl"), ("kubernetes", f"{ns}/redis-auth"), ("docker", "e2e-redis-acl"), ("docker", "e2e-redis-file")}
def found():
    d = {(x["cluster"]["kind"], x["name"]): x for x in call("GET", "/applications/discovered")["discovered"] if x["type"] == "redis"}
    return d if want <= set(d) else None
d = wait(found, 180, 5) or {}
check("the four Redis servers are discovered", bool(d), str(sorted(d)))
if not d:
    sys.exit(1)

def probe(svc, access):
    body = {"clusterId": svc["cluster"]["id"], "type": "redis", "target": svc["target"], "access": access}
    if svc["target"]["kind"] == "address":
        body["collectorHost"] = host
    return call("POST", "/applications/probes", body)

def settle(p, timeout=90):
    pid = p["probe"]["id"]
    def done():
        q = call("GET", f"/applications/probes/{pid}")["probe"]
        return q if q["status"] == "ok" or (q["result"] and q["result"]["code"] != "unreachable" and q["attempts"] >= 2) else None
    return wait(done, timeout) or call("GET", f"/applications/probes/{pid}")["probe"]

monitored = []
def monitor(svc, probe_id):
    a = call("POST", "/applications", {"clusterId": svc["cluster"]["id"], "type": "redis", "target": svc["target"],
                                         "probeId": probe_id, "defaultAlerts": ["redis_memory_high", "redis_evicting"]})["application"]
    monitored.append(a["id"])
    return a

def page_ok(app_id, label):
    def connected():
        a = call("GET", f"/applications/{app_id}")
        return a if a["application"]["reason"]["code"] == "connected" else None
    a = wait(connected, 120)
    check(f"{label}: connected", bool(a), json.dumps(call('GET', f'/applications/{app_id}')['reasons'])[:300])
    check(f"{label}: the Redis page", bool(a) and a["page"]["id"] == "redis")
    def filled():
        ps = call("GET", f"/applications/{app_id}/panels?tab=overview")["panels"]
        s = next(p for p in ps if p["id"] == "summary")
        return ps if s["state"] == "ok" else None
    ps = wait(filled, 90)
    check(f"{label}: the Overview fills", bool(ps))
    perms = [p["id"] for t in ("overview", "memory", "commands", "clients")
             for p in call("GET", f"/applications/{app_id}/panels?tab={t}")["panels"] if p["state"] == "needs_permission"]
    check(f"{label}: the generated user can read every panel", not perms, str(perms))

# 1. The generated ACL user, on Kubernetes and Docker: the command, run for real.
for key, via in [(("kubernetes", f"{ns}/redis-acl"), "kubectl exec"), (("docker", "e2e-redis-acl"), "docker exec")]:
    svc = d[key]
    p = probe(svc, {"method": "generated"})
    cmd = p["command"]
    check(f"{key[0]}: the command uses {via}", cmd.startswith(via), cmd.split(" ACL")[0])
    first = settle(p, 30)
    check(f"{key[0]}: before the command runs, the test waits (auth_failed)",
          first["status"] == "pending" and (first["result"] or {}).get("code") == "auth_failed", json.dumps(first))
    vm_run(cmd)
    call("POST", f"/applications/probes/{p['probe']['id']}/check")
    q = wait(lambda: (lambda x: x if x["status"] == "ok" else None)(call("GET", f"/applications/probes/{p['probe']['id']}")["probe"]), 60)
    check(f"{key[0]}: after the command, the test passes with no excess privilege",
          bool(q) and q["result"]["code"] == "ok" and not q["result"]["excess"], json.dumps(q))
    a = monitor(svc, p["probe"]["id"])
    page_ok(a["id"], f"{key[0]} generated user")

# 2. A wrong password, and a user without +info (Kubernetes acl server).
k_acl = d[("kubernetes", f"{ns}/redis-acl")]
wrong = settle(probe(k_acl, {"method": "entered", "username": "watchlog", "password": "not-the-password"}))
check("a wrong password fails as auth_failed", (wrong["result"] or {}).get("code") == "auth_failed", json.dumps(wrong))
vm_run(f"kubectl exec -n {ns} statefulset/redis-acl -- redis-cli ACL SETUSER noinfo reset on '>a-password-for-e2e' +ping")
noinfo = settle(probe(k_acl, {"method": "entered", "username": "noinfo", "password": "a-password-for-e2e"}))
check("a user without +info fails as permission_missing, naming it",
      (noinfo["result"] or {}).get("code") == "permission_missing" and "+info" in noinfo["result"]["missing"], json.dumps(noinfo))

# 3. Kubernetes: the password in a Secret; refused until the Role and RoleBinding exist.
k_auth = d[("kubernetes", f"{ns}/redis-auth")]
p = probe(k_auth, {"method": "reference", "secret": {"name": "redis-e2e-password", "key": "password"}})
before = settle(p, 45)
check("Secret: before the Role, the test says the collector may not read it",
      (before["result"] or {}).get("code") == "credential_unavailable" and "may not read" in (before["result"]["error"] or ""), json.dumps(before))
for c in p["commands"]:
    vm_run(c)
call("POST", f"/applications/probes/{p['probe']['id']}/check")
after = wait(lambda: (lambda x: x if x["status"] == "ok" else None)(call("GET", f"/applications/probes/{p['probe']['id']}")["probe"]), 90)
check("Secret: after the Role and RoleBinding, the test passes", bool(after), json.dumps(call("GET", f"/applications/probes/{p['probe']['id']}")))
a = monitor(k_auth, p["probe"]["id"])
def connected_with_secret():
    x = call("GET", f"/applications/{a['id']}")
    return x if x["application"]["reason"]["code"] == "connected" else None
check("Secret: the service connects with the password from the Secret", bool(wait(connected_with_secret, 120)))

# 4. Docker: the password in a file on the host.
f_svc = d[("docker", "e2e-redis-file")]
p = probe(f_svc, {"method": "reference", "file": "e2e-redis-file"})
check("File: WatchLog shows the mount", p.get("mount") == "-v /etc/watchlog/secrets:/etc/watchlog/secrets:ro")
ok = wait(lambda: (lambda x: x if x["status"] == "ok" else None)(call("GET", f"/applications/probes/{p['probe']['id']}")["probe"]), 60)
check("File: the test passes with the password from the file", bool(ok), json.dumps(call("GET", f"/applications/probes/{p['probe']['id']}")))
a = monitor(f_svc, p["probe"]["id"])
def connected_with_file():
    x = call("GET", f"/applications/{a['id']}")
    return x if x["application"]["reason"]["code"] == "connected" else None
check("File: the service connects with the password from the file", bool(wait(connected_with_file, 120)))

# 5. Memory near maxmemory and evictions on the Kubernetes acl server.
k_app = monitored[0]
vm_run(f"kubectl exec -n {ns} statefulset/redis-acl -- redis-cli CONFIG SET maxmemory 3mb")
vm_run(f"kubectl exec -n {ns} statefulset/redis-acl -- redis-cli CONFIG SET maxmemory-policy allkeys-lru")
fill = "for i=1,30000 do redis.call('set','e2e:'..i,string.rep('x',200)) end return 1"
vm_run(f"kubectl exec -n {ns} statefulset/redis-acl -- redis-cli EVAL {shlex.quote(fill)} 0")
def reasons():
    codes = {r["code"] for r in call("GET", f"/applications/{k_app}")["reasons"]}
    return codes if {"evicting", "memory_near_max"} <= codes else None
got = wait(reasons, 150, 5)
check("eviction and memory near maxmemory are reasons", bool(got), str({r['code'] for r in call('GET', f'/applications/{k_app}')['reasons']}))

for m in monitored:
    call("DELETE", f"/applications/{m}")
print(f"\n{failures} failed" if failures else "\nall passed")
sys.exit(1 if failures else 0)
PY
