#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Egress watch end to end (v0.7, ADR-184 to ADR-193) on the demo VM: a client that starts
# talking to the internet, on the kind cluster "demo" (a fresh namespace egress-e2e-<run>)
# and on the VM's Docker host (a fresh Compose project egress-e2e-<run>), and what WatchLog
# makes of it through the API, the alerts, probable cause, MCP and the policy suggestion.
#
#   egress-e2e.sh up      the client, idle at first, then changed to start dialling (a
#                         rollout on kind, a re-create on Docker: the cause to find). It
#                         dials example.org:443 (a name nothing else uses) and 1.1.1.1:443 (a
#                         public address with no DNS name), TCP connects only (nc -z), every
#                         20 s until `down`, so 5 or more in 10 minutes to the raw IP
#   egress-e2e.sh check   on both platforms, waiting up to EGRESS_E2E_TIMEOUT for each step:
#                         1. the rows: example.org:443 (class name) and 1.1.1.0/24:443 (class
#                            public_network) for the client, with the badges New and Raw IP
#                         2. the alerts "New external destination" and "Raw IP egress", their
#                            titles and messages in the platform's words, and the row's alertId
#                         3. the cause of the New alert: change_before_egress, likely
#                         4. the API with an API token: GET /egress (firstSeenAfter) answers,
#                            POST /egress/expected is refused (session only)
#                         5. MCP with that token: get_egress and get_new_destinations name both
#                            destinations for the client
#                         6. the policy: kind's standard NetworkPolicy from GET /egress/policy
#                            passes `kubectl apply --dry-run=server`; Docker answers 404 with
#                            the reason
#                         7. marking example.org:443 expected for the client (Owner/Admin): the
#                            row gets Expected and the New alert resolves; Raw IP stays
#   egress-e2e.sh down    removes the namespace and the Compose project. The run's two
#                         expectations stay (they match only that run's client, which is gone),
#                         so its New alerts stay resolved; the Raw IP alerts resolve about 20
#                         minutes after the client stops
#
# Every run is a new source (the run's id is in the namespace and the project), since a
# destination stays known to its source for 90 days (ADR-185) and alerts only once.
#
# Needs:
#   - the agents reporting with network flows on (eBPF), e.g. WATCHLOG_E2E_FLOWS=true
#     deploy/test/integrations-e2e.sh, which starts the e2e agents beside the demo's own;
#   - the backend AND the alert worker from this checkout started with
#     WATCHLOG_EGRESS_LEARNING_DAYS=0 (this test's backend only: "New external destination"
#     is quiet for 7 days otherwise). The worker fills the inventory every minute and raises
#     the alerts; `check` stops early when the page still says "learning".
#
#   WATCHLOG_URL           the backend as seen from this machine (required: this script writes
#                          an API token and expectations into it)
#   WATCHLOG_E2E_EMAIL and WATCHLOG_E2E_PASSWORD   an Owner or Admin in it (`check`)
#   WATCHLOG_E2E_KUBE_CLUSTER, WATCHLOG_E2E_DOCKER_CLUSTER
#                          the cluster and fleet (id or name); default the only one of each kind
#   VM                     the Lima VM (default watchlog-demo)
#   EGRESS_E2E_TIMEOUT     seconds each step of `check` waits (default 420)
# Every object is labelled app.kubernetes.io/part-of=egress-e2e; nothing else is touched.
# shellcheck disable=SC2016
set -euo pipefail
cd "$(dirname "$0")/../.."
vm=${VM:-watchlog-demo}
url=${WATCHLOG_URL:-}
# The run's state in the VM (the tilde expands there).
# shellcheck disable=SC2088
dir='~/egress-e2e'
in_vm() { limactl shell "$vm" bash -c "cd ~ && export PATH=\$HOME/bin:\$PATH && $*"; }
kc() { in_vm "kubectl --context kind-demo $*"; }
say() { printf '\n== %s\n' "$*"; }

