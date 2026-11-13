#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Right-sizing hints end to end (v0.5 slice 6, ADR-168, SPEC §4.3) on the demo VM, after
# deploy/test/demo-up.sh (or integrations-e2e.sh) started agents at this checkout's version
# for the backend at WATCHLOG_URL. On the kind cluster "demo" (namespace rs-e2e) and on the
# VM's Docker host (Compose project rs-e2e):
#   - idle: asks for 500m CPU and 256 MiB (two replicas) and sleeps; on Docker a 256 MiB
#     memory reservation;
#   - tight: a 32 MiB memory limit and 30 MB written to /dev/shm (about 91 % of the limit).
# Then, through REST and MCP: idle gets cpu_request_high and memory_request_high with
# giveBack for both replicas (Kubernetes) and memory_reservation_high (Docker); tight gets
# memory_limit_tight on both; the summary counts them; the workload and Compose filters work.
#
# History: hints need WATCHLOG_RIGHT_SIZING_MIN_HOURS of it (24 by default). For a run in
# minutes, start the backend with WATCHLOG_RIGHT_SIZING_MIN_HOURS=0.25 and run `up`, then
# `check` after 20 minutes. The backend keeps the use an hour per cluster: do not ask for
# right-sizing on these clusters between `up` and `check` (or restart the backend first).
#   rightsizing-e2e.sh up | check | down
#   WATCHLOG_URL, WATCHLOG_E2E_EMAIL, WATCHLOG_E2E_PASSWORD   the backend and an account
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
  in_vm 'kubectl --context kind-demo delete namespace rs-e2e --ignore-not-found --wait=false >/dev/null
    [ -f ~/rs-e2e/compose.yaml ] && docker compose -f ~/rs-e2e/compose.yaml down >/dev/null 2>&1 || true
    rm -rf ~/rs-e2e'
}

up() {
  down
  in_vm 'kubectl --context kind-demo wait --for=delete namespace/rs-e2e --timeout 120s >/dev/null 2>&1 || true'
  say "image"
  in_vm "docker image inspect $image >/dev/null 2>&1 || docker pull -q $image >/dev/null"
  in_vm "kind load docker-image $image --name demo >/dev/null 2>&1 || true"
  fill='head -c 30000000 /dev/zero > /dev/shm/fill; sleep 1000000'
  say "Kubernetes: idle (500m, 256 MiB, 2 replicas) and tight (32 MiB limit, 30 MB used)"
  in_vm "mkdir -p ~/rs-e2e && cat > ~/rs-e2e/kube.yaml" <<YAML
apiVersion: v1
kind: Namespace
metadata: {name: rs-e2e}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: idle, namespace: rs-e2e}
spec:
  replicas: 2
  selector: {matchLabels: {app: idle}}
  template:
    metadata: {labels: {app: idle}}
    spec:
      containers:
        - name: idle
          image: $image
          imagePullPolicy: IfNotPresent
          command: ["sh", "-c", "sleep 1000000"]
          resources:
            requests: {cpu: 500m, memory: 256Mi}
            limits: {memory: 512Mi}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: tight, namespace: rs-e2e}
spec:
  replicas: 1
  selector: {matchLabels: {app: tight}}
  template:
    metadata: {labels: {app: tight}}
    spec:
      containers:
        - name: tight
          image: $image
          imagePullPolicy: IfNotPresent
          command: ["sh", "-c", "$fill"]
          resources:
            requests: {cpu: 10m, memory: 32Mi}
            limits: {cpu: 100m, memory: 32Mi}
YAML
  in_vm 'kubectl --context kind-demo apply -f ~/rs-e2e/kube.yaml >/dev/null'
  say "Docker: idle (256 MiB reservation) and tight (32 MiB limit, 30 MB used)"
  in_vm "cat > ~/rs-e2e/compose.yaml" <<YAML
name: rs-e2e
services:
  idle:
    image: $image
    command: ["sh", "-c", "sleep 1000000"]
    mem_reservation: 256m
  tight:
    image: $image
    command: ["sh", "-c", "$fill"]
    mem_limit: 32m
YAML
  in_vm 'docker compose -f ~/rs-e2e/compose.yaml up -d >/dev/null 2>&1'
  echo "up; run '$0 check' once the backend's minimum history has passed"
}

