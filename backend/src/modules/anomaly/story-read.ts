// SPDX-License-Identifier: AGPL-3.0-only
// The reads What changed's story needs (0.14.0, ADR-231), around causes/story.ts's pure rules:
//   - the changes in a window: Kubernetes and Docker change markers (rollouts, image changes,
//     scaling, Compose and container recreates, nodes), a server's service events (started,
//     restarted, failed, its unit file changed) and new executables, and scheduled runs (a
//     job's run started; jobs every 5 minutes or more often are left out, they'd flood it);
//   - "related": calls between two things on the service map, or a shared node (Kubernetes,
//     from the pods) or server.
// Package updates aren't here: the agent sends no package events (pending review).
import type { Database } from '../../db/index.js';
import type { Change, ChangeKind, Related } from '../causes/story.js';
import { isOwnChange, type OwnParts } from './live.js';
import type { ClusterKind, ObjectView } from './read.js';

const MARKER_KINDS: Record<string, ChangeKind> = {
  rollout: 'rollout',
  image: 'image',
  scale: 'scale',
  compose: 'compose',
  recreate: 'recreate',
  node: 'node',
};
const EVENT_KINDS: Record<string, ChangeKind> = {
  Started: 'service_start',
  Restarted: 'service_restart',
  Failed: 'service_failed',
  UnitChanged: 'unit_changed',
  Release: 'release',
};
const CHANGES_MAX = 200;

/** A marker's target as a name and where: "Deployment/shop/api", "Container/host/name", "Node/n". */
export function markerTarget(target: string): {
  kind: string;
  name: string;
  namespace?: string;
  host?: string;
} {
  const parts = target.split('/');
  const kind = parts[0] ?? '';
  if (kind === 'Container' && parts.length >= 3)
    return { kind, host: parts[1]!, name: parts.slice(2).join('/') };
  if (parts.length >= 3) return { kind, namespace: parts[1]!, name: parts.slice(2).join('/') };
  return { kind, name: parts.slice(1).join('/') || target };
}

export async function readChanges(
  db: Database,
  clusterId: string,
  fromMs: number,
  toMs: number,
  /** WatchLog's own parts when they are hidden: their changes are left out too. */
  own: OwnParts | null = null,
): Promise<Change[]> {
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const [markers, events, runs] = await Promise.all([
    db
      .selectFrom('change_markers')
      .select(['kind', 'target', 'namespace', 'details', 'ts'])
      .where('cluster_id', '=', clusterId)
      .where('kind', 'in', Object.keys(MARKER_KINDS))
      .where('ts', '>=', from)
      .where('ts', '<=', to)
      .orderBy('ts')
      .limit(CHANGES_MAX)
      .execute(),
    db
      .selectFrom('k8s_events')
      .select(['involved_kind', 'involved_name', 'reason', 'host', 'last_ts', 'message'])
      .where('cluster_id', '=', clusterId)
      .where('involved_kind', 'in', ['Service', 'Process'])
      .where('reason', 'in', Object.keys(EVENT_KINDS))
      .where('day', '>=', new Date(fromMs - 86_400_000))
      .where('last_ts', '>=', from)
      .where('last_ts', '<=', to)
      .orderBy('last_ts')
      .limit(CHANGES_MAX)
      .execute(),
    db
      .selectFrom('job_runs as r')
      .innerJoin('scheduled_jobs as j', (jn) =>
        jn
          .onRef('j.cluster_id', '=', 'r.cluster_id')
          .onRef('j.node', '=', 'r.node')
          .onRef('j.job_id', '=', 'r.job_id'),
      )
      .select(['j.name', 'j.kind', 'r.node', 'r.started_at', 'r.ended_at', 'r.result'])
      .where('r.cluster_id', '=', clusterId)
      .where('j.frequent', '=', false)
      .where('r.started_at', '>=', from)
      .where('r.started_at', '<=', to)
      .orderBy('r.started_at')
      .limit(CHANGES_MAX)
      .execute(),
  ]);
  const out: Change[] = [];
  for (const m of markers) {
    const t = markerTarget(m.target);
    const d = (m.details ?? {}) as Record<string, unknown>;
    const fact = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? v : null);
    out.push({
      at: new Date(m.ts).getTime(),
      kind: MARKER_KINDS[m.kind]!,
      name: t.name,
      ...(t.namespace
        ? { namespace: t.namespace }
        : m.namespace && t.kind !== 'Container'
          ? { namespace: m.namespace }
          : {}),
      ...(t.host ? { host: t.host } : {}),
      facts: {
        from: fact(d.from),
        to: fact(d.to),
        workloadKind: t.kind,
        ...(d.image ? { image: fact(d.image) } : {}),
      },
    });
  }
  for (const e of events) {
    // A process group's event matters only for a new executable; its starts are its own.
    if (e.involved_kind === 'Process' && e.reason !== 'Release') continue;
    out.push({
      at: new Date(e.last_ts).getTime(),
      kind: EVENT_KINDS[e.reason]!,
      name: e.involved_name,
      ...(e.host ? { host: e.host } : {}),
      facts: { unitKind: e.involved_kind },
    });
  }
  for (const r of runs) {
    const start = new Date(r.started_at).getTime();
    out.push({
      at: start,
      kind: 'job_run',
      name: r.name,
      ...(r.node ? { host: r.node } : {}),
      facts: {
        jobKind: r.kind,
        result: r.result,
        seconds: r.ended_at ? Math.round((new Date(r.ended_at).getTime() - start) / 1000) : null,
      },
    });
  }
  return (own ? out.filter((c) => !isOwnChange(c, own)) : out).sort((a, b) => a.at - b.at);
}

