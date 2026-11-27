// SPDX-License-Identifier: AGPL-3.0-only
// One RabbitMQ queue's page (1.1.0, ADR-243), at its own address: its tiles, depth against
// what is usual (with What changed), in against acked and redelivered, consumers and how busy,
// what happened around it (consumer changes, the clients that ended, its alerts), the probable
// cause, its facts and the alerts on it. RabbitMQ doesn't say which client consumes which
// queue: the cause is the client that left when the consumers did, said as such.
import { sql } from 'kysely';
import { usualBands, usualWindow } from '../../anomaly/usual.js';
import { endedClients, lastConsumedAt, queueGrowth } from './rabbitmq.js';
import { esc, queueRows, watermarkIn } from './rabbitmq-queues.js';
import { P } from './rabbitmq-tabs.js';
import { instant, one, pointsOf, range, valueOf, windowOf } from './query.js';
import type {
  CausePanel,
  Panel,
  PageContext,
  Point,
  QueueAlertsPanel,
  Severity,
  TimelinePanel,
} from './types.js';

/** The alerts a queue's page offers to add (scope: this service and this queue). */
export const QUEUE_PRESETS: QueueAlertsPanel['presets'] = [
  {
    key: 'unconsumed',
    nameKey: `${P}.queueAlerts.unconsumed`,
    metric: 'rabbitmq.queue.unconsumed',
    op: '>',
    value: 0,
    forSeconds: 300,
    severity: 'critical',
  },
  {
    key: 'depth',
    nameKey: `${P}.queueAlerts.depth`,
    metric: 'rabbitmq.queue.ready',
    op: '>',
    value: 5000,
    forSeconds: 300,
    severity: 'warning',
  },
  // Dead letters aren't counted per source queue: a dead-letter queue's own arrivals are.
  {
    key: 'dead_letters',
    nameKey: `${P}.queueAlerts.deadLetters`,
    metric: 'rabbitmq.queue.in.rate',
    op: '>',
    value: 0,
    forSeconds: 300,
    severity: 'warning',
  },
];

