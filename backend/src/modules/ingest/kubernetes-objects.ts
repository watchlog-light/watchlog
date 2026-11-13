// SPDX-License-Identifier: AGPL-3.0-only
// Kubernetes objects from the cluster-agent (ADR-055): snapshots in chunks, deltas
// every 5 s, stored in the same `objects` table as Docker inventory.
import { sql } from 'kysely';
import { Type, type Static } from 'typebox';
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';

/** Kinds the cluster-agent sends (ADR-052); ReplicaSets are never sent. */
export const KUBERNETES_KINDS = [
  'Namespace',
  'Node',
  'Pod',
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'Job',
  'CronJob',
  'HorizontalPodAutoscaler',
  'PersistentVolumeClaim',
  // Service map topology (Phase 4, ADR-101): cluster IPs, ports, workloads behind it.
  'Service',
] as const;

const Kind = Type.Union(KUBERNETES_KINDS.map((k) => Type.Literal(k)));
const Summary = Type.Record(Type.String(), Type.Unknown());

export const KubernetesObjectsBody = Type.Object({
  source: Type.Literal('kubernetes'),
  kind: Type.Union([Type.Literal('snapshot'), Type.Literal('delta')]),
  snapshot_id: Type.String({ minLength: 1, maxLength: 64 }),
  /** Last chunk of a snapshot: objects of `kinds` not seen in it are deleted. */
  final: Type.Optional(Type.Boolean()),
  kinds: Type.Optional(Type.Array(Kind, { maxItems: 32 })),
  objects: Type.Array(
    Type.Object({
      kind: Kind,
      uid: Type.String({ minLength: 1, maxLength: 128 }),
      namespace: Type.Optional(Type.String({ maxLength: 253 })),
      name: Type.String({ minLength: 1, maxLength: 253 }),
      node: Type.Optional(Type.String({ maxLength: 253 })),
      spec: Summary,
      status: Summary,
      deleted: Type.Optional(Type.Boolean()),
    }),
    { maxItems: 2500 },
  ),
});
export type KubernetesObjects = Static<typeof KubernetesObjectsBody>;

/** Rows per INSERT … ON CONFLICT statement. */
const BATCH = 500;

type Summary = Record<string, unknown>;
interface Marker {
  kind: 'rollout' | 'image' | 'scale' | 'node' | 'namespace';
  target: string;
  namespace: string;
  details: Summary;
}
const MARKED_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'Node', 'Namespace'];

const images = (spec: Summary) =>
  ((spec.containers as { name: string; image: string }[] | undefined) ?? []).map(
    (c) => `${c.name}=${c.image}`,
  );

/**
 * Change markers (ADR-061) from an object's previous and new summary: template
 * revision → rollout, container images → image, replicas → scale (HPA-driven
 * scaling shows as the workload's replicas), Node added or removed → node, Namespace
 * created → namespace. Added nodes and namespaces are marked only from deltas: a first
 * snapshot is not a change.
 */
export function changeMarkers(
  kind: string,
  namespace: string,
  name: string,
  prev: { spec: Summary; status: Summary; deleted: boolean } | undefined,
  next: { spec: Summary; status: Summary; deleted: boolean },
  isDelta: boolean,
): Marker[] {
  const target = namespace ? `${kind}/${namespace}/${name}` : `${kind}/${name}`;
  const out: Marker[] = [];
  // A namespace created after the first snapshot: often a new app being deployed.
  if (kind === 'Namespace') {
    if (isDelta && !next.deleted && (!prev || prev.deleted))
      out.push({ kind: 'namespace', target, namespace: name, details: { action: 'created' } });
    return out;
  }
  if (kind === 'Node') {
    if (isDelta && !next.deleted && (!prev || prev.deleted))
      out.push({ kind: 'node', target, namespace: '', details: { action: 'added' } });
    if (next.deleted && prev && !prev.deleted)
      out.push({ kind: 'node', target, namespace: '', details: { action: 'removed' } });
    return out;
  }
  if (!prev || prev.deleted || next.deleted) return out;
  const [before, after] = [images(prev.spec), images(next.spec)];
  if (before.join(',') !== after.join(','))
    out.push({ kind: 'image', target, namespace, details: { from: before, to: after } });
  const revision = (s: Summary, st: Summary) =>
    kind === 'Deployment' ? s.revision : kind === 'StatefulSet' ? st.update_revision : s.generation;
  const [r0, r1] = [revision(prev.spec, prev.status), revision(next.spec, next.status)];
  if (r1 !== undefined && r1 !== '' && r0 !== r1)
    out.push({ kind: 'rollout', target, namespace, details: { from: r0 ?? null, to: r1 } });
  if (kind !== 'DaemonSet' && prev.spec.replicas !== next.spec.replicas)
    out.push({
      kind: 'scale',
      target,
      namespace,
      details: { from: prev.spec.replicas ?? null, to: next.spec.replicas ?? null },
    });
  return out;
}

