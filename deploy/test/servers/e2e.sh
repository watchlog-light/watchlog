#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Servers end to end (ADR-207 to ADR-213) on a test VM (servers.sh up <distro> first), every
# step bounded: a throwaway backend and alert worker from this checkout on this machine, a
# Server fleet, the agent installed in the VM by the install script with the fleet's token,
# then through the API: the server and its workloads from all three sources; a release
# followed by a real crash loop, with its exits, the release on the timeline, probable cause
# "release" and the default rule firing; a service's log on demand; a service's external
# destination in Egress; the series What changed scores for services and process groups;
# PHP-FPM installed natively and Redis in a container, discovered and monitored; the server's
# own events (0.9.2): a pm2 app killed, a unit failing, an OOM kill, a release, each on Events
# within a minute. Root inside
# the VM only (the owner's exception: testing the installer). Leaves nothing behind: the
# agent is uninstalled, the backend stopped and its database dropped.
#   deploy/test/servers/e2e.sh <distro>
# Environment (defaults: the dev infrastructure, `pnpm infra:up`):
#   E2E_PG_CONTAINER   the PostgreSQL container to create the database in (watchlog-dev-postgres-1)
#   E2E_PG_URL         its URL without the database (postgres://watchlog:watchlog@127.0.0.1:54320)
#   E2E_VM_URL         VictoriaMetrics (http://127.0.0.1:8428)
#   E2E_SMTP_URL       SMTP for the backend (smtp://127.0.0.1:1025)
#   E2E_PORT           the backend's port, reachable from the VM (4191; +1 internal, +2 worker)
#   E2E_KEEP=1         leave the backend, its database and the agent running afterwards (debugging)
#   E2E_ONLY=events    stop after the server's own events (0.9.2): a pm2 app killed, a unit
#                      failing, an OOM kill under MemoryMax, an executable replaced
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
distro=${1:?distro}
vm="wl-srv-$distro"
bounded() { local s=$1; shift; perl -e 'alarm shift; exec @ARGV or die "exec: $!"' "$s" "$@"; }
in_vm() { bounded "${BOUND:-300}" limactl shell "$vm" sudo bash -c "$*"; }
pg_container=${E2E_PG_CONTAINER:-watchlog-dev-postgres-1}
pg_url=${E2E_PG_URL:-postgres://watchlog:watchlog@127.0.0.1:54320}
port=${E2E_PORT:-4191}
db=watchlog_servers_e2e
work=$(mktemp -d)
psql() { docker exec "$pg_container" psql -U watchlog -d "$1" -qtA -c "$2"; }
# npx runs tsx, which runs node: stop the whole tree, not only the pid it wrote.
killtree() { local c; for c in $(pgrep -P "$1" 2>/dev/null); do killtree "$c"; done; kill "$1" 2>/dev/null; }
cleanup() {
  if [ -n "${E2E_KEEP:-}" ]; then
    echo "kept: backend :$port (pids $(cat "$work"/*.pid 2>/dev/null | paste -sd' ' -)), logs in $work, agent in $vm"
    return
  fi
  [ -f "$work/backend.pid" ] && killtree "$(cat "$work/backend.pid")"
  [ -f "$work/worker.pid" ] && killtree "$(cat "$work/worker.pid")"
  if [ -n "${home:-}" ]; then
    in_vm "systemctl stop wl-e2e-egress 2>/dev/null; bash $home/wl-dist/install.sh --uninstall >/dev/null 2>&1" >/dev/null 2>&1
    limactl shell "$vm" bash -c 'rm -rf ~/wl-dist' >/dev/null 2>&1
  fi
  sleep 1
  psql postgres "DROP DATABASE IF EXISTS $db WITH (FORCE)" >/dev/null 2>&1
  rm -rf "$work"
}
trap cleanup EXIT

arch=$(limactl list --format '{{.Arch}}' "$vm")
case "$arch" in aarch64) arch=arm64 ;; x86_64) arch=amd64 ;; esac
echo "== the agent's assets ($arch)"
GOPROXY=${GOPROXY:-'https://proxy.golang.org|https://goproxy.io,direct'} \
  bounded 290 "$root/deploy/linux/build.sh" 0.9.2-e2e "$work/dist" "$arch" >/dev/null || { echo "build failed"; exit 1; }
