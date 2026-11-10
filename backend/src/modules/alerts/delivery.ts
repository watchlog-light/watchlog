// SPDX-License-Identifier: AGPL-3.0-only
// The outbox sender (ADR-074): claims due notifications with FOR UPDATE SKIP LOCKED and
// a lease, so two workers never send the same row; retries with back-off; records the
// result on the row and the channel. Also the synchronous "send test" (ADR-080).
import { sql, type Selectable } from 'kysely';
import type { Database } from '../../db/index.js';
import type { AlertChannels, Notifications } from '../../db/types.js';
import { decryptJson } from '../../lib/secrets.js';
import {
  DeliveryError,
  deliver,
  type ChannelTarget,
  type ChannelType,
  type HttpClient,
} from './channels.js';
import { attachCauses, type WorkOut } from './likely-cause.js';
import type { MessagePayload } from './outbox.js';
import { testPayload } from './render.js';
import type { AlertingSettings } from '../settings/service.js';

export const MAX_ATTEMPTS = 8;
export const LEASE_MS = 60_000;
const BATCH = 20;

export interface DeliveryDeps {
  db: Database;
  secretKey: Buffer;
  http: HttpClient;
  /** The public address, email server and Telegram settings in effect (ADR-093). */
  settings: () => Promise<AlertingSettings>;
  log: { warn(obj: object, msg: string): void; info?(obj: object, msg: string): void };
  /**
   * Probable cause for the firing alerts (ADR-157; the worker's in-process app): without it,
   * messages go without the likely cause.
   */
  causes?: WorkOut;
}

/** 30 s, 1 min, 2 min … capped at 1 h. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** (attempt - 1), 3_600_000);
}

export function channelTarget(row: Selectable<AlertChannels>, key: Buffer): ChannelTarget {
  return {
    id: row.id,
    type: row.type as ChannelType,
    name: row.name,
    config: row.config as Record<string, unknown>,
    secret: row.secret ? decryptJson(key, row.secret) : {},
  };
}

export interface DeliveryReport {
  sent: number;
  retried: number;
  failed: number;
  /** Dropped before sending: their alerts resolved, or their firing was never delivered (ADR-090). */
  dropped: number;
  /** Resolve messages waiting for a firing message still in flight (ADR-090). */
  deferred: number;
}

const FIRING_KINDS = ['firing', 'escalated', 'renotify', 'flapping'];
/** How long a resolve waits for a firing message of the same alerts that is in flight. */
export const DEFER_MS = 5_000;

type Plan =
  | { action: 'send'; payload: MessagePayload }
  | { action: 'drop'; reason: string }
  | { action: 'defer'; until: number };

function only(p: MessagePayload, keep: Set<string>): MessagePayload {
  return { ...p, items: p.items.filter((i) => keep.has(i.alertId)), total: keep.size };
}

/**
 * ADR-090: a firing message never arrives after its resolve. A firing message leaves
 * out alerts that have resolved since it was queued (dropped when none are left). A
 * resolve message waits while a firing message of its alerts is in flight on the
 * channel, then goes out only for alerts whose firing message was delivered (ADR-077).
 * When both are still queued, neither is sent.
 */
async function plan(db: Database, n: Selectable<Notifications>, now: number): Promise<Plan> {
  const payload = n.payload as unknown as MessagePayload;
  const links = await db
    .selectFrom('notification_alerts as na')
    .leftJoin('alert_states as s', 's.id', 'na.alert_state_id')
    .select(['na.alert_state_id as id', 's.state'])
    .where('na.notification_id', '=', n.id)
    .execute();
  if (links.length === 0) return { action: 'send', payload };
  const ids = links.map((l) => l.id);

  if (FIRING_KINDS.includes(n.kind)) {
    const open = new Set(links.filter((l) => l.state && l.state !== 'resolved').map((l) => l.id));
    if (open.size === links.length) return { action: 'send', payload };
    if (open.size === 0) return { action: 'drop', reason: 'resolved before it was sent' };
    return { action: 'send', payload: only(payload, open) };
  }
  if (n.kind !== 'resolved') return { action: 'send', payload };

  const firing = await db
    .selectFrom('notifications as f')
    .innerJoin('notification_alerts as na', 'na.notification_id', 'f.id')
    .select(['f.id', 'f.status', 'f.next_attempt_at', 'na.alert_state_id'])
    .where('f.channel_id', '=', n.channel_id)
    .where('f.kind', 'in', FIRING_KINDS)
    .where('f.id', '<>', n.id)
    .where('na.alert_state_id', 'in', ids)
    .execute();
  const waiting = firing.filter((f) => f.status === 'pending' || f.status === 'sending');
  if (waiting.length) {
    // Settle them first: in flight, or due before long (a pending one is dropped or
    // trimmed when it is sent, since these alerts are resolved).
    const due = Math.min(...waiting.map((f) => new Date(f.next_attempt_at).getTime()));
    return { action: 'defer', until: Math.max(now + DEFER_MS, due + 1000) };
  }
  const delivered = new Set(firing.filter((f) => f.status === 'sent').map((f) => f.alert_state_id));
  const keep = new Set(ids.filter((id) => delivered.has(id)));
  if (keep.size === 0) return { action: 'drop', reason: 'no firing message was delivered' };
  return { action: 'send', payload: keep.size === ids.length ? payload : only(payload, keep) };
}