export async function queuePage(ctx: PageContext): Promise<Panel[]> {
  const vhost = ctx.params?.vhost ?? '/';
  const queue = ctx.params?.queue;
  if (!queue) return [];
  const q = `${one(ctx.row.id)},vhost="${esc(vhost)}",queue="${esc(queue)}"`;
  const [
    rows,
    growthAll,
    lostAt,
    acks,
    ackLast,
    ready,
    unacked,
    inLine,
    ackLine,
    redLine,
    consLine,
    busyLine,
    info,
    raftTerm,
    raftLatency,
    onDisk,
    redHour,
  ] = await Promise.all([
    queueRows(ctx, { vhost, queue }),
    queueGrowth(ctx),
    lastConsumedAt(ctx, `vhost="${esc(vhost)}",queue="${esc(queue)}"`),
    instant(ctx, `sum(rate(rabbitmq_detailed_queue_messages_acked_total{${q}}[5m]))`),
    lastPositive(ctx, `sum(rate(rabbitmq_detailed_queue_messages_acked_total{${q}}[5m]))`),
    range(ctx, `sum(rabbitmq_detailed_queue_messages_ready{${q}})`),
    range(ctx, `sum(rabbitmq_detailed_queue_messages_unacked{${q}})`),
    range(ctx, `sum(rate(rabbitmq_detailed_queue_exchange_messages_published_total{${q}}[5m]))`),
    range(ctx, `sum(rate(rabbitmq_detailed_queue_messages_acked_total{${q}}[5m]))`),
    range(ctx, `sum(rate(rabbitmq_detailed_queue_messages_redelivered_total{${q}}[5m]))`),
    range(ctx, `sum(rabbitmq_detailed_queue_consumers{${q}})`),
    range(ctx, `max(rabbitmq_detailed_queue_consumer_utilisation{${q}})`),
    instant(ctx, `max by (member, type, membership) (rabbitmq_detailed_queue_info{${q}})`),
    instant(ctx, `count(max by (member) (rabbitmq_detailed_raft_term_total{${q}}))`),
    instant(ctx, `max(rabbitmq_detailed_raft_entry_commit_latency_seconds{${q}})`),
    instant(ctx, `max(rabbitmq_detailed_queue_messages_persistent_bytes{${q}})`),
    instant(ctx, `sum(increase(rabbitmq_detailed_queue_messages_redelivered_total{${q}}[1h]))`),
  ]);
  const row = rows[0];
  if (!row) {
    return [
      {
        id: 'missing',
        title: `${P}.queueMissing`,
        kind: 'facts',
        span: 2,
        state: 'empty',
        note: { key: `${P}.queueMissingNote`, values: { queue: queue } },
        rows: [],
      },
    ];
  }
  const name = row.name;
  const growth = growthAll.get(name) ?? 0;
  const eta = growth > 0.05 ? await watermarkIn(ctx) : null;
  const ended = await endedClients(ctx, lostAt).catch(() => []);
  const wasConsumers = await instant(
    ctx,
    `max_over_time(sum(rabbitmq_detailed_queue_consumers{${q}})[6h:1m])`,
  );
  const acking = (valueOf(acks) ?? 0) > 0.01;

  const tiles: Panel = {
    id: 'summary',
    title: `${P}.summary`,
    kind: 'stat',
    span: 2,
    state: 'ok',
    tiles: [
      {
        id: 'ready',
        labelKey: `${P}.ready`,
        value: row.ready,
        unit: 'count',
        ...(Math.abs(growth) >= 0.05
          ? {
              sub: {
                key: growth > 0 ? `${P}.growing` : `${P}.draining`,
                values: { n: Math.round(Math.abs(growth) * 60) },
              },
            }
          : {}),
        ...(growth > 0.5 ? { severity: 'warning' as Severity } : {}),
        ...(row.severity === 'critical' ? { severity: 'critical' as Severity } : {}),
      },
      {
        id: 'unacked',
        labelKey: `${P}.unacked`,
        value: row.unacked,
        unit: 'count',
        ...(row.unacked === 0 ? { sub: { key: `${P}.noneHeld` } } : {}),
      },
      {
        id: 'consumers',
        labelKey: `${P}.consumers`,
        value: row.consumers,
        unit: 'count',
        ...(row.consumers === 0 && (valueOf(wasConsumers) ?? 0) > 0
          ? {
              sub: { key: `${P}.wasUntil`, values: { n: valueOf(wasConsumers), at: lostAt } },
              severity: 'critical' as Severity,
            }
          : row.busy !== null
            ? { sub: { key: `${P}.busyPct`, values: { pct: Math.round(row.busy * 100) } } }
            : {}),
      },
      {
        id: 'lastAck',
        labelKey: `${P}.lastAck`,
        value: acking ? null : ackLast,
        unit: 'seconds',
        sub: {
          key: acking ? `${P}.ackingNow` : ackLast === null ? `${P}.noAck6h` : `${P}.sinceLastAck`,
        },
        ...(acking || ackLast === null ? {} : { severity: 'warning' as Severity }),
      },
      {
        id: 'drain',
        labelKey: eta !== null ? `${P}.fillsMemory` : `${P}.drainsIn`,
        value: eta ?? (row.drain.state === 'eta' ? row.drain.seconds : null),
        unit: 'seconds',
        sub: {
          key: eta !== null ? `${P}.atThisRate` : `${P}.drain.${row.drain.state}`,
        },
        ...(eta !== null && eta < 4 * 3600 ? { severity: 'warning' as Severity } : {}),
      },
    ],
  };

  const marker = lostAt
    ? [{ at: lostAt, text: { key: `${P}.markerLost` }, severity: 'critical' as Severity }]
    : [];
  const band = await usualBand(ctx, `sum(rabbitmq_detailed_queue_messages_ready{${q}})`);
  const before = lostAt ? busyBefore(busyLine[0]?.points ?? [], lostAt) : null;

  const typeRow = info[0]?.labels.type ?? row.type;
  const leader = info.find((i) => i.labels.membership === 'leader')?.labels.member ?? null;
  const members = valueOf(raftTerm);
  const facts: Panel = {
    id: 'facts',
    title: `${P}.thisQueue`,
    kind: 'facts',
    span: 1,
    state: 'ok',
    rows: [
      { labelKey: `${P}.fact.type`, value: typeRow ?? null },
      ...(name !== queue ? [{ labelKey: `${P}.fact.vhost`, value: vhost }] : []),
      ...(leader ? [{ labelKey: `${P}.fact.leader`, value: leader }] : []),
      ...(typeRow === 'quorum' && members
        ? [
            {
              labelKey: `${P}.fact.members`,
              value: null,
              text: { key: `${P}.fact.membersN`, values: { n: members } },
            },
          ]
        : []),
      ...(valueOf(raftLatency) !== null
        ? [
            {
              labelKey: `${P}.fact.commitLatency`,
              value: valueOf(raftLatency),
              unit: 'seconds' as const,
            },
          ]
        : []),
      ...(valueOf(onDisk) !== null
        ? [{ labelKey: `${P}.fact.onDisk`, value: valueOf(onDisk), unit: 'bytes' as const }]
        : []),
      ...(row.busy !== null
        ? [{ labelKey: `${P}.fact.busy`, value: row.busy, unit: 'ratio' as const }]
        : []),
      ...(valueOf(redHour) !== null
        ? [
            {
              labelKey: `${P}.fact.redelivered`,
              value: Math.round(valueOf(redHour)!),
              unit: 'count' as const,
            },
          ]
        : []),
    ],
  };

  const first = ended[0];
  const cause: CausePanel = {
    id: 'cause',
    title: `${P}.probableCause`,
    kind: 'cause',
    span: 1,
    state: 'ok',
    text:
      row.consumers === 0 && row.ready > 0 && first
        ? { key: `${P}.causeEnded`, values: { name: first.name, how: first.how, at: first.at } }
        : row.drain.state === 'growing' && row.busy !== null && row.busy > 0.9
          ? { key: `${P}.causeSlow`, values: { pct: Math.round(row.busy * 100) } }
          : null,
    caveat: { key: `${P}.causeCaveat` },
    links:
      first && row.consumers === 0 ? [{ kind: first.kind, id: first.id, name: first.name }] : [],
  };

  return [
    tiles,
    {
      id: 'depth',
      title: `${P}.depth`,
      kind: 'line',
      span: 2,
      unit: 'count',
      state: ready.length ? 'ok' : 'empty',
      ...(marker.length ? { markers: marker } : {}),
      ...(band ? { band, note: { key: `${P}.usualBandNote` } } : {}),
      series: [
        { nameKey: `${P}.series.ready`, points: pointsOf(ready[0]) },
        { nameKey: `${P}.series.unacked`, points: pointsOf(unacked[0]), severity: 'warning' },
      ],
    },
    {
      id: 'inOut',
      title: `${P}.inOut`,
      kind: 'line',
      span: 1,
      unit: 'per_second',
      state: inLine.length || ackLine.length ? 'ok' : 'empty',
      ...(marker.length ? { markers: marker } : {}),
      series: [
        { nameKey: `${P}.series.published`, points: pointsOf(inLine[0]) },
        { nameKey: `${P}.series.ack`, points: pointsOf(ackLine[0]) },
        { nameKey: `${P}.series.redeliver`, points: pointsOf(redLine[0]), severity: 'warning' },
      ],
    },
    {
      id: 'consumers',
      title: `${P}.consumersBusy`,
      kind: 'line',
      span: 1,
      unit: 'ratio',
      state: busyLine.length ? 'ok' : 'empty',
      ...(before !== null && before > 0.9 ? { note: { key: `${P}.busyBeforeDrop` } } : {}),
      series: [{ nameKey: `${P}.series.busy`, points: pointsOf(busyLine[0]) }],
    },
    {
      id: 'consumerCount',
      title: `${P}.consumerCount`,
      kind: 'line',
      span: 1,
      unit: 'count',
      state: consLine.length ? 'ok' : 'empty',
      series: [{ nameKey: `${P}.series.consumers`, points: pointsOf(consLine[0]) }],
    },
    await timeline(
      ctx,
      name,
      vhost,
      queue,
      consLine[0]?.points ?? [],
      busyLine[0]?.points ?? [],
      ended,
    ),
    cause,
    facts,
    await alertsOn(ctx, vhost, queue),
  ];
}

