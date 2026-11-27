// SPDX-License-Identifier: AGPL-3.0-only
// RabbitMQ's queues as rows (1.1.0, ADR-243): type, ready, unacked, in and out per second,
// consumers and how busy they are, and how long the queue takes to drain. Shared by the
// Overview, the Queues tab, the queue's page, the API and MCP. The collector keeps the
// 200 deepest queues of each node and every queue with messages and no consumer.
import { instant, one } from './query.js';
import type { QuerySeries } from '../../../lib/victoria.js';
import type { PageContext, QueueRow, Severity } from './types.js';

export const QBY = 'vhost, queue';
export const UNACKED_HIGH = 10_000;
/** Below this net rate (messages a second) a queue neither drains nor grows. */
const STILL = 0.01;

/** "orders", or "billing/orders" outside the default vhost. */
export const queueName = (l: Record<string, string>) =>
  !l.vhost || l.vhost === '/' ? (l.queue ?? '') : `${l.vhost}/${l.queue ?? ''}`;

const keyOf = (l: Record<string, string>) => `${l.vhost ?? '/'}\u0000${l.queue ?? ''}`;

/**
 * How long a queue takes to drain: ready ÷ (out − in) when it shrinks. Otherwise why it
 * doesn't: no messages, a stream (it keeps what it holds), nothing takes from it (never), or
 * more comes in than goes out (growing).
 */
export function drainOf(row: {
  ready: number;
  in: number | null;
  out: number | null;
  consumers: number | null;
  type: QueueRow['type'];
}): QueueRow['drain'] {
  if (row.type === 'stream') return { state: 'stream' };
  if (row.ready <= 0) return { state: 'empty' };
  const net = (row.out ?? 0) - (row.in ?? 0);
  if (net > STILL) return { state: 'eta', seconds: Math.round(row.ready / net) };
  if (!row.consumers || (row.out ?? 0) <= STILL) return { state: 'never' };
  return { state: 'growing' };
}

/** A queue named like a dead-letter queue (`orders.dlq`, `orders-dead-letter`). */
export const DLQ = /dead.?letter|\.dlq|\.dlx|-dlq|_dlq/i;

/**
 * A queue that needs a look: nothing consumes it, it grows, or holds many unacked. A
 * dead-letter queue without a consumer is usual (a warning: its dead letters are), a stream
 * keeps what it holds (never a problem for that).
 */
export function severityOf(row: Omit<QueueRow, 'severity'>): Severity | undefined {
  if (row.type !== 'stream' && row.ready > 0 && row.consumers === 0)
    return DLQ.test(row.queue) ? 'warning' : 'critical';
  // Consumers that can't keep up (1.1.1): 95% busy or more, with messages waiting.
  if (row.consumers && row.busy !== null && row.busy >= 0.95 && row.ready > 0) return 'warning';
  if (row.drain.state === 'growing' && row.ready > 1000) return 'warning';
  if (row.unacked > UNACKED_HIGH) return 'warning';
  if (row.drain.state === 'never' && row.ready > 0 && row.type !== 'stream') return 'warning';
  return undefined;
}

const SEV = { critical: 0, warning: 1, info: 2, ok: 3 } as const;
/** The worst first, then the deepest. */
export const byNeed = (a: QueueRow, b: QueueRow) =>
  (SEV[a.severity ?? 'ok'] ?? 3) - (SEV[b.severity ?? 'ok'] ?? 3) ||
  b.ready + b.unacked - (a.ready + a.unacked) ||
  a.name.localeCompare(b.name);

