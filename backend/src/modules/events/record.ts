// SPDX-License-Identifier: AGPL-3.0-only
// An event from a module (ee/, ADR-233: a switch port went down, a device rebooted) in the
// Events list of the place it concerns, stored like the agents' events: one row per day,
// involved object and reason, counted.
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { ensureEventPartitions } from './partitions.js';

export interface RecordedEvent {
  orgId: string;
  clusterId: string;
  /** "NetworkPort", "NetworkDevice": what the event is about. */
  kind: string;
  /** "sw-access-2/Gi1/0/14". */
  name: string;
  /** A stable key for the object ("net:<device id>/<port>"), with the reason the day's row. */
  key: string;
  /** The server or Kubernetes node it concerns ('' for the whole place). */
  host: string;
  /** The namespace of the workload it concerns, when it concerns one. */
  namespace?: string;
  /** "PortDown", "PortUp", "SpeedChanged", "ErrorsStarted", "DeviceRebooted", "UplinkErrors". */
  reason: string;
  type: 'Normal' | 'Warning';
  message: string;
  at: number;
  /** Who reported it ("watchlog-network"). */
  source: string;
}

const NO_PARTITION = '23514';

export async function recordEvent(
  db: Database,
  e: RecordedEvent,
  retentionDays = 15,
): Promise<void> {
  const at = new Date(e.at);
  const values = {
    cluster_id: e.clusterId,
    org_id: e.orgId,
    day: at.toISOString().slice(0, 10) as unknown as Date,
    involved_key: e.key.slice(0, 640),
    reason: e.reason.slice(0, 128),
    namespace: e.namespace ?? '',
    involved_kind: e.kind,
    involved_name: e.name.slice(0, 512),
    involved_uid: '',
    host: e.host,
    type: e.type,
    message: e.message.slice(0, 1024),
    count: 1,
    event_counts: JSON.stringify({ [String(e.at)]: 1 }),
    first_ts: at,
    last_ts: at,
    reporting_controller: e.source,
  };
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
    await ensureEventPartitions(db, retentionDays, at);
    await upsert();
  }
}
