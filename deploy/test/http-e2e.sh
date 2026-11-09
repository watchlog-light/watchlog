#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# HTTP stats on service-map edges end to end (v0.3 slice 9, ADR-139), on the demo VM after
# deploy/test/demo-up.sh started the agents (built from this checkout) for the backend at
# WATCHLOG_URL. On the kind cluster "demo" and on the VM's Docker host, a caller asks
# podinfo for nine 200s and one 503 per round; the map must show that edge with its
# requests per second, a 5xx share near 10 % (critical) and latency, and the edge's HTTP
# series. `http-e2e.sh down` removes what it made.
#   WATCHLOG_URL, WATCHLOG_E2E_EMAIL, WATCHLOG_E2E_PASSWORD   the backend and an account
#   VM                                                        the Lima VM (default watchlog-demo)
# shellcheck disable=SC2016
set -euo pipefail
cd "$(dirname "$0")/../.."
vm=${VM:-watchlog-demo}
url=${WATCHLOG_URL:-http://127.0.0.1:4080}
in_vm() { limactl shell "$vm" bash -c "cd ~ && export PATH=\$HOME/bin:\$PATH && $*"; }
caller='while true; do for i in 1 2 3 4 5 6 7 8 9; do wget -q -O /dev/null -T 2 http://API/status/200; done; wget -q -O /dev/null -T 2 http://API/status/503 || true; sleep 0.2; done'

down() {
  in_vm 'kubectl --context kind-demo delete namespace http-e2e --ignore-not-found --wait=false >/dev/null
    docker rm -f e2e-http-api e2e-http-caller >/dev/null 2>&1 || true
    docker network rm e2e-http >/dev/null 2>&1 || true'
}
if [ "${1:-}" = down ]; then
  down
  exit 0
fi
: "${WATCHLOG_E2E_EMAIL:?}" "${WATCHLOG_E2E_PASSWORD:?}"
down
in_vm 'kubectl --context kind-demo wait --for=delete namespace/http-e2e --timeout 120s >/dev/null 2>&1 || true'

echo "== podinfo and a caller on kind (namespace http-e2e) and on the Docker host"
in_vm "kubectl --context kind-demo apply -f - >/dev/null" <<YAML
apiVersion: v1
kind: Namespace
metadata: { name: http-e2e }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: api, namespace: http-e2e }
spec:
  selector: { matchLabels: { app: api } }
  template:
    metadata: { labels: { app: api } }
    spec:
      containers:
        - { name: api, image: ghcr.io/stefanprodan/podinfo:6.16.0, ports: [{ containerPort: 9898 }] }
---
apiVersion: v1
kind: Service
metadata: { name: api, namespace: http-e2e }
spec: { selector: { app: api }, ports: [{ port: 9898 }] }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: caller, namespace: http-e2e }
spec:
  selector: { matchLabels: { app: caller } }
  template:
    metadata: { labels: { app: caller } }
    spec:
      containers:
        - name: caller
          image: busybox:latest
          command: [sh, -c, '${caller//API/api:9898}']
YAML
in_vm "docker network create e2e-http >/dev/null && \
  docker run -d --name e2e-http-api --network e2e-http ghcr.io/stefanprodan/podinfo:6.16.0 >/dev/null && \
  docker run -d --name e2e-http-caller --network e2e-http busybox:latest sh -c '${caller//API/e2e-http-api:9898}' >/dev/null && \
  kubectl --context kind-demo -n http-e2e rollout status deploy/api deploy/caller --timeout 180s >/dev/null"

echo "== the edges on the service map"
WATCHLOG_URL=$url python3 - <<'PY'
import http.cookiejar, json, os, sys, time, urllib.parse, urllib.request

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

clusters = {c["kind"]: c for c in call("GET", "/clusters")["clusters"]}
want = {"kubernetes": ("caller", "api"), "docker": ("e2e-http-caller", "e2e-http-api")}
for kind, (src, dst) in want.items():
    cid = clusters[kind]["id"]
    def find():
        m = call("GET", f"/clusters/{cid}/service-map?range=600")
        names = {n["id"]: n["name"] for n in m["nodes"]}
        for e in m["edges"]:
            if names.get(e["source"]) == src and names.get(e["target"]) == dst and e.get("http") and e["http"]["requestsPerSecond"] > 1:
                return e
        return None
    deadline, e = time.time() + 240, None
    while time.time() < deadline and not (e := find()):
        time.sleep(10)
    check(f"{kind}: the edge {src} → {dst} has HTTP requests", bool(e), "none after 4 minutes")
    if not e:
        continue
    h = e["http"]
    check(f"{kind}: about 10 % of them answer 5xx ({h['serverErrorRatio']:.3f})",
          0.05 <= (h["serverErrorRatio"] or 0) <= 0.15, json.dumps(h))
    check(f"{kind}: the edge is critical for its 5xx", e["health"] == "critical", e["health"])
    check(f"{kind}: p50, p95 and p99 are known", all(h[k] is not None for k in ("p50Seconds", "p95Seconds", "p99Seconds")), json.dumps(h))
    q = urllib.parse.urlencode({"source": e["source"], "target": e["target"], "port": e["port"], "range": 600})
    s = call("GET", f"/clusters/{cid}/service-map/edge?{q}")
    check(f"{kind}: the edge's HTTP series (requests, 5xx, p95)",
          all(any(p[1] for p in s[k]) for k in ("httpRequests", "http5xx", "httpP95")),
          json.dumps({k: s[k][-2:] for k in ("httpRequests", "http5xx", "httpP95")}))
print(f"\n{failures} failed" if failures else "\nall passed")
sys.exit(1 if failures else 0)
PY
