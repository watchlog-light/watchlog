#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Traefik end to end (v0.5 slice 3, SPEC §4.12, ADR-165) on the demo VM, after
# deploy/test/integrations-e2e.sh has started the agents and collectors (same backend,
# same environment variables). Traefik 3.6 on the kind cluster "demo" (namespace
# traefik-e2e, run the way k3s runs it: entrypoints web :8000, websecure :8443 and
# metrics :9100, the Ingress and CRD providers with empty services allowed, as Traefik's
# Helm chart sets) and Traefik 3.6 on the VM's Docker host (Compose project traefik-e2e,
# the Docker provider; 3.6.1 or later, since older ones can't talk to Docker 29):
#   - discovery of both, connected with nothing to enter (Traefik needs no user), its
#     metrics found (:9100 on kind, :8082 on Docker);
#   - a client sends plain HTTP to /api (eBPF sees it) and HTTPS (only Traefik sees it):
#     the Services tab lists api with its backend, the entrypoints websecure's TLS
#     requests;
#   - the scenario of phases/v0.5: the backend behind a route has no server up (kind: the
#     api Deployment scaled to 0; Docker: the api container frozen, so its health check
#     fails) → Traefik answers 503 itself, counted on its entrypoint only → no_server_up
#     naming traefik-e2e/api (kind) or the api container (Docker); probable cause:
#     application_finding; on the service map, the Traefik → api edge carries the
#     requests "answered by Traefik";
#   - a second Traefik on Docker without metrics (`bare`): metrics_off.
#
#   traefik-e2e.sh up        the fixtures only (namespace and Compose project), for a look
#   traefik-e2e.sh           everything above, then restores the backends
#   traefik-e2e.sh down      removes what it made
#
#   VM (default watchlog-demo), WATCHLOG_URL (default http://127.0.0.1:4080),
#   WATCHLOG_E2E_EMAIL and WATCHLOG_E2E_PASSWORD, as integrations-e2e.sh.
# shellcheck disable=SC2016
set -euo pipefail
cd "$(dirname "$0")/../.."
vm=${VM:-watchlog-demo}
url=${WATCHLOG_URL:-http://127.0.0.1:4080}
ns=traefik-e2e
tag=v3.6
crds=https://raw.githubusercontent.com/traefik/traefik/$tag/docs/content/reference/dynamic-configuration/kubernetes-crd-definition-v1.yml
# The fixtures' folder in the VM (the tilde expands there).
# shellcheck disable=SC2088
dir='~/traefik-e2e'
compose="docker compose -p traefik-e2e -f $dir/compose.yaml"
in_vm() { limactl shell "$vm" bash -c "cd ~ && export PATH=\$HOME/bin:\$PATH && $*"; }
say() { printf '\n== %s\n' "$*"; }

# Traefik from Docker Hub or, when it doesn't answer, its mirror on ECR Public. Kind gets
# it as an archive (a multi-platform image's `kind load docker-image` can fail), on one
# worker only, where the pods are pinned.
images() {
  in_vm "docker image inspect traefik:$tag >/dev/null 2>&1 || timeout 300 docker pull -q traefik:$tag >/dev/null 2>&1 || {
      docker pull -q public.ecr.aws/docker/library/traefik:$tag >/dev/null && docker tag public.ecr.aws/docker/library/traefik:$tag traefik:$tag; }
    for i in ghcr.io/stefanprodan/podinfo:6.16.0 nginx:1.27-alpine curlimages/curl:8.17.0; do docker image inspect \$i >/dev/null 2>&1 || docker pull -q \$i >/dev/null; done
    docker exec demo-worker crictl inspecti docker.io/library/traefik:$tag >/dev/null 2>&1 || {
      docker save --platform linux/\$(dpkg --print-architecture) traefik:$tag -o /tmp/traefik-e2e.tar &&
        kind load image-archive --name demo --nodes demo-worker /tmp/traefik-e2e.tar >/dev/null; rm -f /tmp/traefik-e2e.tar; }
    for i in ghcr.io/stefanprodan/podinfo:6.16.0 curlimages/curl:8.17.0; do
      docker exec demo-worker crictl inspecti \$i >/dev/null 2>&1 || kind load docker-image --name demo --nodes demo-worker \$i >/dev/null; done"
}