/** When an expression was last above zero, within 6 hours: seconds ago, or null. */
async function lastPositive(ctx: PageContext, expr: string): Promise<number | null> {
  if (!ctx.vm) return null;
  const end = Math.floor(ctx.now / 1000);
  const rows = await ctx.vm.queryRange(ctx.scope, expr, end - 6 * 3600, end, 60);
  const pts = rows[0]?.points ?? [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const [t, v] = pts[i]!;
    if (v !== null && v > 0.01) return end - t;
  }
  return null;
}

/** The highest utilisation in the 30 minutes before the consumers left. */
export function busyBefore(points: Point[], lostAt: number): number | null {
  let max: number | null = null;
  for (const [t, v] of points) {
    if (v === null || t > lostAt || t < lostAt - 1800) continue;
    max = max === null ? v : Math.max(max, v);
  }
  return max;
}

/** The usual band of a series over the page's window, hour by hour (What changed only). */
async function usualBand(ctx: PageContext, expr: string) {
  if (!ctx.usual || !ctx.vm) return null;
  const w = windowOf(ctx.range, ctx.now);
  const { start } = usualWindow(w.start * 1000);
  const rows = await ctx.vm.queryRange(ctx.scope, expr, start / 1000, w.end, 600);
  const points: Array<[number, number]> = [];
  for (const r of rows) for (const [t, v] of r.points) if (v !== null) points.push([t * 1000, v]);
  const HOUR = 3_600_000;
  const bands = usualBands(
    points,
    Math.floor((w.start * 1000) / HOUR) * HOUR,
    Math.floor((w.end * 1000) / HOUR) * HOUR,
    'count',
    600,
  ).filter((b) => !b.learning);
  if (!bands.length) return null;
  const low: Point[] = [];
  const high: Point[] = [];
  for (const b of bands) {
    for (const t of [b.t, b.t + HOUR - 1000]) {
      low.push([Math.floor(t / 1000), b.low]);
      high.push([Math.floor(t / 1000), b.high]);
    }
  }
  return { low, high };
}

