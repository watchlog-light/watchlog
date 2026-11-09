#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Applications end to end (v0.3, SPEC §4.12) on the demo VM (deploy/test/demo-up.sh):
# agents and the integrations collector built from this checkout report to a WatchLog
# backend; the services they see are discovered, monitored through the API, and report
# their state, on the kind cluster "demo" and on the VM's Docker host.
#
# Needs a backend reachable from the VM and an account that can add services:
#   WATCHLOG_URL           the backend as seen from this machine (default http://127.0.0.1:4080)
#   WATCHLOG_E2E_EMAIL and WATCHLOG_E2E_PASSWORD
#   WATCHLOG_E2E_KUBE_TOKEN and WATCHLOG_E2E_DOCKER_TOKEN
#                          tokens of a Kubernetes cluster and a Docker fleet in that backend
#   VM                     the Lima VM (default watchlog-demo)
#   GOPROXY                for the image builds (e.g. https://goproxy.io,direct)
# The agents run beside the demo's own (release watchlog-e2e in namespace watchlog-e2e,
# container watchlog-agent-e2e), without eBPF; `integrations-e2e.sh down` removes them.
# The Docker collector mounts ~/watchlog-e2e-secrets on the VM as /etc/watchlog/secrets:
# the host-file path, root-owned and 0700 like the documented `sudo install -d`, made by a
# root container instead of sudo. deploy/test/redis-e2e.sh and postgres-e2e.sh run after this.
# shellcheck disable=SC2016
set -euo pipefail
cd "$(dirname "$0")/../.."
repo=$PWD
vm=${VM:-watchlog-demo}
url=${WATCHLOG_URL:-http://127.0.0.1:4080}
in_vm() { limactl shell "$vm" bash -c "cd ~ && export PATH=\$HOME/bin:\$PATH && $*"; }
say() { printf '\n== %s\n' "$*"; }

if [ "${1:-}" = down ]; then
  in_vm 'helm --kube-context kind-demo uninstall watchlog-e2e -n watchlog-e2e >/dev/null 2>&1 || true
    kubectl --context kind-demo delete namespace watchlog-e2e --ignore-not-found >/dev/null
    docker rm -f watchlog-agent-e2e watchlog-integrations-e2e >/dev/null 2>&1 || true
    docker volume rm watchlog-agent-e2e-state >/dev/null 2>&1 || true'
  exit 0
fi
: "${WATCHLOG_E2E_EMAIL:?}" "${WATCHLOG_E2E_PASSWORD:?}" "${WATCHLOG_E2E_KUBE_TOKEN:?}" "${WATCHLOG_E2E_DOCKER_TOKEN:?}"

port=${url##*:}
host_ip=$(in_vm 'getent ahostsv4 host.lima.internal | awk "NR==1{print \$1}"')
endpoint="http://$host_ip:$port"
in_vm "curl -fs -o /dev/null -m 5 $endpoint/api/v1/health" || {
  echo "the backend is not reachable from the VM at $endpoint" >&2
  exit 1
}

say "the demo's services running (kind and the Compose app on the VM)"
in_vm '[ -f ~/demo-compose/compose.yaml ] && docker compose -f ~/demo-compose/compose.yaml up -d --quiet-pull >/dev/null 2>&1 || true'

say "images from this checkout"
in_vm "cd '$repo/agent' && for t in agent cluster-agent integrations; do docker build -q ${GOPROXY:+--build-arg GOPROXY=$GOPROXY} --build-arg VERSION=e2e -t ghcr.io/watchlog-light/\$t:e2e --target \$t . >/dev/null; done"
in_vm 'for t in agent cluster-agent integrations; do kind load docker-image --name demo ghcr.io/watchlog-light/$t:e2e >/dev/null; done'

say "Kubernetes: agents and collector → $endpoint"
printf '%s' "$WATCHLOG_E2E_KUBE_TOKEN" | limactl shell "$vm" bash -c "cd ~ && export PATH=\$HOME/bin:\$PATH && t=\$(cat) && \
  helm --kube-context kind-demo upgrade --install watchlog-e2e '$repo/deploy/helm/watchlog-agent' -n watchlog-e2e --create-namespace \
  --set watchlog.endpoint=$endpoint --set-string watchlog.clusterToken=\"\$t\" --set image.tag=e2e --set image.pullPolicy=Never \
  --set agent.networkFlows.enabled=false --wait --timeout 5m >/dev/null"
# A new token or image doesn't restart the pods by itself: they read both at start.
in_vm 'kubectl --context kind-demo -n watchlog-e2e rollout restart deployment,daemonset >/dev/null \
  && kubectl --context kind-demo -n watchlog-e2e rollout status deployment,daemonset --timeout 180s >/dev/null'

say "Docker: agent and collector → $endpoint"
vm_host=$(in_vm 'hostname')
printf '%s' "$WATCHLOG_E2E_DOCKER_TOKEN" | limactl shell "$vm" bash -c "cd ~ && t=\$(cat) && \
  docker rm -f watchlog-agent-e2e watchlog-integrations-e2e >/dev/null 2>&1; \
  docker run --rm -v \$HOME:/h redis:7.2-alpine sh -c 'mkdir -p /h/watchlog-e2e-secrets && chown 0:0 /h/watchlog-e2e-secrets && chmod 0700 /h/watchlog-e2e-secrets'; \
  docker run -d --name watchlog-agent-e2e --pid host --user 0:65532 --cap-drop ALL --security-opt no-new-privileges \
    -v /var/run/docker.sock:/var/run/docker.sock:ro -v /proc:/host/proc:ro -v /sys:/host/sys:ro -v /:/host/root:ro,rslave \
    -v watchlog-agent-e2e-state:/var/lib/watchlog-agent -e WATCHLOG_TOKEN=\"\$t\" -e WATCHLOG_ENDPOINT=$endpoint \
    -e WATCHLOG_HOSTNAME=$vm_host -e WATCHLOG_EBPF=false ghcr.io/watchlog-light/agent:e2e --mode=docker >/dev/null && \
  docker run -d --name watchlog-integrations-e2e --network host --user 0:0 --cap-drop ALL --read-only \
    --tmpfs /var/lib/watchlog-integrations --security-opt no-new-privileges \
    -v \$HOME/watchlog-e2e-secrets:/etc/watchlog/secrets:ro \
    -e WATCHLOG_TOKEN=\"\$t\" -e WATCHLOG_ENDPOINT=$endpoint -e WATCHLOG_HOSTNAME=$vm_host \
    ghcr.io/watchlog-light/integrations:e2e >/dev/null"

say "discover, monitor and wait for the services' state"
WATCHLOG_URL=$url DOCKER_HOST_NAME=$vm_host python3 - <<'PY'
import http.cookiejar, json, os, sys, time, urllib.request

url = os.environ["WATCHLOG_URL"] + "/api/v1"
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

def call(method, path, body=None):
    req = urllib.request.Request(url + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"content-type": "application/json"} if body is not None else {})
    with opener.open(req, timeout=30) as res:
        raw = res.read()
        return json.loads(raw) if raw else None

call("POST", "/auth/login", {"email": os.environ["WATCHLOG_E2E_EMAIL"], "password": os.environ["WATCHLOG_E2E_PASSWORD"]})
failures = 0
def check(name, ok, detail=""):
    global failures
    print(("PASS  " if ok else "FAIL  ") + name + (f": {detail}" if detail and not ok else ""))
    failures += 0 if ok else 1

# The demo's own Redis on the Docker host (a Compose service, no password) before any
# other container (redis-e2e.sh's have passwords).
def redis_on_docker(found):
    rs = [d for d in found if d["cluster"]["kind"] == "docker" and d["type"] == "redis" and not d["name"].startswith("e2e-")]
    return sorted(rs, key=lambda d: (not d.get("group"), d["name"]))

# The agents' first inventories arrive within a minute.
want = {("kubernetes", "redis", "shop/redis"), ("kubernetes", "postgres", "shop/postgres")}
deadline = time.time() + 180
found = []
while time.time() < deadline:
    found = call("GET", "/applications/discovered")["discovered"]
    seen = {(d["cluster"]["kind"], d["type"], d["name"]) for d in found}
    docker = redis_on_docker(found)
    if want <= seen and docker:
        break
    time.sleep(5)
seen = {(d["cluster"]["kind"], d["type"], d["name"]) for d in found}
for kind, typ, name in sorted(want):
    check(f"discovered {typ} {name} on Kubernetes", (kind, typ, name) in seen, str(sorted(seen)))
docker = redis_on_docker(found)
check("discovered a Redis container on the Docker host", bool(docker), str(sorted(seen)))

# Monitor them; their collectors connect. (Slices 3 to 5 below: the page, the connect
# flow's probes through the real collectors, and the services' alert rules.)
monitored = []
for d in [x for x in found if (x["cluster"]["kind"], x["type"], x["name"]) in want] + docker[:1]:
    res = call("POST", "/applications", {"clusterId": d["cluster"]["id"], "type": d["type"], "target": d["target"]})
    monitored.append(res["application"]["id"])
# PostgreSQL logs in (slice 8): the demo's server has a password and none is set yet, so
# its collector reaches it and says it can't log in; the others connect.
expect = lambda a: "login_failed" if a["type"] == "postgres" else "connected"
deadline = time.time() + 120
apps = []
while time.time() < deadline:
    apps = [a for a in call("GET", "/applications")["applications"] if a["id"] in monitored]
    if apps and all(a["reason"]["code"] == expect(a) for a in apps):
        break
    time.sleep(5)
for a in apps:
    check(f"{a['cluster']['kind']} {a['type']} {a['name']} reports through its collector ({expect(a)})",
          a["reason"]["code"] == expect(a) and (a["members"]["up"] >= 1 or a["type"] == "postgres"),
          json.dumps({"reason": a["reason"], "members": a["members"]}))
collectors = call("GET", "/applications/collectors")["collectors"]
check("a collector reports for the cluster and one for the Docker host",
      {c["cluster"]["kind"] for c in collectors if c["reporting"]} == {"kubernetes", "docker"},
      json.dumps(collectors))

# The service page (slice 3): reasons and the generic Overview's panels.
for a in apps:
    d = call("GET", f"/applications/{a['id']}")
    check(f"{a['cluster']['kind']} {a['name']}: the page says {expect(a)}",
          # Most severe first: an integration's own notes (no maxmemory) may come before it.
          expect(a) in [r["code"] for r in d["reasons"]], json.dumps(d["reasons"]))
    p = call("GET", f"/applications/{a['id']}/panels")
    # Redis and PostgreSQL have their own pages (slices 7 and 8, filled in redis-e2e.sh and
    # postgres-e2e.sh); the others the generic one.
    want_panels = {
        "redis": ["summary", "memory", "hits", "slowlog"],
        "postgres": ["summary", "connections", "transactions", "slowest", "busiest", "capacity"],
    }.get(a["type"], ["summary", "connect", "reachable"])
    check(f"{a['cluster']['kind']} {a['name']}: the Overview has its panels",
          [x["id"] for x in p["panels"]] == want_panels, json.dumps(p)[:300])

# The connect flow (slice 4): each collector tries a probe and reports; the tested
# access becomes the service's, and its collector receives it.
for a in apps:
    probe = call("POST", "/applications/probes", {
        "clusterId": a["cluster"]["id"], "type": a["type"], "target": a["target"], "integrationId": a["id"],
        "access": {"method": "entered", "username": "e2e", "password": "e2e-not-a-real-password"}})["probe"]
    deadline = time.time() + 60
    while time.time() < deadline and probe["status"] == "pending" and not probe["result"]:
        time.sleep(3)
        probe = call("GET", f"/applications/probes/{probe['id']}")["probe"]
    # Redis and PostgreSQL log in (slices 7 and 8): the made-up password is refused. A type
    # that can't log in yet reaches the port and stays waiting, saying so; it never passes
    # on the port alone.
    want_code = "auth_failed" if a["type"] in ("redis", "postgres") else "login_untested"
    check(f"{a['cluster']['kind']} {a['name']}: its collector tried the probe and didn't pass it ({want_code})",
          probe["status"] == "pending" and (probe["result"] or {}).get("code") == want_code,
          json.dumps(probe))
    call("PUT", f"/applications/{a['id']}/access", {"probeId": probe["id"]})
    acc = call("GET", f"/applications/{a['id']}/access")
    check(f"{a['cluster']['kind']} {a['name']}: the access is stored, never shown",
          acc["access"]["method"] == "entered" and "e2e-not-a-real-password" not in json.dumps(acc),
          json.dumps(acc)[:300])

# Alert rules for services (slice 5): each got its two default rules, off.
rules = [r for r in call("GET", "/alert-rules")["rules"] if (r.get("service") or {}).get("id") in monitored]
# Two for every service, five more for each Redis and PostgreSQL (SPEC §4.12).
want_rules = sum(7 if a["type"] in ("redis", "postgres") else 2 for a in apps)
check("every monitored service has its default rules",
      len(rules) == want_rules, json.dumps([r["name"] for r in rules]))
for a in monitored:
    call("DELETE", f"/applications/{a}")
left = [r for r in call("GET", "/alert-rules")["rules"] if (r.get("scope") or {}).get("service") in monitored]
check("removing the services removed their rules", not left, json.dumps(left)[:300])
print(f"\n{failures} failed" if failures else "\nall passed")
sys.exit(1 if failures else 0)
PY
