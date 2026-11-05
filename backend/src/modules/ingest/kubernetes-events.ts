// SPDX-License-Identifier: AGPL-3.0-only
// Kubernetes events from the cluster-agent (ADR-061), and Docker events from the Docker
// agents (with their host), de-duplicated per UTC day by involved object and reason.
import { sql } from 'kysely';
import { Type, type Static } from 'typebox';
import type { Database } from '../../db/index.js';
import { ensureEventPartitions, retainedDays, utcDay } from '../events/partitions.js';

const Str = (max: number) => Type.String({ maxLength: max });

export const EventsBody = Type.Object({
  events: Type.Array(
    Type.Object({
      uid: Type.String({ minLength: 1, maxLength: 128 }),
      /** Docker: the Compose project ("" for standalone containers). */
      namespace: Type.Optional(Str(253)),
      /** Docker: the host. */
      host: Type.Optional(Str(253)),
      involved: Type.Object({
        kind: Str(63),
        namespace: Type.Optional(Str(253)),
        name: Str(253),
        uid: Type.Optional(Str(128)),
      }),
      type: Str(32),
      reason: Str(128),
      message: Str(4096),
      count: Type.Integer({ minimum: 1 }),
      first_ts: Type.String({ format: 'date-time' }),
      last_ts: Type.String({ format: 'date-time' }),
      reporting_controller: Type.Optional(Str(253)),
    }),
    { maxItems: 1000 },
  ),
});
export type KubernetesEvents = Static<typeof EventsBody>;

/** Postgres error for an insert without a matching partition. */
const NO_PARTITION = '23514';

export async function storeKubernetesEvents(
  db: Database,
  clusterId: string,
  body: KubernetesEvents,
  retentionDays: number,
  now = new Date(),
): Promise<{ stored: number; skipped: number }> {
  const { oldest } = retainedDays(retentionDays, now);
  const today = utcDay(now);
  const rows = new Map<
    string,
    Record<string, unknown> & { event_counts: Record<string, number> }
  >();
  let skipped = 0;
  for (const e of body.events) {
    let day = utcDay(new Date(e.last_ts));
    if (day < oldest) {
      skipped++; // past retention
      continue;
    }
    if (day > today) day = today; // clock skew
    // A Docker container keeps its key when it is re-created (a new ID, the same name).
    const involvedKey = e.host
      ? `${e.involved.kind}/${e.host}/${e.involved.name}`
      : e.involved.uid || `${e.involved.kind}/${e.involved.namespace ?? ''}/${e.involved.name}`;
    const key = `${day}\u0000${involvedKey}\u0000${e.reason}`;
    const prev = rows.get(key);
    const counts = { ...(prev?.event_counts ?? {}), [e.uid]: e.count };
    const newer = !prev || e.last_ts >= (prev.last_ts as string);
    rows.set(key, {
      ...(newer ? {} : prev),
      cluster_id: clusterId,
      day,
      involved_key: involvedKey.slice(0, 640),
      reason: e.reason,
      namespace: (newer ? e.namespace : prev!.namespace) ?? '',
      host: e.host ?? '',
      involved_kind: e.involved.kind,
      involved_name: e.involved.name,
      involved_uid: e.involved.uid ?? '',
      type: newer ? e.type : prev!.type,
      message: newer ? e.message : prev!.message,
      event_counts: counts,
      count: Object.values(counts).reduce((a, b) => a + b, 0),
      first_ts: prev && (prev.first_ts as string) < e.first_ts ? prev.first_ts : e.first_ts,
      last_ts: newer ? e.last_ts : prev!.last_ts,
      reporting_controller: (newer ? e.reporting_controller : prev!.reporting_controller) ?? '',
    });
  }
  if (rows.size === 0) return { stored: 0, skipped };
  const values = [...rows.values()].map((r) => ({
    ...r,
    event_counts: JSON.stringify(r.event_counts),
  }));
  const upsert = () =>
    db
      .insertInto('k8s_events')
      .values(values as never)
      .onConflict((oc) =>
        oc.columns(['cluster_id', 'day', 'involved_key', 'reason']).doUpdateSet({
          event_counts: sql`k8s_events.event_counts || excluded.event_counts`,
          count: sql`(select coalesce(sum(value::int), 0)::int from jsonb_each_text(k8s_events.event_counts || excluded.event_counts))`,
          first_ts: sql`least(k8s_events.first_ts, excluded.first_ts)`,
          last_ts: sql`greatest(k8s_events.last_ts, excluded.last_ts)`,
          message: sql`case when excluded.last_ts >= k8s_events.last_ts then excluded.message else k8s_events.message end`,
          type: sql`case when excluded.last_ts >= k8s_events.last_ts then excluded.type else k8s_events.type end`,
          updated_at: sql`now()`,
        }),
      )
      .execute();
  try {
    await upsert();
  } catch (err) {
    if ((err as { code?: string }).code !== NO_PARTITION) throw err;
    // A day without a partition yet (first start, maintenance not run): create and retry.
    await ensureEventPartitions(db, retentionDays, now);
    await upsert();
  }
  return { stored: rows.size, skipped };
}