/**
 * What happened around the queue, oldest first, from what WatchLog already has: its
 * consumer count changing, its consumers turning busy, the clients that ended (OOM-killed,
 * crash-looping, exited), and its alerts firing and resolving.
 */
export async function timeline(
  ctx: PageContext,
  name: string,
  vhost: string,
  queue: string,
  consumers: Point[],
  busy: Point[],
  ended: Awaited<ReturnType<typeof endedClients>>,
): Promise<TimelinePanel> {
  const from = ctx.now / 1000 - ctx.range;
  const events: TimelinePanel['events'] = [];
  let prev: number | null = null;
  for (const [t, v] of consumers) {
    if (v === null) continue;
    if (prev !== null && v !== prev)
      events.push({
        at: t,
        text: { key: `${P}.event.consumers`, values: { from: prev, to: v } },
        sourceKey: `${P}.source.rabbitmq`,
        severity: v === 0 ? 'critical' : v < prev ? 'warning' : 'ok',
      });
    prev = v;
  }
  let wasBusy = false;
  for (const [t, v] of busy) {
    if (v === null) continue;
    if (!wasBusy && v >= 0.95) {
      events.push({
        at: t,
        text: { key: `${P}.event.busy`, values: { pct: Math.round(v * 100) } },
        sourceKey: `${P}.source.rabbitmq`,
        severity: 'warning',
      });
      wasBusy = true;
    } else if (wasBusy && v < 0.8) wasBusy = false;
  }
  for (const e of ended) {
    if (e.at === null || e.at < from) continue;
    events.push({
      at: e.at,
      text: { key: `${P}.event.ended`, values: { name: e.name, how: e.how } },
      sourceKey: e.kind === 'workload' ? `${P}.source.kubernetes` : `${P}.source.docker`,
      severity: 'critical',
      link: { kind: e.kind, id: e.id, name: e.name },
    });
  }
  // This service's alerts: the queue's own, and the broker's that name it or no queue.
  const alerts = await ctx.db
    .selectFrom('alert_states')
    .innerJoin('alert_rules', 'alert_rules.id', 'alert_states.rule_id')
    .select([
      'alert_rules.name',
      'alert_states.labels',
      'alert_states.fired_at',
      'alert_states.resolved_at',
      'alert_states.severity',
    ])
    .where('alert_states.cluster_id', '=', ctx.row.cluster_id)
    .where(sql<boolean>`alert_rules.scope->>'service' = ${ctx.row.id}`)
    .where('alert_states.fired_at', 'is not', null)
    .where((eb) =>
      eb.or([
        eb('alert_states.resolved_at', 'is', null),
        eb('alert_states.resolved_at', '>', new Date(from * 1000)),
      ]),
    )
    .limit(50)
    .execute();
  for (const a of alerts) {
    const l = (a.labels ?? {}) as Record<string, string>;
    if (l.queue && (l.queue !== queue || (l.vhost ?? '/') !== vhost)) continue;
    const fired = a.fired_at ? new Date(a.fired_at).getTime() / 1000 : null;
    if (fired !== null && fired >= from)
      events.push({
        at: fired,
        text: { key: `${P}.event.alertFired`, values: { name: a.name } },
        sourceKey: `${P}.source.alerts`,
        severity: a.severity === 'critical' ? 'critical' : 'warning',
      });
    const resolved = a.resolved_at ? new Date(a.resolved_at).getTime() / 1000 : null;
    if (resolved !== null && resolved >= from)
      events.push({
        at: resolved,
        text: { key: `${P}.event.alertResolved`, values: { name: a.name } },
        sourceKey: `${P}.source.alerts`,
        severity: 'ok',
      });
  }
  events.sort((a, b) => a.at - b.at);
  return {
    id: 'timeline',
    title: `${P}.whatHappened`,
    kind: 'timeline',
    span: 1,
    state: events.length ? 'ok' : 'empty',
    note: { key: `${P}.whatHappenedNote`, values: { queue: name } },
    events: events.slice(-30),
  };
}