# The client: idle while DIAL is 0, so that `up` can change it (the cause `check` expects),
# then example.org:443 and 1.1.1.1:443 every 20 s. The name ends in a dot: no search-list
# lookups (NXDOMAIN) before the real one. It never exits, so every connection is attributed
# (a container must still run at the agent's next drain, 15 s later).
client='echo "client: DIAL=$DIAL"
if [ "$DIAL" = 1 ]; then
  while true; do
    if nc -z -w 5 example.org. 443; then a=connected; else a="no answer"; fi
    if nc -z -w 3 1.1.1.1 443; then b=connected; else b="no answer"; fi
    echo "$(date -u +%H:%M:%S) example.org:443 $a, 1.1.1.1:443 $b"
    sleep 20
  done
fi
exec sleep 2147483647'

manifest() { # namespace DIAL
  cat <<YAML
apiVersion: v1
kind: Namespace
metadata: { name: $1, labels: { app.kubernetes.io/part-of: egress-e2e } }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: client, namespace: $1, labels: { app.kubernetes.io/part-of: egress-e2e } }
spec:
  selector: { matchLabels: { app: client } }
  template:
    metadata: { labels: { app: client, app.kubernetes.io/part-of: egress-e2e } }
    spec:
      automountServiceAccountToken: false
      terminationGracePeriodSeconds: 2
      containers:
        - name: client
          image: busybox:1.37
          imagePullPolicy: IfNotPresent
          env: [{ name: DIAL, value: '$2' }]
          command:
            - sh
            - -c
            - |
$(printf '%s\n' "$client" | sed 's/^/              /')
          resources: { requests: { cpu: 1m, memory: 4Mi }, limits: { cpu: 20m, memory: 16Mi } }
YAML
}

compose_file() { # project
  cat <<YAML
# egress-e2e.sh: the Docker host's client (Compose project $1).
name: $1
services:
  client:
    image: busybox:1.37
    environment: { DIAL: '\${DIAL:-0}' }
    labels: { app.kubernetes.io/part-of: egress-e2e }
    command:
      - sh
      - -c
      - |
$(printf '%s\n' "$client" | sed 's/\$/$$/g; s/^/        /')
    mem_limit: 16m
    cpus: 0.02
    restart: unless-stopped
YAML
}

run_id() { in_vm "cat $dir/run 2>/dev/null" || true; }

