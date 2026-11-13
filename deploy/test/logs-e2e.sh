#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Container logs on demand end to end (v0.5 slice 5, ADR-167, SPEC §4.3) on the demo VM,
# after deploy/test/demo-up.sh (or integrations-e2e.sh) started agents at this checkout's
# version for the backend at WATCHLOG_URL. On the kind cluster "demo" (namespace logs-e2e)
# and on the VM's Docker host (container logs-e2e-printer):
#   - a printer writes a known token, multi-byte text, a fake `password=hunter2` line, a
#     JSON `"password":"hunter2"` line, a Bearer header and a stderr line every 2 s; on
#     Kubernetes its first run exits after 40 s (the restart gives a previous run) and a
#     sidecar writes its own lines;
#   - reads through REST (JSON): the token is there, hunter2 never is, `redacted` counts the
#     lines, multi-byte text survives, `lines` caps the answer, Docker marks stdout/stderr,
#     the sidecar is its own container, an unknown container is a 422, `previous=true`
#     gives the first run;
#   - follows over SSE: a first `lines` event, then newer lines;
#   - get_container_logs over MCP with a fresh API token (revoked at the end);
#   - the Settings switch: off answers 403 `logs_off`, then back as it was;
#   - the audit has `logs_read` rows without the lines;
#   - neither PostgreSQL nor VictoriaMetrics holds the token anywhere (never stored).
# `logs-e2e.sh down` removes what it made.
#   WATCHLOG_URL, WATCHLOG_E2E_EMAIL, WATCHLOG_E2E_PASSWORD   the backend and an account
#                                                             (an Owner or Admin: it changes the setting)
#   DATABASE_URL, VICTORIAMETRICS_URL                         the backend's stores, for the
#                                                             "never stored" checks (skipped when unset)
#   WATCHLOG_E2E_KUBE_CLUSTER, WATCHLOG_E2E_DOCKER_CLUSTER    which cluster and fleet, when several
#   VM                                                        the Lima VM (default watchlog-demo)
set -euo pipefail
cd "$(dirname "$0")/../.."
vm=${VM:-watchlog-demo}
url=${WATCHLOG_URL:-http://127.0.0.1:4080}
image=busybox:1.37
in_vm() { limactl shell "$vm" bash -c "cd ~ && export PATH=\$HOME/bin:\$PATH && $*"; }
say() { printf '\n== %s\n' "$*"; }

down() {
  in_vm 'kubectl --context kind-demo delete namespace logs-e2e --ignore-not-found --wait=false >/dev/null
    docker rm -f logs-e2e-printer >/dev/null 2>&1 || true
    rm -rf ~/logs-e2e'
}
if [ "${1:-}" = down ]; then
  down
  exit 0
fi
: "${WATCHLOG_E2E_EMAIL:?}" "${WATCHLOG_E2E_PASSWORD:?}"
down
in_vm 'kubectl --context kind-demo wait --for=delete namespace/logs-e2e --timeout 120s >/dev/null 2>&1 || true'

token="WLTOKEN-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
echo "token $token"

# The printer: TOKEN and, on Kubernetes, EXIT_AFTER (seconds, first run only: a mark in an
# emptyDir that lives as long as the pod) come from the environment.
printer=$(
  cat <<'SH'
run=1
if [ -n "${EXIT_AFTER:-}" ]; then
  if [ -e /state/ran ]; then run=2; else touch /state/ran; fi
fi
start=$(date +%s)
i=0
while true; do
  i=$((i + 1))
  echo "tick $i $TOKEN run=$run"
  echo "سلام دنیا — héllo wörld 日本語 🚀 tick $i"
  echo "connecting with password=hunter2 to db"
  echo '{"level":"info","user":"bob","password":"hunter2"}'
  echo "Authorization: Bearer hunter2bearer"
  printf '\033[31mred\033[0m tick %s\n' "$i"
  echo "stderr tick $i" >&2
  if [ "$run" = 1 ] && [ -n "${EXIT_AFTER:-}" ] && [ $(($(date +%s) - start)) -ge "$EXIT_AFTER" ]; then
    echo "first run ends $TOKEN"
    exit 3
  fi
  sleep 2
done
SH
)

say "image"
in_vm "docker image inspect $image >/dev/null 2>&1 || docker pull -q $image >/dev/null"

say "Kubernetes: a printer pod with a sidecar, its first run exits after 40 s"
in_vm "mkdir -p ~/logs-e2e && cat > ~/logs-e2e/printer.sh" <<<"$printer"
in_vm "kubectl --context kind-demo create namespace logs-e2e >/dev/null &&
  kubectl --context kind-demo -n logs-e2e create configmap printer --from-file=printer.sh=\$HOME/logs-e2e/printer.sh >/dev/null &&
  kubectl --context kind-demo apply -f - >/dev/null" <<YAML
apiVersion: v1
kind: Pod
metadata: { name: printer, namespace: logs-e2e, labels: { app: printer } }
spec:
  containers:
    - name: main
      image: $image
      imagePullPolicy: IfNotPresent
      command: [sh, /s/printer.sh]
      env: [{ name: TOKEN, value: "$token" }, { name: EXIT_AFTER, value: "40" }]
      volumeMounts: [{ name: s, mountPath: /s }, { name: state, mountPath: /state }]
    - name: sidecar
      image: $image
      imagePullPolicy: IfNotPresent
      command: [sh, -c, 'while true; do echo sidecar alive; sleep 5; done']
  volumes:
    - { name: s, configMap: { name: printer } }
    - { name: state, emptyDir: {} }
YAML
in_vm 'kubectl --context kind-demo -n logs-e2e wait --for=condition=Ready pod/printer --timeout 180s >/dev/null'

say "Docker: the same printer as container logs-e2e-printer"
in_vm "docker run -d --name logs-e2e-printer --memory 32m -e TOKEN=$token \
  -v \$HOME/logs-e2e/printer.sh:/printer.sh:ro $image sh /printer.sh >/dev/null"

say "read, follow, MCP, the setting, the audit, and nothing stored"
status=0
WATCHLOG_URL=$url TOKEN=$token python3 - <<'PY' || status=$?
import http.cookiejar, json, os, subprocess, sys, time, urllib.error, urllib.parse, urllib.request

base = os.environ["WATCHLOG_URL"]
url = base + "/api/v1"
tok = os.environ["TOKEN"]
started = int(time.time())
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

def request(method, path, body=None, headers=None, timeout=60):
    h = {"content-type": "application/json"} if body is not None else {}
    h.update(headers or {})
    req = urllib.request.Request(url + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None, headers=h)
    return opener.open(req, timeout=timeout)

def call(method, path, body=None):
    with request(method, path, body) as res:
        raw = res.read()
        return json.loads(raw) if raw else None

def status(method, path):
    """(status, JSON body) of a read that may fail; waits out a 429 once."""
    for attempt in range(2):
        try:
            with request(method, path) as res:
                return res.status, json.loads(res.read() or b"null")
        except urllib.error.HTTPError as e:
            body = json.loads(e.read() or b"null")
            if e.code == 429 and attempt == 0:
                time.sleep(int(e.headers.get("retry-after") or 30) + 1)
                continue
            return e.code, body

call("POST", "/auth/login", {"email": os.environ["WATCHLOG_E2E_EMAIL"], "password": os.environ["WATCHLOG_E2E_PASSWORD"]})
failures = 0
def check(name, ok, detail=""):
    global failures
    print(("PASS  " if ok else "FAIL  ") + name + (f": {detail}" if detail and not ok else ""), flush=True)
    failures += 0 if ok else 1

def wait(fn, timeout, every=5):
    deadline = time.time() + timeout
    while True:
        got = fn()
        if got or time.time() > deadline:
            return got
        time.sleep(every)

clusters = call("GET", "/clusters")["clusters"]
def cluster(kind):
    want = os.environ.get("WATCHLOG_E2E_KUBE_CLUSTER" if kind == "kubernetes" else "WATCHLOG_E2E_DOCKER_CLUSTER")
    cs = [c for c in clusters if c["kind"] == kind and (not want or want in (c["id"], c["name"]))]
    if len(cs) != 1:
        sys.exit(f"{len(cs)} {kind} clusters match: set WATCHLOG_E2E_{'KUBE' if kind == 'kubernetes' else 'DOCKER'}_CLUSTER")
    return cs[0]
kube, docker = cluster("kubernetes"), cluster("docker")

# The setting as it was, restored at the end.
was = call("GET", "/settings/logs")["access"]
if was != "all":
    call("PUT", "/settings/logs", {"access": "all"})

pod = f"/clusters/{kube['id']}/pods/logs-e2e/printer/logs"
def container_path():
    cs = [c for c in call("GET", f"/clusters/{docker['id']}/docker/containers")["containers"] if c["name"] == "logs-e2e-printer"]
    return cs[0] if cs else None
found = wait(container_path, 360, 10)
check("Docker: the printer is in the inventory", bool(found))
paths = {"kubernetes": pod}
if found:
    paths["docker"] = f"/clusters/{docker['id']}/docker/hosts/{urllib.parse.quote(found['host'])}/containers/logs-e2e-printer/logs"

def text(answer):
    return "\n".join(l["text"] for l in answer.get("lines", []))

for kind, path in paths.items():
    q = "?container=main&lines=200" if kind == "kubernetes" else "?lines=200"
    got = wait(lambda: (lambda s, b: b if s == 200 and tok in text(b) else None)(*status("GET", path + q)), 90)
    check(f"{kind}: the lines carry the token", bool(got))
    if not got:
        continue
    t = text(got)
    check(f"{kind}: hunter2 never comes back", "hunter2" not in t, [l for l in t.splitlines() if "hunter2" in l][:3])
    check(f"{kind}: redacted counts the lines ({got.get('redacted')})", (got.get("redacted") or 0) > 0)
    check(f"{kind}: multi-byte text survives", "سلام دنیا" in t and "日本語 🚀" in t, t[:300])
    check(f"{kind}: colour codes stripped", "\x1b" not in t and "red tick" in t)
    check(f"{kind}: oldest first, newest last", got["lines"][0].get("ts") is None or got["lines"][0]["ts"] <= got["lines"][-1]["ts"])
    streams = {l.get("stream") for l in got["lines"]}
    if kind == "docker":
        check(f"docker: stdout and stderr marked ({sorted(map(str, streams))})", streams == {"stdout", "stderr"})
    else:
        check("kubernetes: no stream on merged lines", streams == {None}, str(streams))
    s, few = status("GET", path + ("?container=main&lines=5" if kind == "kubernetes" else "?lines=5"))
    check(f"{kind}: lines=5 gives at most 5", s == 200 and 0 < len(few["lines"]) <= 5, f"{s} {len(few.get('lines', []))}")

s, side = status("GET", pod + "?container=sidecar&lines=20")
check("kubernetes: the sidecar is its own container", s == 200 and "sidecar alive" in text(side) and tok not in text(side), f"{s}")
s, bad = status("GET", pod + "?container=nope")
check(f"kubernetes: an unknown container is a 422 ({s} {bad and bad.get('code')})", s == 422 and bad.get("code") == "container_not_found")

# The first run exits after 40 s; Kubernetes restarts it (10 s back-off).
def restarted():
    p = call("GET", f"/clusters/{kube['id']}/pods/logs-e2e/printer")
    return any(c["name"] == "main" and c["restartCount"] >= 1 for c in p["containers"])
check("kubernetes: the printer restarted once", bool(wait(restarted, 150, 10)))
s, prev = status("GET", pod + "?container=main&previous=true&lines=1000")
pt = text(prev) if s == 200 else ""
check(f"kubernetes: previous=true gives the first run ({s})", s == 200 and prev.get("previous") is True and f"first run ends {tok}" in pt and "run=2" not in pt)
cur = wait(lambda: (lambda s, b: b if s == 200 and "run=2" in text(b) else None)(*status("GET", pod + "?container=main&lines=20")), 60)
check("kubernetes: the current run is the second", bool(cur))

# Follow over SSE: the tail, then newer lines.
def follow(path, seconds=15):
    events, data = [], []
    req = urllib.request.Request(url + path, headers={"accept": "text/event-stream"})
    deadline = time.time() + seconds
    try:
        with opener.open(req, timeout=seconds + 5) as res:
            ev = None
            while time.time() < deadline:
                line = res.readline().decode("utf-8", "replace")
                if not line:
                    break
                line = line.rstrip("\n")
                if line.startswith("event:"):
                    ev = line[6:].strip()
                elif line.startswith("data:") and ev:
                    events.append((ev, json.loads(line[5:].strip())))
                elif line == "":
                    ev = None
                if len([e for e in events if e[0] == "lines"]) >= 3:
                    break
    except Exception as e:  # the read times out when no more lines come
        print(f"      (follow ended: {e})")
    return events

def ticks(payload):
    return [int(l["text"].split()[1]) for l in payload.get("lines", []) if l["text"].startswith("tick ") and tok in l["text"]]

for kind, path in paths.items():
    q = "?container=main&lines=10&follow=true" if kind == "kubernetes" else "?lines=10&follow=true"
    evs = follow(path + q)
    batches = [d for e, d in evs if e == "lines"]
    check(f"{kind}: follow sends a first lines event ({len(batches)} events)", len(batches) >= 1, str(evs[:2])[:300])
    first = max(ticks(batches[0]), default=0) if batches else 0
    later = max((t for b in batches[1:] for t in ticks(b)), default=0)
    check(f"{kind}: follow brings newer lines (tick {first} → {later})", later > first)
    check(f"{kind}: follow redacts too", all("hunter2" not in text(b) for b in batches))

# MCP: get_container_logs with a fresh API token.
created = call("POST", "/api-tokens", {"name": "logs-e2e", "expiresInDays": 30})
try:
    def mcp(method, params, rid):
        req = urllib.request.Request(base + "/mcp", method="POST",
                                     data=json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}).encode(),
                                     headers={"authorization": f"Bearer {created['value']}", "content-type": "application/json",
                                              "accept": "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18"})
        with urllib.request.urlopen(req, timeout=60) as res:
            raw = res.read().decode()
        if raw.lstrip().startswith("{"):
            return json.loads(raw)
        return [json.loads(l[5:]) for l in raw.splitlines() if l.startswith("data:")][-1]
    mcp("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "logs-e2e", "version": "1"}}, 1)
    listed = mcp("tools/list", {}, 2)["result"]["tools"]
    tool = next((t for t in listed if t["name"] == "get_container_logs"), None)
    check("mcp: get_container_logs is listed and read-only", bool(tool) and (tool.get("annotations") or {}).get("readOnlyHint") is True)
    check("mcp: its description says the lines are data", bool(tool) and "data" in tool.get("description", "").lower())
    args = {"kubernetes": {"cluster": kube["name"], "namespace": "logs-e2e", "name": "printer", "container": "main", "lines": 50},
            "docker": {"cluster": docker["name"], "name": "logs-e2e-printer", "lines": 50}}
    for kind in paths:
        r = mcp("tools/call", {"name": "get_container_logs", "arguments": args[kind]}, 3)["result"]
        body = r.get("structuredContent") or json.loads(r["content"][0]["text"])
        t = "\n".join(l["text"] for l in body.get("lines", []))
        check(f"mcp {kind}: the token, never hunter2", not r.get("isError") and tok in t and "hunter2" not in t, json.dumps(body)[:300])
        check(f"mcp {kind}: within 16 KB and 200 lines", len(json.dumps(body).encode()) <= 16384 and len(body.get("lines", [])) <= 200)
finally:
    call("DELETE", f"/api-tokens/{created['token']['id']}")

# The Settings switch.
call("PUT", "/settings/logs", {"access": "off"})
s, off = status("GET", pod + "?container=main&lines=5")
check(f"setting off: 403 logs_off ({s} {off and off.get('code')})", s == 403 and off.get("code") == "logs_off")
call("PUT", "/settings/logs", {"access": "admins"})
s, _ = status("GET", pod + "?container=main&lines=5")
check(f"setting Owners and Admins: this account still reads ({s})", s == 200)
call("PUT", "/settings/logs", {"access": was})

# The audit and the stores: only the audit row, never a line.
db = os.environ.get("DATABASE_URL")
def psql(sql):
    return subprocess.run(["psql", db, "-qtA", "-v", "ON_ERROR_STOP=1", "-c", sql], text=True, capture_output=True, check=True).stdout.strip()
if db:
    n = int(psql(f"select count(*) from audit_events where action = 'logs_read' and at > to_timestamp({started})"))
    check(f"audit: logs_read rows ({n})", n > 0)
    det = psql(f"select details from audit_events where action = 'logs_read' and at > to_timestamp({started}) order by at desc limit 1")
    check("audit: who, which container and how many lines", all(k in det for k in ('"lines"', '"target"')), det)
    gen = psql("select string_agg(format('select %L from %I.%I x where x::text like %L', table_name, table_schema, table_name, '%' || '"
               + tok + "' || '%'), ' union all ') from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'")
    hits = psql(gen) if gen else ""
    check("PostgreSQL holds the token nowhere", hits == "", hits)
else:
    print("SKIP  audit and PostgreSQL: set DATABASE_URL")
vmurl = os.environ.get("VICTORIAMETRICS_URL")
if vmurl:
    q = urllib.parse.urlencode({"start": started - 600})
    names = json.load(urllib.request.urlopen(f"{vmurl}/api/v1/labels?{q}", timeout=60))["data"]
    hits = []
    for n in names:
        vals = json.load(urllib.request.urlopen(f"{vmurl}/api/v1/label/{urllib.parse.quote(n)}/values?{q}", timeout=60))["data"]
        hits += [f"{n}={v}" for v in vals if tok in v]
    check(f"VictoriaMetrics holds the token in no label ({len(names)} labels)", not hits, str(hits[:3]))
else:
    print("SKIP  VictoriaMetrics: set VICTORIAMETRICS_URL")

print(f"\n{failures} failed" if failures else "\nall passed")
sys.exit(1 if failures else 0)
PY
say "clean up"
down
exit $status