/** The alerts scoped to this queue, firing or quiet, and the ones the page can add. */
async function alertsOn(ctx: PageContext, vhost: string, queue: string): Promise<QueueAlertsPanel> {
  const rules = await ctx.db
    .selectFrom('alert_rules')
    .select(['id', 'name', 'enabled'])
    .where(sql<boolean>`scope->>'service' = ${ctx.row.id}`)
    .where(sql<boolean>`scope->'queue'->>'name' = ${queue}`)
    .where(sql<boolean>`coalesce(scope->'queue'->>'vhost', '/') = ${vhost}`)
    .orderBy('name')
    .execute();
  const firing = rules.length
    ? await ctx.db
        .selectFrom('alert_states')
        .select('rule_id')
        .where(
          'rule_id',
          'in',
          rules.map((r) => r.id),
        )
        .where('state', '=', 'firing')
        .execute()
    : [];
  const on = new Set(firing.map((f) => f.rule_id));
  return {
    id: 'alerts',
    title: `${P}.queueAlerts.title`,
    kind: 'queue_alerts',
    span: 2,
    state: 'ok',
    vhost,
    queue,
    rules: rules.map((r) => ({
      id: r.id,
      name: r.name,
      state: !r.enabled ? 'off' : on.has(r.id) ? 'firing' : 'quiet',
    })),
    presets: QUEUE_PRESETS,
  };
}
