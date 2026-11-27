// SPDX-License-Identifier: AGPL-3.0-only
// RabbitMQ's tabs (1.1.0, ADR-243): Overview (the message flow, six tiles with what is usual,
// publish against deliver with what happened, ready by queue, the health checks, the queues
// that need a look), Queues (every queue: type, ready, unacked, in, out, consumers and how
// busy, drains in), Clients (from the agents' network flows) and Nodes (each node against its
// limits). Only what rabbitmq_prometheus or the agents' flows really give (Step 0's table,
// ADR-243): no partitions, no replicas in sync, no per-queue bindings or dead-letter target.
import { usualBands, usualWindow } from '../../anomaly/usual.js';
import { clientRows } from './rabbitmq-clients.js';
import { byNeed, queueRows, watermarkIn } from './rabbitmq-queues.js';
import { endedClients, nodesOf, queueGrowth } from './rabbitmq.js';
import { bytes } from './owners.js';
import { instant, one, pointsOf, range, valueOf } from './query.js';
import type { QuerySeries } from '../../../lib/victoria.js';
import type {
  ChecksPanel,
  ClientsPanel,
  FlowPanel,
  NodesPanel,
  PageContext,
  Panel,
  QueueRow,
  Severity,
  StatPanel,
  Text,
  Unit,
} from './types.js';

export const P = 'integrations.rabbitmq.panels';
const RATE = '2m';
const HOUR_MS = 3_600_000;
const DOCS = 'https://watchlog.io/docs/integrations/rabbitmq/';

/** The usual band for this hour of the week (What changed's statistics), or null. */
export async function usualNow(
  ctx: PageContext,
  expr: string,
  unit: Unit,
): Promise<{ low: number; high: number; median: number } | null> {
  if (!ctx.usual || !ctx.vm) return null;
  const hour = Math.floor(ctx.now / HOUR_MS) * HOUR_MS;
  const { start, end } = usualWindow(ctx.now);
  const rows = await ctx.vm.queryRange(ctx.scope, expr, start / 1000, end / 1000, 600);
  const points: Array<[number, number]> = [];
  for (const r of rows) for (const [t, v] of r.points) if (v !== null) points.push([t * 1000, v]);
  const band = usualBands(points, hour, hour, unit, 600)[0];
  return band && !band.learning ? band : null;
}

/** "usual for this hour", or "usually 1,000–1,400" when outside its band. */
function usualSub(v: number | null, band: Awaited<ReturnType<typeof usualNow>>): Text | undefined {
  if (v === null || !band) return undefined;
  if (v >= band.low && v <= band.high) return { key: `${P}.usualNow` };
  return {
    key: v > band.high ? `${P}.aboveUsual` : `${P}.belowUsual`,
    values: { low: round(band.low), high: round(band.high) },
  };
}
const round = (v: number) => (Math.abs(v) >= 10 ? Math.round(v) : Math.round(v * 10) / 10);
const perMin = (perSecond: number) => Math.round(Math.abs(perSecond) * 60);

// ------------------------------------------------------------------------- Overview

