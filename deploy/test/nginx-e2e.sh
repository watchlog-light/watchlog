#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Nginx end to end (v0.3 slice 10, SPEC §4.12) on the demo VM, after deploy/test/demo-up.sh
# (or integrations-e2e.sh) started agents with eBPF and the integrations collectors for
# the backend at WATCHLOG_URL. Everything is discovered and monitored through the API.
#   Kubernetes (kind "demo"):
#     - ingress-nginx (deploy/test/nginx/ingress-nginx.yaml) without --enable-metrics:
#       requests, 5xx and latency come from eBPF, and the page gives the command to turn
#       its metrics on. The command is run as shown; then the controller's own series
#       fill the page (upstreams by backend Service, connections).
#     - behind it, namespace nginx-e2e: api (podinfo: 200s, 503s, a 2 s delay) and cart,
#       a Service with no ready endpoint;
#     - a plain Nginx (nginx-e2e/web) with stub_status on 8080, proxying to api.
#   Docker (the VM's host), Compose project nginx-e2e: web (stub_status on 8080) and
#   bare (none), both proxying to app (podinfo) and, under /gone/, to a port of app
#   nothing listens on.
#   A caller on each side asks for 200s, 503s, a missing upstream and a slow page.
# `nginx-e2e.sh down` removes what it made.
#   WATCHLOG_URL, WATCHLOG_E2E_EMAIL, WATCHLOG_E2E_PASSWORD   the backend and an account
#   VM                         the Lima VM (default watchlog-demo)
#   WATCHLOG_E2E_INGRESS_IMAGE the controller image (default registry.k8s.io's v1.12.1;
#                              a build of the same controller where that is unreachable)
# shellcheck disable=SC2016
set -euo pipefail
cd "$(dirname "$0")/../.."
vm=${VM:-watchlog-demo}
url=${WATCHLOG_URL:-http://127.0.0.1:4080}
image=${WATCHLOG_E2E_INGRESS_IMAGE:-registry.k8s.io/ingress-nginx/controller:v1.12.1}
in_vm() { limactl shell "$vm" bash -c "cd ~ && export PATH=\$HOME/bin:\$PATH && $*"; }
say() { printf '\n== %s\n' "$*"; }

down() {
  in_vm 'kubectl --context kind-demo delete namespace nginx-e2e ingress-nginx-e2e --ignore-not-found --wait=false >/dev/null
    kubectl --context kind-demo delete clusterrole,clusterrolebinding ingress-nginx-e2e --ignore-not-found >/dev/null
    kubectl --context kind-demo delete ingressclass nginx-e2e --ignore-not-found >/dev/null
    [ -f ~/nginx-e2e/compose.yaml ] && docker compose -f ~/nginx-e2e/compose.yaml down --remove-orphans >/dev/null 2>&1 || true
    rm -rf ~/nginx-e2e'
}
if [ "${1:-}" = down ]; then
  down
  exit 0
fi
: "${WATCHLOG_E2E_EMAIL:?}" "${WATCHLOG_E2E_PASSWORD:?}"
down
in_vm 'kubectl --context kind-demo wait --for=delete namespace/nginx-e2e namespace/ingress-nginx-e2e --timeout 120s >/dev/null 2>&1 || true'

# 8×200, 2×503, cart (no endpoint), a 2 s page, per round; Host for the Ingress rule.
round='for i in 1 2 3 4 5 6 7 8; do wget -q -O /dev/null -T 5 $H $U/status/200; done; wget -q -O /dev/null -T 5 $H $U/status/503; wget -q -O /dev/null -T 5 $H $U/status/503; wget -q -O /dev/null -T 5 $H $U$C || true; wget -q -O /dev/null -T 5 $H $U/delay/2'
caller() { # caller <url> <missing upstream path> [host header]
  printf '%s' "while true; do for U in $1; do H='${3:+--header Host:$3}'; C='$2'; $round; done; sleep 0.5; done"
}

say "Kubernetes: ingress-nginx (metrics off), api, cart without endpoints, a plain Nginx"
sed "s#IMAGE#$image#" deploy/test/nginx/ingress-nginx.yaml | in_vm 'kubectl --context kind-demo apply -f - >/dev/null'
in_vm "kubectl --context kind-demo apply -f - >/dev/null" <<YAML
apiVersion: v1
kind: Namespace
metadata: { name: nginx-e2e }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: api, namespace: nginx-e2e }
spec:
  selector: { matchLabels: { app: api } }
  template:
    metadata: { labels: { app: api } }
    spec:
      containers: [{ name: api, image: ghcr.io/stefanprodan/podinfo:6.16.0, ports: [{ containerPort: 9898 }] }]
