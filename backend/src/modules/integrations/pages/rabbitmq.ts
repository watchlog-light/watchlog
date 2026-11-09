// SPDX-License-Identifier: AGPL-3.0-only
// The RabbitMQ page (SPEC §4.12, v0.3 slice 11): Overview, Queues, Message rates and
// Resources, from the rabbitmq_prometheus series the collector reads on every node (node
// totals; per queue `rabbitmq_detailed_queue_*`, the 200 deepest and every idle queue
// with messages). Reasons: a queue growing with no consumers, linked to the clients
// that were connected to RabbitMQ and ended (OOM-killed, crash-looping, exited) when
// it lost them; a queue growing anyway; memory and disk alarms; unacked messages;
// dead letters; and the plugin check.
import { genericPage } from './generic.js';
import { destination, ownComponents, SOURCE } from './connected.js';
import { ago, bytes } from './owners.js';
import { instant, one, pointsOf, range, some, SPARK_RANGE, valueOf } from './query.js';
import type { QuerySeries } from '../../../lib/victoria.js';
import type { IntegrationPage, PageContext, Panel, Reason, RowMetrics, Severity } from './types.js';

const P = 'integrations.rabbitmq.panels';
const RATE = '2m';
const DAY = 86_400;
const UNACKED_HIGH = 10_000;

interface Node {
  member?: string;
  node?: string;
  cluster?: string;
  plugin?: boolean;
}
const nodes = (ctx: PageContext): Node[] =>
  (ctx.row.status_details as { extra?: { rabbitmq?: Node[] } } | null)?.extra?.rabbitmq ?? [];

/** "orders", or "billing/orders" outside the default vhost. */
export const queueName = (l: Record<string, string>) =>
  !l.vhost || l.vhost === '/' ? (l.queue ?? '') : `${l.vhost}/${l.queue ?? ''}`;

const at = (rows: QuerySeries[], l: Record<string, string>) =>
  rows.find((r) => queueName(r.labels) === queueName(l))?.points[0]?.[1] ?? null;

const QBY = 'vhost, queue';

