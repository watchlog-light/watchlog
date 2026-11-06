#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Measures the delay from a Service's creation to a correct edge on the map (ADR-116).

Per round, in a fresh namespace: a server (podinfo) and a client that calls the
Service by name every second start first, with no Service, so the client's lookups
fail. Then the Service is created (t0). Each second the map is read until the edge
client → server's workload, through the Service, appears. Every other edge from the
client seen meanwhile is reported: an external named under svc.<cluster domain> or a
bare Service node means the destination was misclassified.

The delay includes the client's next call, the agent's drain (15 s), remote write and
the query; the part this measures is whether the first edge drawn is already right.

Usage: servicemap-latency.py --context kind-watchlog-e2e --url http://127.0.0.1:18080 \
         --email admin@example.com --password ... [--rounds 3]
Exit 1 if any round drew a wrong edge or none within 3 minutes.
"""
import argparse
import statistics
import subprocess
import sys
import time

from acceptance import Api, kubectl

MANIFEST = """
apiVersion: v1
kind: Namespace
metadata: {{name: {ns}}}
---
apiVersion: apps/v1
kind: Deployment
metadata: {{name: server, namespace: {ns}}}
spec:
  replicas: 1
  selector: {{matchLabels: {{app: server}}}}
  template:
    metadata: {{labels: {{app: server}}}}
    spec:
      containers:
        - name: podinfo
          image: ghcr.io/stefanprodan/podinfo:6.16.0
          command: [./podinfo, --port=9898]
          readinessProbe: {{httpGet: {{path: /readyz, port: 9898}}, periodSeconds: 2}}
---
apiVersion: apps/v1
kind: Deployment
metadata: {{name: client, namespace: {ns}}}
spec:
  replicas: 1
  selector: {{matchLabels: {{app: client}}}}
  template:
    metadata: {{labels: {{app: client}}}}
    spec:
      containers:
        - name: client
          image: busybox:latest
          command: [sh, -c, "while true; do wget -q -T 2 -O /dev/null http://server:9898/ 2>/dev/null; sleep 1; done"]
"""

SERVICE = """
apiVersion: v1
kind: Service
metadata: {{name: server, namespace: {ns}}}
spec:
  selector: {{app: server}}
  ports: [{{port: 9898, targetPort: 9898}}]
"""


def apply(ctx, text):
    subprocess.run(["kubectl", "--context", ctx, "apply", "-f", "-"], input=text, text=True,
                   check=True, capture_output=True)


def one_round(api, ctx, path_for, n):
    ns = f"wl-lat-{int(time.time()) % 100000}-{n}"
    apply(ctx, MANIFEST.format(ns=ns))
    kubectl(ctx, "-n", ns, "wait", "--for=condition=Available", "deploy/server", "deploy/client", "--timeout=300s")
    client = f"w:{ns}/Deployment/client"
    want = (client, f"w:{ns}/Deployment/server", 9898)
    apply(ctx, SERVICE.format(ns=ns))
    t0 = time.time()
    wrong = set()
    took = None
    while time.time() - t0 < 180:
        m = api.get(path_for(ns))
        for e in m["edges"]:
            key = (e["source"], e["target"], e["port"])
            if e["source"] != client:
                continue
            if key == want and e.get("service") == "server":
                took = time.time() - t0
            elif key != want:
                wrong.add(e["target"])
        if took is not None:
            break
        time.sleep(1)
    kubectl(ctx, "delete", "namespace", ns, "--wait=false")
    return took, sorted(wrong)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--context", required=True)
    ap.add_argument("--url", required=True)
    ap.add_argument("--email", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--rounds", type=int, default=3)
    args = ap.parse_args()
    api = Api(args.url)
    if api.call("POST", "/auth/login", {"email": args.email, "password": args.password})[0] != 200:
        sys.exit("login failed")
    cluster = next(c for c in api.get("/clusters")["clusters"] if c["kind"] == "kubernetes")

    def path_for(ns):
        return f"/clusters/{cluster['id']}/service-map?range=600&namespaces={ns}"

    delays, failed = [], False
    for n in range(args.rounds):
        took, wrong = one_round(api, args.context, path_for, n)
        status = f"{took:.0f} s" if took is not None else "no correct edge within 3 min"
        print(f"round {n + 1}: Service created → correct edge: {status}; wrong edges: {wrong or 'none'}", flush=True)
        if took is None or wrong:
            failed = True
        if took is not None:
            delays.append(took)
    if delays:
        print(f"delay: min {min(delays):.0f} s, median {statistics.median(delays):.0f} s, max {max(delays):.0f} s")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