/** Sends every due notification once. Rows of one channel go in creation order. */
export async function deliverDue(deps: DeliveryDeps, now = Date.now()): Promise<DeliveryReport> {
  const { db } = deps;
  const report: DeliveryReport = { sent: 0, retried: 0, failed: 0, dropped: 0, deferred: 0 };
  const at = new Date(now);
  const claimed = await sql<Selectable<Notifications>>`
    UPDATE notifications
       SET status = 'sending', attempts = attempts + 1, lease_until = ${new Date(now + LEASE_MS)}
     WHERE id IN (
       SELECT id FROM notifications
        WHERE (status = 'pending' AND next_attempt_at <= ${at})
           OR (status = 'sending' AND lease_until < ${at})
        ORDER BY next_attempt_at, created_at
        LIMIT ${BATCH}
          FOR UPDATE SKIP LOCKED)
    RETURNING *`.execute(db);
  if (claimed.rows.length === 0) return report;
  // The likely cause, worked out when an alert fires (2 s at most, ADR-148), before sending.
  if (deps.causes) {
    await attachCauses(db, deps.causes, claimed.rows, {
      info: (o, m) => deps.log.info?.(o, m),
      warn: (o, m) => deps.log.warn(o, m),
    });
  }
  const settings = await deps.settings();

  const channels = await db
    .selectFrom('alert_channels')
    .selectAll()
    .where('id', 'in', [...new Set(claimed.rows.map((r) => r.channel_id))])
    .execute();
  const byChannel = new Map<string, Selectable<Notifications>[]>();
  for (const r of claimed.rows.sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at))) {
    byChannel.set(r.channel_id, [...(byChannel.get(r.channel_id) ?? []), r]);
  }

  await Promise.all(
    [...byChannel].map(async ([channelId, rows]) => {
      const row = channels.find((c) => c.id === channelId);
      for (const n of rows) {
        let error: DeliveryError | null = null;
        try {
          if (!row) throw new DeliveryError('channel deleted', true);
          const p = await plan(db, n, now);
          if (p.action !== 'send') {
            report[p.action === 'drop' ? 'dropped' : 'deferred']++;
            await settle(db, n, p);
            continue;
          }
          if (p.payload.total !== (n.payload as unknown as MessagePayload).total) {
            // The message no longer covers the alerts left out: their resolve must not follow.
            const keep = p.payload.items.map((i) => i.alertId);
            await db
              .deleteFrom('notification_alerts')
              .where('notification_id', '=', n.id)
              .where((eb) => (keep.length ? eb('alert_state_id', 'not in', keep) : eb.lit(true)))
              .execute();
          }
          await deliver(channelTarget(row, deps.secretKey), p.payload, {
            http: deps.http,
            ...settings,
            deliveryId: n.id,
            now: () => now,
          });
        } catch (err) {
          error =
            err instanceof DeliveryError ? err : new DeliveryError((err as Error).message, false);
        }
        const outcome = await finish(db, n, error, now);
        report[outcome]++;
        if (error) {
          deps.log.warn(
            { notification: n.id, channel: channelId, attempt: n.attempts, err: error.message },
            outcome === 'failed' ? 'notification failed' : 'notification will be retried',
          );
        }
      }
    }),
  );
  return report;
}

/** Records a drop, or puts a deferred row back without counting the attempt. */
async function settle(
  db: Database,
  n: Selectable<Notifications>,
  p: Extract<Plan, { action: 'drop' | 'defer' }>,
): Promise<void> {
  await db
    .updateTable('notifications')
    .set(
      p.action === 'drop'
        ? { status: 'dropped', error: p.reason, lease_until: null }
        : {
            status: 'pending',
            attempts: n.attempts - 1,
            lease_until: null,
            next_attempt_at: new Date(p.until),
          },
    )
    .where('id', '=', n.id)
    .where('status', '=', 'sending')
    .where('attempts', '=', n.attempts)
    .execute();
}

async function finish(
  db: Database,
  n: Selectable<Notifications>,
  error: DeliveryError | null,
  now: number,
): Promise<'sent' | 'retried' | 'failed'> {
  const outcome: 'sent' | 'retried' | 'failed' = !error
    ? 'sent'
    : error.permanent || n.attempts >= MAX_ATTEMPTS
      ? 'failed'
      : 'retried';
  const at = new Date(now);
  // Only the holder of this attempt's lease may record its result.
  await db
    .updateTable('notifications')
    .set({
      status: outcome === 'sent' ? 'sent' : outcome === 'failed' ? 'failed' : 'pending',
      error: error?.message.slice(0, 1000) ?? null,
      sent_at: outcome === 'sent' ? at : null,
      lease_until: null,
      next_attempt_at: outcome === 'retried' ? new Date(now + backoffMs(n.attempts)) : at,
    })
    .where('id', '=', n.id)
    .where('status', '=', 'sending')
    .where('attempts', '=', n.attempts)
    .execute();
  await db
    .updateTable('alert_channels')
    .set(
      error
        ? { last_error: error.message.slice(0, 1000), last_error_at: at }
        : { last_sent_at: at, last_error: null, last_error_at: null },
    )
    .where('id', '=', n.channel_id)
    .execute();
  return outcome;
}

/** "Send test" (ADR-080): one message now, the provider's error returned as is. */
export async function sendTest(
  deps: DeliveryDeps,
  channelId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const row = await deps.db
    .selectFrom('alert_channels')
    .selectAll()
    .where('id', '=', channelId)
    .executeTakeFirstOrThrow();
  try {
    await deliver(channelTarget(row, deps.secretKey), testPayload(), {
      http: deps.http,
      ...(await deps.settings()),
      deliveryId: `test-${Date.now()}`,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