---
apiVersion: v1
kind: Service
metadata: { name: api, namespace: nginx-e2e }
spec: { selector: { app: api }, ports: [{ port: 9898 }] }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: cart, namespace: nginx-e2e }
spec:
  replicas: 0
  selector: { matchLabels: { app: cart } }
  template:
    metadata: { labels: { app: cart } }
    spec:
      containers: [{ name: cart, image: ghcr.io/stefanprodan/podinfo:6.16.0, ports: [{ containerPort: 9898 }] }]
---
apiVersion: v1
kind: Service
metadata: { name: cart, namespace: nginx-e2e }
spec: { selector: { app: cart }, ports: [{ port: 9898 }] }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: shop, namespace: nginx-e2e }
spec:
  ingressClassName: nginx-e2e
  rules:
    - host: shop.e2e
      http:
        paths:
          - { path: /cart, pathType: Prefix, backend: { service: { name: cart, port: { number: 9898 } } } }
          - { path: /, pathType: Prefix, backend: { service: { name: api, port: { number: 9898 } } } }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: web, namespace: nginx-e2e }
data:
  nginx.conf: |
    events {}
    http {
      server { listen 80; location / { proxy_pass http://api.nginx-e2e.svc.cluster.local:9898; } }
      server { listen 8080; location = /stub_status { stub_status; } }
    }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: nginx-e2e }
spec:
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - name: nginx
          image: nginx:1.27-alpine
          ports: [{ containerPort: 80 }]
          volumeMounts: [{ name: conf, mountPath: /etc/nginx/nginx.conf, subPath: nginx.conf }]
      volumes: [{ name: conf, configMap: { name: web } }]
---
apiVersion: v1
kind: Service
metadata: { name: web, namespace: nginx-e2e }
spec: { selector: { app: web }, ports: [{ port: 80 }] }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: caller, namespace: nginx-e2e }
spec:
  selector: { matchLabels: { app: caller } }
  template:
    metadata: { labels: { app: caller } }
    spec:
      containers:
        - name: caller
          image: busybox:latest
          command:
            - sh
            - -c
            - |
              ($(caller http://ingress-nginx-controller.ingress-nginx-e2e /cart shop.e2e)) &
              $(caller http://web /missing)
YAML
in_vm 'kubectl --context kind-demo -n ingress-nginx-e2e rollout status deploy/ingress-nginx-controller --timeout 240s >/dev/null &&
  kubectl --context kind-demo -n nginx-e2e rollout status deploy/api deploy/web deploy/caller --timeout 240s >/dev/null'

say "Docker: Compose project nginx-e2e (web with stub_status, bare without)"
in_vm 'mkdir -p ~/nginx-e2e && cat > ~/nginx-e2e/web.conf && cat > ~/nginx-e2e/bare.conf <<EOF
events {}
http {
  server {
    listen 80;
    location /gone/ { proxy_pass http://app:9999/; }
    location / { proxy_pass http://app:9898; }
  }
}
EOF' <<'CONF'
events {}
http {
  server {
    listen 80;
    location /gone/ { proxy_pass http://app:9999/; }
    location / { proxy_pass http://app:9898; }
  }
  server { listen 8080; location = /stub_status { stub_status; } }
}
CONF
in_vm "cat > ~/nginx-e2e/compose.yaml" <<YAML
name: nginx-e2e
services:
  app:
    image: ghcr.io/stefanprodan/podinfo:6.16.0
  web:
    image: nginx:1.27-alpine
    volumes: ['./web.conf:/etc/nginx/nginx.conf:ro']
    depends_on: [app]
  bare:
    image: nginx:1.27-alpine
    volumes: ['./bare.conf:/etc/nginx/nginx.conf:ro']
    depends_on: [app]
  caller:
    image: busybox:latest
    depends_on: [web, bare]
    command:
      - sh
      - -c
      - |
        sleep 3
        $(caller 'http://web http://bare' /gone/x | sed 's/\$/$$/g')
YAML
in_vm 'docker compose -f ~/nginx-e2e/compose.yaml up -d --quiet-pull >/dev/null'

say "discover, monitor, and what the pages say"
WATCHLOG_URL=$url VM=$vm python3 - <<'PY'
import http.cookiejar, json, os, subprocess, sys, time, urllib.request

url = os.environ["WATCHLOG_URL"] + "/api/v1"
vm = os.environ["VM"]
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

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
    print(("PASS  " if ok else "FAIL  ") + name + (f": {detail}" if detail and not ok else ""))
    failures += 0 if ok else 1

def wait(fn, timeout, every=10):
    deadline = time.time() + timeout
    while True:
        got = fn()
        if got or time.time() > deadline:
            return got
        time.sleep(every)

ALERTS = ["nginx_5xx_high", "nginx_latency_high", "nginx_upstream_down", "nginx_certificate_expiring"]
want = {
    ("kubernetes", "ingress-nginx-e2e/ingress-nginx-controller"): "ingress",
    ("kubernetes", "nginx-e2e/web"): "web-k8s",
    ("docker", "nginx-e2e/web"): "web-docker",
    ("docker", "nginx-e2e/bare"): "bare",
}
# A previous run stopped half-way leaves its services monitored (so not found): remove them.
for a in call("GET", "/applications")["applications"]:
    if a["type"] == "nginx" and (a["cluster"]["kind"], a["name"]) in want:
        call("DELETE", f"/applications/{a['id']}")

def discovered():
    found = {(d["cluster"]["kind"], d["name"]): d for d in call("GET", "/applications/discovered")["discovered"] if d["type"] == "nginx"}
    return found if all(k in found for k in want) else None
found = wait(discovered, 240) or {}
apps = {}
for key, label in want.items():
    d = found.get(key)
    check(f"discovered {key[0]} {key[1]} as Nginx", bool(d), str(sorted(found)))
    if d:
        apps[label] = call("POST", "/applications", {"clusterId": d["cluster"]["id"],
                                                     "type": "nginx", "target": d["target"], "defaultAlerts": ALERTS})["application"]["id"]
if failures:
    sys.exit(1)

def reasons(label):
    return {r["code"]: r for r in call("GET", f"/applications/{apps[label]}")["reasons"]}
def tab(label, t):
    return {p["id"]: p for p in call("GET", f"/applications/{apps[label]}/panels?tab={t}")["panels"]}
def tile(label, tid):
    return next(t for t in tab(label, "overview")["summary"]["tiles"] if t["id"] == tid)

# eBPF, with nothing set up: the plain Nginx on both sides and ingress-nginx meanwhile.
for label in ("web-k8s", "web-docker", "bare", "ingress"):
    got = wait(lambda: "errors_high" in reasons(label) and (tile(label, "rps")["value"] or 0) > 1, 300)
    check(f"{label}: requests/s and 5xx from eBPF", bool(got), json.dumps(list(reasons(label))))
    r = reasons(label)
    if "errors_high" in r:
        check(f"{label}: 5xx share about 17 % ({r['errors_high']['facts']['pct']} %)",
              8 <= r["errors_high"]["facts"]["pct"] <= 30, json.dumps(r["errors_high"]))
    got = wait(lambda: "latency_high" in reasons(label), 180)
    check(f"{label}: latency_high (a 2 s page)", bool(got), json.dumps(list(reasons(label))))

r = reasons("bare")
check("bare: stub_status_missing with the snippet", "stub_status;" in (r.get("stub_status_missing", {}).get("facts", {}).get("command") or ""), json.dumps(list(r)))
check("bare: Connections needs stub_status", tab("bare", "connections")["states"]["state"] == "needs_permission")
for label in ("web-k8s", "web-docker"):
    got = wait(lambda: tab(label, "connections")["states"]["state"] == "ok", 120)
    check(f"{label}: connections from stub_status", bool(got))
    check(f"{label}: no stub_status hint", "stub_status_missing" not in reasons(label))
ups = wait(lambda: "upstream_no_endpoints" in reasons("web-docker"), 180)
check("web-docker: the port nothing listens on is an upstream down",
      ":9999" in (reasons("web-docker").get("upstream_no_endpoints", {}).get("facts", {}).get("upstream") or ""),
      json.dumps(reasons("web-docker").get("upstream_no_endpoints")))

# ingress-nginx: its metrics are off; the page's command turns them on.
r = reasons("ingress")
cmd = r.get("ingress_metrics_off", {}).get("facts", {}).get("command") or ""
check("ingress: says its metrics are off, with the command", cmd.startswith("kubectl -n ingress-nginx-e2e patch deployment ingress-nginx-controller"), cmd)
check("ingress: Connections needs its metrics", tab("ingress", "connections")["states"]["state"] == "needs_permission")
if cmd:
    run = subprocess.run(["limactl", "shell", vm, "bash", "-c", "export PATH=$HOME/bin:$PATH && cmd=$(cat) && eval \"kubectl --context kind-demo ${cmd#kubectl }\" && kubectl --context kind-demo -n ingress-nginx-e2e rollout status deploy/ingress-nginx-controller --timeout 240s"],
                         input=cmd, text=True, capture_output=True)
    check("ingress: the command runs as shown", run.returncode == 0, run.stderr[-300:])
    got = wait(lambda: "ingress_metrics_off" not in reasons("ingress") and tab("ingress", "connections")["states"]["state"] == "ok", 300)
    check("ingress: then its own metrics fill the page", bool(got), json.dumps(list(reasons("ingress"))))
    got = wait(lambda: (reasons("ingress").get("errors_high", {}).get("facts", {}).get("upstream") or "").startswith("nginx-e2e/"), 300)
    check("ingress: errors_high names its upstream", bool(got), json.dumps(reasons("ingress").get("errors_high")))
    got = wait(lambda: "upstream_no_endpoints" in reasons("ingress"), 180)
    check("ingress: cart has no ready endpoint", bool(got), json.dumps(list(reasons("ingress"))))
    up = tile("ingress", "upstreams")
    check(f"ingress: upstreams ready {up['value']}", up["value"] in ("1/2",), json.dumps(up))
    codes = lambda: {i["label"] for i in tab("ingress", "errors")["codes"]["items"]}
    wait(lambda: {"200", "503"} <= codes(), 180)
    check("ingress: status codes 200 and 503", {"200", "503"} <= codes(), str(codes()))

# Every page's tabs answer, and the list has its numbers.
for label, aid in apps.items():
    for t in ("overview", "errors", "latency", "connections"):
        ps = call("GET", f"/applications/{aid}/panels?tab={t}")["panels"]
        check(f"{label}: {t} has no failed panel", all(p["state"] != "error" for p in ps), json.dumps([p["id"] for p in ps if p["state"] == "error"]))
def rows():
    m = call("GET", "/applications/metrics")["metrics"]
    return {aid: {k["id"]: k["value"] for k in m.get(aid, {}).get("keyMetrics", [])} for aid in apps.values()}
wait(lambda: all((km.get("rps") or 0) > 0 for km in rows().values()), 180)
metrics = rows()
for label, aid in apps.items():
    km = metrics[aid]
    check(f"{label}: list row requests/s ({km.get('rps')})", (km.get("rps") or 0) > 0, json.dumps(km))
rules = [r for r in call("GET", "/alert-rules")["rules"] if r.get("scope", {}).get("service") in apps.values()]
check(f"default rules created and on ({len(rules)})", len(rules) >= 4 * len(apps) and all(r["enabled"] for r in rules if r.get("defaultKey") in ALERTS))

for aid in apps.values():
    call("DELETE", f"/applications/{aid}")
print(f"\n{failures} failed" if failures else "\nall passed")
sys.exit(1 if failures else 0)
PY