limactl shell "$vm" bash -c 'rm -rf ~/wl-dist && mkdir -p ~/wl-dist'
for f in "$work/dist"/*; do limactl copy "$f" "$vm:wl-dist/"; done
home=$(limactl shell "$vm" bash -c 'echo $HOME')

echo "== a throwaway backend and alert worker on :$port"
psql postgres "DROP DATABASE IF EXISTS $db WITH (FORCE)" >/dev/null
psql postgres "CREATE DATABASE $db" >/dev/null || { echo "no database"; exit 1; }
export DATABASE_URL=$pg_url/$db VICTORIAMETRICS_URL=${E2E_VM_URL:-http://127.0.0.1:8428}
export WATCHLOG_SMTP_URL=${E2E_SMTP_URL:-smtp://127.0.0.1:1025}
export HOST=0.0.0.0 WATCHLOG_INTERNAL_HOST=127.0.0.1 PORT=$port
export WATCHLOG_INTERNAL_PORT=$((port + 1)) WATCHLOG_WORKER_PORT=$((port + 2))
export WATCHLOG_ADMIN_EMAIL=e2e@example.com WATCHLOG_ADMIN_PASSWORD=e2e-password-1234
export WATCHLOG_SECRET_KEY=${WATCHLOG_SECRET_KEY:-$(head -c 32 /dev/urandom | base64)}
(cd "$root/backend" && bounded 120 npx tsx src/migrate.ts >/dev/null) || { echo "migrations failed"; exit 1; }
(cd "$root/backend" && nohup npx tsx src/server.ts >"$work/backend.log" 2>&1 & echo $! >"$work/backend.pid")
(cd "$root/backend" && nohup npx tsx src/alert-worker.ts >"$work/worker.log" 2>&1 & echo $! >"$work/worker.pid")
api=http://127.0.0.1:$port/api/v1
for _ in $(seq 60); do curl -fs -o /dev/null "$api/health" && break; sleep 1; done
curl -fs -o /dev/null "$api/health" || { echo "backend not up"; tail -20 "$work/backend.log"; exit 1; }

export E2E_API=$api E2E_VM_NAME=$vm E2E_HOST="e2e-$distro" E2E_WORK=$work
created=$(python3 - <<'EOF'
import http.cookiejar, json, os, urllib.request
jar = http.cookiejar.MozillaCookieJar(os.environ["E2E_WORK"] + "/cookies")
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def call(m, p, b=None):
    r = urllib.request.Request(os.environ["E2E_API"] + p, method=m, data=json.dumps(b).encode() if b is not None else None,
                               headers={"content-type": "application/json"} if b is not None else {})
    return json.loads(op.open(r, timeout=20).read() or b"null")
call("POST", "/auth/login", {"email": os.environ["WATCHLOG_ADMIN_EMAIL"], "password": os.environ["WATCHLOG_ADMIN_PASSWORD"]})
jar.save(ignore_discard=True)
c = call("POST", "/clusters", {"name": "servers-e2e", "kind": "server"})
print(c["cluster"]["id"], c["token"]["value"])
EOF
) || { echo "no fleet"; exit 1; }
read -r cluster token <<<"$created"
export E2E_CLUSTER=$cluster

echo "== the agent, installed by the script with the fleet's token"
# mailer (pm2) calls api (pm2) every 2 seconds: connections to attribute to a pm2 group.
limactl copy "$here/apps/api.js" "$vm:wl-dist/api.js"
in_vm "install -m 0644 $home/wl-dist/api.js /opt/wl-apps/api.js && su - app -c 'pm2 delete mailer >/dev/null 2>&1; pm2 start /opt/wl-apps/api.js --name mailer -- 0 http://127.0.0.1:8092/ >/dev/null && pm2 save >/dev/null'" >/dev/null 2>&1
# The test stacks' jar is started by hand and doesn't survive a reboot of the VM.
in_vm 'pgrep -x java >/dev/null || su - app -c "nohup java -jar /opt/wl-apps/billing.jar >/tmp/billing.log 2>&1 &"' >/dev/null
in_vm "bash $home/wl-dist/install.sh --uninstall >/dev/null 2>&1; WATCHLOG_INSTALL_FROM=$home/wl-dist sh $home/wl-dist/install.sh --token $token --url http://host.lima.internal:$port --hostname e2e-$distro" >"$work/install.out" 2>&1
grep -q 'Checksum verified.' "$work/install.out" || { echo "install failed"; tail -5 "$work/install.out"; exit 1; }
# A service that talks to the internet, for Egress (a file, so no quoting crosses the VM's
# shells; github.com, which a test VM reaches anyway).
printf '%s\n' 'for i in $(seq 1 40); do curl -s -o /dev/null -m 5 https://github.com; sleep 6; done' >"$work/egress.sh"
limactl copy "$work/egress.sh" "$vm:wl-dist/egress.sh"
in_vm "systemd-run --unit=wl-e2e-egress --collect /bin/sh $home/wl-dist/egress.sh" >/dev/null 2>&1

bounded "$([ "${E2E_ONLY:-}" = events ] && echo 280 || echo 540)" python3 - <<'EOF'
import http.cookiejar, json, os, subprocess, sys, time, urllib.parse, urllib.request
jar = http.cookiejar.MozillaCookieJar(os.environ["E2E_WORK"] + "/cookies")
jar.load(ignore_discard=True)
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
cid, host, vm = os.environ["E2E_CLUSTER"], os.environ["E2E_HOST"], os.environ["E2E_VM_NAME"]
fails = 0
def call(m, p, b=None):
    r = urllib.request.Request(os.environ["E2E_API"] + p, method=m, data=json.dumps(b).encode() if b is not None else None,
                               headers={"content-type": "application/json"} if b is not None else {})
    try:
        return json.loads(op.open(r, timeout=60).read() or b"null")
    except urllib.error.HTTPError as e:
        return {"error": e.code, "body": e.read()[:300].decode(errors="replace")}
    except (TimeoutError, OSError) as e:
        return {"error": "timeout", "body": str(e)}
def wait(fn, timeout, every=5):
    deadline = time.time() + timeout
    while True:
        try:
            got = fn()
        except Exception:
            got = None
        if got or time.time() > deadline:
            return got
        time.sleep(every)
def check(name, ok, got=""):
    global fails
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok else f" — got: {str(got)[:300]}"), flush=True)
    fails += 0 if ok else 1
def vm_root(cmd):
    return subprocess.run(["limactl", "shell", vm, "sudo", "bash", "-c", cmd], capture_output=True, text=True, timeout=120).stdout
q = urllib.parse.quote
base = f"/clusters/{cid}/servers/{q(host)}"

server = wait(lambda: next((s for s in call("GET", f"/clusters/{cid}/servers").get("servers", []) if s.get("name") == host), None), 150)
check("the server appears within 150 s", server is not None, call("GET", f"/clusters/{cid}/servers"))
detail = call("GET", base)
info = json.dumps(detail)
check("the server: OS, kernel and systemd", all(k in info for k in ('"os"', '"kernel"', '"systemd"')) and "error" not in detail, detail)

def workloads():
    w = call("GET", base + "/workloads")
    ids = {x.get("id") for x in w.get("workloads", [])}
    need = {"service:orders.service", "process:api", "container:redis"}
    return ids if need <= ids and any(i.startswith("process:pool ") for i in ids) else None
ids = wait(workloads, 120)
seen = sorted(x.get("id") for x in call("GET", base + "/workloads").get("workloads", []))
check("workloads: a service, a pm2 app, a PHP-FPM pool and a container", ids is not None, seen)

print("== the server's own events (0.9.2): each on Events within a minute", flush=True)
def events_of(q=""):
    return call("GET", f"/clusters/{cid}/events?limit=200&from={int(time.time()) - 3600}{q}").get("events", [])
def event(kind, name, reason, text=""):
    def find():
        return next((e for e in events_of() if e.get("involvedKind") == kind and e.get("involvedName") == name
                     and e.get("reason") == reason and text in (e.get("message") or "")), None)
    return wait(find, 60)
# A pm2 app killed: pm2 starts it again.
vm_root("kill -9 $(su - app -c 'pm2 pid mailer')")
e = event("Process", "mailer", "FailedExit", "SIGKILL")
check("a pm2 app killed: Process mailer FailedExit (SIGKILL)", e is not None, [x for x in events_of() if x.get("involvedName") == "mailer"])
check("  its workload id and server", bool(e) and e.get("workload") == "process:mailer" and e.get("host") == host, e)
# A unit that fails with exit code 3 (it runs long enough to be seen started).
vm_root("systemctl reset-failed wl-e2e-fail 2>/dev/null; systemd-run --unit=wl-e2e-fail /bin/sh -c 'sleep 25; exit 3'")
e = event("Service", "wl-e2e-fail.service", "Started")
check("a unit started: Service wl-e2e-fail.service Started", e is not None, [x for x in events_of() if "wl-e2e" in x.get("involvedName", "")])
e = event("Service", "wl-e2e-fail.service", "Failed", "exit code 3")
check("a unit failed: Service wl-e2e-fail.service Failed (exit-code, exit code 3)", e is not None, [x for x in events_of() if "wl-e2e" in x.get("involvedName", "")])
# OOM-killed under MemoryMax: tail of /dev/zero holds what it reads (no newline ever comes).
vm_root("systemctl reset-failed wl-e2e-oom 2>/dev/null; systemd-run --unit=wl-e2e-oom -p MemoryMax=64M -p MemorySwapMax=0 /bin/sh -c 'sleep 25; tail /dev/zero'")
oom = wait(lambda: next((x for x in events_of() if x.get("reason") == "OOMKilled" and "64 MiB" in (x.get("message") or "")
                         and x.get("involvedName") in ("wl-e2e-oom.service", "tail")), None), 75)
check("OOM-killed under MemoryMax: OOMKilled with its limit of 64 MiB", oom is not None, [x for x in events_of() if x.get("reason") == "OOMKilled" or "oom" in x.get("involvedName", "")])
# An executable replaced on disk: a release.
vm_root("cp /opt/wl-apps/orders /opt/wl-apps/orders.new && mv -f /opt/wl-apps/orders.new /opt/wl-apps/orders && systemctl restart orders")
rel = wait(lambda: next((x for x in events_of() if x.get("reason") == "Release" and x.get("involvedName") in ("orders.service", "orders")), None), 75)
check("an executable changed: Release for orders", rel is not None, [x for x in events_of() if "orders" in x.get("involvedName", "")])
# Never a pid or a command line in what is stored.
mine = events_of("&kinds=Service,Process")
check("no event carries a command line", not any("/opt/wl-apps" in (x.get("message") or "") or "tail /dev/zero" in (x.get("message") or "") for x in mine), mine[:5])
# Hide system leaves our events and drops the agent's own unit's.
hidden = {x.get("involvedName") for x in events_of("&system=hide")}
check("Hide system keeps the workloads' events", {"mailer", "wl-e2e-fail.service"} <= hidden, sorted(hidden))
check("Hide system drops WatchLog's own units", not ({"watchlog-agent.service", "watchlog-integrations.service"} & hidden), sorted(hidden))
d = call("GET", base)
check("the server page reads the stored events", d.get("eventsStored") is True and any(x.get("kind") == "event" for x in d.get("events", [])), {k: d.get(k) for k in ("eventsStored", "events")})
wd = call("GET", f"{base}/workloads/{q('process:mailer', safe='')}")
check("the workload page lists its events", any(x.get("reason") == "FailedExit" for x in wd.get("events", [])), wd.get("events"))
vm_root("systemctl reset-failed wl-e2e-fail wl-e2e-oom 2>/dev/null")
if os.environ.get("E2E_ONLY") == "events":
    print(f"{fails} check(s) failed", flush=True)
    sys.exit(1 if fails else 0)

print("== a release, then a real crash loop", flush=True)
vm_root("cp /opt/wl-apps/orders /opt/wl-apps/orders.new && mv -f /opt/wl-apps/orders.new /opt/wl-apps/orders && systemctl restart orders")
time.sleep(40)  # two scrapes see the new executable
for _ in range(4):
    vm_root("curl -s -m 2 localhost:8091/crash >/dev/null; sleep 8")
wl = f"{base}/workloads/{q('service:orders.service', safe='')}"
d = wait(lambda: (lambda x: x if x.get("crashLoopSince") and x.get("cause", {}).get("code") == "release" else None)(call("GET", wl)), 150)
d = d or call("GET", wl)
check("orders.service is crash-looping (crashLoopSince)", bool(d.get("crashLoopSince")), {k: d.get(k) for k in ("crashLoopSince", "error", "body")})
# A new counter's first sample isn't an increase, so the exits show a scrape after the restarts.
failed = lambda x: sum(p[1] for p in x.get("timeline", {}).get("points", []) if len(p) > 1)
d = wait(lambda: (lambda x: x if failed(x) >= 2 else None)(call("GET", wl)), 90) or call("GET", wl)
check("its failed exits are on the timeline", failed(d) >= 2, d.get("timeline", {}).get("points", [])[-5:])
check("the release is marked on the timeline", len(d.get("timeline", {}).get("releases", [])) >= 1, d.get("timeline", {}).get("releases"))
check("probable cause: likely the release", d.get("cause", {}).get("code") == "release" and d.get("cause", {}).get("state") == "likely", d.get("cause"))
fired = wait(lambda: [a for a in call("GET", f"/alerts?view=firing&clusterId={cid}").get("alerts", []) if a.get("rule", {}).get("key") == "server.unit.crashloop"], 180)
check("the default rule 'Service crash-looping' fires", bool(fired), [a.get("rule") for a in call("GET", f"/alerts?view=firing&clusterId={cid}").get("alerts", [])])

logs = call("GET", f"{wl}/logs?lines=50")
check("the service's journal on demand", isinstance(logs, dict) and "error" not in logs and len(json.dumps(logs)) > 100, logs)

now = int(time.time())
for metric, scope in (("unit.cpu.usage", {"host": host, "unit": "orders.service"}),
                      ("unit.memory.working_set", {"host": host, "unit": "orders.service"}),
                      ("process.cpu.usage", {"host": host, "group": "api"}),
                      ("process.memory.rss", {"host": host, "group": "api"})):
    r = call("POST", "/query/range", {"clusterId": cid, "metric": metric, "scope": scope, "from": now - 600, "to": now})
    check(f"What changed's input {metric} has data", bool(r.get("series")) and any(s.get("points") or s.get("values") for s in r["series"]), r)

eg = wait(lambda: (lambda r: r if "wl-e2e-egress" in json.dumps(r) else None)(call("GET", f"/egress?cluster={cid}&from={int(time.time()) - 3600}")), 200)
check("Egress: the service's external destination", eg is not None, call("GET", f"/egress?cluster={cid}&from={int(time.time()) - 3600}"))

print("== the workload page's charts and connections", flush=True)
now = int(time.time())
def has_data(metric, scope):
    r = call("POST", "/query/range", {"clusterId": cid, "metric": metric, "scope": {"host": host, **scope}, "from": now - 900, "to": now})
    return any(p[1] is not None for s in r.get("series", []) for p in s.get("points", []))
pool = next((i.split(":", 1)[1] for i in (ids or []) if i.startswith("process:pool ")), "pool www")
for metric, scope in (("unit.cpu.usage", {"unit": "nginx.service"}), ("unit.memory.working_set", {"unit": "nginx.service"}),
                      ("unit.tasks", {"unit": "nginx.service"}), ("unit.io", {"unit": "nginx.service"}),
                      ("unit.restarts.step", {"unit": "orders.service"}), ("unit.exits.failed.step", {"unit": "orders.service"}),
                      ("process.cpu.usage", {"group": "api"}), ("process.memory.rss", {"group": "api"}),
                      ("process.instances", {"group": "api"}), ("process.threads", {"group": "api"}),
                      ("process.open_files", {"group": "api"}), ("process.cpu.usage", {"group": pool}),
                      ("process.instances", {"group": pool}), ("unit.memory.limit", {"unit": "orders.service"})):
    check(f"chart data: {metric} for {list(scope.values())[0]}", has_data(metric, scope))
mailer = f"{base}/workloads/{q('process:mailer', safe='')}"
conn = wait(lambda: (lambda x: x if any(e.get("port") == 8092 for e in x.get("connections", [])) else None)(call("GET", mailer)), 120)
check("connections: pm2's mailer → api :8092, attributed to the mailer group", conn is not None,
      call("GET", mailer).get("connections"))

print("== applications on the server: PHP-FPM installed natively, Redis in a container", flush=True)
def found(typ, kind):
    return next((d for d in call("GET", "/applications/discovered").get("discovered", [])
                 if d["cluster"]["id"] == cid and d["type"] == typ and d["target"]["kind"] == kind), None)
for typ, kind in (("php-fpm", "native"), ("redis", "container")):
    d = wait(lambda: found(typ, kind), 120)
    check(f"{typ} ({kind}) is discovered", d is not None, call("GET", "/applications/discovered"))
    if d:
        r = call("POST", "/applications", {"clusterId": cid, "type": typ, "target": d["target"], "defaultAlerts": []})
        check(f"{typ} is monitored", "application" in r, r)
for typ in ("php-fpm", "redis"):
    a = wait(lambda: next((x for x in call("GET", "/applications").get("applications", [])
                           if x["type"] == typ and x["cluster"]["id"] == cid and x.get("lastReportAt")), None), 150)
    check(f"{typ}: its collector reports", a is not None, [x for x in call("GET", "/applications").get("applications", []) if x["type"] == typ])

print(f"{fails} check(s) failed", flush=True)
sys.exit(1 if fails else 0)
EOF
rc=$?
[ $rc = 0 ] || { echo "-- backend log (last lines)"; tail -5 "$work/backend.log"; tail -5 "$work/worker.log"; }
exit $rc
