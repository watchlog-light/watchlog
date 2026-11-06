#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Phase 4 acceptance on kind: the service map of the demo app (SPEC §13).

1. The demo app (deploy/test/k8s/demo/demo.yaml) is created from scratch; the map
   must show its edges within 2 minutes of the pods being ready.
2. Scaling a dependency (catalog) to 0 must show failed connections on the map and
   fire the failed-connections default rule; scaling it back resolves the alert.

Usage: servicemap-acceptance.py --context kind-watchlog --url http://127.0.0.1:18080 \
         --email admin@example.com --password ...
"""
import argparse
import os
import subprocess
import sys
import time

from acceptance import Api, check, kubectl, results

# A fresh namespace per run: edges of an earlier run would otherwise still be in the
# map's range and appear at once.
NS = f"wl-demo-{int(time.time()) % 100000}"
DEMO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "demo", "demo.yaml")


def W(kind, name):
    return f"w:{NS}/{kind}/{name}"


EXPECTED = {
    (W("Deployment", "loadgen"), W("Deployment", "frontend"), 9898),
    (W("Deployment", "frontend"), W("Deployment", "cart"), 9898),
    (W("Deployment", "cart"), W("Deployment", "catalog"), 9898),
    (W("Deployment", "orders"), W("StatefulSet", "postgres"), 5432),
    (W("Deployment", "sessions"), W("Deployment", "redis"), 6379),
}
RULE = "network.connections.failed"


def poll(fn, timeout, every=5):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = fn()
        if value:
            return value
        time.sleep(every)
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--context", required=True)
    ap.add_argument("--url", required=True)
    ap.add_argument("--email", required=True)
    ap.add_argument("--password", required=True)
    args = ap.parse_args()
    ctx = args.context

    api = Api(args.url)
    if api.call("POST", "/auth/login", {"email": args.email, "password": args.password})[0] != 200:
        sys.exit("login failed")
    cluster = next(c for c in api.get("/clusters")["clusters"] if c["kind"] == "kubernetes")
    path = f"/clusters/{cluster['id']}/service-map?range=600&namespaces={NS}"

    first = api.get(path)
    enabled = [a["node"] for a in first["agents"] if a["ebpf"] == "enabled"]
    check("eBPF is enabled on every node agent", len(enabled) == len(first["agents"]) > 0,
          ", ".join(f"{a['node']}: {a['ebpf']} {a['reason'] or ''}" for a in first["agents"]))

    # 1 · Correct edges within 2 minutes of a fresh demo app.
    for old in kubectl(ctx, "get", "namespaces", "-o", "name").split():
        if old.startswith("namespace/wl-demo"):
            kubectl(ctx, "delete", old, "--wait=false")
    manifest = open(DEMO, encoding="utf-8").read().replace("wl-demo", NS)
    subprocess.run(["kubectl", "--context", ctx, "apply", "-f", "-"], input=manifest, text=True,
                   check=True, capture_output=True)
    print(f"demo app in namespace {NS}", flush=True)
    kubectl(ctx, "-n", NS, "wait", "--for=condition=Ready", "pods", "--all", "--timeout=300s")
    ready = time.time()

    def edges_now():
        m = api.get(path)
        return {(e["source"], e["target"], e["port"]): e for e in m["edges"]}

    def all_expected():
        now = edges_now()
        return now if EXPECTED <= set(now) else None

    got = poll(all_expected, 180)
    took = time.time() - ready
    check("the map shows the demo app's 5 edges", got is not None,
          f"after {took:.0f} s" if got else f"missing {sorted(EXPECTED - set(edges_now()))}")
    check("edges appear within 2 minutes of the pods being ready", got is not None and took <= 120, f"{took:.0f} s")
    if got:
        extra = sorted(k for k in got if k not in EXPECTED and k[0].startswith(f"w:{NS}/"))
        check("no edges the demo app does not make", not extra, str(extra))
        # A fresh edge has one sample of its counters, so no rate yet, and reads "idle"
        # until the next 15 s drain. Connections refused while a dependency was still
        # starting are real and on the right edge (ADR-116); an edge counts as failing
        # only while it had failures in the last minute, so it recovers about a minute
        # after the dependency is up, though its 5-minute share still shows them.
        settled = poll(lambda: (lambda now: now if all(now.get(k, {}).get("health") == "ok" for k in EXPECTED)
                                else None)(edges_now()), 150, every=10) or edges_now()
        check("all demo edges are healthy", all(settled.get(k, {}).get("health") == "ok" for k in EXPECTED),
              str({k: settled.get(k, {}).get("health") for k in EXPECTED}))
        via = got[(W("Deployment", "frontend"), W("Deployment", "cart"), 9898)]
        check("ClusterIP connections are attributed through their Service", via["service"] == "cart", str(via))

    # 2 · A dependency scaled to 0: failed connections and the default rule.
    kubectl(ctx, "-n", NS, "scale", "deploy/catalog", "--replicas=0")
    down = time.time()

    def failing():
        for (src, dst, port), e in edges_now().items():
            if src == W("Deployment", "cart") and "catalog" in dst and port == 9898 \
                    and e["health"] == "critical" and (e["failedRatio"] or 0) > 0.05:
                return e
        return None

    e = poll(failing, 180)
    check("the map shows cart's connections to catalog failing", e is not None,
          f"{(e['failedRatio'] or 0) * 100:.0f}% failed after {time.time() - down:.0f} s" if e else "not within 3 min")

    def fired():
        for a in api.get("/alerts")["alerts"]:
            if a["rule"]["key"] == RULE and a["state"] == "firing" and a["labels"].get("workload") == "cart":
                return a
        return None

    alert = poll(fired, 600, every=15)
    check("the failed-connections rule fires", alert is not None,
          f"{alert['title']!r} after {time.time() - down:.0f} s (rule duration 5 min)" if alert else "not within 10 min")

    kubectl(ctx, "-n", NS, "scale", "deploy/catalog", "--replicas=1")
    if alert:
        up = time.time()

        def resolved():
            status, body = api.call("GET", f"/alerts/{alert['id']}")
            return body if status == 200 and body["alert"]["state"] == "resolved" else None

        r = poll(resolved, 600, every=15)
        check("the alert resolves when catalog is back", r is not None,
              f"after {time.time() - up:.0f} s" if r else "not within 10 min")

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n{passed}/{len(results)} checks passed")
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