/** Every queue the collector sends, now, as rows (the worst and deepest first). */
export async function queueRows(
  ctx: PageContext,
  only?: { vhost: string; queue: string },
): Promise<QueueRow[]> {
  const s = only
    ? `${one(ctx.row.id)},vhost="${esc(only.vhost)}",queue="${esc(only.queue)}"`
    : one(ctx.row.id);
  const [ready, unacked, consumers, busy, inRate, outRate, types] = await Promise.all([
    instant(ctx, `sum by (${QBY}) (rabbitmq_detailed_queue_messages_ready{${s}})`),
    instant(ctx, `sum by (${QBY}) (rabbitmq_detailed_queue_messages_unacked{${s}})`),
    instant(ctx, `sum by (${QBY}) (rabbitmq_detailed_queue_consumers{${s}})`),
    instant(ctx, `max by (${QBY}) (rabbitmq_detailed_queue_consumer_utilisation{${s}})`),
    instant(
      ctx,
      `sum by (${QBY}) (rate(rabbitmq_detailed_queue_exchange_messages_published_total{${s}}[2m]))`,
    ),
    instant(
      ctx,
      `sum by (${QBY}) (rate({__name__=~"rabbitmq_detailed_queue_messages_delivered(_ack)?_total",${s}}[2m]))`,
    ),
    instant(ctx, `max by (${QBY}, type) (rabbitmq_detailed_queue_info{${s}})`),
  ]);
  const at = (rows: QuerySeries[]) =>
    new Map(rows.map((r) => [keyOf(r.labels), r.points[0]?.[1] ?? null]));
  const [u, c, b, i, o] = [at(unacked), at(consumers), at(busy), at(inRate), at(outRate)];
  const t = new Map(types.map((r) => [keyOf(r.labels), r.labels.type ?? null]));
  // A queue with only some series (a new one) still has a row.
  const seen = new Map<string, Record<string, string>>();
  for (const r of [...ready, ...consumers, ...unacked]) seen.set(keyOf(r.labels), r.labels);
  const readyBy = at(ready);
  const rows: QueueRow[] = [];
  for (const [k, l] of seen) {
    const type = (t.get(k) ?? null) as QueueRow['type'];
    const base = {
      vhost: l.vhost ?? '/',
      queue: l.queue ?? '',
      name: queueName(l),
      type: type === 'classic' || type === 'quorum' || type === 'stream' ? type : null,
      ready: Math.round(readyBy.get(k) ?? 0),
      unacked: Math.round(u.get(k) ?? 0),
      in: round2(i.get(k) ?? null),
      out: round2(o.get(k) ?? null),
      consumers: c.get(k) ?? null,
      // RabbitMQ's consumer utilisation is the share of time the queue can deliver at once: 1
      // means the consumers keep up. Busy is the rest (1.1.1), and only with consumers.
      busy: busyOf(b.get(k) ?? null, c.get(k) ?? null),
    };
    const row = { ...base, drain: drainOf(base) };
    const severity = severityOf(row);
    rows.push(severity ? { ...row, severity } : row);
  }
  return rows.sort(byNeed);
}

/**
 * When the first node reaches its memory high watermark at the last 15 minutes' growth
 * (seconds from now), or null when memory isn't growing. The finding and the queue's page
 * say "reaches the memory watermark in about 2 h 40 min".
 */
export async function watermarkIn(ctx: PageContext): Promise<number | null> {
  const s = one(ctx.row.id);
  const rows = await instant(
    ctx,
    `min((max by (member) (rabbitmq_resident_memory_limit_bytes{${s}}) - max by (member) (rabbitmq_process_resident_memory_bytes{${s}})) / (max by (member) (deriv(rabbitmq_process_resident_memory_bytes{${s}}[15m])) > 0))`,
  );
  const v = rows[0]?.points[0]?.[1];
  return v === undefined || v === null || !Number.isFinite(v) || v < 0 || v > WATERMARK_HORIZON
    ? null
    : Math.round(v);
}

/** How busy the consumers are: 1 − RabbitMQ's consumer utilisation, with consumers only. */
export function busyOf(utilisation: number | null, consumers: number | null): number | null {
  if (utilisation === null || !consumers) return null;
  return Math.round(Math.min(1, Math.max(0, 1 - utilisation)) * 100) / 100;
}

/** Beyond a week a memory clock says nothing useful ("in about 1881 d"): no clock then. */
export const WATERMARK_HORIZON = 7 * 86_400;

const round2 = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);
export const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
