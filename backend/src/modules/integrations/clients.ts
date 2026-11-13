// SPDX-License-Identifier: AGPL-3.0-only
// Discovery's client check (ADR-132): a pod or container that runs a server's image only for
// its command-line client (mysql, mongosh, psql, redis-cli, Kafka's scripts) isn't a service.
// The image can't tell, so the eBPF flows do: it connects out to the type's port and nothing
// connects to it there. A port it declares (Kubernetes) or publishes (Docker) means it
// listens, so it is never hidden; without flows (no eBPF, or no traffic yet) nothing is.
import type { ClusterScope, QuerySeries, VictoriaQueryClient } from '../../lib/victoria.js';

/** A day: a daily job's connections, and a client's that it holds open (bytes). */
export const CLIENT_WINDOW = '24h';

/** Who connected out on which port, and who was reached on which, as `who|port`. */
export interface FlowSides {
  out: Set<string>;
  in: Set<string>;
}

/** A Kubernetes workload or a Docker container, as both ends of a flow name it. */
export const workloadKey = (namespace: string, kind: string, name: string) =>
  `w:${namespace}/${kind}/${name}`;
export const containerKey = (name: string) => `c:${name}`;

/** The two instant queries: connections out on the ports, and established ones in. */
export function flowQueries(ports: number[]): { out: string; in: string } {
  const p = `dst_port=~"${[...new Set(ports)].sort((a, b) => a - b).join('|')}"`;
  return {
    // Connects, failed ones too, or bytes on connections it holds open.
    out: `(sum by (namespace, workload_kind, workload, container, dst_port) (increase(watchlog_flow_connections_total{${p}}[${CLIENT_WINDOW}])) > 0) or (sum by (namespace, workload_kind, workload, container, dst_port) (increase(watchlog_flow_bytes_total{${p}}[${CLIENT_WINDOW}])) > 0)`,
    // Established connections, or bytes on older ones (keep-alive): something answered.
    in: `(sum by (dst_kind, dst_namespace, dst_workload_kind, dst_workload, dst, dst_port) (increase(watchlog_flow_connect_latency_seconds_count{${p}}[${CLIENT_WINDOW}])) > 0) or (sum by (dst_kind, dst_namespace, dst_workload_kind, dst_workload, dst, dst_port) (increase(watchlog_flow_bytes_total{${p}}[${CLIENT_WINDOW}])) > 0)`,
  };
}

/** Reads the two answers into the sets `looksLikeClient` checks. */
export function flowSides(out: QuerySeries[], inbound: QuerySeries[]): FlowSides {
  const sides: FlowSides = { out: new Set(), in: new Set() };
  for (const { labels: l } of out) {
    if (!l.dst_port) continue;
    if (l.workload && l.workload_kind && l.namespace)
      sides.out.add(`${workloadKey(l.namespace, l.workload_kind, l.workload)}|${l.dst_port}`);
    else if (l.container) sides.out.add(`${containerKey(l.container)}|${l.dst_port}`);
  }
  for (const { labels: l } of inbound) {
    if (!l.dst_port) continue;
    if (l.dst_kind === 'workload' && l.dst_namespace && l.dst_workload_kind && l.dst_workload)
      sides.in.add(
        `${workloadKey(l.dst_namespace, l.dst_workload_kind, l.dst_workload)}|${l.dst_port}`,
      );
    else if (l.dst_kind === 'container' && l.dst)
      sides.in.add(`${containerKey(l.dst)}|${l.dst_port}`);
  }
  return sides;
}

/**
 * It connected out on one of the type's ports, and no connection reached it on any of them.
 * `listens` are the ports it declares or publishes: any of the type's there keeps it.
 */
export function looksLikeClient(
  sides: FlowSides,
  who: string,
  ports: number[],
  listens: number[],
): boolean {
  if (ports.some((p) => listens.includes(p))) return false;
  return (
    ports.some((p) => sides.out.has(`${who}|${p}`)) &&
    !ports.some((p) => sides.in.has(`${who}|${p}`))
  );
}

/** The flows of each cluster; a cluster whose query fails gets none (nothing hidden). */
export async function clusterFlows(
  vm: VictoriaQueryClient,
  clusters: ClusterScope[],
  ports: number[],
): Promise<Map<string, FlowSides>> {
  const q = flowQueries(ports);
  const all = await Promise.all(
    clusters.map(async (scope) => {
      try {
        const [o, i] = await Promise.all([vm.query(scope, q.out), vm.query(scope, q.in)]);
        return [scope.clusterId, flowSides(o, i)] as const;
      } catch {
        return null;
      }
    }),
  );
  return new Map(all.flatMap((e) => (e ? [e] : [])));
}
