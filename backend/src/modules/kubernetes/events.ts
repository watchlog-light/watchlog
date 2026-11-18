// SPDX-License-Identifier: AGPL-3.0-only
// The Events page's queries (ADR-111): filters shared by
// the list and its summary, and the summary itself: events per bucket (Warning and
// Normal), facet counts and markers for notable events. Counts are event occurrences
// (the `count` of each stored event), not rows.
import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';
import type { Database } from '../../db/index.js';
import type { DB } from '../../db/types.js';

/**
 * Kinds without a namespace. Their events are stored in the namespace the reporter used
 * ("default" for nodes), which is not theirs; they are shown as cluster-wide.
 */
export const CLUSTER_SCOPED_KINDS = [
  'Node',
  'Namespace',
  'PersistentVolume',
  'StorageClass',
  'ClusterRole',
  'ClusterRoleBinding',
  'CustomResourceDefinition',
  'PriorityClass',
  'CSINode',
  'CSIDriver',
  'VolumeAttachment',
  'APIService',
  'MutatingWebhookConfiguration',
  'ValidatingWebhookConfiguration',
];
const CLUSTER = new Set(CLUSTER_SCOPED_KINDS);
export const isClusterScoped = (kind: string) => CLUSTER.has(kind);

/**
 * The value that stands for objects without a namespace in the namespace facet and
 * filter: cluster-wide Kubernetes objects, standalone Docker containers (no Compose
 * project).
 */
export const CLUSTER_WIDE = '-';

/** Reasons worth a marker on the histogram. */
export const NOTABLE_REASONS = [
  'Rebooted',
  // Servers (0.9.2)
  'CrashLoop',
  'Release',
  // Docker
  'OOMKilled',
  'Died',
  'NodeNotReady',
  'OOMKilling',
  'SystemOOM',
  'Evicted',
  'EvictionThresholdMet',
  'NodeHasDiskPressure',
  'NodeHasInsufficientMemory',
];

export interface EventFilter {
  clusterId: string;
  /** The top bar's namespaces: namespaced objects in them only. */
  namespaces?: string[];
  types?: string[];
  kinds?: string[];
  reasons?: string[];
  /** The page's namespace (Docker: Compose project) facet; CLUSTER_WIDE selects the rest. */
  ns?: string[];
  /** Docker hosts; a Server fleet's servers. */
  hosts?: string[];
  /** A Server fleet's workloads: `service:<unit>`, `process:<group>`, `container:<name>`. */
  workloads?: string[];
  /** Events of these stored keys left out ("Hide system": the OS's own and WatchLog's own). */
  excludeKeys?: string[];
  name?: string;
  /** Words to find in the object's name, the reason or the message. */
  q?: string;
  from?: number;
  to?: number;
}

type Eb = ExpressionBuilder<DB, 'k8s_events'>;
type Dimension = 'types' | 'kinds' | 'reasons' | 'ns' | 'hosts' | 'workloads';