down() {
  in_vm "kubectl --context kind-demo delete namespace $ns --ignore-not-found --wait=false >/dev/null
    kubectl --context kind-demo delete clusterrole,clusterrolebinding traefik-e2e --ignore-not-found >/dev/null
    kubectl --context kind-demo delete ingressclass traefik-e2e --ignore-not-found >/dev/null
    [ -f $dir/compose.yaml ] && { $compose kill -s CONT api >/dev/null 2>&1 || true; $compose down -v --remove-orphans >/dev/null 2>&1 || true; }
    rm -rf $dir"
  # Traefik's CRDs stay: other Traefiks in the cluster may use them, and they hold nothing.
}

up() {
  say "Traefik $tag on kind (namespace $ns) and on the VM's Docker host (project traefik-e2e)"
  images
  in_vm "mkdir -p $dir"
  # The CRDs (IngressRoute), fetched where the script runs: the VM's own access to GitHub
  # can time out.
  curl -sfL -m 120 "$crds" | in_vm "kubectl --context kind-demo apply --server-side -f - >/dev/null"
  in_vm "kubectl --context kind-demo apply -f - >/dev/null" <<'YAML'
apiVersion: v1
kind: Namespace
metadata: { name: traefik-e2e }
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: traefik, namespace: traefik-e2e }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: traefik-e2e }
rules:
  - apiGroups: [""]
    resources: [services, secrets, nodes, configmaps]
    verbs: [get, list, watch]
  - apiGroups: [discovery.k8s.io]
    resources: [endpointslices]
    verbs: [list, watch]
  - apiGroups: [extensions, networking.k8s.io]
    resources: [ingresses, ingressclasses]
    verbs: [get, list, watch]
  - apiGroups: [extensions, networking.k8s.io]
    resources: [ingresses/status]
    verbs: [update]
  - apiGroups: [traefik.io]
    resources: [middlewares, middlewaretcps, ingressroutes, traefikservices, ingressroutetcps, ingressrouteudps, tlsoptions, tlsstores, serverstransports, serverstransporttcps]
    verbs: [get, list, watch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: traefik-e2e }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: traefik-e2e }
subjects: [{ kind: ServiceAccount, name: traefik, namespace: traefik-e2e }]
---
apiVersion: networking.k8s.io/v1
kind: IngressClass
metadata: { name: traefik-e2e }
spec: { controller: traefik.io/ingress-controller }
YAML
  in_vm "kubectl --context kind-demo -n $ns apply -f - >/dev/null" <<YAML
# The way k3s runs it: entrypoints web :8000, websecure :8443, metrics :9100.
apiVersion: apps/v1
kind: Deployment
metadata: { name: traefik }
spec:
  selector: { matchLabels: { app: traefik } }
  template:
    metadata: { labels: { app: traefik } }
    spec:
      serviceAccountName: traefik
      nodeSelector: { kubernetes.io/hostname: demo-worker }
      containers:
        - name: traefik
          image: traefik:$tag
          imagePullPolicy: Never
          args:
            - --entrypoints.web.address=:8000
            - --entrypoints.websecure.address=:8443
            - --entrypoints.websecure.http.tls=true
            - --entrypoints.metrics.address=:9100
            - --metrics.prometheus=true
            - --metrics.prometheus.entrypoint=metrics
            - --providers.kubernetesingress
            - --providers.kubernetesingress.ingressclass=traefik-e2e
            - --providers.kubernetesingress.allowemptyservices=true
            - --providers.kubernetescrd
            - --providers.kubernetescrd.allowemptyservices=true
            - --ping
            - --api.insecure=true
          ports:
            - { name: web, containerPort: 8000 }
            - { name: websecure, containerPort: 8443 }
            - { name: metrics, containerPort: 9100 }
          resources: { limits: { memory: 128Mi } }