# The API side of `check`, in Python as the other e2e scripts.
api() {
  : "${WATCHLOG_E2E_EMAIL:?}" "${WATCHLOG_E2E_PASSWORD:?}"
  WATCHLOG_URL=$url VM=$vm RUN=$1 STARTED=$2 EGRESS_E2E_TIMEOUT=${EGRESS_E2E_TIMEOUT:-420} python3 - <<'PY'
import http.cookiejar, json, os, subprocess, sys, time, urllib.error, urllib.parse, urllib.request

base = os.environ["WATCHLOG_URL"].rstrip("/")
url = base + "/api/v1"
vm, run, started = os.environ["VM"], os.environ["RUN"], int(os.environ["STARTED"])
timeout = int(os.environ["EGRESS_E2E_TIMEOUT"])
ns = project = f"egress-e2e-{run}"
session = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
plain = urllib.request.build_opener()

def call(method, path, body=None, token=None, raw=False):
    headers = {"content-type": "application/json"} if body is not None else {}
    if token:
        headers["authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url + path, method=method, headers=headers,
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with (plain if token else session).open(req, timeout=60) as res:
            data = res.read()
            out = json.loads(data) if data else None
            return (res.status, out) if raw else out
    except urllib.error.HTTPError as e:
        if not raw:
            raise SystemExit(f"{method} {path}: {e.code} {e.read()[:300]!r}")
        data = e.read()
        try:
            return e.code, json.loads(data) if data else None
        except ValueError:
            return e.code, None

def wait(fn, every=10):
    deadline = time.time() + timeout
    while True:
        got = fn()
        if got or time.time() > deadline:
            return got
        time.sleep(every)

failures = 0
def check(label, ok, detail=""):
    global failures
    print(f"{'PASS' if ok else 'FAIL'}  {label}" + (f": {detail}" if detail else ""))
    if not ok:
        failures += 1
    return ok

call("POST", "/auth/login", {"email": os.environ["WATCHLOG_E2E_EMAIL"], "password": os.environ["WATCHLOG_E2E_PASSWORD"]})
clusters = call("GET", "/clusters")["clusters"]
def cluster(kind):
    want = os.environ.get("WATCHLOG_E2E_KUBE_CLUSTER" if kind == "kubernetes" else "WATCHLOG_E2E_DOCKER_CLUSTER")
    cs = [c for c in clusters if c["kind"] == kind and (not want or want in (c["id"], c["name"]))]
    if len(cs) != 1:
        sys.exit(f"{len(cs)} {kind} clusters match: set WATCHLOG_E2E_{'KUBE' if kind == 'kubernetes' else 'DOCKER'}_CLUSTER")
    return cs[0]

# Each platform's source, in its own vocabulary: the Egress page's filter, the expectation's
# source, the alert's labels, the MCP arguments and the words in the alert's title.
PLATFORMS = {
    "kubernetes": dict(filter={"namespace": ns, "kind": "Deployment", "workload": "client"},
                       source={"namespace": ns, "workloadKind": "Deployment", "workload": "client"},
                       labels={"namespace": ns, "workload_kind": "Deployment", "workload": "client"},
                       mcp={"workload": f"{ns}/Deployment/client"}, who="client", unit="cluster"),
    "docker": dict(filter={"project": project, "service": "client"},
                   source={"composeProject": project, "composeService": "client"},
                   labels={"compose_project": project, "compose_service": "client"},
                   mcp={"composeService": f"{project}/client"}, who=f"{project}/client", unit="fleet"),
}
NAME, RAW = ("example.org", 443), ("1.1.1.0/24", 443)

# An API token for steps 4 and 5, revoked at the end whatever happens.
created = call("POST", "/api-tokens", {"name": f"egress-e2e {run}", "expiresInDays": 30})
token = created["value"]

def mcp(tool, args):
    """One tools/call over the 2025 protocol (the server's stateless fallback): the tool's text."""
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": args}}
    req = urllib.request.Request(base + "/mcp", method="POST", data=json.dumps(body).encode(), headers={
        "authorization": f"Bearer {token}", "content-type": "application/json",
        "accept": "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25"})
    try:
        with plain.open(req, timeout=60) as res:
            text = res.read().decode()
    except urllib.error.HTTPError as e:
        return f"HTTP {e.code}: {e.read()[:300]!r}"
    # A JSON body, or server-sent events whose data lines carry it.
    if not text.lstrip().startswith("{"):
        text = "\n".join(l[5:].strip() for l in text.splitlines() if l.startswith("data:"))
    try:
        msg = json.loads(text)
    except ValueError:
        return f"not JSON: {text[:300]}"
    if "error" in msg:
        return f"error: {json.dumps(msg['error'])[:300]}"
    return "\n".join(c.get("text", "") for c in msg.get("result", {}).get("content", []))

try:
    for kind, p in PLATFORMS.items():
        c = cluster(kind)
        cid = c["id"]
        print(f"\n== {kind}: {c['name']}, source {p['who']} (run {run})")
        q = lambda extra={}: urllib.parse.urlencode({"cluster": cid, **p["filter"], **extra})
        page = call("GET", f"/egress?{q()}")
        if page["learning"]["learning"]:
            sys.exit(f"the {kind} cluster is learning until {page['learning']['until']}: start the backend and "
                     "the alert worker with WATCHLOG_EGRESS_LEARNING_DAYS=0")

        # 1. The rows and badges.
        def rows():
            got = {(r["destination"], r["port"]): r for r in call("GET", f"/egress?{q()}")["rows"]}
            n, r = got.get(NAME), got.get(RAW)
            return got if n and r and "new" in n["badges"] and {"new", "raw_ip"} <= set(r["badges"]) else None
        got = wait(rows) or {(r["destination"], r["port"]): r for r in call("GET", f"/egress?{q()}")["rows"]}
        n, r = got.get(NAME), got.get(RAW)
        check(f"{kind} row example.org:443, class name, New",
              bool(n) and n["class"] == "name" and "new" in n["badges"] and not n["private"],
              json.dumps(n)[:300] if n else f"rows: {sorted(got)}")
        check(f"{kind} row 1.1.1.0/24:443, class public_network, New and Raw IP",
              bool(r) and r["class"] == "public_network" and {"new", "raw_ip"} <= set(r["badges"]),
              json.dumps(r)[:300] if r else f"rows: {sorted(got)}")

        # 2. Both alerts, their words, and the row's link to the New one.
        def alert(key, dest):
            want = {**p["labels"], "destination": dest[0], "port": str(dest[1])}
            for a in call("GET", f"/alerts?view=firing&clusterId={cid}&limit=200")["alerts"]:
                if a["rule"].get("key") == key and all(a["labels"].get(k) == v for k, v in want.items()):
                    return a
            return None
        new = wait(lambda: alert("egress.new_destination", NAME))
        raw = wait(lambda: alert("egress.raw_ip", RAW))
        if check(f"{kind} alert New external destination for example.org:443", bool(new)):
            check(f"{kind} its title", new["title"] == f"{p['who']} started talking to example.org:443", new["title"])
            # "nothing else in the cluster talks to it", "1 other workload talks to it" or "N other … talk to it".
            check(f"{kind} its message", "first connection at" in new["why"]
                  and (new["why"].endswith("talks to it") or new["why"].endswith("talk to it")), new["why"])
            row = next((x for x in call("GET", f"/egress?{q()}")["rows"] if (x["destination"], x["port"]) == NAME), {})
            check(f"{kind} the row's View alert (alertId)", row.get("alertId") == new["id"], str(row.get("alertId")))
        if check(f"{kind} alert Raw IP egress for 1.1.1.0/24:443", bool(raw)):
            check(f"{kind} its title", raw["title"] == f"{p['who']} connects to 1.1.1.0/24:443 by IP address", raw["title"])
            check(f"{kind} its message", "connections in 10 min" in raw["why"] and "no DNS name behind it" in raw["why"], raw["why"])

        # 3. The cause: the change `up` made just before the first connection.
        if new:
            body = call("GET", "/causes?" + urllib.parse.urlencode({"cluster": cid, "subject": f"alert:{new['id']}"}))
            top = (body.get("causes") or [{}])[0]
            check(f"{kind} cause change_before_egress, likely",
                  top.get("rule", top.get("code")) == "change_before_egress" and top.get("strength") == "likely",
                  f"{top.get('rule', top.get('code'))} {top.get('strength')}, headline {body.get('headline', {}).get('code')}")

        # 4. The API with the token: the read is public, the write is not.
        s, b = call("GET", f"/egress?{q({'firstSeenAfter': started - 60})}", token=token, raw=True)
        dests = {(x["destination"], x["port"]) for x in (b or {}).get("rows", [])}
        check(f"{kind} GET /egress with a token and firstSeenAfter", s == 200 and {NAME, RAW} <= dests, f"{s} {sorted(dests)}")
        s, b = call("POST", "/egress/expected", {"cluster": cid, "pattern": "example.org", "port": 443, "source": p["source"]},
                    token=token, raw=True)
        check(f"{kind} POST /egress/expected with a token is refused", s == 403, f"{s}")

        # 5. MCP.
        for tool, args in (("get_egress", {"cluster": c["name"], **p["mcp"]}),
                           ("get_new_destinations", {"cluster": c["name"], **p["mcp"], "hours": 2})):
            text = mcp(tool, args)
            check(f"{kind} MCP {tool}", "example.org" in text and "1.1.1.0/24" in text, text[:200].replace("\n", " "))

        # 6. The policy suggestion (Kubernetes only, ADR-190).
        s, b = call("GET", "/egress/policy?" + urllib.parse.urlencode(
            {"cluster": cid, "workload": f"{ns}/Deployment/client" if kind == "kubernetes" else f"{project}/client"}), raw=True)
        if kind == "kubernetes":
            std = next((x for x in (b or {}).get("policies", []) if x["flavour"] == "kubernetes"), None)
            if check(f"{kind} GET /egress/policy has the standard flavour", s == 200 and bool(std), f"{s}"):
                check(f"{kind} the policy allows 1.1.1.0/24 and names example.org", "1.1.1.0/24" in std["yaml"] and "example.org" in std["yaml"])
                dry = subprocess.run(["limactl", "shell", vm, "bash", "-c",
                                      "export PATH=$HOME/bin:$PATH; kubectl --context kind-demo apply --dry-run=server -f -"],
                                     input=std["yaml"], capture_output=True, text=True)
                check(f"{kind} kubectl apply --dry-run=server", dry.returncode == 0 and "server dry run" in dry.stdout,
                      (dry.stdout + dry.stderr).strip()[:300])
        else:
            check(f"{kind} GET /egress/policy answers 404 with the reason",
                  s == 404 and "Docker has no egress policy object" in json.dumps(b), f"{s} {json.dumps(b)[:200]}")

        # 7. Marking expected resolves the New alert; Raw IP isn't silenced by it.
        if new:
            s, b = call("POST", "/egress/expected", {"cluster": cid, "pattern": "example.org", "port": 443, "source": p["source"],
                                                     "comment": f"egress-e2e {run}"}, raw=True)
            check(f"{kind} mark example.org:443 expected for the client", s in (201, 409), f"{s} {json.dumps(b)[:200]}")
            row = next((x for x in call("GET", f"/egress?{q()}")["rows"] if (x["destination"], x["port"]) == NAME), {})
            check(f"{kind} the row is Expected", "expected" in row.get("badges", []), str(row.get("badges")))
            gone = wait(lambda: call("GET", f"/alerts/{new['id']}")["alert"].get("resolvedAt"))
            check(f"{kind} the New alert resolved", bool(gone), str(gone))
            check(f"{kind} Raw IP still firing", bool(alert("egress.raw_ip", RAW)))
finally:
    call("DELETE", f"/api-tokens/{created['token']['id']}", raw=True)

print(f"\n{failures} failed" if failures else "\nall passed")
sys.exit(1 if failures else 0)
PY
}

cmd=${1:-}
case "$cmd" in
  up)
    old=$(run_id)
    [ -z "$old" ] || {
      echo "run $old is still up: egress-e2e.sh down first" >&2
      exit 1
    }
    run=$(date -u +%m%d%H%M)
    ns=egress-e2e-$run
    in_vm "mkdir -p $dir && echo $run > $dir/run"
    say "kind: namespace $ns, client idle"
    manifest "$ns" 0 | kc "apply -f - >/dev/null"
    say "Docker: Compose project $ns, client idle"
    compose_file "$ns" | in_vm "cat > $dir/compose.yaml"
    in_vm "docker pull -q busybox:1.37 >/dev/null; docker compose -f $dir/compose.yaml up -d 2>&1 | tail -n 1"
    kc "-n $ns rollout status deploy/client --timeout 180s >/dev/null"
    # The agents see the idle client first, so that the change below is the client's own.
    sleep 45
    say "the change: client starts dialling (kind: a rollout; Docker: a re-create)"
    in_vm "date +%s > $dir/started"
    manifest "$ns" 1 | kc "apply -f - >/dev/null"
    in_vm "DIAL=1 docker compose -f $dir/compose.yaml up -d 2>&1 | tail -n 1"
    kc "-n $ns rollout status deploy/client --timeout 180s >/dev/null"
    sleep 25
    kc "-n $ns logs deploy/client --tail 2"
    in_vm "docker logs --tail 2 $ns-client-1"
    echo "run $run up; check in a few minutes: WATCHLOG_URL=… egress-e2e.sh check"
    ;;
  check)
    : "${url:?set WATCHLOG_URL}"
    run=$(run_id)
    [ -n "$run" ] || {
      echo "no run is up: egress-e2e.sh up first" >&2
      exit 1
    }
    api "$run" "$(in_vm "cat $dir/started")"
    ;;
  down)
    run=$(run_id)
    if [ -n "$run" ]; then
      in_vm "kubectl --context kind-demo delete namespace egress-e2e-$run --ignore-not-found --wait=false >/dev/null
        docker compose -f $dir/compose.yaml down --remove-orphans >/dev/null 2>&1 || true"
    fi
    in_vm "rm -rf $dir"
    echo "removed${run:+ run $run}"
    ;;
  *)
    sed -n '3,51p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 2
    ;;
esac
