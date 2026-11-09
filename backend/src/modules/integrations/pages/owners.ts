// SPDX-License-Identifier: AGPL-3.0-only
// Who an address belongs to (SPEC §4.12): a service's clients and slow commands come
// with the client's IP; the pages name the workload or container behind it, from the
// objects the agents report (pod IPs on Kubernetes, container IPs on Docker).
import type { Database } from '../../../db/index.js';

export interface Owner {
  kind: 'workload' | 'container';
  /** "namespace/workload" on Kubernetes; the container name on Docker. */
  name: string;
}

export async function ipOwners(db: Database, clusterId: string): Promise<Map<string, Owner>> {
  const rows = await db
    .selectFrom('objects')
    .select(['kind', 'namespace', 'name', 'spec_summary', 'status_summary'])
    .where('cluster_id', '=', clusterId)
    .where('kind', 'in', ['Pod', 'DockerContainer'])
    .where('deleted_at', 'is', null)
    .execute();
  const out = new Map<string, Owner>();
  for (const r of rows) {
    if (r.kind === 'Pod') {
      const ip = (r.status_summary as { pod_ip?: string }).pod_ip;
      const w = (r.spec_summary as { workload?: { name?: string } }).workload;
      if (ip) out.set(ip, { kind: 'workload', name: `${r.namespace}/${w?.name ?? r.name}` });
    } else {
      for (const ip of (r.spec_summary as { ips?: string[] }).ips ?? []) {
        out.set(ip, { kind: 'container', name: r.name });
      }
    }
  }
  return out;
}

/** "3 min ago", "2 h ago", from unix seconds. */
export function ago(unix: number, now: number): string {
  const s = Math.max(0, now / 1000 - unix);
  if (s < 90) return `${Math.round(s)} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172_800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

/** "312 MB", "1.2 GB". */
export function bytes(b: number): string {
  if (b >= 2 ** 30) return `${(b / 2 ** 30).toFixed(1)} GB`;
  if (b >= 2 ** 20) return `${Math.round(b / 2 ** 20)} MB`;
  return `${Math.round(b / 2 ** 10)} KB`;
}