---
apiVersion: v1
kind: Service
metadata: { name: traefik }
spec:
  selector: { app: traefik }
  ports:
    - { name: web, port: 80, targetPort: 8000 }
    - { name: websecure, port: 443, targetPort: 8443 }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template:
    metadata: { labels: { app: api } }
    spec:
      nodeSelector: { kubernetes.io/hostname: demo-worker }
      containers:
        - name: api
          image: ghcr.io/stefanprodan/podinfo:6.16.0
          imagePullPolicy: IfNotPresent
          ports: [{ containerPort: 9898 }]
          resources: { limits: { memory: 64Mi } }
---
apiVersion: v1
kind: Service
metadata: { name: api }
spec:
  selector: { app: api }
  ports: [{ name: http, port: 9898 }]
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: api }
spec:
  ingressClassName: traefik-e2e
  rules:
    - http:
        paths:
          - { path: /api, pathType: Prefix, backend: { service: { name: api, port: { number: 9898 } } } }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: shop }
spec:
  selector: { matchLabels: { app: shop } }
  template:
    metadata: { labels: { app: shop } }
    spec:
      nodeSelector: { kubernetes.io/hostname: demo-worker }
      containers:
        - name: shop
          image: ghcr.io/stefanprodan/podinfo:6.16.0
          imagePullPolicy: IfNotPresent
          ports: [{ containerPort: 9898 }]
          resources: { limits: { memory: 64Mi } }
---
apiVersion: v1
kind: Service
metadata: { name: shop }
spec:
  selector: { app: shop }
  ports: [{ name: http, port: 9898 }]
