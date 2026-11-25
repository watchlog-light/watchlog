// SPDX-License-Identifier: AGPL-3.0-only
// What an own-metric series belongs to (1.0.0, ADR-236): a workload of a Kubernetes cluster or a
// server of a fleet, where WatchLog knows it; "Not tied to anything" otherwise, and still usable.
//
//   scrape        the scraped pod's owner, or the server that was scraped (targets.ts);
//   remote write  the series' `namespace` and `pod` labels matched to a pod WatchLog knows (its
//                 workload); on a fleet, its `instance`, `host`, `hostname`, `server` or `node`
//                 label matched to a server's name;
//   push          the push's own field: `workload` ("namespace/name") or `server`.
//
// A cluster's pods, workloads and servers are read once a minute, never per series.
import type { Database } from '../../db/index.js';
import { NO_OWNER, type Owner } from './service.js';

interface Known {
  at: number;
  kind: 'kubernetes' | 'server';
  /** "namespace/pod" → its workload */
  pods: Map<string, { kind: string; name: string }>;
  /** "namespace/name" → the workload's kind */
  workloads: Map<string, string>;
  servers: Set<string>;
}

const WORKLOAD_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Job'];
const TTL_MS = 60_000;
/** Labels that may name the server a series is about, in the order they are tried. */
const SERVER_LABELS = ['server', 'host', 'hostname', 'node', 'instance'] as const;

export class Belonging {
  private readonly clusters = new Map<string, Known>();

  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  /** Forgets a cluster's lists (tests, and after its objects changed in one). */
  forget(clusterId?: string): void {
    if (clusterId) this.clusters.delete(clusterId);
    else this.clusters.clear();
  }

  async known(clusterId: string): Promise<Known> {
    const hit = this.clusters.get(clusterId);
    if (hit && this.now() - hit.at < TTL_MS) return hit;
    const { db } = this;
    const cluster = await db
      .selectFrom('clusters')
      .select('kind')
      .where('id', '=', clusterId)
      .executeTakeFirst();
    const k: Known = {
      at: this.now(),
      kind: cluster?.kind === 'server' ? 'server' : 'kubernetes',
      pods: new Map(),
      workloads: new Map(),
      servers: new Set(),
    };
    if (k.kind === 'kubernetes') {
      const rows = await db
        .selectFrom('objects')
        .select(['kind', 'namespace', 'name', 'spec_summary'])
        .where('cluster_id', '=', clusterId)
        .where('deleted_at', 'is', null)
        .where('kind', 'in', ['Pod', ...WORKLOAD_KINDS])
        .execute();
      for (const r of rows) {
        if (r.kind === 'Pod') {
          const w = (r.spec_summary as { workload?: { kind?: string; name?: string } }).workload;
          if (w?.kind && w.name)
            k.pods.set(`${r.namespace}/${r.name}`, { kind: w.kind, name: w.name });
        } else {
          // A Job owned by a CronJob is the CronJob's; a Deployment wins over what it owns.
          const key = `${r.namespace}/${r.name}`;
          if (!k.workloads.has(key) || r.kind !== 'Job') k.workloads.set(key, r.kind);
        }
      }
    } else {
      const rows = await db
        .selectFrom('agent_instances')
        .select('node')
        .where('cluster_id', '=', clusterId)
        .where('mode', '=', 'docker')
        .execute();
      for (const r of rows) k.servers.add(r.node);
    }
    this.clusters.set(clusterId, k);
    return k;
  }

  /** Remote write: from the series' own labels. */
  fromLabels(k: Known, labels: Readonly<Record<string, string>>): Owner {
    if (k.kind === 'kubernetes') {
      const ns = labels.namespace ?? labels.kubernetes_namespace ?? '';
      const pod = labels.pod ?? labels.kubernetes_pod_name ?? labels.pod_name ?? '';
      const w = ns && pod ? k.pods.get(`${ns}/${pod}`) : undefined;
      return w ? { kind: 'workload', namespace: ns, workloadKind: w.kind, name: w.name } : NO_OWNER;
    }
    for (const l of SERVER_LABELS) {
      const v = labels[l];
      if (!v) continue;
      // "db-1:9100" names db-1; a server's name with a colon is tried whole first.
      const name = k.servers.has(v) ? v : v.replace(/:\d+$/, '');
      if (k.servers.has(name)) return { ...NO_OWNER, kind: 'server', name };
    }
    return NO_OWNER;
  }

  /** A push's field: `workload` as "namespace/name" on a cluster, `server` on a fleet. */
  fromPush(k: Known, to: { workload?: string; server?: string } | undefined): Owner {
    if (!to) return NO_OWNER;
    if (k.kind === 'kubernetes' && to.workload) {
      const kind = k.workloads.get(to.workload);
      const slash = to.workload.indexOf('/');
      if (kind && slash > 0)
        return {
          kind: 'workload',
          namespace: to.workload.slice(0, slash),
          workloadKind: kind,
          name: to.workload.slice(slash + 1),
        };
    }
    if (k.kind === 'server' && to.server && k.servers.has(to.server))
      return { ...NO_OWNER, kind: 'server', name: to.server };
    return NO_OWNER;
  }
}
