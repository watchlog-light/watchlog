#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Phase 2 acceptance against a cluster installed with `helm install` (SPEC §13).

Compares every P0 view's API answer with what kubectl reports, checks that metrics
arrive for nodes and pods, and measures how long a CrashLoopBackOff and an OOMKilled
pod take to appear in WatchLog (target: within 30 s).

  deploy/test/k8s/acceptance.py --context kind-watchlog --url http://localhost:8080 \
      --email admin@example.com --password '...'

Needs the test workloads (deploy/test/k8s/workloads.yaml) and python3 only.
Exit status 0 when every check passes.
"""
import argparse
import http.cookiejar
import json
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

TARGET_S = 30
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{f' — {detail}' if detail else ''}", flush=True)
    return ok


class Api:
    def __init__(self, url):
        self.base = url.rstrip("/") + "/api/v1"
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
        )

    def call(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None:
            req.add_header("content-type", "application/json")
        try:
            with self.opener.open(req, timeout=30) as res:
                raw = res.read()
                return res.status, json.loads(raw) if raw else None
        except urllib.error.HTTPError as err:
            return err.code, None

    def get(self, path):
        status, body = self.call("GET", path)
        if status != 200:
            raise RuntimeError(f"GET {path}: HTTP {status}")
        return body


def kubectl(ctx, *args, check_rc=True):
    out = subprocess.run(
        ["kubectl", "--context", ctx, *args], capture_output=True, text=True, check=False
    )
    if check_rc and out.returncode != 0:
        raise RuntimeError(f"kubectl {' '.join(args)}: {out.stderr.strip()}")
    return out.stdout


def kjson(ctx, *args):
    return json.loads(kubectl(ctx, *args, "-o", "json"))["items"]


def eventually(fetch, timeout=20):
    """Re-reads (kubectl, api) sets until they agree or the timeout passes."""
    deadline = time.time() + timeout
    while True:
        k, a = fetch()
        if k == a or time.time() > deadline:
            return k, a
        time.sleep(2)


def p0_views(api, ctx, cid, ns):
    nodes = {n["metadata"]["name"] for n in kjson(ctx, "get", "nodes")}
    api_nodes = api.get(f"/clusters/{cid}/nodes")["nodes"]
    check("nodes: same names as kubectl", {n["name"] for n in api_nodes} == nodes, f"{len(nodes)} nodes")
    check(
        "nodes: every node agent reports",
        all(n["agent"]["status"] == "active" for n in api_nodes),
        ", ".join(f"{n['name']}={n['agent']['status']}" for n in api_nodes),
    )
    check(
        "nodes: kubelet TLS reported (ADR-051)",
        all(n["agent"]["kubeletTls"] in ("verified", "unverified") for n in api_nodes),
        ", ".join(f"{n['name']}={n['agent']['kubeletTls']}" for n in api_nodes),
    )
    check(
        "nodes: allocatable and usage present",
        all(n["cpu"]["allocatableCores"] and n["cpu"]["usageCores"] is not None for n in api_nodes),
    )
    detail = api.get(f"/clusters/{cid}/nodes/{urllib.parse.quote(api_nodes[0]['name'])}")
    check("node detail: pods and conditions", detail["pods"] and detail["node"]["conditions"])

    ov = api.get(f"/clusters/{cid}/overview")
    # The overview's shape since ADR-110: KPIs, facts and one list of problems.
    kpi_nodes = {k: v for k, v in ov["kpis"]["nodes"].items() if k != "series"}
    check("overview: node tile matches", kpi_nodes["total"] == len(nodes), json.dumps(kpi_nodes))
    check("overview: cluster-agent active", ov["facts"]["clusterAgent"] == "active")
    cpu = ov["kpis"]["cpu"]
    check("overview: usage and requests", cpu["usage"] is not None and (cpu["requests"] or 0) > 0, json.dumps(cpu))
    # A problem comes from a firing alert (no object, the workload in the title) or
    # from the object itself.
    problems = [(p["type"], p["title"], (p["object"] or {}).get("name", "")) for p in ov["problems"]["items"]]
    check(
        "overview: crashloop is a problem",
        any(t == "crashloop" and (title.startswith("crashloop ") or name.startswith("crashloop"))
            for t, title, name in problems),
        json.dumps(problems),
    )

    # Pods and workloads: compare names (Job pods come and go every minute). Objects
    # arrive as 5 s deltas (ADR-055), so a fresh change may need a few seconds.
    def pod_sets():
        k = {
            f"{p['metadata']['namespace']}/{p['metadata']['name']}"
            for p in kjson(ctx, "get", "pods", "-A")
            if not any(o["kind"] == "Job" for o in p["metadata"].get("ownerReferences", []))
        }
        a = {
            f"{p['namespace']}/{p['name']}"
            for p in api.get(f"/clusters/{cid}/pods")["pods"]
            if p["workloadKind"] not in ("Job", "CronJob")
        }
        return k, a

    def workload_sets():
        k = set()
        for kind in ("deployments", "statefulsets", "daemonsets"):
            k |= {f"{w['metadata']['namespace']}/{w['metadata']['name']}" for w in kjson(ctx, "get", kind, "-A")}
        a = {
            f"{w['namespace']}/{w['name']}"
            for w in api.get(f"/clusters/{cid}/workloads")["workloads"]
            if w["kind"] in ("Deployment", "StatefulSet", "DaemonSet")
        }
        return k, a

    kpods, apods = eventually(pod_sets)
    check("pods: same as kubectl", kpods == apods, f"{len(kpods)} pods; missing {sorted(kpods - apods)[:5]}, extra {sorted(apods - kpods)[:5]}")
    kw, aw = eventually(workload_sets)
    check("workloads: same as kubectl", kw == aw, f"{len(kw)} workloads")
    web = next((w for w in api.get(f"/clusters/{cid}/workloads?namespaces={ns}")["workloads"] if w["name"] == "web"), None)
    check("workloads: web ready and using CPU", web and web["ready"] == web["desired"] and web["cpuCores"] is not None)

    # The OOM test pod: WatchLog must show the termination Kubernetes reports
    # (containerd on kind reports some OOM kills as Error/137).
    def oom_pair():
        p = api.get(f"/clusters/{cid}/pods/{ns}/oom")
        t = p["pod"]["lastTermination"]
        return k8s_termination(ctx, ns, "oom"), (t["reason"], t["exitCode"]) if t else None

    want, got = eventually(oom_pair)
    check(
        "pod detail: oom pod's termination as Kubernetes reports it",
        got == want and got is not None and got[1] == 137,
        f"Kubernetes {want}, WatchLog {got}",
    )
    pod = api.get(f"/clusters/{cid}/pods/{ns}/oom")
    check("pod detail: events", len(pod["events"]) > 0)

    knss = {n["metadata"]["name"] for n in kjson(ctx, "get", "namespaces")}
    check("namespaces: same as kubectl", {n["name"] for n in api.get(f"/clusters/{cid}/namespaces")["namespaces"]} == knss)
    ev = api.get(f"/clusters/{cid}/events?type=Warning&limit=5")
    check("events: Warning events stored", len(ev["events"]) > 0)
    now = int(time.time())
    mk = api.get(f"/clusters/{cid}/change-markers?from={now - 86400}&to={now}")
    check("change markers endpoint answers", "markers" in mk, f"{len(mk['markers'])} in 24 h")

    for metric, scope in (("pod.cpu.usage", {"namespace": ns}), ("node.cpu.utilization", {}), ("pod.container.memory.working_set", {"namespace": ns, "pod": "besteffort"})):
        status, res = api.call("POST", "/query/range", {"clusterId": cid, "metric": metric, "scope": scope, "from": now - 600, "to": now})
        check(f"metrics: {metric}", status == 200 and res["series"], f"{len(res['series']) if res else 0} series")


POD = """{{"apiVersion": "v1", "kind": "Pod",
 "metadata": {{"name": "{name}", "namespace": "{ns}", "labels": {{"app.kubernetes.io/part-of": "watchlog-acceptance"}}}},
 "spec": {{"restartPolicy": "Always", "containers": [{{"name": "main", "image": "busybox:1.37",
   "command": ["sh", "-c", "{cmd}"]{limits}}}]}}}}"""


def k8s_termination(ctx, ns, name):
    out = kubectl(ctx, "-n", ns, "get", "pod", name, "-o", "json", check_rc=False)
    if not out:
        return None
    for c in json.loads(out)["status"].get("containerStatuses", []):
        t = (c.get("state", {}).get("terminated") or c.get("lastState", {}).get("terminated"))
        if t:
            return t.get("reason"), t.get("exitCode")
    return None


def api_termination(api, cid, ns, name):
    status, body = api.call("GET", f"/clusters/{cid}/pods/{ns}/{name}")
    if status != 200:
        return None
    t = body["pod"]["lastTermination"]
    return (t["reason"], t["exitCode"]) if t else None


def termination_timing(api, ctx, cid, ns):
    """Creates a crashing and an OOM-killed pod and times how long WatchLog takes to show
    the termination Kubernetes reports (reason and exit code)."""
    suffix = str(int(time.time()))[-6:]
    crash, oom = f"wl-acc-crash-{suffix}", f"wl-acc-oom-{suffix}"
    # Accepted (reason, exit code) per pod. containerd sometimes reports an OOM kill
    # as Error/137 (measured on kind); WatchLog must then show the same.
    pods = {
        crash: (POD.format(name=crash, ns=ns, cmd="sleep 2; exit 1", limits=""), {("Error", 1)}, "CrashLoopBackOff (Error, exit 1)"),
        oom: (
            POD.format(name=oom, ns=ns, cmd="sleep 3; tail /dev/zero",
                       limits=', "resources": {"limits": {"memory": "32Mi"}}'),
            {("OOMKilled", 137), ("Error", 137)},
            "OOMKilled (exit 137)",
        ),
    }
    t0 = time.time()
    for manifest, _, _ in pods.values():
        subprocess.run(["kubectl", "--context", ctx, "apply", "-f", "-"], input=manifest, text=True,
                       capture_output=True, check=True)
    k8s, seen = {}, {}
    while time.time() - t0 < 180 and len(seen) < len(pods):
        for name in pods:
            if name not in k8s:
                t = k8s_termination(ctx, ns, name)
                if t:
                    k8s[name] = (t, time.time())
            if name in k8s and name not in seen and api_termination(api, cid, ns, name) == k8s[name][0]:
                seen[name] = time.time()
        time.sleep(0.5)
    for name, (_, accepted, label) in pods.items():
        if name not in k8s:
            check(f"{label}: Kubernetes reports a termination", False, "none within 180 s")
            continue
        (reason, code), at = k8s[name]
        check(f"{label}: Kubernetes reports {reason} (exit {code})", (reason, code) in accepted,
              "containerd reported the OOM kill as Error/137" if (reason, code) == ("Error", 137) else "")
        if name not in seen:
            check(f"{label} appears in WatchLog", False, "not within 180 s")
            continue
        lag = seen[name] - at
        check(
            f"{label} appears within {TARGET_S} s of Kubernetes",
            lag <= TARGET_S,
            f"Kubernetes after {at - t0:.1f} s, WatchLog after {seen[name] - t0:.1f} s (lag {lag:.1f} s)",
        )
    kubectl(ctx, "-n", ns, "delete", "pod", *pods, "--wait=false", check_rc=False)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--context", required=True)
    ap.add_argument("--url", required=True, help="WatchLog base URL (web service)")
    ap.add_argument("--email", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--namespace", default="wl-test", help="namespace of the test workloads")
    args = ap.parse_args()

    api = Api(args.url)
    status, _ = api.call("POST", "/auth/login", {"email": args.email, "password": args.password})
    if status != 200:
        sys.exit(f"login failed: HTTP {status}")
    cluster = next((c for c in api.get("/clusters")["clusters"] if c["kind"] == "kubernetes"), None)
    if not check("a Kubernetes cluster is registered (helm bootstrap)", cluster):
        sys.exit(1)
    check("cluster node count", cluster["nodeCount"] == len(kjson(args.context, "get", "nodes")), str(cluster["nodeCount"]))
    p0_views(api, args.context, cluster["id"], args.namespace)
    termination_timing(api, args.context, cluster["id"], args.namespace)

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