---
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata: { name: shop }
spec:
  entryPoints: [websecure]
  routes:
    - match: PathPrefix(\`/shop\`)
      kind: Rule
      services: [{ name: shop, port: 9898 }]
  tls: {}
---
# Clients: plain HTTP to /api (eBPF sees it), HTTPS to /shop (only Traefik does).
apiVersion: apps/v1
kind: Deployment
metadata: { name: client }
spec:
  selector: { matchLabels: { app: client } }
  template:
    metadata: { labels: { app: client } }
    spec:
      nodeSelector: { kubernetes.io/hostname: demo-worker }
      containers:
        - name: client
          image: curlimages/curl:8.17.0
          imagePullPolicy: IfNotPresent
          command: [sh, -c, 'while true; do curl -s -o /dev/null -m 3 http://traefik/api/info; curl -sk -o /dev/null -m 3 https://traefik/shop/; sleep 0.5; done']
          resources: { limits: { memory: 32Mi } }
YAML
  # Docker: the api with a health check (Traefik's server_up exists only with one), a web
  # service on the default name (<service>-<project>@docker), a client, and `bare`, a
  # Traefik without metrics.
  in_vm "cat > $dir/compose.yaml" <<YAML
name: traefik-e2e
services:
  traefik:
    image: traefik:$tag
    command:
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --providers.docker.constraints=Label(\`watchlog.e2e\`, \`traefik\`)
      - --entrypoints.web.address=:80
      - --entrypoints.websecure.address=:443
      - --entrypoints.metrics.address=:8082
      - --metrics.prometheus=true
      - --metrics.prometheus.entrypoint=metrics
      - --api.insecure=true
    volumes: ["/var/run/docker.sock:/var/run/docker.sock:ro"]
    mem_limit: 128m
  api:
    image: ghcr.io/stefanprodan/podinfo:6.16.0
    labels:
      - watchlog.e2e=traefik
      - traefik.enable=true
      - traefik.http.routers.api.rule=PathPrefix(\`/api\`)
      - traefik.http.routers.api.entrypoints=web
      - traefik.http.routers.apitls.rule=PathPrefix(\`/api\`)
      - traefik.http.routers.apitls.entrypoints=websecure
      - traefik.http.routers.apitls.tls=true
      - traefik.http.services.api.loadbalancer.server.port=9898
      - traefik.http.services.api.loadbalancer.healthcheck.path=/healthz
      - traefik.http.services.api.loadbalancer.healthcheck.interval=5s
    mem_limit: 64m
  web:
    image: nginx:1.27-alpine
    labels:
      - watchlog.e2e=traefik
      - traefik.enable=true
      - traefik.http.routers.web.rule=PathPrefix(\`/\`)
      - traefik.http.routers.web.entrypoints=web
    mem_limit: 32m
  client:
    image: curlimages/curl:8.17.0
    command: [sh, -c, 'while true; do curl -s -o /dev/null -m 3 http://traefik/api/info; curl -sk -o /dev/null -m 3 https://traefik/api/info; curl -s -o /dev/null -m 3 http://traefik/; sleep 0.5; done']
    mem_limit: 32m
  bare:
    image: traefik:$tag
    command: [--entrypoints.web.address=:80, --ping]
    mem_limit: 64m
YAML
  in_vm "$compose up -d --quiet-pull >/dev/null && kubectl --context kind-demo -n $ns rollout status deployment/traefik deployment/api deployment/shop deployment/client --timeout 180s >/dev/null"
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
down
in_vm "kubectl --context kind-demo wait --for=delete namespace/$ns --timeout 180s >/dev/null 2>&1 || true"
up

say "connect and monitor; the Services tab; no server up, its cause and the map; metrics off"
WATCHLOG_URL=$url VM=$vm NS=$ns DIR=$dir python3 - <<'PY'
import atexit, http.cookiejar, json, os, re, subprocess, sys, time, urllib.error, urllib.parse, urllib.request

url = os.environ["WATCHLOG_URL"] + "/api/v1"
vm, ns, d_ = os.environ["VM"], os.environ["NS"], os.environ["DIR"]
compose = f"docker compose -p traefik-e2e -f {d_}/compose.yaml"
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

K, D, B = ("kubernetes", f"{ns}/traefik"), ("docker", "traefik-e2e/traefik"), ("docker", "traefik-e2e/bare")
want = {K, D, B}
def found():
    d = {(x["cluster"]["kind"], x["name"]): x for x in call("GET", "/applications/discovered")["discovered"] if x["type"] == "traefik"}
    return d if want <= set(d) else None
for x in call("GET", "/applications")["applications"]:
    if x["type"] == "traefik" and (x["cluster"]["kind"], x["name"]) in want:
        call("DELETE", f"/applications/{x['id']}")
d = wait(found, 180, 5) or {}
check("Traefik on kind, on Docker and the bare one are discovered", bool(d), str(sorted(d)))
if not d:
    sys.exit(1)

def probe(svc):
    return call("POST", "/applications/probes", {"clusterId": svc["cluster"]["id"], "type": "traefik", "target": svc["target"], "access": {"method": "none"}})

def passed(pid, timeout=90):
    return wait(lambda: (lambda x: x if x["status"] == "ok" else None)(call("GET", f"/applications/probes/{pid}")["probe"]), timeout)

monitored = []
@atexit.register
def cleanup():
    for m in monitored:
        call("DELETE", f"/applications/{m}", ok=False)
    try:
        vm_run(f"kubectl -n {ns} scale deployment api --replicas 1 >/dev/null; {compose} kill -s CONT api >/dev/null 2>&1 || true")
    except Exception as e:  # noqa: BLE001
        print(f"cleanup: {e}")

def monitor(svc, label):
    p = probe(svc)
    q = passed(p["probe"]["id"])
    check(f"{label}: the test passes with nothing entered", bool(q), json.dumps(call("GET", f"/applications/probes/{p['probe']['id']}")["probe"])[:300])
    a = call("POST", "/applications", {"clusterId": svc["cluster"]["id"], "type": "traefik", "target": svc["target"],
                                         "probeId": p["probe"]["id"], "defaultAlerts": []})["application"]
    monitored.append(a["id"])
    return a["id"], q

def connected(app_id, label):
    def ok():
        a = call("GET", f"/applications/{app_id}")
        return a if a["application"]["reason"]["code"] == "connected" else None
    a = wait(ok, 120)
    check(f"{label}: connected", bool(a), json.dumps(call("GET", f"/applications/{app_id}")["reasons"])[:300])
    return a

def panels(app_id, tab):
    return call("GET", f"/applications/{app_id}/panels?tab={tab}")["panels"]
def reason(app_id, code):
    return next((r for r in call("GET", f"/applications/{app_id}")["reasons"] if r["code"] == code), None)

apps = {}
for label, key, at in (("kubernetes", K, ":9100/metrics"), ("docker", D, ":8082/metrics")):
    app_id, q = monitor(d[key], label)
    apps[label] = app_id
    facts = (q or {}).get("result", {}).get("facts", {})
    check(f"{label}: the metrics are found at {at}, Traefik 3.6", facts.get("metrics") is True and facts.get("metrics_at") == at
          and (q or {}).get("result", {}).get("version", "").startswith("3.6"), json.dumps(facts))
    a = connected(app_id, label)
    check(f"{label}: the Traefik page", bool(a) and a["page"]["id"] == "traefik", json.dumps((a or {}).get("page", {}))[:200])

# The Services tab: api with its backend; the entrypoints: websecure's TLS requests.
for label, backend in (("kubernetes", f"{ns}/api"), ("docker", "api")):
    s = wait(lambda: (lambda x: x if backend in x else None)(json.dumps(panels(apps[label], "services"))), 180, 5)
    check(f"{label}: the Services tab lists {backend}", bool(s), json.dumps(panels(apps[label], "services"))[:400])
    e = wait(lambda: (lambda x: x if "websecure" in x else None)(json.dumps(panels(apps[label], "entrypoints"))), 120, 5)
    check(f"{label}: the Entrypoints tab has websecure", bool(e))

# The scenario: no server up. Kind: api scaled to 0 (the Service keeps its route, empty
# services allowed); Docker: api frozen, so its health check fails and the route stays.
vm_run(f"kubectl -n {ns} scale deployment api --replicas 0 >/dev/null; {compose} kill -s STOP api >/dev/null")
for label, holder in (("kubernetes", f"{ns}/api"), ("docker", "traefik-e2e-api-1")):
    app_id = apps[label]
    r = wait(lambda: (lambda x: x if x and holder in json.dumps(x) else None)(reason(app_id, "no_server_up")), 300, 5)
    check(f"{label}: no_server_up names {holder}", bool(r), json.dumps(call("GET", f"/applications/{app_id}")["reasons"])[:400])
    cluster_id = d[K if label == "kubernetes" else D]["cluster"]["id"]
    def cause():
        c = call("GET", "/causes?" + urllib.parse.urlencode({"cluster": cluster_id, "subject": f"application:{app_id}"}), ok=False)
        top = (c.get("causes") or [None])[0]
        return c if top and top.get("rule", top.get("code")) == "application_finding" else None
    c = wait(cause, 180, 5)
    check(f"{label}: the top cause is application_finding, naming the backend", bool(c) and holder.split("/")[-1] in json.dumps(c),
          json.dumps(call("GET", "/causes?" + urllib.parse.urlencode({"cluster": cluster_id, "subject": f"application:{app_id}"}), ok=False))[:500])
    # The map: the requests Traefik answered itself, on its edge to api.
    def answered():
        m = call("GET", f"/clusters/{cluster_id}/service-map?range=600")
        for e in m["edges"]:
            if "traefik" in e["source"] and "api" in e["target"] and (e.get("answeredByProxy") or {}).get("perSecond", 0) > 0:
                return e
        return None
    e = wait(answered, 180, 10)
    check(f"{label}: the map's Traefik → api edge shows the requests answered by Traefik", bool(e))

vm_run(f"kubectl -n {ns} scale deployment api --replicas 1 >/dev/null; {compose} kill -s CONT api >/dev/null")

# A Traefik without metrics: metrics_off, with the setting.
b_id, _ = monitor(d[B], "docker bare")
connected(b_id, "docker bare")
r = wait(lambda: reason(b_id, "metrics_off"), 120, 5)
check("docker bare: metrics_off gives the setting", bool(r) and "metrics" in json.dumps(r), json.dumps(call("GET", f"/applications/{b_id}")["reasons"])[:300])

print(f"\n{failures} failed" if failures else "\nall passed")
sys.exit(1 if failures else 0)
PY
