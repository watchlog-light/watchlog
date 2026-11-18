// SPDX-License-Identifier: AGPL-3.0-only
// "Hide system" on a Server fleet's Events (0.9.2): the stored events of the OS's own
// workloads and of WatchLog's own agent and collector, as the Workloads page decides them
// (ADR-208 amended): a service by its unit (the OS's) or by the agent's own="true" (ours, by
// unit and binary); a process group by the executable it is named after; a container by its
// image. Never by a process's name alone: another product's watchlog-agent stays shown.
import type { Database } from '../../db/index.js';
import type { ClusterScope, VictoriaQueryClient } from '../../lib/victoria.js';
import { WORKLOAD_KINDS } from '../kubernetes/events.js';
import { isOwnImage, isSystemGroup, isSystemUnit } from './workloads.js';

/** The stored keys (involved_key) of system workloads' events since `from` (unix seconds). */
export async function systemEventKeys(
  db: Database,
  victoria: VictoriaQueryClient | undefined,
  cluster: { id: string; scope: ClusterScope },
  from: number,
  hosts?: string[],
): Promise<string[]> {
  let q = db
    .selectFrom('k8s_events')
    .select(['involved_key', 'involved_kind', 'involved_name', 'host'])
    .distinct()
    .where('cluster_id', '=', cluster.id)
    .where('host', '<>', '')
    .where('involved_kind', 'in', Object.values(WORKLOAD_KINDS))
    .where('last_ts', '>=', new Date(from * 1000))
    .where('day', '>=', new Date(Math.floor(from / 86400) * 86400_000));
  if (hosts?.length) q = q.where('host', 'in', hosts);
  const rows = await q.limit(5000).execute();
  if (!rows.length) return [];

  // WatchLog's own units, as the agent tells them (unit and binary together).
  const own = new Set<string>();
  if (victoria && rows.some((r) => r.involved_kind === WORKLOAD_KINDS.service)) {
    const series = await victoria
      .query(
        cluster.scope,
        'max by (host, unit) (last_over_time(watchlog_service_exe_info{own="true"}[1d]))',
      )
      .catch(() => []);
    for (const s of series) own.add(`${s.labels.host}\u0000${s.labels.unit}`);
  }
  // WatchLog's own containers, by their image.
  const ownContainers = new Set<string>();
  if (rows.some((r) => r.involved_kind === WORKLOAD_KINDS.container)) {
    const objs = await db
      .selectFrom('objects')
      .select(['node', 'name', 'spec_summary'])
      .where('cluster_id', '=', cluster.id)
      .where('kind', '=', 'DockerContainer')
      .execute();
    for (const o of objs) {
      const image = (o.spec_summary as { image?: string } | null)?.image ?? '';
      if (isOwnImage(image)) ownContainers.add(`${o.node}\u0000${o.name}`);
    }
  }
  return rows
    .filter((r) => {
      const k = `${r.host}\u0000${r.involved_name}`;
      switch (r.involved_kind) {
        case WORKLOAD_KINDS.service:
          return isSystemUnit(r.involved_name) || own.has(k);
        case WORKLOAD_KINDS.process:
          return isSystemGroup(r.involved_name);
        default:
          return ownContainers.has(k);
      }
    })
    .map((r) => r.involved_key);
}