export async function overview(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const g = (m: string) => `sum(rate(rabbitmq_global_messages_${m}_total{${s}}[${RATE}]))`;
  const [
    ready,
    growth,
    unacked,
    publish,
    deliver,
    deliverPeak,
    consumers,
    consumersWas,
    memory,
    publishLine,
    deliverLine,
    topQueue,
    readyLine,
    lostLine,
    rows,
    clients,
    ended,
    usualReady,
    usualUnacked,
    usualPublish,
    usualDeliver,
  ] = await Promise.all([
    instant(ctx, `sum(rabbitmq_queue_messages_ready{${s}})`),
    queueGrowth(ctx),
    instant(ctx, `sum(rabbitmq_queue_messages_unacked{${s}})`),
    instant(ctx, g('received')),
    instant(ctx, g('delivered')),
    instant(ctx, `max_over_time(${g('delivered')}[1h:1m])`),
    instant(ctx, `sum(rabbitmq_consumers{${s}})`),
    instant(ctx, `max_over_time(sum(rabbitmq_consumers{${s}})[1h:1m])`),
    instant(
      ctx,
      `max(rabbitmq_process_resident_memory_bytes{${s}} / (rabbitmq_resident_memory_limit_bytes{${s}} > 0))`,
    ),
    range(ctx, g('received')),
    range(ctx, g('delivered')),
    instant(ctx, `topk(1, sum by (vhost, queue) (rabbitmq_detailed_queue_messages_ready{${s}}))`),
    range(ctx, `sum(rabbitmq_detailed_queue_messages_ready{${s}})`),
    range(ctx, g('redelivered')).then(async (red) => ({
      red,
      dropped: await range(ctx, g('unroutable_dropped')),
      returned: await range(ctx, g('unroutable_returned')),
      dead: await range(
        ctx,
        `sum(rate({__name__=~"rabbitmq_global_messages_dead_lettered_.*_total",${s}}[${RATE}]))`,
      ),
    })),
    queueRows(ctx),
    clientRows(ctx).catch(() => [] as ClientsPanel['rows']),
    endedClients(ctx, null).catch(() => []),
    usualNow(ctx, `sum(rabbitmq_queue_messages_ready{${s}})`, 'count'),
    usualNow(ctx, `sum(rabbitmq_queue_messages_unacked{${s}})`, 'count'),
    usualNow(ctx, g('received'), 'per_second'),
    usualNow(ctx, g('delivered'), 'per_second'),
  ]);
  const d = valueOf(deliver);
  const dPeak = valueOf(deliverPeak);
  const c = valueOf(consumers);
  const cWas = valueOf(consumersWas);
  const mem = valueOf(memory);
  const r = valueOf(ready);
  const u = valueOf(unacked);
  const p = valueOf(publish);
  const rr = growth.size ? [...growth.values()].reduce((a, b) => a + b, 0) : null;
  const dropped = d !== null && dPeak !== null && dPeak > 1 && d < dPeak / 2;

  const summary: StatPanel = {
    id: 'summary',
    title: `${P}.summary`,
    kind: 'stat',
    span: 2,
    state: r === null ? 'empty' : 'ok',
    tiles: [
      {
        id: 'ready',
        labelKey: `${P}.ready`,
        value: r,
        unit: 'count',
        sub:
          rr !== null && Math.abs(rr) >= 0.05
            ? { key: rr > 0 ? `${P}.growing` : `${P}.draining`, values: { n: perMin(rr) } }
            : usualSub(r, usualReady),
        severity: rr !== null && rr > 0.5 ? 'warning' : undefined,
      },
      {
        id: 'unacked',
        labelKey: `${P}.unacked`,
        value: u,
        unit: 'count',
        sub: usualSub(u, usualUnacked),
        severity: (u ?? 0) > 10_000 ? 'warning' : undefined,
      },
      {
        id: 'publish',
        labelKey: `${P}.publish`,
        value: p,
        unit: 'per_second',
        sub: usualSub(p, usualPublish),
      },
      {
        id: 'deliver',
        labelKey: `${P}.deliver`,
        value: d,
        unit: 'per_second',
        sub: dropped
          ? { key: `${P}.wasRate`, values: { n: Math.round(dPeak! * 10) / 10 } }
          : usualSub(d, usualDeliver),
        severity: dropped ? 'warning' : undefined,
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
  };

  // What happened, on the charts: the clients that ended (OOM-killed, exited) in the window.
  const from = ctx.now / 1000 - ctx.range;
  const markers = ended
    .filter((e) => e.at !== null && e.at >= from)
    .map((e) => ({
      at: e.at!,
      text: { key: `${P}.markerEnded`, values: { name: e.name, how: e.how } },
      severity: 'critical' as Severity,
    }));

  const top = topQueue[0];
  const topName = top ? queueNameOf(top.labels) : null;
  const topLine = top
    ? await range(
        ctx,
        `sum(rabbitmq_detailed_queue_messages_ready{${s},vhost="${esc(top.labels.vhost ?? '/')}",queue="${esc(top.labels.queue ?? '')}"})`,
      )
    : [];
  const restLine = topLine.length ? minus(readyLine[0], topLine[0]) : null;

  return [
    await flow(ctx, rows, clients),
    summary,
    {
      id: 'rates',
      title: `${P}.publishDeliver`,
      kind: 'line',
      span: 1,
      unit: 'per_second',
      state: publishLine.length ? 'ok' : 'empty',
      ...(markers.length ? { markers } : {}),
      series: [
        { nameKey: `${P}.series.publish`, points: pointsOf(publishLine[0]) },
        { nameKey: `${P}.series.deliver`, points: pointsOf(deliverLine[0]) },
      ],
    },
    {
      id: 'readyByQueue',
      title: `${P}.readyByQueue`,
      kind: 'stack',
      span: 1,
      unit: 'count',
      state: readyLine.length ? 'ok' : 'empty',
      ...(markers.length ? { markers } : {}),
      series: topName
        ? [
            { name: topName, points: pointsOf(topLine[0]) },
            ...(restLine
              ? [
                  {
                    nameKey: `${P}.series.otherQueues`,
                    points: restLine,
                  },
                ]
              : []),
          ]
        : [{ nameKey: `${P}.series.ready`, points: pointsOf(readyLine[0]) }],
    },
    await checks(ctx, rows),
    {
      id: 'needLook',
      title: `${P}.needLook`,
      kind: 'queues',
      span: 2,
      state: rows.length ? 'ok' : 'empty',
      full: false,
      total: rows.length,
      rows: rows.slice(0, 6),
    },
    {
      id: 'lost',
      title: `${P}.unroutable`,
      kind: 'line',
      span: 2,
      unit: 'per_second',
      state: lostLine.red.length ? 'ok' : 'empty',
      note: { key: `${P}.deadLetterNote` },
      series: [
        {
          nameKey: `${P}.series.redeliver`,
          points: pointsOf(lostLine.red[0]),
          severity: 'warning',
        },
        {
          nameKey: `${P}.series.dropped`,
          points: pointsOf(lostLine.dropped[0]),
          severity: 'critical',
        },
        { nameKey: `${P}.series.returned`, points: pointsOf(lostLine.returned[0]) },
        { nameKey: `${P}.series.deadLettered`, points: pointsOf(lostLine.dead[0]) },
      ],
    },
  ];
}

/** a − b point by point (the other queues' ready: all minus the deepest). */
function minus(a: QuerySeries | undefined, b: QuerySeries | undefined) {
  if (!a || !b) return null;
  const bt = new Map(b.points.map(([t, v]) => [t, v]));
  return a.points.map(([t, v]) => {
    const o = bt.get(t);
    return [t, v === null ? null : Math.max(0, v - (o ?? 0))] as [number, number | null];
  });
}

const queueNameOf = (l: Record<string, string>) =>
  !l.vhost || l.vhost === '/' ? (l.queue ?? '') : `${l.vhost}/${l.queue ?? ''}`;
const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * Publishers → exchanges → queues → consumers, with the rate between each. Publishers and
 * consumers are the clients the agents saw (by the direction of their traffic: a guess,
 * shown only where clear); with no flows, RabbitMQ's own counts of publishing channels and
 * consumers stand in. Exchanges and queues are RabbitMQ's.
 */
export async function flow(
  ctx: PageContext,
  queues: QueueRow[],
  clients: ClientsPanel['rows'],
): Promise<FlowPanel> {
  const s = one(ctx.row.id);
  const [routed, received, delivered, pubChannels, consumers, exRates, exNames, unroutable] =
    await Promise.all([
      instant(ctx, `sum(rate(rabbitmq_global_messages_routed_total{${s}}[5m]))`),
      instant(ctx, `sum(rate(rabbitmq_global_messages_received_total{${s}}[5m]))`),
      instant(ctx, `sum(rate(rabbitmq_global_messages_delivered_total{${s}}[5m]))`),
      instant(ctx, `sum(rabbitmq_global_publishers{${s}})`),
      instant(ctx, `sum(rabbitmq_consumers{${s}})`),
      instant(
        ctx,
        `sum by (vhost, exchange) (rate(rabbitmq_detailed_exchange_messages_published_total{${s}}[5m]))`,
      ),
      instant(ctx, `max by (vhost, exchange, type) (rabbitmq_cluster_exchange_name{${s}})`),
      instant(
        ctx,
        `sum(rate({__name__=~"rabbitmq_global_messages_unroutable_(dropped|returned)_total",${s}}[5m]))`,
      ),
    ]);
  const typeOf = new Map(
    exNames.map((e) => [`${e.labels.vhost}\u0000${e.labels.exchange}`, e.labels.type ?? '']),
  );
  // The user's exchanges: not the built-in amq.* ones nor the default "".
  const own = exNames.filter((e) => e.labels.exchange && !e.labels.exchange.startsWith('amq.'));
  const exRows = exRates
    .map((e) => ({
      name: e.labels.exchange || '(default)',
      type: typeOf.get(`${e.labels.vhost}\u0000${e.labels.exchange}`) ?? '',
      rate: e.points[0]?.[1] ?? 0,
    }))
    .sort((a, b) => b.rate - a.rate);
  const un = valueOf(unroutable);
  const flows = clients.length > 0;
  const pubs = clients.filter((c) => c.mostly === 'publishes');
  const cons = clients.filter(
    (c) => c.mostly === 'consumes' || (c.state.key === 'ended' && c.mostly !== 'publishes'),
  );
  const ready = queues.reduce((a, q) => a + q.ready, 0);
  const deep = [...queues].sort((a, b) => b.ready - a.ready);
  const worst = queues.find((q) => q.severity === 'critical');
  const more = (n: number, shown: number) => (n > shown ? n - shown : 0);
  const columns: FlowPanel['columns'] = [
    {
      id: 'publishers',
      title: flows
        ? { key: `${P}.flow.publishers`, values: { n: pubs.length } }
        : { key: `${P}.flow.publishersChannels`, values: { n: valueOf(pubChannels) } },
      value: valueOf(received),
      unit: 'per_second',
      rows: [
        ...pubs.slice(0, 2).map((c) => ({
          name: c.name,
          value: c.sends,
          unit: 'bytes_per_second' as Unit,
          ...(c.link ? { link: c.link } : {}),
        })),
        ...(more(pubs.length, 2)
          ? [
              {
                name: '',
                nameKey: `${P}.flow.more`,
                value: null,
                unit: 'count' as Unit,
                text: { key: `${P}.flow.moreN`, values: { n: pubs.length - 2 } },
              },
            ]
          : []),
      ],
      next: valueOf(received),
    },
    {
      id: 'exchanges',
      title: { key: `${P}.flow.exchanges`, values: { n: own.length } },
      value: exRows.length ? exRows.reduce((a, e) => a + e.rate, 0) : valueOf(received),
      unit: 'per_second',
      valueKey: `${P}.flow.in`,
      rows: [
        ...exRows.slice(0, 2).map((e) => ({
          name: e.type ? `${e.name} (${e.type})` : e.name,
          value: round(e.rate),
          unit: 'per_second' as Unit,
        })),
        ...(un !== null && un > 0
          ? [
              {
                name: '',
                nameKey: `${P}.flow.unroutable`,
                value: round(un),
                unit: 'per_second' as Unit,
                severity: 'warning' as Severity,
              },
            ]
          : []),
      ],
      next: valueOf(routed),
    },
    {
      id: 'queues',
      title: { key: `${P}.flow.queues`, values: { n: queues.length } },
      value: ready,
      unit: 'count',
      valueKey: `${P}.flow.ready`,
      ...(worst ? { severity: 'critical' as Severity } : {}),
      rows: [
        ...deep.slice(0, 2).map((q) => ({
          name: q.name,
          value: q.ready,
          unit: 'count' as Unit,
          ...(q.severity ? { severity: q.severity } : {}),
          link: { kind: 'queue' as const, vhost: q.vhost, queue: q.queue, name: q.name },
        })),
        ...(more(deep.length, 2)
          ? [
              {
                name: '',
                nameKey: `${P}.flow.more`,
                value: deep.slice(2).reduce((a, q) => a + q.ready, 0),
                unit: 'count' as Unit,
                text: { key: `${P}.flow.moreN`, values: { n: deep.length - 2 } },
              },
            ]
          : []),
      ],
      next: valueOf(delivered),
    },
    {
      id: 'consumers',
      title: flows
        ? { key: `${P}.flow.consumers`, values: { n: cons.length } }
        : { key: `${P}.flow.consumersCount`, values: { n: valueOf(consumers) } },
      value: valueOf(delivered),
      unit: 'per_second',
      rows: cons.slice(0, 3).map((c) =>
        c.state.key === 'ended'
          ? {
              name: c.name,
              value: null,
              unit: 'count' as Unit,
              text: { key: `${P}.flow.gone`, values: { at: c.state.values?.at ?? null } },
              severity: 'critical' as Severity,
              ...(c.link ? { link: c.link } : {}),
            }
          : {
              name: c.name,
              value: c.receives,
              unit: 'bytes_per_second' as Unit,
              ...(c.link ? { link: c.link } : {}),
            },
      ),
    },
  ];
  return {
    id: 'flow',
    title: `${P}.flow.title`,
    kind: 'flow',
    span: 2,
    state: valueOf(received) === null && !queues.length ? 'empty' : 'ok',
    note: { key: flows ? `${P}.flow.note` : `${P}.flow.noteNoFlows` },
    columns,
  };
}

/**
 * Is the broker itself fine? Only what the metrics can tell (Step 0): consumers on every
 * queue with messages, alarms, every node answering, the plugin on every node, the same
 * version everywhere, unroutable messages, and (4.x) quorum leaders and Raft elections.
 */
export async function checks(ctx: PageContext, rows: QueueRow[]): Promise<ChecksPanel> {
  const s = one(ctx.row.id);
  const [memAlarm, memRatio, diskAlarm, diskHead, versions, dropped, quorum, leaders, elections] =
    await Promise.all([
      instant(ctx, `max(rabbitmq_alarms_memory_used_watermark{${s}})`),
      instant(
        ctx,
        `max(rabbitmq_process_resident_memory_bytes{${s}} / (rabbitmq_resident_memory_limit_bytes{${s}} > 0))`,
      ),
      instant(ctx, `max(rabbitmq_alarms_free_disk_space_watermark{${s}})`),
      instant(
        ctx,
        `min(rabbitmq_disk_space_available_bytes{${s}} - rabbitmq_disk_space_available_limit_bytes{${s}})`,
      ),
      instant(
        ctx,
        `count by (version) (max by (member, version) (watchlog_rabbitmq_node_info{${s}}))`,
      ),
      instant(
        ctx,
        `sum(rate({__name__=~"rabbitmq_global_messages_unroutable_(dropped|returned)_total",${s}}[5m]))`,
      ),
      instant(
        ctx,
        `count(max by (vhost, queue) (rabbitmq_detailed_queue_info{${s},type="quorum"}))`,
      ),
      instant(
        ctx,
        `count(max by (vhost, queue) (rabbitmq_detailed_queue_info{${s},type="quorum",membership="leader"}))`,
      ),
      instant(ctx, `sum(increase(rabbitmq_detailed_raft_term_total{${s}}[1h]))`),
    ]);
  const items: ChecksPanel['items'] = [];
  const idle = rows.filter((q) => q.type !== 'stream' && q.ready > 0 && q.consumers === 0);
  items.push({
    id: 'consumers',
    labelKey: `${P}.checks.consumers`,
    state: idle.length ? 'fail' : 'pass',
    value: idle.length
      ? { key: `${P}.checks.queuesN`, values: { n: idle.length } }
      : { key: `${P}.checks.allQueues` },
    ...(idle.length
      ? {
          link: {
            kind: 'tab' as const,
            tab: 'queues',
            filter: 'no_consumers',
            name: idle[0]!.name,
          },
        }
      : {}),
  });
  const ma = valueOf(memAlarm);
  if (ma !== null || valueOf(memRatio) !== null)
    items.push({
      id: 'memory',
      labelKey: `${P}.checks.memory`,
      state: (ma ?? 0) > 0 ? 'fail' : 'pass',
      value: { key: `${P}.checks.ofLimit`, values: { pct: pct(valueOf(memRatio)) } },
      ...((ma ?? 0) > 0 ? { link: { kind: 'tab' as const, tab: 'nodes', name: 'nodes' } } : {}),
    });
  const da = valueOf(diskAlarm);
  if (da !== null)
    items.push({
      id: 'disk',
      labelKey: `${P}.checks.disk`,
      state: da > 0 ? 'fail' : 'pass',
      value: {
        key: `${P}.checks.aboveLimit`,
        values: {
          bytes: valueOf(diskHead) === null ? null : bytes(Math.max(0, valueOf(diskHead)!)),
        },
      },
      ...(da > 0 ? { link: { kind: 'tab' as const, tab: 'nodes', name: 'nodes' } } : {}),
    });
  const members =
    (ctx.row.status_details as { members?: { name: string; up: boolean }[] } | null)?.members ?? [];
  if (members.length) {
    const up = members.filter((m) => m.up).length;
    items.push({
      id: 'nodes',
      labelKey: `${P}.checks.nodes`,
      state: up < members.length ? 'fail' : 'pass',
      value: { key: `${P}.checks.nOfM`, values: { n: up, m: members.length } },
      ...(up < members.length
        ? { link: { kind: 'tab' as const, tab: 'nodes', name: 'nodes' } }
        : {}),
    });
  }
  const q = valueOf(quorum) ?? 0;
  // 4.x says which node leads each quorum queue; 3.13 doesn't, and the check isn't shown there.
  const led = valueOf(leaders);
  if (q > 0 && led !== null)
    items.push({
      id: 'leaders',
      labelKey: `${P}.checks.leaders`,
      state: led < q ? 'fail' : 'pass',
      value: { key: `${P}.checks.nOfM`, values: { n: led, m: q } },
      ...(led < q
        ? { link: { kind: 'docs' as const, href: `${DOCS}#quorum-queues`, name: 'docs' } }
        : {}),
    });
  const el = valueOf(elections);
  if (q > 0 && el !== null)
    items.push({
      id: 'elections',
      labelKey: `${P}.checks.elections`,
      state: el >= 1 ? 'warn' : 'pass',
      value: { key: `${P}.checks.electionsN`, values: { n: Math.round(el) } },
      ...(el >= 1
        ? { link: { kind: 'docs' as const, href: `${DOCS}#quorum-queues`, name: 'docs' } }
        : {}),
    });
  if (versions.length)
    items.push({
      id: 'version',
      labelKey: `${P}.checks.version`,
      state: versions.length > 1 ? 'warn' : 'pass',
      value:
        versions.length > 1
          ? { key: `${P}.checks.versionsN`, values: { n: versions.length } }
          : {
              key: `${P}.checks.versionOne`,
              values: { version: versions[0]!.labels.version ?? '' },
            },
      ...(versions.length > 1
        ? { link: { kind: 'tab' as const, tab: 'nodes', name: 'nodes' } }
        : {}),
    });
  const un = valueOf(dropped);
  if (un !== null)
    items.push({
      id: 'unroutable',
      labelKey: `${P}.checks.unroutable`,
      state: un > 0.01 ? 'warn' : 'pass',
      value: { key: `${P}.checks.perSecond`, values: { n: round(un) } },
      ...(un > 0.01
        ? { link: { kind: 'docs' as const, href: `${DOCS}#unroutable-messages`, name: 'docs' } }
        : {}),
    });
  const nodes = nodesOf(ctx);
  if (nodes.length) {
    const on = nodes.filter((n) => n.plugin !== false).length;
    items.push({
      id: 'plugin',
      labelKey: `${P}.checks.plugin`,
      state: on < nodes.length ? 'fail' : 'pass',
      value: { key: `${P}.checks.nOfM`, values: { n: on, m: nodes.length } },
      ...(on < nodes.length
        ? { link: { kind: 'docs' as const, href: `${DOCS}#what-it-needs`, name: 'docs' } }
        : {}),
    });
  }
  // Before any metric arrives, nothing is checked yet: the panel says it is empty.
  const anyData =
    rows.length > 0 ||
    ma !== null ||
    valueOf(memRatio) !== null ||
    da !== null ||
    un !== null ||
    versions.length > 0 ||
    // A node down or without its plugin is worth saying before any metric.
    items.some((i) => (i.id === 'nodes' || i.id === 'plugin') && i.state === 'fail');
  return {
    id: 'checks',
    title: `${P}.checks.title`,
    kind: 'checks',
    span: 1,
    state: anyData ? 'ok' : 'empty',
    items: anyData ? items : [],
  };
}
const pct = (v: number | null) => (v === null ? null : Math.round(v * 100));

// --------------------------------------------------------------------------- Queues

export async function queuesTab(ctx: PageContext): Promise<Panel[]> {
  const rows = await queueRows(ctx);
  return [
    {
      id: 'queues',
      title: `${P}.allQueues`,
      kind: 'queues',
      span: 2,
      state: rows.length ? 'ok' : 'empty',
      note: { key: `${P}.queuesLimit`, values: { n: 200 } },
      full: true,
      total: rows.length,
      rows: [...rows].sort(byNeed),
    },
  ];
}

export async function queueCount(ctx: PageContext): Promise<number | null> {
  const r = await instant(
    ctx,
    `count(max by (vhost, queue) (rabbitmq_detailed_queue_messages_ready{${one(ctx.row.id)}}))`,
  );
  return valueOf(r);
}

// -------------------------------------------------------------------------- Clients

export async function clientsTab(ctx: PageContext): Promise<Panel[]> {
  const rows = await clientRows(ctx);
  return [
    {
      id: 'clients',
      title: `${P}.clients`,
      kind: 'clients',
      span: 2,
      state: rows.length ? 'ok' : 'empty',
      note: { key: `${P}.clientsNote` },
      rows,
    },
  ];
}

// ---------------------------------------------------------------------------- Nodes

export async function nodesTab(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const by = (m: string) => instant(ctx, `max by (member) (${m}{${s}})`);
  const [
    mem,
    memLimit,
    disk,
    diskLimit,
    fds,
    fdsMax,
    sockets,
    socketsMax,
    procs,
    procsMax,
    uptime,
    connections,
    info,
    leaders,
    anyMembership,
    alarms,
    opened,
    closed,
    memLine,
    limitLine,
  ] = await Promise.all([
    by('rabbitmq_process_resident_memory_bytes'),
    by('rabbitmq_resident_memory_limit_bytes'),
    by('rabbitmq_disk_space_available_bytes'),
    by('rabbitmq_disk_space_available_limit_bytes'),
    by('rabbitmq_process_open_fds'),
    by('rabbitmq_process_max_fds'),
    by('rabbitmq_process_open_tcp_sockets'),
    by('rabbitmq_process_max_tcp_sockets'),
    by('rabbitmq_erlang_processes_used'),
    by('rabbitmq_erlang_processes_limit'),
    by('rabbitmq_erlang_uptime_seconds'),
    by('rabbitmq_connections'),
    instant(ctx, `max by (member, version) (watchlog_rabbitmq_node_info{${s}})`),
    instant(
      ctx,
      `count by (member) (max by (member, vhost, queue) (rabbitmq_detailed_queue_info{${s},membership="leader"}))`,
    ),
    instant(ctx, `count(rabbitmq_detailed_queue_info{${s},membership!=""})`),
    instant(
      ctx,
      `max by (member) ({__name__=~"rabbitmq_alarms_(memory_used|free_disk_space)_watermark",${s}})`,
    ),
    range(ctx, `sum(rate(rabbitmq_connections_opened_total{${s}}[5m]))`),
    range(ctx, `sum(rate(rabbitmq_connections_closed_total{${s}}[5m]))`),
    range(ctx, `max by (member) (rabbitmq_process_resident_memory_bytes{${s}})`),
    range(ctx, `max(rabbitmq_resident_memory_limit_bytes{${s}})`),
  ]);
  const of = (rows: QuerySeries[], m: string) =>
    rows.find((r) => r.labels.member === m)?.points[0]?.[1] ?? null;
  const known =
    (
      ctx.row.status_details as {
        members?: { name: string; up?: boolean; error?: string }[];
      } | null
    )?.members ?? [];
  const downOf = new Map(
    known.filter((m) => m.up === false).map((m) => [m.name, m.error || 'not answering']),
  );
  const names = [
    ...new Set([...known.map((m) => m.name), ...mem.map((m) => m.labels.member ?? '')]),
  ]
    .filter(Boolean)
    .sort();
  const has4x = (valueOf(anyMembership) ?? 0) > 0;
  const items: NodesPanel['items'] = names.map((m) => {
    const limits: NodesPanel['items'][number]['limits'] = [];
    const add = (labelKey: string, v: number | null, max: number | null, unit: Unit) => {
      if (v !== null && max)
        limits.push({ labelKey: `${P}.limit.${labelKey}`, value: v, max, unit });
    };
    add('memory', of(mem, m), of(memLimit, m), 'bytes');
    // The disk bar is the alarm's limit against what is free: it fills as free space runs out.
    add('disk', of(diskLimit, m), of(disk, m), 'bytes');
    add('fds', of(fds, m), of(fdsMax, m), 'count');
    add('sockets', of(sockets, m), of(socketsMax, m), 'count');
    add('processes', of(procs, m), of(procsMax, m), 'count');
    const ratio = (of(mem, m) ?? 0) / (of(memLimit, m) || Infinity);
    const alarm = (of(alarms, m) ?? 0) > 0;
    const version = info.find((r) => r.labels.member === m)?.labels.version ?? null;
    const down = downOf.get(m);
    const sev: Severity | undefined =
      alarm || down ? 'critical' : ratio > 0.8 ? 'warning' : undefined;
    return {
      name: m,
      version,
      uptime: of(uptime, m),
      connections: of(connections, m),
      leaders: has4x ? (of(leaders, m) ?? 0) : null,
      ...(down ? { down } : {}),
      ...(sev ? { severity: sev } : {}),
      limits,
    };
  });
  return [
    {
      id: 'nodes',
      title: `${P}.nodes`,
      kind: 'nodes',
      span: 2,
      state: items.length ? 'ok' : 'empty',
      note: { key: `${P}.nodesNote` },
      items,
    },
    {
      id: 'churn',
      title: `${P}.churn`,
      kind: 'line',
      span: 1,
      unit: 'per_second',
      state: opened.length ? 'ok' : 'empty',
      note: { key: `${P}.churnNote` },
      series: [
        { nameKey: `${P}.series.opened`, points: pointsOf(opened[0]) },
        { nameKey: `${P}.series.closed`, points: pointsOf(closed[0]) },
      ],
    },
    {
      id: 'memory',
      title: `${P}.memoryOverTime`,
      kind: 'line',
      span: 1,
      unit: 'bytes',
      state: memLine.length ? 'ok' : 'empty',
      note: { key: `${P}.watermarkNote` },
      series: [
        ...memLine.map((x) => ({ name: x.labels.member ?? '', points: pointsOf(x) })),
        ...(limitLine[0]
          ? [{ nameKey: `${P}.watermark`, points: pointsOf(limitLine[0]), dashed: true }]
          : []),
      ],
    },
  ];
}

export { watermarkIn };