async function overview(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [
    ready,
    readyRate,
    unacked,
    publish,
    deliver,
    deliverPeak,
    consumers,
    consumersWas,
    memory,
    readyLine,
    unackedLine,
    publishLine,
    deliverLine,
    qReady,
    qUnacked,
    qConsumers,
    qPublish,
    qDeliver,
  ] = await Promise.all([
    instant(ctx, `sum(rabbitmq_queue_messages_ready{${s}})`),
    instant(ctx, `sum(deriv(rabbitmq_queue_messages_ready{${s}}[5m]))`),
    instant(ctx, `sum(rabbitmq_queue_messages_unacked{${s}})`),
    instant(ctx, `sum(rate(rabbitmq_global_messages_received_total{${s}}[${RATE}]))`),
    instant(ctx, `sum(rate(rabbitmq_global_messages_delivered_total{${s}}[${RATE}]))`),
    instant(
      ctx,
      `max_over_time(sum(rate(rabbitmq_global_messages_delivered_total{${s}}[${RATE}]))[1h:1m])`,
    ),
    instant(ctx, `sum(rabbitmq_consumers{${s}})`),
    instant(ctx, `max_over_time(sum(rabbitmq_consumers{${s}})[1h:1m])`),
    instant(
      ctx,
      `max(rabbitmq_process_resident_memory_bytes{${s}} / (rabbitmq_resident_memory_limit_bytes{${s}} > 0))`,
    ),
    range(ctx, `sum(rabbitmq_queue_messages_ready{${s}})`),
    range(ctx, `sum(rabbitmq_queue_messages_unacked{${s}})`),
    range(ctx, `sum(rate(rabbitmq_global_messages_received_total{${s}}[${RATE}]))`),
    range(ctx, `sum(rate(rabbitmq_global_messages_delivered_total{${s}}[${RATE}]))`),
    instant(ctx, `sum by (${QBY}) (rabbitmq_detailed_queue_messages_ready{${s}})`),
    instant(ctx, `sum by (${QBY}) (rabbitmq_detailed_queue_messages_unacked{${s}})`),
    instant(ctx, `sum by (${QBY}) (rabbitmq_detailed_queue_consumers{${s}})`),
    instant(
      ctx,
      `sum by (${QBY}) (rate(rabbitmq_detailed_queue_exchange_messages_published_total{${s}}[5m]))`,
    ),
    instant(
      ctx,
      `sum by (${QBY}) (rate({__name__=~"rabbitmq_detailed_queue_messages_delivered(_ack)?_total",${s}}[5m]))`,
    ),
  ]);
  const d = valueOf(deliver);
  const dPeak = valueOf(deliverPeak);
  const c = valueOf(consumers);
  const cWas = valueOf(consumersWas);
  const mem = valueOf(memory);
  const rr = valueOf(readyRate);
  const queues = qReady
    .map((q) => ({
      labels: q.labels,
      ready: q.points[0]?.[1] ?? 0,
      unacked: at(qUnacked, q.labels) ?? 0,
      consumers: at(qConsumers, q.labels),
      publish: at(qPublish, q.labels),
      deliver: at(qDeliver, q.labels),
    }))
    .sort((a, b) => b.ready + b.unacked - (a.ready + a.unacked))
    .slice(0, 50);
  return [
    {
      id: 'summary',
      title: `${P}.summary`,
      kind: 'stat',
      span: 2,
      state: valueOf(ready) === null ? 'empty' : 'ok',
      tiles: [
        {
          id: 'ready',
          labelKey: `${P}.ready`,
          value: valueOf(ready),
          unit: 'count',
          sub:
            rr !== null && Math.abs(rr) >= 0.05
              ? { key: rr > 0 ? `${P}.growing` : `${P}.draining`, values: { n: perMin(rr) } }
              : undefined,
          severity: rr !== null && rr > 0.5 ? 'warning' : undefined,
        },
        {
          id: 'unacked',
          labelKey: `${P}.unacked`,
          value: valueOf(unacked),
          unit: 'count',
          severity: (valueOf(unacked) ?? 0) > UNACKED_HIGH ? 'warning' : undefined,
        },
        { id: 'publish', labelKey: `${P}.publish`, value: valueOf(publish), unit: 'per_second' },
        {
          id: 'deliver',
          labelKey: `${P}.deliver`,
          value: d,
          unit: 'per_second',
          // A drop: the value before it, from the last hour.
          sub:
            d !== null && dPeak !== null && dPeak > 1 && d < dPeak / 2
              ? { key: `${P}.wasRate`, values: { n: Math.round(dPeak * 10) / 10 } }
              : undefined,
          severity:
            d !== null && dPeak !== null && dPeak > 1 && d < dPeak / 2 ? 'warning' : undefined,
        },
        {
          id: 'consumers',
          labelKey: `${P}.consumers`,
          value: c,
          unit: 'count',
          sub:
            c !== null && cWas !== null && cWas > c
              ? { key: `${P}.was`, values: { n: cWas } }
              : undefined,
          severity: c !== null && cWas !== null && cWas > c ? 'warning' : undefined,
        },
        {
          id: 'memory',
          labelKey: `${P}.memory`,
          value: mem,
          unit: 'ratio',
          sub: { key: `${P}.ofWatermark` },
          severity: mem === null ? undefined : mem >= 1 ? 'critical' : mem > 0.8 ? 'warning' : 'ok',
        },
      ],
    },
    {
      id: 'depth',
      title: `${P}.depth`,
      kind: 'line',
      span: 1,
      unit: 'count',
      state: readyLine.length ? 'ok' : 'empty',
      series: [
        { nameKey: `${P}.series.ready`, points: pointsOf(readyLine[0]) },
        { nameKey: `${P}.series.unacked`, points: pointsOf(unackedLine[0]), severity: 'warning' },
      ],
    },
    {
      id: 'rates',
      title: `${P}.publishDeliver`,
      kind: 'line',
      span: 1,
      unit: 'per_second',
      state: publishLine.length ? 'ok' : 'empty',
      series: [
        { nameKey: `${P}.series.publish`, points: pointsOf(publishLine[0]) },
        { nameKey: `${P}.series.deliver`, points: pointsOf(deliverLine[0]) },
      ],
    },
    {
      id: 'queues',
      title: `${P}.queues`,
      kind: 'table',
      span: 2,
      state: queues.length ? 'ok' : 'empty',
      note: { key: `${P}.queuesNote` },
      columns: [
        `${P}.cols.queue`,
        `${P}.cols.ready`,
        `${P}.cols.unacked`,
        `${P}.cols.consumers`,
        `${P}.cols.publish`,
        `${P}.cols.deliver`,
      ],
      rows: queues.map((q) => ({
        cells: [
          queueName(q.labels),
          Math.round(q.ready),
          Math.round(q.unacked),
          q.consumers,
          q.publish === null ? null : `${round1(q.publish)}/s`,
          q.deliver === null ? null : `${round1(q.deliver)}/s`,
        ],
        severity:
          q.consumers === 0 && q.ready > 0
            ? 'critical'
            : q.unacked > UNACKED_HIGH
              ? 'warning'
              : undefined,
      })),
    },
  ];
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const perMin = (perSecond: number) => Math.round(Math.abs(perSecond) * 60);

async function queues(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [depth, consumers, top] = await Promise.all([
    instant(
      ctx,
      `topk(15, sum by (${QBY}) (rabbitmq_detailed_queue_messages_ready{${s}}) + sum by (${QBY}) (rabbitmq_detailed_queue_messages_unacked{${s}}))`,
    ),
    instant(ctx, `topk(15, sum by (${QBY}) (rabbitmq_detailed_queue_consumers{${s}}))`),
    range(ctx, `topk(8, sum by (${QBY}) (rabbitmq_detailed_queue_messages_ready{${s}}))`),
  ]);
  const bars = (
    rows: QuerySeries[],
    severityOf?: (v: number, l: Record<string, string>) => Severity | undefined,
  ) =>
    rows
      .map((r) => ({
        label: queueName(r.labels),
        value: r.points[0]?.[1] ?? 0,
        severity: severityOf?.(r.points[0]?.[1] ?? 0, r.labels),
      }))
      .sort((a, b) => b.value - a.value);
  return [
    {
      id: 'depth',
      title: `${P}.depthByQueue`,
      kind: 'bars',
      span: 1,
      unit: 'count',
      state: depth.length ? 'ok' : 'empty',
      items: bars(depth, (v, l) => (v > 0 && at(consumers, l) === 0 ? 'critical' : undefined)),
    },
    {
      id: 'consumers',
      title: `${P}.consumersByQueue`,
      kind: 'bars',
      span: 1,
      unit: 'count',
      state: consumers.length ? 'ok' : 'empty',
      items: bars(consumers),
    },
    {
      id: 'top',
      title: `${P}.readyTop`,
      kind: 'line',
      span: 2,
      unit: 'count',
      state: top.length ? 'ok' : 'empty',
      series: top.map((x) => ({ name: queueName(x.labels), points: pointsOf(x) })),
    },
  ];
}

async function rates(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const r = (m: string) =>
    range(ctx, `sum(rate(rabbitmq_global_messages_${m}_total{${s}}[${RATE}]))`);
  const [publish, deliver, redeliver, ack, confirm, dropped, returned, dead] = await Promise.all([
    r('received'),
    r('delivered'),
    r('redelivered'),
    r('acknowledged'),
    r('confirmed'),
    r('unroutable_dropped'),
    r('unroutable_returned'),
    range(
      ctx,
      `sum(rate({__name__=~"rabbitmq_global_messages_dead_lettered_.*_total",${s}}[${RATE}]))`,
    ),
  ]);
  return [
    {
      id: 'flow',
      title: `${P}.messageRates`,
      kind: 'stack',
      span: 2,
      unit: 'per_second',
      state: publish.length ? 'ok' : 'empty',
      series: [
        { nameKey: `${P}.series.publish`, points: pointsOf(publish[0]) },
        { nameKey: `${P}.series.deliver`, points: pointsOf(deliver[0]) },
        { nameKey: `${P}.series.redeliver`, points: pointsOf(redeliver[0]), severity: 'warning' },
        { nameKey: `${P}.series.ack`, points: pointsOf(ack[0]) },
      ],
    },
    {
      id: 'confirms',
      title: `${P}.confirms`,
      kind: 'line',
      span: 1,
      unit: 'per_second',
      state: confirm.length ? 'ok' : 'empty',
      series: [{ nameKey: `${P}.series.confirm`, points: pointsOf(confirm[0]) }],
    },
    {
      id: 'lost',
      title: `${P}.unroutable`,
      kind: 'line',
      span: 1,
      unit: 'per_second',
      state: dropped.length ? 'ok' : 'empty',
      note: { key: `${P}.deadLetterNote` },
      series: [
        { nameKey: `${P}.series.dropped`, points: pointsOf(dropped[0]), severity: 'critical' },
        { nameKey: `${P}.series.returned`, points: pointsOf(returned[0]), severity: 'warning' },
        { nameKey: `${P}.series.deadLettered`, points: pointsOf(dead[0]) },
      ],
    },
  ];
}

async function resources(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const by = (m: string) => instant(ctx, `max by (member) (${m}{${s}})`);
  const [mem, memLimit, disk, diskLimit, fds, fdsMax, procs, procsMax, memLine, limitLine] =
    await Promise.all([
      by('rabbitmq_process_resident_memory_bytes'),
      by('rabbitmq_resident_memory_limit_bytes'),
      by('rabbitmq_disk_space_available_bytes'),
      by('rabbitmq_disk_space_available_limit_bytes'),
      by('rabbitmq_process_open_fds'),
      by('rabbitmq_process_max_fds'),
      by('rabbitmq_erlang_processes_used'),
      by('rabbitmq_erlang_processes_limit'),
      range(ctx, `max by (member) (rabbitmq_process_resident_memory_bytes{${s}})`),
      range(ctx, `max(rabbitmq_resident_memory_limit_bytes{${s}})`),
    ]);
  const of = (rows: QuerySeries[], member: string) =>
    rows.find((r) => r.labels.member === member)?.points[0]?.[1] ?? null;
  const members = [...new Set(mem.map((m) => m.labels.member ?? ''))].sort();
  const items = members.flatMap((m) => {
    const out: {
      label: string;
      labelKey?: string;
      value: number;
      max: number;
      unit: 'bytes' | 'count';
      warnAt?: number;
      note?: { key: string; values?: Record<string, string | number | null> };
    }[] = [];
    const ml = of(memLimit, m);
    if (ml)
      out.push({
        label: `${m} · memory`,
        value: of(mem, m) ?? 0,
        max: ml,
        unit: 'bytes',
        warnAt: 0.8,
      });
    const fm = of(fdsMax, m);
    if (fm)
      out.push({
        label: `${m} · file descriptors`,
        value: of(fds, m) ?? 0,
        max: fm,
        unit: 'count',
        warnAt: 0.8,
      });
    const pm = of(procsMax, m);
    if (pm)
      out.push({
        label: `${m} · Erlang processes`,
        value: of(procs, m) ?? 0,
        max: pm,
        unit: 'count',
        warnAt: 0.8,
      });
    return out;
  });
  return [
    {
      id: 'limits',
      title: `${P}.limits`,
      kind: 'gauge',
      span: 1,
      state: items.length ? 'ok' : 'empty',
      note: { key: `${P}.watermarkNote` },
      items,
    },
    {
      id: 'disk',
      title: `${P}.disk`,
      kind: 'stat',
      span: 1,
      state: disk.length ? 'ok' : 'empty',
      tiles: members.map((m) => {
        const free = of(disk, m);
        const limit = of(diskLimit, m);
        return {
          id: m,
          labelKey: `${P}.diskFree`,
          value: free === null ? null : bytes(free),
          sub: {
            key: `${P}.diskLimit`,
            values: { member: m, limit: limit === null ? null : bytes(limit) },
          },
          severity: (free !== null && limit !== null && free < limit * 2
            ? 'warning'
            : undefined) as Severity | undefined,
        };
      }),
    },
    {
      id: 'memory',
      title: `${P}.memoryOverTime`,
      kind: 'line',
      span: 2,
      unit: 'bytes',
      state: memLine.length ? 'ok' : 'empty',
      series: [
        ...memLine.map((x) => ({ name: x.labels.member ?? '', points: pointsOf(x) })),
        ...(limitLine[0]
          ? [{ nameKey: `${P}.watermark`, points: pointsOf(limitLine[0]), dashed: true }]
          : []),
      ],
    },
  ];
}

// ------------------------------------------------------------------ former consumers

export interface Ended {
  kind: 'workload' | 'container';
  /** "namespace/Kind/name" for a workload, the container's name. */
  id: string;
  name: string;
  /** OOMKilled, CrashLoopBackOff, Error, Exited (n), or gone. */
  how: string;
  /** Unix seconds; null when not known. */
  at: number | null;
}

interface PodStatus {
  containers?: {
    state?: string;
    reason?: string;
    restart_count?: number;
    last_termination?: { reason?: string; exit_code?: number; finished_at?: string };
  }[];
}

/**
 * The clients connected to RabbitMQ's AMQP port in the last 24 hours (eBPF flows), not
 * WatchLog's own, that ended since: the likeliest former consumers of a queue that lost
 * its consumers. The plugin doesn't say which client consumed which queue, so they are
 * ranked by how close their end came to the moment the consumers left.
 */
export async function endedClients(ctx: PageContext, lostAt: number | null): Promise<Ended[]> {
  if (!ctx.vm) return [];
  const dst = await destination(ctx);
  if (!dst) return [];
  const port = 'port' in ctx.row.target ? ctx.row.target.port : null;
  const own = await ownComponents(ctx);
  const clients = await ctx.vm.query(
    { clusterId: ctx.row.cluster_id },
    `max by (${SOURCE}) (present_over_time(watchlog_flow_connections_total{${dst}${port ? `,dst_port="${port}"` : ''}}[24h]))`,
    Math.floor(ctx.now / 1000),
  );
  const since = ctx.now / 1000 - DAY;
  const out: Ended[] = [];
  for (const c of clients) {
    const l = c.labels;
    if (l.workload && l.namespace) {
      if (own.workloads.has(`${l.namespace}/${l.workload}`)) continue;
      const pods = await ctx.db
        .selectFrom('objects')
        .select(['status_summary', 'spec_summary', 'deleted_at'])
        .where('cluster_id', '=', ctx.row.cluster_id)
        .where('kind', '=', 'Pod')
        .where('namespace', '=', l.namespace)
        .where((eb) =>
          eb.or([eb('deleted_at', 'is', null), eb('deleted_at', '>', new Date(since * 1000))]),
        )
        .execute();
      let best: { how: string; at: number | null } | null = null;
      for (const p of pods) {
        const w = (p.spec_summary as { workload?: { name?: string } }).workload;
        if (w?.name !== l.workload) continue;
        for (const ct of (p.status_summary as PodStatus).containers ?? []) {
          const t = ct.last_termination;
          const tAt = t?.finished_at ? Date.parse(t.finished_at) / 1000 : null;
          if (ct.state === 'waiting' && ct.reason === 'CrashLoopBackOff') {
            const how =
              t?.reason === 'OOMKilled' ? 'OOMKilled, CrashLoopBackOff' : 'CrashLoopBackOff';
            best = pick(best, { how, at: tAt }, lostAt);
          } else if (t && tAt !== null && tAt >= since) {
            best = pick(
              best,
              { how: t.reason || `Exited (${t.exit_code ?? '?'})`, at: tAt },
              lostAt,
            );
          }
        }
      }
      if (best) {
        out.push({
          kind: 'workload',
          id: `${l.namespace}/${l.workload_kind}/${l.workload}`,
          name: `${l.namespace}/${l.workload}`,
          ...best,
        });
      }
    } else if (l.container) {
      if (own.containers.has(l.container)) continue;
      const row = await ctx.db
        .selectFrom('objects')
        .select(['status_summary', 'deleted_at'])
        .where('cluster_id', '=', ctx.row.cluster_id)
        .where('kind', '=', 'DockerContainer')
        .where('name', '=', l.container)
        .orderBy('updated_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      const st = (row?.status_summary ?? {}) as {
        state?: string;
        oom_killed?: boolean;
        exit_code?: number;
        finished_at?: string;
        restart_count?: number;
      };
      const tAt = st.finished_at ? Date.parse(st.finished_at) / 1000 : null;
      let how: string | null = null;
      if (!row || row.deleted_at) how = 'gone';
      else if (st.state !== 'running' && st.oom_killed) how = 'OOMKilled';
      else if (st.state === 'restarting')
        how = st.oom_killed ? 'OOMKilled, restarting' : 'restarting';
      else if (st.state !== 'running') how = `Exited (${st.exit_code ?? '?'})`;
      else if (tAt !== null && tAt >= since && (st.restart_count ?? 0) > 0)
        how = st.oom_killed ? 'OOMKilled, restarted' : 'restarted';
      if (how) out.push({ kind: 'container', id: l.container, name: l.container, how, at: tAt });
    }
  }
  const dist = (e: Ended) =>
    lostAt === null || e.at === null ? Infinity : Math.abs(e.at - lostAt);
  return out.sort((a, b) => dist(a) - dist(b) || (b.at ?? 0) - (a.at ?? 0)).slice(0, 5);
}

/** The termination closest to when the consumers left (or the newest). */
function pick(
  a: { how: string; at: number | null } | null,
  b: { how: string; at: number | null },
  lostAt: number | null,
) {
  if (!a) return b;
  if (lostAt !== null && a.at !== null && b.at !== null)
    return Math.abs(b.at - lostAt) < Math.abs(a.at - lostAt) ? b : a;
  return (b.at ?? 0) > (a.at ?? 0) ? b : a;
}

// ------------------------------------------------------------------ reasons

const COMMAND = (ctx: PageContext, member: string | undefined) => {
  const t = ctx.row.target;
  if (t.kind === 'workload')
    return `kubectl exec -n ${t.namespace} ${member ?? `${t.workload_kind.toLowerCase()}/${t.workload}`} -- rabbitmq-plugins enable rabbitmq_prometheus`;
  if (t.kind === 'compose' || t.kind === 'container')
    return `docker exec ${member ?? (t.kind === 'container' ? t.container : '<container>')} rabbitmq-plugins enable rabbitmq_prometheus`;
  return 'rabbitmq-plugins enable rabbitmq_prometheus';
};

async function reasons(ctx: PageContext): Promise<Reason[]> {
  const s = one(ctx.row.id);
  const [idle, growing, alarms, unacked, dead, deadQueues] = await Promise.all([
    // Ready messages, no consumer, and more coming.
    instant(
      ctx,
      `(sum by (${QBY}) (rabbitmq_detailed_queue_messages_ready{${s}}) > 0) and (sum by (${QBY}) (rabbitmq_detailed_queue_consumers{${s}}) == 0) and (sum by (${QBY}) (deriv(rabbitmq_detailed_queue_messages_ready{${s}}[5m])) > 0)`,
    ),
    instant(
      ctx,
      `(sum by (${QBY}) (deriv(rabbitmq_detailed_queue_messages_ready{${s}}[15m])) > 0.5) and (sum by (${QBY}) (rabbitmq_detailed_queue_consumers{${s}}) > 0) and (sum by (${QBY}) (rabbitmq_detailed_queue_messages_ready{${s}}) > 1000)`,
    ),
    instant(
      ctx,
      `max by (member) (rabbitmq_alarms_memory_used_watermark{${s}}) > 0 or label_replace(max by (member) (rabbitmq_alarms_free_disk_space_watermark{${s}}) > 0, "disk", "1", "", "")`,
    ),
    instant(ctx, `sum(rabbitmq_queue_messages_unacked{${s}})`),
    instant(
      ctx,
      `sum(increase({__name__=~"rabbitmq_global_messages_dead_lettered_.*_total",${s}}[15m]))`,
    ),
    // Before 3.12 (no dead-letter counters): queues named like dead-letter queues that grow.
    instant(
      ctx,
      `sum by (${QBY}) (deriv(rabbitmq_detailed_queue_messages_ready{${s},queue=~"(?i).*(dead.?letter|\\\\.dlq|\\\\.dlx|-dlq|_dlq).*"}[15m])) > 0`,
    ),
  ]);
  const out: Reason[] = [];
  if (idle.length) {
    // When the consumers left: the last time the busiest idle queue had one.
    const top = [...idle].sort((a, b) => (b.points[0]?.[1] ?? 0) - (a.points[0]?.[1] ?? 0))[0]!;
    const q = `vhost="${esc(top.labels.vhost ?? '/')}",queue="${esc(top.labels.queue ?? '')}"`;
    const lastSeen = await instant(
      ctx,
      `tlast_over_time((sum(rabbitmq_detailed_queue_consumers{${s},${q}}) > 0)[24h:1m])`,
    );
    const lostAt = valueOf(lastSeen);
    const ended = await endedClients(ctx, lostAt);
    const growth = await instant(
      ctx,
      `sum(deriv(rabbitmq_detailed_queue_messages_ready{${s},${q}}[5m]))`,
    );
    const first = ended[0];
    out.push({
      severity: 'critical',
      code: 'queue_no_consumers',
      facts: {
        queue: queueName(top.labels),
        queues: idle.length,
        ready: Math.round(top.points[0]?.[1] ?? 0),
        perMin: perMin(valueOf(growth) ?? 0),
        since: lostAt ? ago(lostAt, ctx.now) : null,
        consumer: first?.name ?? null,
        how: first?.how ?? null,
        when: first?.at ? ago(first.at, ctx.now) : null,
      },
      links: ended.map((e) => ({ kind: e.kind, id: e.id, name: e.name })),
    });
  }
  for (const g of growing.slice(0, 3)) {
    out.push({
      severity: 'warning',
      code: 'queue_growing',
      facts: { queue: queueName(g.labels), perMin: perMin(g.points[0]?.[1] ?? 0) },
    });
  }
  for (const a of alarms) {
    out.push({
      severity: 'critical',
      code: a.labels.disk ? 'disk_alarm' : 'memory_alarm',
      facts: { member: a.labels.member ?? null },
    });
  }
  const u = valueOf(unacked);
  if (u !== null && u > UNACKED_HIGH)
    out.push({ severity: 'warning', code: 'unacked_high', facts: { n: Math.round(u) } });
  const dl = valueOf(dead);
  if ((dl ?? 0) > 0)
    out.push({ severity: 'warning', code: 'dead_letters_growing', facts: { n: Math.round(dl!) } });
  else if (deadQueues.length)
    out.push({
      severity: 'warning',
      code: 'dead_letters_growing',
      facts: { n: null, queue: queueName(deadQueues[0]!.labels) },
    });
  const off = nodes(ctx).filter((n) => n.plugin === false);
  if (off.length) {
    out.push({
      severity: 'info',
      code: 'prometheus_plugin_off',
      facts: {
        n: off.length,
        command: off.map((n) => COMMAND(ctx, n.member)).join('\n'),
      },
    });
  }
  return out;
}

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export const rabbitmqPage: IntegrationPage = {
  id: 'rabbitmq',
  tabs: [
    { id: 'overview', title: 'integrations.rabbitmq.tabs.overview', panels: overview },
    { id: 'queues', title: 'integrations.rabbitmq.tabs.queues', panels: queues },
    { id: 'rates', title: 'integrations.rabbitmq.tabs.rates', panels: rates },
    { id: 'resources', title: 'integrations.rabbitmq.tabs.resources', panels: resources },
    {
      id: 'connection',
      title: 'integrations.tabs.connection',
      panels: genericPage.tabs[0]!.panels,
    },
  ],

  async listMetrics({ vm, clusterId, ids, now }) {
    const scope = { clusterId };
    const s = some(ids);
    const end = Math.floor(now / 1000 / 300) * 300;
    const [ready, publish, consumers, spark] = await Promise.all([
      vm.query(scope, `sum by (service) (rabbitmq_queue_messages_ready{${s}})`),
      vm.query(scope, `sum by (service) (rate(rabbitmq_global_messages_received_total{${s}}[5m]))`),
      vm.query(scope, `sum by (service) (rabbitmq_consumers{${s}})`),
      vm.queryRange(
        scope,
        `sum by (service) (rabbitmq_queue_messages_ready{${s}})`,
        end - SPARK_RANGE,
        end,
        300,
      ),
    ]);
    const v = (rows: QuerySeries[], id: string) =>
      rows.find((r) => r.labels.service === id)?.points[0]?.[1] ?? null;
    const out = new Map<string, RowMetrics>();
    for (const id of ids) {
      out.set(id, {
        keyMetrics: [
          { id: 'ready', labelKey: `${P}.ready`, value: v(ready, id), unit: 'count' },
          { id: 'publish', labelKey: `${P}.publish`, value: v(publish, id), unit: 'per_second' },
          { id: 'consumers', labelKey: `${P}.consumers`, value: v(consumers, id), unit: 'count' },
        ],
        spark: spark.find((r) => r.labels.service === id)?.points ?? [],
      });
    }
    return out;
  },

  reasons,
};