/** The service map's nodes and edges, as GET /clusters/:id/service-map gives them. */
export interface MapRead {
  nodes: { id: string; name: string; namespace: string | null }[];
  edges: { source: string; target: string }[];
}

/** Where each Kubernetes workload's pods run: "namespace/workload" → nodes. */
export async function workloadNodes(
  db: Database,
  clusterId: string,
): Promise<Map<string, Set<string>>> {
  const pods = await db
    .selectFrom('objects')
    .select(['namespace', 'node', 'spec_summary'])
    .where('cluster_id', '=', clusterId)
    .where('kind', '=', 'Pod')
    .where('deleted_at', 'is', null)
    .execute();
  const out = new Map<string, Set<string>>();
  for (const p of pods) {
    const w = (p.spec_summary as { workload?: { name?: string } } | null)?.workload?.name;
    if (!w || !p.node) continue;
    const k = `${p.namespace}/${w}`;
    const s = out.get(k) ?? new Set<string>();
    s.add(p.node);
    out.set(k, s);
  }
  return out;
}

/** The map's node ids an object can be: by name and namespace (a Compose service's too). */
function idsOf(o: ObjectView, map: MapRead): Set<string> {
  const names = new Set([o.name, ...(o.composeService ? [o.composeService] : [])]);
  const ns = o.namespace ?? o.composeProject ?? null;
  return new Set(
    map.nodes
      .filter(
        (n) => names.has(n.name) && (ns === null || n.namespace === null || n.namespace === ns),
      )
      .map((n) => n.id),
  );
}

/**
 * Related (ADR-231): calls between them on the service map (either way), or the same server,
 * or (Kubernetes) a node both run pods on, or a node and a workload on it.
 */
export function relatedBy(
  kind: ClusterKind,
  map: MapRead | null,
  nodesOf: Map<string, Set<string>>,
): Related {
  const nodesFor = (o: ObjectView): Set<string> => {
    if (o.kind === 'node') return new Set([o.name]);
    if (o.kind === 'workload' && o.namespace)
      return nodesOf.get(`${o.namespace}/${o.name}`) ?? new Set();
    return new Set();
  };
  return (a, b) => {
    if (a.host && b.host && a.host === b.host) return true;
    if ((a.kind === 'host' && b.host === a.name) || (b.kind === 'host' && a.host === b.name))
      return true;
    if (kind === 'kubernetes') {
      const na = nodesFor(a);
      for (const n of nodesFor(b)) if (na.has(n)) return true;
    }
    if (map && map.edges.length) {
      const ia = idsOf(a, map);
      const ib = idsOf(b, map);
      if (ia.size && ib.size) {
        return map.edges.some(
          (e) => (ia.has(e.source) && ib.has(e.target)) || (ib.has(e.source) && ia.has(e.target)),
        );
      }
    }
    return false;
  };
}
