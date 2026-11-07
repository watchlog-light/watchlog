#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Host isolation checks on kind (ADR-121), run by isolation-test.sh.

The kind nodes are containers limited to --cpus and --memory on a machine that also runs
processes and a plain Docker container making TCP connections and DNS lookups. Nothing
of that machine may appear in WatchLog:

1. Network: no edge, source, destination or DNS row from the outsiders; the agents' pod
   filter is on and its counters grow; the demo app's edges are there.
2. Nodes: capacity is the node containers' limits; no host disk, device, interface or
   filesystem size, no host boot time and no host name in the node API or the node series.
"""
import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request

from acceptance import Api, check, kubectl, results


def vm_query(url, expr):
    q = urllib.parse.urlencode({"query": expr})
    with urllib.request.urlopen(f"{url}/api/v1/query?{q}", timeout=30) as res:
        return json.load(res)["data"]["result"]


def vm_series(url, match):
    q = urllib.parse.urlencode({"match[]": match, "start": int(time.time()) - 600})
    with urllib.request.urlopen(f"{url}/api/v1/series?{q}", timeout=30) as res:
        return json.load(res)["data"]


def total(url, expr):
    r = vm_query(url, expr)
    return float(r[0]["value"][1]) if r else 0.0


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--context", required=True)
    ap.add_argument("--url", required=True, help="WatchLog web, port-forwarded")
    ap.add_argument("--vm-url", required=True, help="VictoriaMetrics, port-forwarded")
    ap.add_argument("--email", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--demo-ns", required=True)
    ap.add_argument("--cpus", type=float, required=True)
    ap.add_argument("--memory-bytes", type=float, required=True)
    ap.add_argument("--outsider-port", required=True, type=int)
    ap.add_argument("--forbidden", required=True,
                    help="comma-separated strings that must not appear: host IPs, networks, "
                         "interface and device names, the host name")
    ap.add_argument("--node-starts", required=True, help="JSON {node: unix start}")
    ap.add_argument("--host-boot", type=float, required=True)
    ap.add_argument("--node-ifaces", required=True, help="comma-separated interfaces of the nodes")
    args = ap.parse_args()
    forbidden = [f for f in args.forbidden.split(",") if f]
    node_starts = json.loads(args.node_starts)
    node_ifaces = set(args.node_ifaces.split(","))

    api = Api(args.url)
    if api.call("POST", "/auth/login", {"email": args.email, "password": args.password})[0] != 200:
        sys.exit("login failed")
    cluster = next(c for c in api.get("/clusters")["clusters"] if c["kind"] == "kubernetes")
    cid = cluster["id"]

    # Whole words only: a pod's random suffix may contain "vda".
    # A prefix ending in "." (a network) matches any address in it.
    patterns = [(f, re.compile(r"(?<![A-Za-z0-9.])" + re.escape(f)
                               + (r"(?![A-Za-z0-9])" if f[-1].isalnum() else ""))) for f in forbidden]

    def leaks(doc):
        text = json.dumps(doc)
        return [f for f, p in patterns if p.search(text)]

    # 1 · Network.
    before = (total(args.vm_url, "sum(watchlog_agent_flow_filtered_connections_total)"),
              total(args.vm_url, "sum(watchlog_agent_dns_filtered_queries_total)"),
              total(args.vm_url, "sum(watchlog_agent_flow_unattributed_connections_total)"))
    time.sleep(45)
    after = (total(args.vm_url, "sum(watchlog_agent_flow_filtered_connections_total)"),
             total(args.vm_url, "sum(watchlog_agent_dns_filtered_queries_total)"),
             total(args.vm_url, "sum(watchlog_agent_flow_unattributed_connections_total)"))
    grown = [a - b for a, b in zip(after, before)]
    on = vm_query(args.vm_url, "watchlog_agent_flow_pod_filter")
    nodes = sorted(node_starts)
    check("the pod filter is on in every node agent",
          sorted(r["metric"].get("node", "") for r in on if r["value"][1] == "1") == nodes,
          str({r["metric"].get("node"): r["value"][1] for r in on}))
    check("the kernel filters the outsiders' connections (counter grows)", grown[0] > 100,
          f"+{grown[0]:.0f} in 45 s")
    check("the kernel filters the outsiders' DNS queries (counter grows)", grown[1] > 20,
          f"+{grown[1]:.0f} in 45 s")
    check("almost nothing reaches user space unattributed", grown[2] <= max(10, grown[0] / 100),
          f"+{grown[2]:.0f} unattributed vs +{grown[0]:.0f} filtered")

    m = api.get(f"/clusters/{cid}/service-map?range=600")
    check("eBPF is enabled on every node agent",
          sorted(a["node"] for a in m["agents"] if a["ebpf"] == "enabled") == nodes,
          ", ".join(f"{a['node']}: {a['ebpf']}" for a in m["agents"]))
    namespaces = set(kubectl(args.context, "get", "namespaces", "-o",
                             "jsonpath={.items[*].metadata.name}").split())
    bad_src = sorted({e["source"] for e in m["edges"]
                      if not e["source"].startswith("w:") or e["source"][2:].split("/")[0] not in namespaces})
    check("every edge starts at a workload of the cluster", not bad_src, str(bad_src))
    check("no edge to the outsiders' port", not [e for e in m["edges"] if e["port"] == args.outsider_port])
    check("no node, edge or DNS row names a host address, network or name", not leaks(m), str(leaks(m)))
    bad_dns = sorted(d["node"] for d in m["dns"] if not d["node"].startswith("w:"))
    check("DNS rows are workloads only", not bad_dns, str(bad_dns))
    ns = args.demo_ns
    want = {(f"w:{ns}/Deployment/loadgen", f"w:{ns}/Deployment/frontend", 9898),
            (f"w:{ns}/Deployment/frontend", f"w:{ns}/Deployment/cart", 9898),
            (f"w:{ns}/Deployment/cart", f"w:{ns}/Deployment/catalog", 9898)}
    got = {(e["source"], e["target"], e["port"]) for e in m["edges"]}
    check("the demo app's edges are on the map", want <= got, str(sorted(want - got)))
    flow_series = vm_series(args.vm_url, "watchlog_flow_connections_total")
    check("every flow series has a source namespace", all(s.get("namespace") for s in flow_series),
          str([s for s in flow_series if not s.get("namespace")][:3]))
    check("no flow series names a host address", not leaks(flow_series), str(leaks(flow_series)))

    # 2 · Nodes.
    listed = api.get(f"/clusters/{cid}/nodes?range=900")["nodes"]
    check("the nodes are the kind node containers", sorted(n["name"] for n in listed) == nodes,
          str([n["name"] for n in listed]))
    for n in listed:
        name = n["name"]
        check(f"{name}: CPU capacity is the container's {args.cpus:g}",
              n["cpu"]["allocatableCores"] == args.cpus, str(n["cpu"]))
        check(f"{name}: memory capacity is the container's {args.memory_bytes / 2**30:g} GiB",
              n["memory"]["allocatableBytes"] == args.memory_bytes, str(n["memory"]))
        usage = n["cpu"]["usageCores"]
        check(f"{name}: CPU usage within the limit", usage is not None and usage <= args.cpus * 1.05,
              str(usage))
        check(f"{name}: no host filesystem", n["disks"] == [] and n["diskUtilization"] is None,
              str(n["disks"]))
        boot = n["bootTime"]
        check(f"{name}: boot time is the node container's start",
              boot is not None and abs(boot - node_starts[name]) <= 5 and abs(boot - args.host_boot) > 60,
              f"{boot} vs container {node_starts[name]}, host {args.host_boot}")
        detail = api.get(f"/clusters/{cid}/nodes/{name}")
        check(f"{name}: detail capacity matches",
              detail["node"]["cpu"]["allocatableCores"] == args.cpus
              and detail["node"]["memory"]["allocatableBytes"] == args.memory_bytes)
        check(f"{name}: no host name, address, device or interface in the node API",
              not leaks(n) and not leaks(detail), str(leaks(n) + leaks(detail)))
    o = api.get(f"/clusters/{cid}/overview")
    check("overview: CPU and memory totals are the containers' limits",
          o["kpis"]["cpu"]["allocatable"] == args.cpus * len(nodes)
          and o["kpis"]["memory"]["allocatable"] == args.memory_bytes * len(nodes),
          f"{o['kpis']['cpu']['allocatable']} cores, {o['kpis']['memory']['allocatable']} bytes")

    node_series = vm_series(args.vm_url, '{__name__=~"watchlog_node_.*"}')
    names = {s["__name__"] for s in node_series}
    check("no load average, no filesystem series",
          not names & {"watchlog_node_load1", "watchlog_node_load5", "watchlog_node_load15",
                       "watchlog_node_filesystem_bytes"}, str(sorted(names)))
    devs = {s.get("dev") for s in node_series if s["__name__"] == "watchlog_node_disk_io_bytes_total"}
    check("disk I/O without device names", devs == {"all"}, str(devs))
    ifaces = {s.get("iface") for s in node_series if s["__name__"] == "watchlog_node_network_bytes_total"}
    check("network interfaces are the nodes' own", ifaces and ifaces <= node_ifaces, str(ifaces))
    check("no node series names a host device, interface or address", not leaks(node_series),
          str(leaks(node_series)))

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