check() {
  : "${WATCHLOG_E2E_EMAIL:?}" "${WATCHLOG_E2E_PASSWORD:?}"
  WATCHLOG_URL=$url python3 - <<'PY'
import http.cookiejar, json, os, sys, urllib.parse, urllib.request

url = os.environ["WATCHLOG_URL"] + "/api/v1"
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

def call(method, path, body=None, headers=None):
    h = {"content-type": "application/json"} if body is not None else {}
    h.update(headers or {})
    req = urllib.request.Request(url + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None, headers=h)
    with opener.open(req, timeout=60) as res:
        raw = res.read()
        return json.loads(raw) if raw else None

call("POST", "/auth/login", {"email": os.environ["WATCHLOG_E2E_EMAIL"], "password": os.environ["WATCHLOG_E2E_PASSWORD"]})
failures = 0
def check(name, ok, detail=""):
    global failures
    print(("PASS  " if ok else "FAIL  ") + name + (f": {detail}" if detail and not ok else ""), flush=True)
    failures += 0 if ok else 1

clusters = call("GET", "/clusters")["clusters"]
def cluster(kind):
    want = os.environ.get("WATCHLOG_E2E_KUBE_CLUSTER" if kind == "kubernetes" else "WATCHLOG_E2E_DOCKER_CLUSTER")
    cs = [c for c in clusters if c["kind"] == kind and (not want or want in (c["id"], c["name"]))]
    if len(cs) != 1:
        sys.exit(f"{len(cs)} {kind} clusters match: set WATCHLOG_E2E_{'KUBE' if kind == 'kubernetes' else 'DOCKER'}_CLUSTER")
    return cs[0]
kube, docker = cluster("kubernetes"), cluster("docker")

def codes(answer, name):
    return {h["code"]: h for h in answer["hints"] if h["object"]["name"] == name}

k = call("GET", f"/clusters/{kube['id']}/right-sizing?namespace=rs-e2e")
short = [n["object"]["name"] for n in k["notEnoughHistory"]]
check(f"kubernetes: history enough ({k['window']})", not short, str(short))
idle, tight = codes(k, "idle"), codes(k, "tight")
c = idle.get("cpu_request_high")
check("kubernetes: idle's CPU request is too high, 2 replicas giving back 980m",
      bool(c) and c["suggestion"] == 0.01 and abs(c["giveBack"] - 0.98) < 1e-6 and c["facts"]["replicas"] == 2, str(c))
m = idle.get("memory_request_high")
check("kubernetes: idle's memory request is too high (16 MiB would cover it)",
      bool(m) and m["suggestion"] == 16 * 2**20 and m["giveBack"] == 2 * 240 * 2**20, str(m))
t = tight.get("memory_limit_tight")
check("kubernetes: tight is close to its 32 MiB limit",
      bool(t) and t["facts"]["limitBytes"] == 32 * 2**20 and t["facts"]["peakBytes"] >= 0.9 * 32 * 2**20, str(tight.keys()))
check("kubernetes: OOM risk first", k["hints"][0]["code"] in ("memory_limit_tight", "memory_limit_oom"))
check(f"kubernetes: summary ({k['summary']})", k["summary"]["giveBackObjects"] >= 1 and k["summary"]["oomRisk"] >= 1)
one = call("GET", f"/clusters/{kube['id']}/right-sizing?namespace=rs-e2e&kind=Deployment&workload=idle")
check("kubernetes: the workload filter", {h["object"]["name"] for h in one["hints"]} == {"idle"})

d = call("GET", f"/clusters/{docker['id']}/right-sizing?project=rs-e2e")
short = [n["object"]["name"] for n in d["notEnoughHistory"]]
check(f"docker: history enough ({d['window']})", not short, str(short))
idle, tight = codes(d, "rs-e2e-idle-1"), codes(d, "rs-e2e-tight-1")
r = idle.get("memory_reservation_high")
check("docker: idle's 256 MiB reservation is too high", bool(r) and r["facts"]["reservationBytes"] == 256 * 2**20, str(idle.keys()))
check("docker: no CPU request hints on Docker", not any(h["code"].startswith("cpu_request") for h in d["hints"]))
t = tight.get("memory_limit_tight") or tight.get("memory_limit_oom")
check("docker: tight is close to its 32 MiB limit", bool(t), str(tight.keys()))
svc = call("GET", f"/clusters/{docker['id']}/right-sizing?project=rs-e2e&service=idle")
check("docker: the Compose service filter", {h["object"]["name"] for h in svc["hints"]} == {"rs-e2e-idle-1"})

# MCP with a fresh API token, revoked at the end.
created = call("POST", "/api-tokens", {"name": "rightsizing-e2e", "expiresInDays": 30})
try:
    def mcp(method, params, rid):
        req = urllib.request.Request(os.environ["WATCHLOG_URL"] + "/mcp", method="POST",
                                     data=json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}).encode(),
                                     headers={"authorization": f"Bearer {created['value']}", "content-type": "application/json",
                                              "accept": "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18"})
        with urllib.request.urlopen(req, timeout=60) as res:
            raw = res.read().decode()
        if raw.lstrip().startswith("{"):
            return json.loads(raw)
        return [json.loads(l[5:]) for l in raw.splitlines() if l.startswith("data:")][-1]
    def tool(args, rid):
        r = mcp("tools/call", {"name": "get_right_sizing", "arguments": args}, rid)["result"]
        return r.get("structuredContent") or json.loads(r["content"][0]["text"])
    mcp("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "rightsizing-e2e", "version": "1"}}, 1)
    body = tool({"cluster": kube["name"], "namespace": "rs-e2e"}, 2)
    check("mcp kubernetes: get_right_sizing names idle's CPU request",
          any(h["code"] == "cpu_request_high" and h["object"]["name"] == "idle" for h in body.get("hints", [])), json.dumps(body)[:300])
    body = tool({"cluster": docker["name"], "composeService": "rs-e2e/idle"}, 3)
    check("mcp docker: the reservation hint", any(h["code"] == "memory_reservation_high" for h in body.get("hints", [])), json.dumps(body)[:300])
    check("mcp: within 16 KB", len(json.dumps(body).encode()) <= 16384)
finally:
    call("DELETE", f"/api-tokens/{created['token']['id']}")

print(f"\n{failures} failed" if failures else "\nall passed")
sys.exit(1 if failures else 0)
PY
}

case "${1:-}" in
  up) up ;;
  check) check ;;
  down) down ;;
  *) echo "usage: $0 up | check | down" >&2; exit 2 ;;
esac