export async function storeKubernetesObjects(
  db: Database,
  clusterId: string,
  /** The cluster's org, given so no row needs the org_id trigger (ADR-174). */
  orgId: string,
  body: KubernetesObjects,
  now = new Date(),
): Promise<void> {
  // The same object twice in one statement would make ON CONFLICT fail; keep the last.
  const latest = new Map(body.objects.map((o) => [o.uid, o]));
  const live = [...latest.values()].filter((o) => !o.deleted);
  const gone = [...latest.values()].filter((o) => o.deleted).map((o) => o.uid);

  await db.transaction().execute(async (trx) => {
    // Previous state of the kinds that produce change markers.
    const marked = [...latest.values()].filter((o) => MARKED_KINDS.includes(o.kind));
    const previous = new Map(
      marked.length === 0
        ? []
        : (
            await trx
              .selectFrom('objects')
              .select(['uid', 'spec_summary', 'status_summary', 'deleted_at'])
              .where('cluster_id', '=', clusterId)
              .where(
                'uid',
                'in',
                marked.map((o) => o.uid),
              )
              .execute()
          ).map((r) => [
            r.uid,
            {
              spec: r.spec_summary as Summary,
              status: r.status_summary as Summary,
              deleted: r.deleted_at !== null,
            },
          ]),
    );
    const markers = marked.flatMap((o) =>
      changeMarkers(
        o.kind,
        o.namespace ?? '',
        o.name,
        previous.get(o.uid),
        { spec: o.spec, status: o.status, deleted: o.deleted ?? false },
        body.kind === 'delta',
      ),
    );
    if (markers.length > 0) {
      await trx
        .insertInto('change_markers')
        .values(
          markers.map((m) => ({
            id: newId(),
            cluster_id: clusterId,
            org_id: orgId,
            kind: m.kind,
            target: m.target,
            namespace: m.namespace,
            details: JSON.stringify(m.details),
            ts: now,
          })),
        )
        .execute();
    }

    for (let i = 0; i < live.length; i += BATCH) {
      await trx
        .insertInto('objects')
        .values(
          live.slice(i, i + BATCH).map((o) => ({
            id: newId(),
            cluster_id: clusterId,
            org_id: orgId,
            source: 'kubernetes',
            kind: o.kind,
            namespace: o.namespace ?? '',
            name: o.name,
            uid: o.uid,
            node: o.node ?? '',
            spec_summary: JSON.stringify(o.spec),
            status_summary: JSON.stringify(o.status),
            snapshot_id: body.snapshot_id,
            deleted_at: null,
          })),
        )
        .onConflict((oc) =>
          oc.columns(['cluster_id', 'uid']).doUpdateSet((eb) => ({
            kind: eb.ref('excluded.kind'),
            namespace: eb.ref('excluded.namespace'),
            name: eb.ref('excluded.name'),
            node: eb.ref('excluded.node'),
            spec_summary: eb.ref('excluded.spec_summary'),
            status_summary: eb.ref('excluded.status_summary'),
            snapshot_id: eb.ref('excluded.snapshot_id'),
            deleted_at: null,
          })),
        )
        .execute();
    }
    if (gone.length > 0) {
      await trx
        .updateTable('objects')
        .set({ deleted_at: now })
        .where('cluster_id', '=', clusterId)
        .where('source', '=', 'kubernetes')
        .where('uid', 'in', gone)
        .where('deleted_at', 'is', null)
        .execute();
    }
    if (body.kind === 'snapshot' && body.final && body.kinds && body.kinds.length > 0) {
      // Deltas carry the current snapshot id too, so objects created while the
      // snapshot was being sent are not swept.
      await trx
        .updateTable('objects')
        .set({ deleted_at: now })
        .where('cluster_id', '=', clusterId)
        .where('source', '=', 'kubernetes')
        .where('kind', 'in', body.kinds)
        .where('deleted_at', 'is', null)
        .where(sql<boolean>`snapshot_id is distinct from ${body.snapshot_id}`)
        .execute();
    }
  });
}