/** A server workload's id and the kind its events are stored with (0.9.2). */
export const WORKLOAD_KINDS = {
  service: 'Service',
  process: 'Process',
  container: 'Container',
} as const;
export type WorkloadSource = keyof typeof WORKLOAD_KINDS;
/** `service:nginx.service` → ['Service', 'nginx.service']; null when not a workload id. */
export function workloadKindName(id: string): [string, string] | null {
  const i = id.indexOf(':');
  const kind = WORKLOAD_KINDS[id.slice(0, i) as WorkloadSource];
  return i > 0 && kind && id.length > i + 1 ? [kind, id.slice(i + 1)] : null;
}
/** The workload id of a stored host event (`Service` + `nginx.service`), or null. */
export function workloadId(kind: string, name: string): string | null {
  const source = (Object.keys(WORKLOAD_KINDS) as WorkloadSource[]).find(
    (k) => WORKLOAD_KINDS[k] === kind,
  );
  return source ? `${source}:${name}` : null;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The WHERE of a filter, leaving out one dimension (for that dimension's facet). */
export function eventWhere(f: EventFilter, skip?: Dimension) {
  return (eb: Eb): Expression<SqlBool> => {
    const and: Expression<SqlBool>[] = [eb('cluster_id', '=', f.clusterId)];
    if (f.namespaces)
      and.push(
        eb.and([
          eb('namespace', 'in', f.namespaces),
          eb('involved_kind', 'not in', CLUSTER_SCOPED_KINDS),
        ]),
      );
    if (f.types?.length && skip !== 'types') and.push(eb('type', 'in', f.types));
    if (f.kinds?.length && skip !== 'kinds') and.push(eb('involved_kind', 'in', f.kinds));
    if (f.reasons?.length && skip !== 'reasons') and.push(eb('reason', 'in', f.reasons));
    if (f.hosts?.length && skip !== 'hosts') and.push(eb('host', 'in', f.hosts));
    if (f.workloads?.length && skip !== 'workloads') {
      const pairs = f.workloads.map(workloadKindName).filter((p): p is [string, string] => !!p);
      and.push(
        pairs.length
          ? eb.or(
              pairs.map(([k, n]) =>
                eb.and([eb('involved_kind', '=', k), eb('involved_name', '=', n)]),
              ),
            )
          : sql<SqlBool>`false`,
      );
    }
    if (f.excludeKeys?.length) and.push(eb('involved_key', 'not in', f.excludeKeys));
    if (f.ns?.length && skip !== 'ns') {
      const named = f.ns.filter((n) => n !== CLUSTER_WIDE);
      const or: Expression<SqlBool>[] = [];
      if (named.length)
        or.push(
          eb.and([
            eb('namespace', 'in', named),
            eb('involved_kind', 'not in', CLUSTER_SCOPED_KINDS),
          ]),
        );
      if (f.ns.includes(CLUSTER_WIDE))
        or.push(eb.or([eb('involved_kind', 'in', CLUSTER_SCOPED_KINDS), eb('namespace', '=', '')]));
      and.push(eb.or(or));
    }
    if (f.name) and.push(eb('involved_name', '=', f.name));
    for (const word of (f.q ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5)) {
      const like = `%${escapeLike(word)}%`;
      and.push(
        eb.or([
          eb('involved_name', 'ilike', like),
          eb('reason', 'ilike', like),
          eb('message', 'ilike', like),
          eb('involved_kind', 'ilike', like),
        ]),
      );
    }
    // The partition key bounds the scan when a range is given.
    if (f.from !== undefined)
      and.push(
        eb.and([
          eb('last_ts', '>=', new Date(f.from * 1000)),
          eb('day', '>=', new Date(Math.floor(f.from / 86400) * 86400_000)),
        ]),
      );
    if (f.to !== undefined) and.push(eb('first_ts', '<=', new Date(f.to * 1000)));
    return eb.and(and);
  };
}

/** A bucket size giving at most 48 bars: whole minutes or hours. */
export function bucketSeconds(range: number): number {
  const sizes = [60, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
  return sizes.find((s) => range / s <= 48) ?? 86400;
}

export interface EventSummary {
  from: number;
  to: number;
  bucket: number;
  histogram: { ts: number; warning: number; normal: number }[];
  facets: {
    kinds: { value: string; count: number }[];
    namespaces: { value: string; count: number }[];
    reasons: { value: string; type: string; count: number }[];
    hosts: { value: string; count: number }[];
    /** A Server fleet's workloads (`service:nginx.service`), the busiest 50. */
    workloads: { value: string; count: number }[];
  };
  markers: { ts: number; reason: string; kind: string; objects: number }[];
  total: number;
}

/**
 * The histogram spreads each stored event's count evenly over its first..last seen
 * time, so an event repeated all day does not pile up in its last hour.
 */
export async function eventSummary(
  db: Database,
  f: EventFilter & { from: number; to: number },
): Promise<EventSummary> {
  const bucket = bucketSeconds(f.to - f.from);
  const start = Math.floor(f.from / bucket) * bucket;
  const buckets = Math.ceil((f.to - start) / bucket);
  const nsExpr = sql<string>`case when involved_kind in (${sql.join(CLUSTER_SCOPED_KINDS)}) or namespace = '' then ${CLUSTER_WIDE} else namespace end`;
  const sum = sql<string>`sum(count)`;
  const [hist, kinds, namespaces, reasons, markers, hosts, workloads] = await Promise.all([
    db
      .with('e', (qb) =>
        qb
          .selectFrom('k8s_events')
          .select([
            'type',
            'count',
            sql<number>`extract(epoch from first_ts)`.as('f'),
            sql<number>`greatest(extract(epoch from last_ts), extract(epoch from first_ts) + 1)`.as(
              'l',
            ),
          ])
          .where(eventWhere(f)),
      )
      .selectFrom(
        sql<{ type: string; count: number; f: number; l: number; b: number }>`(
          select e.*, b from e, generate_series(
            greatest(0, floor((greatest(e.f, ${start}) - ${start}) / ${bucket}))::int,
            least(${buckets - 1}, floor((least(e.l, ${f.to}) - ${start}) / ${bucket}))::int
          ) b
        )`.as('x'),
      )
      .select([
        'x.b',
        sql<string>`sum(case when x.type = 'Warning' then x.count * (least(x.l, ${start} + (x.b + 1) * ${bucket}) - greatest(x.f, ${start} + x.b * ${bucket})) / (x.l - x.f) else 0 end)`.as(
          'warning',
        ),
        sql<string>`sum(case when x.type <> 'Warning' then x.count * (least(x.l, ${start} + (x.b + 1) * ${bucket}) - greatest(x.f, ${start} + x.b * ${bucket})) / (x.l - x.f) else 0 end)`.as(
          'normal',
        ),
      ])
      .groupBy('x.b')
      .execute(),
    db
      .selectFrom('k8s_events')
      .select(['involved_kind as value', sum.as('n')])
      .where(eventWhere(f, 'kinds'))
      .groupBy('involved_kind')
      .execute(),
    db
      .selectFrom('k8s_events')
      .select([nsExpr.as('value'), sum.as('n')])
      .where(eventWhere(f, 'ns'))
      .groupBy(sql`1`)
      .execute(),
    db
      .selectFrom('k8s_events')
      .select(['reason as value', sql<string>`max(type)`.as('type'), sum.as('n')])
      .where(eventWhere(f, 'reasons'))
      .groupBy('reason')
      .execute(),
    db
      .selectFrom('k8s_events')
      .select([
        'reason',
        sql<string>`min(involved_kind)`.as('kind'),
        sql<number>`floor(extract(epoch from last_ts) / ${bucket})`.as('b'),
        sql<number>`min(extract(epoch from last_ts))`.as('ts'),
        sql<string>`count(distinct involved_key)`.as('objects'),
      ])
      .where(eventWhere(f))
      .where('reason', 'in', NOTABLE_REASONS)
      .groupBy(['reason', sql`3`])
      .orderBy(sql`4`)
      .limit(50)
      .execute(),
    db
      .selectFrom('k8s_events')
      .select(['host as value', sum.as('n')])
      .where(eventWhere(f, 'hosts'))
      .where('host', '<>', '')
      .groupBy('host')
      .execute(),
    db
      .selectFrom('k8s_events')
      .select(['involved_kind as kind', 'involved_name as name', sum.as('n')])
      .where(eventWhere(f, 'workloads'))
      .where('host', '<>', '')
      .where('involved_kind', 'in', Object.values(WORKLOAD_KINDS))
      .groupBy(['involved_kind', 'involved_name'])
      .orderBy(sql`3 desc`)
      .limit(50)
      .execute(),
  ]);
  const byBucket = new Map(hist.map((h) => [Number(h.b), h]));
  const histogram = Array.from({ length: buckets }, (_, i) => {
    const h = byBucket.get(i);
    return {
      ts: start + i * bucket,
      warning: h ? Math.round(Number(h.warning)) : 0,
      normal: h ? Math.round(Number(h.normal)) : 0,
    };
  });
  const desc = <T extends { count: number }>(xs: T[]) => xs.sort((a, b) => b.count - a.count);
  const kindFacet = desc(kinds.map((k) => ({ value: k.value, count: Number(k.n) })));
  return {
    from: f.from,
    to: f.to,
    bucket,
    histogram,
    facets: {
      kinds: kindFacet,
      namespaces: desc(namespaces.map((n) => ({ value: n.value, count: Number(n.n) }))),
      reasons: desc(reasons.map((r) => ({ value: r.value, type: r.type, count: Number(r.n) }))),
      hosts: desc(hosts.map((h) => ({ value: h.value, count: Number(h.n) }))),
      workloads: desc(
        workloads.flatMap((w) => {
          const id = workloadId(w.kind, w.name);
          return id ? [{ value: id, count: Number(w.n) }] : [];
        }),
      ),
    },
    markers: markers.map((m) => ({
      ts: Math.round(Number(m.ts)),
      reason: m.reason,
      kind: m.kind,
      objects: Number(m.objects),
    })),
    // The kind facet leaves its own filter out; the total keeps it.
    total: kindFacet
      .filter((k) => !f.kinds?.length || f.kinds.includes(k.value))
      .reduce((s, k) => s + k.count, 0),
  };
}
