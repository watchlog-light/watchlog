// SPDX-License-Identifier: AGPL-3.0-only
// Who talks to a service (ADR-135, ADR-137): the workloads or containers whose network
// flows reach it, from the agents' eBPF flow series. On Kubernetes the destination is
// the service's workload; on Docker, its containers by name. An address added by hand
// is an external destination (its host and port).
import { sql } from 'kysely';
import { anyOf, escapeLabelValue } from '../../query/catalog.js';
import { imagePath } from '../discovery.js';
import type { PageContext } from './types.js';

/**
 * WatchLog's own images (agent, cluster-agent, integrations collector, backend, web), from
 * any registry that keeps a path naming WatchLog: its collector and agents connect to every
 * service they read, and are not that service's clients.
 */
export function isWatchlogImage(ref: string): boolean {
  return /(^|\/)[^/]*watchlog[^/]*\/(agent|cluster-agent|integrations|backend|web)$/.test(
    imagePath(ref),
  );
}

/** WatchLog's own workloads ("namespace/name") and containers in this cluster. */
async function ownComponents(ctx: PageContext) {
  const rows = await ctx.db
    .selectFrom('objects')
    .select(['kind', 'namespace', 'name', 'spec_summary'])
    .where('cluster_id', '=', ctx.row.cluster_id)
    .where('kind', 'in', ['Pod', 'DockerContainer'])
    .where('deleted_at', 'is', null)
    .where(sql<boolean>`spec_summary::text ilike '%watchlog%'`)
    .execute();
  const workloads = new Set<string>();
  const containers = new Set<string>();
  for (const r of rows) {
    const spec = r.spec_summary as {
      image?: string;
      containers?: { image?: string }[];
      workload?: { name?: string };
    };
    if (r.kind === 'Pod') {
      if ((spec.containers ?? []).some((c) => c.image && isWatchlogImage(c.image))) {
        workloads.add(`${r.namespace}/${spec.workload?.name ?? r.name}`);
      }
    } else if (spec.image && isWatchlogImage(spec.image)) {
      containers.add(r.name);
    }
  }
  return { workloads, containers };
}

export interface Connected {
  kind: 'workload' | 'container';
  name: string;
  /** Kubernetes: its namespace and kind. Docker: its Compose project and service. */
  namespace: string | null;
  workloadKind: string | null;
  composeService: string | null;
  /** Connections and failed connects over the page's range. */
  connections: number;
  failed: number;
}

export interface ConnectedResult {
  /** No flow series at all for this cluster: network flows are off or not supported. */
  flows: boolean;
  items: Connected[];
}

const SOURCE = 'namespace, workload_kind, workload, container, compose_project, compose_service';
const q = escapeLabelValue;

/** The destination matcher for the service's target; null when nothing can match yet. */
async function destination(ctx: PageContext): Promise<string | null> {
  const t = ctx.row.target;
  switch (t.kind) {
    case 'workload':
      return `dst_kind="workload",dst_namespace="${q(t.namespace)}",dst_workload_kind="${q(t.workload_kind)}",dst_workload="${q(t.workload)}"`;
    case 'container':
      return `dst_kind="container",dst="${q(t.container)}"`;
    case 'compose': {
      const rows = await ctx.db
        .selectFrom('objects')
        .select(['name', 'spec_summary'])
        .where('cluster_id', '=', ctx.row.cluster_id)
        .where('kind', '=', 'DockerContainer')
        .where('deleted_at', 'is', null)
        .where('node', '=', t.host)
        .where('namespace', '=', t.compose_project)
        .execute();
      const names = rows
        .filter(
          (r) =>
            (r.spec_summary as { compose_service?: string }).compose_service === t.compose_service,
        )
        .map((r) => r.name);
      return names.length ? `dst_kind="container",dst=~"${anyOf(names)}"` : null;
    }
    case 'address': {
      const m = /^\[?([^\]]+)\]?:(\d+)$/.exec(t.address);
      return m ? `dst_kind="external",dst="${q(m[1]!)}",dst_port="${m[2]}"` : null;
    }
  }
}

export async function connectedTo(ctx: PageContext, limit = 20): Promise<ConnectedResult> {
  if (!ctx.vm) return { flows: false, items: [] };
  const scope = { clusterId: ctx.row.cluster_id };
  const at = Math.floor(ctx.now / 1000);
  const dst = await destination(ctx);
  const [any, conns, failed, own] = await Promise.all([
    ctx.vm.query(scope, 'count(last_over_time(watchlog_flow_connections_total[15m]))', at),
    dst
      ? ctx.vm.query(
          scope,
          `sum by (${SOURCE}) (increase(watchlog_flow_connections_total{${dst}}[${ctx.range}s])) > 0`,
          at,
        )
      : Promise.resolve([]),
    dst
      ? ctx.vm.query(
          scope,
          `sum by (${SOURCE}) (increase(watchlog_flow_connect_failed_total{${dst}}[${ctx.range}s])) > 0`,
          at,
        )
      : Promise.resolve([]),
    ownComponents(ctx),
  ]);
  const key = (l: Record<string, string>) =>
    [l.namespace, l.workload_kind, l.workload, l.container, l.compose_project, l.compose_service]
      .map((v) => v ?? '')
      .join('\u0000');
  const failedBy = new Map(failed.map((f) => [key(f.labels), f.points[0]?.[1] ?? 0]));
  const items: Connected[] = conns.flatMap((c): Connected[] => {
    const l = c.labels;
    const n = Math.round(c.points[0]?.[1] ?? 0);
    const f = Math.round(failedBy.get(key(l)) ?? 0);
    // WatchLog's collector and agents reach every service they read: not its clients.
    if (l.workload && own.workloads.has(`${l.namespace}/${l.workload}`)) return [];
    if (!l.workload && l.container && own.containers.has(l.container)) return [];
    if (l.workload) {
      return [
        {
          kind: 'workload',
          name: l.workload,
          namespace: l.namespace ?? null,
          workloadKind: l.workload_kind ?? null,
          composeService: null,
          connections: n,
          failed: f,
        },
      ];
    }
    if (l.container) {
      return [
        {
          kind: 'container',
          name: l.container,
          namespace: l.compose_project || null,
          workloadKind: null,
          composeService: l.compose_service || null,
          connections: n,
          failed: f,
        },
      ];
    }
    return [];
  });
  items.sort((a, b) => b.connections - a.connections || a.name.localeCompare(b.name));
  return { flows: (any[0]?.points[0]?.[1] ?? 0) > 0, items: items.slice(0, limit) };
}
