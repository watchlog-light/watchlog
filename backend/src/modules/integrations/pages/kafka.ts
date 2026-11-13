// SPDX-License-Identifier: AGPL-3.0-only
// The Kafka page (SPEC §4.12, ADR-166, v0.5 slice 4): Overview, Topics, Consumer groups,
// Brokers and Broker internals, from what the collector reads through the admin API
// (Metadata, ListOffsets, DescribeGroups, OffsetFetch, DescribeLogDirs, DescribeConfigs):
// cluster-wide series without a member label, topics and groups by name, and its status
// (brokers, partitions in trouble, groups, members, the last members of an emptied group).
// Messages in/s is end-offset growth ("offsets/s"); lag in time is lag ÷ the topic's
// in-rate ("about"). Broker internals only when a Prometheus endpoint answered.
import { genericPage } from './generic.js';
import { duration } from './mysql.js';
import { ago, bytes, ipOwners, type Owner } from './owners.js';
import { endedClients, endedOf, rankEnded, type Ended } from './rabbitmq.js';
import { instant, one, pointsOf, range, some, SPARK_RANGE, valueOf } from './query.js';
import type { QuerySeries } from '../../../lib/victoria.js';
import type { IntegrationPage, PageContext, Panel, Reason, RowMetrics, Severity } from './types.js';

const P = 'integrations.kafka.panels';
const RATE = '2m';
const LAG_HIGH = 1000;

export interface KafkaBroker {
  id: number;
  host: string;
  port: number;
  rack?: string | null;
  controller: boolean;
  up: boolean;
}
export interface KafkaPartition {
  topic: string;
  partition: number;
  leader: number;
  replicas: string;
  isr: string;
  state: 'offline' | 'under_replicated';
}
export interface KafkaGroup {
  group: string;
  state: string;
  members: number;
  topics: string;
  lag: number;
}
export interface KafkaMember {
  group: string;
  client_id: string;
  client_host: string;
  assigned: number;
}
export interface KafkaLastMember {
  group: string;
  client_id: string;
  client_host: string;
  /** Unix seconds: the first scrape that saw the group empty. */
  left_at: number;
}
interface Extra {
  brokers?: KafkaBroker[];
  partitions?: KafkaPartition[];
  groups?: KafkaGroup[];
  members?: KafkaMember[];
  last_members?: KafkaLastMember[];
  quorum?: { leader: number; voters: number; observers: number }[];
  internals?: { member: string; url: string }[];
}
const extra = (ctx: PageContext): Extra =>
  (ctx.row.status_details as { extra?: Extra } | null)?.extra ?? {};
const missing = (ctx: PageContext) =>
  (ctx.row.status_details as { permissions?: { tab: string; missing: string }[] } | null)
    ?.permissions ?? [];

/** A panel whose read was refused: the ACL WatchLog's user lacks. */
function needs(ctx: PageContext, tab: string): Pick<Panel, 'state' | 'missing'> | null {
  const m = missing(ctx).find((p) => p.tab === tab)?.missing;
  return m ? { state: 'needs_permission', missing: { key: `${P}.acl`, values: { acl: m } } } : null;
}

/** A member's host by its workload or container, else the address. */
export function hostName(owners: Map<string, Owner>, host: string): string {
  return owners.get(host)?.name ?? host;
}

/** Retention: "7 d", "1.5 d", else hours and minutes. */
const retentionText = (sec: number) =>
  sec < 0 ? '∞' : sec >= 86_400 ? `${Number((sec / 86_400).toFixed(1))} d` : duration(sec);
const perMin = (perSecond: number) => Math.round(Math.abs(perSecond) * 60);
const at = (rows: QuerySeries[], key: string, value: string) =>
  rows.find((r) => r.labels[key] === value)?.points[0]?.[1] ?? null;
const bars = (
  rows: QuerySeries[],
  label: string,
  severityOf?: (v: number) => Severity | undefined,
) =>
  rows
    .map((r) => ({
      label: r.labels[label] ?? '',
      value: r.points[0]?.[1] ?? 0,
      severity: severityOf?.(r.points[0]?.[1] ?? 0),
    }))
    .sort((a, b) => b.value - a.value);

/** Each group's lag in time, about: its lag on each topic ÷ that topic's in-rate, the worst. */
function lagTimes(lags: QuerySeries[], rates: QuerySeries[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lags) {
    const g = l.labels.group ?? '';
    const lag = l.points[0]?.[1] ?? 0;
    const r = at(rates, 'topic', l.labels.topic ?? '');
    if (!lag || !r || r <= 0) continue;
    out.set(g, Math.max(out.get(g) ?? 0, lag / r));
  }
  return out;
}

async function overview(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [brokers, brokersUp, offline, under, msgIn, groups, empty, worst, byTopic, byGroup] =
    await Promise.all([
      instant(ctx, `max(watchlog_kafka_brokers{${s}})`),
      instant(ctx, `max(watchlog_kafka_brokers_up{${s}})`),
      instant(ctx, `max(watchlog_kafka_partitions_offline{${s}})`),
      instant(ctx, `max(watchlog_kafka_partitions_under_replicated{${s}})`),
      instant(ctx, `sum(rate(watchlog_kafka_topic_end_offset{${s}}[${RATE}]))`),
      instant(ctx, `max(watchlog_kafka_groups{${s}})`),
      instant(ctx, `count(max by (group) (watchlog_kafka_group_members{${s}}) == 0)`),
      instant(ctx, `topk(1, sum by (group) (watchlog_kafka_group_lag{${s}}))`),
      range(ctx, `topk(8, sum by (topic) (rate(watchlog_kafka_topic_end_offset{${s}}[${RATE}])))`),
      range(ctx, `topk(8, sum by (group) (watchlog_kafka_group_lag{${s}}))`),
    ]);
  const [lagsNow, rates] = await Promise.all([
    instant(ctx, `sum by (group, topic) (watchlog_kafka_group_lag{${s}})`),
    instant(ctx, `sum by (topic) (rate(watchlog_kafka_topic_end_offset{${s}}[5m]))`),
  ]);
  const b = valueOf(brokers);
  const up = valueOf(brokersUp);
  const off = valueOf(offline);
  const ur = valueOf(under);
  const g = valueOf(groups);
  const e = valueOf(empty) ?? 0;
  const top = worst[0];
  const times = lagTimes(lagsNow, rates);
  const list = extra(ctx).groups ?? [];
  return [
    {
      id: 'stats',
      title: `${P}.stats`,
      kind: 'stat',
      span: 2,
      state: b === null ? 'empty' : 'ok',
      tiles: [
        {
          id: 'brokers',
          labelKey: `${P}.brokersUp`,
          value: up,
          unit: 'count',
          sub: b !== null ? { key: `${P}.ofKnown`, values: { n: b } } : undefined,
          severity: b !== null && up !== null && up < b ? 'critical' : 'ok',
        },
        {
          id: 'offline',
          labelKey: `${P}.offline`,
          value: off,
          unit: 'count',
          severity: (off ?? 0) > 0 ? 'critical' : undefined,
        },
        {
          id: 'under',
          labelKey: `${P}.underReplicated`,
          value: ur,
          unit: 'count',
          severity: (ur ?? 0) > 0 ? 'warning' : undefined,
        },
        {
          id: 'in',
          labelKey: `${P}.messagesIn`,
          value: valueOf(msgIn),
          unit: 'per_second',
          sub: { key: `${P}.offsetsNote` },
        },
        {
          id: 'groups',
          labelKey: `${P}.groups`,
          value: g,
          unit: 'count',
          sub: e > 0 ? { key: `${P}.withoutMembers`, values: { n: e } } : undefined,
          severity: e > 0 ? 'warning' : undefined,
        },
        {
          id: 'lag',
          labelKey: `${P}.largestLag`,
          value: top ? Math.round(top.points[0]?.[1] ?? 0) : null,
          unit: 'count',
          sub: top ? { key: `${P}.ofGroup`, values: { group: top.labels.group ?? '' } } : undefined,
        },
      ],
    } as Panel,
    {
      id: 'rate',
      title: `${P}.rateByTopic`,
      kind: 'line',
      span: 1,
      unit: 'per_second',
      state: byTopic.length ? 'ok' : 'empty',
      note: { key: `${P}.offsetsNote` },
      series: byTopic.map((x) => ({ name: x.labels.topic ?? '', points: pointsOf(x) })),
    },
    {
      id: 'lag',
      title: `${P}.lagByGroup`,
      kind: 'line',
      span: 1,
      unit: 'count',
      ...(needs(ctx, 'consumer_groups/lag') ?? { state: byGroup.length ? 'ok' : 'empty' }),
      series: byGroup.map((x) => ({ name: x.labels.group ?? '', points: pointsOf(x) })),
    },
    {
      id: 'groups',
      title: `${P}.groupsTable`,
      kind: 'table',
      span: 2,
      ...(needs(ctx, 'consumer_groups/lag') ?? { state: list.length ? 'ok' : 'empty' }),
      note: { key: `${P}.lagTimeNote` },
      columns: [
        `${P}.cols.group`,
        `${P}.cols.state`,
        `${P}.cols.members`,
        `${P}.cols.topics`,
        `${P}.cols.lag`,
        `${P}.cols.lagTime`,
      ],
      rows: [...list]
        .sort((x, y) => y.lag - x.lag)
        .map((x) => {
          const t = times.get(x.group);
          return {
            cells: [
              x.group,
              x.state,
              x.members,
              x.topics || '–',
              x.lag,
              t !== undefined ? `~${duration(t)}` : '–',
            ],
            severity:
              x.members === 0 && x.lag > 0
                ? ('critical' as Severity)
                : x.lag > LAG_HIGH
                  ? ('warning' as Severity)
                  : undefined,
          };
        }),
    } as Panel,
  ];
}

async function topics(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [size, busy, parts, rf, off, under, retention, sizes] = await Promise.all([
    instant(ctx, `topk(15, max by (topic) (watchlog_kafka_topic_size_bytes{${s}}))`),
    instant(ctx, `topk(15, sum by (topic) (rate(watchlog_kafka_topic_end_offset{${s}}[${RATE}])))`),
    instant(ctx, `max by (topic) (watchlog_kafka_topic_partitions{${s}})`),
    instant(ctx, `max by (topic) (watchlog_kafka_topic_replication_factor{${s}})`),
    instant(ctx, `max by (topic) (watchlog_kafka_topic_offline_partitions{${s}})`),
    instant(ctx, `max by (topic) (watchlog_kafka_topic_under_replicated_partitions{${s}})`),
    instant(ctx, `max by (topic) (watchlog_kafka_topic_retention_seconds{${s}})`),
    instant(ctx, `max by (topic) (watchlog_kafka_topic_size_bytes{${s}})`),
  ]);
  const rows = parts
    .map((p) => {
      const t = p.labels.topic ?? '';
      const o = at(off, 'topic', t) ?? 0;
      const u = at(under, 'topic', t) ?? 0;
      const ret = at(retention, 'topic', t);
      const sz = at(sizes, 'topic', t);
      return {
        size: sz ?? 0,
        cells: [
          t,
          p.points[0]?.[1] ?? 0,
          at(rf, 'topic', t),
          o,
          u,
          ret === null ? '–' : retentionText(ret),
          sz === null ? '–' : bytes(sz),
        ],
        severity: o > 0 ? ('critical' as Severity) : u > 0 ? ('warning' as Severity) : undefined,
      };
    })
    .sort((a, b) => b.size - a.size)
    .map(({ cells, severity }) => ({ cells, severity }));
  return [
    {
      id: 'largest',
      title: `${P}.largest`,
      kind: 'bars',
      span: 1,
      unit: 'bytes',
      note: { key: `${P}.largestNote` },
      ...(needs(ctx, 'topics/largest') ?? { state: size.length ? 'ok' : 'empty' }),
      items: bars(size, 'topic'),
    },
    {
      id: 'busiest',
      title: `${P}.busiest`,
      kind: 'bars',
      span: 1,
      unit: 'per_second',
      note: { key: `${P}.offsetsNote` },
      state: busy.length ? 'ok' : 'empty',
      items: bars(busy, 'topic'),
    },
    {
      id: 'topics',
      title: `${P}.topicsTable`,
      kind: 'table',
      span: 2,
      ...(needs(ctx, 'topics/topics') ?? { state: rows.length ? 'ok' : 'empty' }),
      columns: [
        `${P}.cols.topic`,
        `${P}.cols.partitions`,
        `${P}.cols.replication`,
        `${P}.cols.offline`,
        `${P}.cols.underReplicated`,
        `${P}.cols.retention`,
        `${P}.cols.size`,
      ],
      rows,
    } as Panel,
  ];
}

async function consumerGroups(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [lag, consumed, owners] = await Promise.all([
    range(ctx, `topk(10, sum by (group, topic) (watchlog_kafka_group_lag{${s}}))`),
    range(
      ctx,
      `topk(10, sum by (group) (rate(watchlog_kafka_group_committed_offset{${s}}[${RATE}])))`,
    ),
    ipOwners(ctx.db, ctx.row.cluster_id),
  ]);
  const members = extra(ctx).members ?? [];
  const denied = needs(ctx, 'consumer_groups/lag');
  return [
    {
      id: 'lag',
      title: `${P}.lagByGroupTopic`,
      kind: 'line',
      span: 1,
      unit: 'count',
      ...(denied ?? { state: lag.length ? 'ok' : 'empty' }),
      series: lag.map((x) => ({
        name: `${x.labels.group ?? ''} · ${x.labels.topic ?? ''}`,
        points: pointsOf(x),
      })),
    },
    {
      id: 'consumed',
      title: `${P}.consumed`,
      kind: 'line',
      span: 1,
      unit: 'per_second',
      note: { key: `${P}.consumedNote` },
      ...(denied ?? { state: consumed.length ? 'ok' : 'empty' }),
      series: consumed.map((x) => ({ name: x.labels.group ?? '', points: pointsOf(x) })),
    },
    {
      id: 'members',
      title: `${P}.members`,
      kind: 'table',
      span: 2,
      ...(denied ?? { state: members.length ? 'ok' : 'empty' }),
      columns: [`${P}.cols.group`, `${P}.cols.clientId`, `${P}.cols.client`, `${P}.cols.assigned`],
      rows: members.map((m) => ({
        cells: [m.group, m.client_id, hostName(owners, m.client_host), m.assigned],
      })),
    } as Panel,
  ];
}

async function brokersTab(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [parts, leaders, logs] = await Promise.all([
    instant(ctx, `max by (broker) (watchlog_kafka_broker_partitions{${s}})`),
    instant(ctx, `max by (broker) (watchlog_kafka_broker_leaders{${s}})`),
    instant(ctx, `max by (broker) (watchlog_kafka_broker_log_bytes{${s}})`),
  ]);
  const ex = extra(ctx);
  const list = ex.brokers ?? [];
  const quorum = ex.quorum?.[0];
  const label = (r: QuerySeries) => `${r.labels.broker ?? ''}`;
  return [
    {
      id: 'brokers',
      title: `${P}.brokers`,
      kind: 'table',
      span: 2,
      state: list.length ? 'ok' : 'empty',
      note: quorum
        ? {
            key: `${P}.quorumNote`,
            values: { leader: quorum.leader, voters: quorum.voters },
          }
        : missing(ctx).some((p) => p.tab === 'brokers/brokers')
          ? { key: `${P}.quorumDenied` }
          : undefined,
      columns: [
        `${P}.cols.broker`,
        `${P}.cols.host`,
        `${P}.cols.rack`,
        `${P}.cols.controller`,
        `${P}.cols.reachable`,
      ],
      rows: list.map((b) => ({
        cells: [
          b.id,
          `${b.host}:${b.port}`,
          b.rack || '–',
          b.controller ? '✓' : '',
          b.up ? '✓' : '✗',
        ],
        severity: b.up ? undefined : ('critical' as Severity),
      })),
    } as Panel,
    {
      id: 'partitions',
      title: `${P}.partitionsPerBroker`,
      kind: 'bars',
      span: 1,
      unit: 'count',
      note: leaders.length
        ? {
            key: `${P}.leadersNote`,
            values: {
              leaders: leaders
                .map((l) => `${label(l)}: ${Math.round(l.points[0]?.[1] ?? 0)}`)
                .join(', '),
            },
          }
        : undefined,
      state: parts.length ? 'ok' : 'empty',
      items: parts
        .map((r) => ({ label: label(r), value: r.points[0]?.[1] ?? 0 }))
        .sort((a, b) => b.value - a.value),
    },
    {
      id: 'log_size',
      title: `${P}.logSize`,
      kind: 'bars',
      span: 1,
      unit: 'bytes',
      ...(needs(ctx, 'topics/largest') ?? { state: logs.length ? 'ok' : 'empty' }),
      items: logs
        .map((r) => ({ label: label(r), value: r.points[0]?.[1] ?? 0 }))
        .sort((a, b) => b.value - a.value),
    },
  ];
}

async function internals(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const found = (extra(ctx).internals ?? []).length > 0;
  const [bin, bout, req] = await Promise.all([
    range(ctx, `sum(rate(watchlog_kafka_internal_bytes_in_total{${s}}[${RATE}]))`),
    range(ctx, `sum(rate(watchlog_kafka_internal_bytes_out_total{${s}}[${RATE}]))`),
    range(
      ctx,
      `topk(6, sum by (request) (rate(watchlog_kafka_internal_requests_total{${s}}[${RATE}])))`,
    ),
  ]);
  const none = !found && !bin.length && !req.length;
  const note = none ? { key: `${P}.internalsNone` } : undefined;
  return [
    {
      id: 'traffic',
      title: `${P}.traffic`,
      kind: 'line',
      span: 1,
      unit: 'bytes_per_second',
      state: bin.length || bout.length ? 'ok' : 'empty',
      note,
      series: [
        { nameKey: `${P}.series.in`, points: pointsOf(bin[0]) },
        { nameKey: `${P}.series.out`, points: pointsOf(bout[0]) },
      ],
    },
    {
      id: 'requests',
      title: `${P}.requests`,
      kind: 'line',
      span: 1,
      unit: 'per_second',
      state: req.length ? 'ok' : 'empty',
      note,
      series: req.map((x) => ({ name: x.labels.request ?? '', points: pointsOf(x) })),
    },
  ];
}

// ------------------------------------------------------------------ the lost group

/** The last time a group had members, from the last 6 hours (null: none in them). */
async function lastMembersAt(ctx: PageContext, group: string): Promise<number | null> {
  if (!ctx.vm) return null;
  const end = Math.floor(ctx.now / 1000);
  const rows = await ctx.vm.queryRange(
    { clusterId: ctx.row.cluster_id },
    `max(watchlog_kafka_group_members{${one(ctx.row.id)},group="${esc(group)}"})`,
    end - 6 * 3600,
    end,
    30,
  );
  const points = rows[0]?.points ?? [];
  for (let i = points.length - 1; i >= 0; i--) {
    const [t, v] = points[i]!;
    if (v !== null && v > 0) return t;
  }
  return null;
}

/**
 * The group's last members, as the collector remembered them, through the IP map to their
 * workload or container, with how each ended (OOM-killed, crash-looping, exited, gone):
 * closest first to when the group emptied. When none maps (the address is gone from the
 * map), the clients of the broker port that ended stand in, as RabbitMQ's (ADR-145).
 */
export async function formerMembers(
  ctx: PageContext,
  group: string,
  lostAt: number | null,
  owners: Map<string, Owner>,
): Promise<{ ended: Ended[]; last: string | null }> {
  const last = (extra(ctx).last_members ?? []).filter((m) => m.group === group);
  const out: Ended[] = [];
  const seen = new Set<string>();
  let lastName: string | null = null;
  for (const m of last) {
    const o = owners.get(m.client_host);
    lastName ??= o?.name ?? (m.client_id || m.client_host || null);
    if (!o || seen.has(o.name)) continue;
    seen.add(o.name);
    const e =
      o.kind === 'workload'
        ? await endedOf(
            ctx,
            {
              namespace: o.name.split('/')[0]!,
              workload: o.name.split('/').slice(1).join('/'),
            },
            lostAt,
          )
        : await endedOf(ctx, { container: o.name }, lostAt);
    if (e) out.push(e);
  }
  if (out.length) return { ended: rankEnded(out, lostAt), last: lastName };
  return { ended: await endedClients(ctx, lostAt), last: lastName };
}

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

async function reasons(ctx: PageContext): Promise<Reason[]> {
  const s = one(ctx.row.id);
  const by = 'group';
  const [offline, offTopic, under, underTopic, lostBrokers, lost, growing, owners] =
    await Promise.all([
      instant(ctx, `max(watchlog_kafka_partitions_offline{${s}})`),
      instant(ctx, `topk(1, max by (topic) (watchlog_kafka_topic_offline_partitions{${s}}) > 0)`),
      instant(ctx, `max(watchlog_kafka_partitions_under_replicated{${s}})`),
      instant(
        ctx,
        `topk(1, max by (topic) (watchlog_kafka_topic_under_replicated_partitions{${s}}) > 0)`,
      ),
      instant(
        ctx,
        `max(max_over_time(watchlog_kafka_brokers{${s}}[1h])) - max(watchlog_kafka_brokers{${s}})`,
      ),
      // No member now, lag growing for 5 minutes, and members in the last 24 hours.
      instant(
        ctx,
        `(sum by (${by}) (watchlog_kafka_group_lag{${s}}) > 0) and on (${by}) (max by (${by}) (watchlog_kafka_group_members{${s}}) == 0) and on (${by}) (sum by (${by}) (deriv(watchlog_kafka_group_lag{${s}}[5m])) > 0) and on (${by}) (max by (${by}) (max_over_time(watchlog_kafka_group_members{${s}}[24h])) > 0)`,
      ),
      // Members, but falling behind for 10 minutes.
      instant(
        ctx,
        `(sum by (${by}, topic) (watchlog_kafka_group_lag{${s}}) > ${LAG_HIGH}) and on (${by}) (max by (${by}) (watchlog_kafka_group_members{${s}}) > 0) and on (${by}, topic) (sum by (${by}, topic) (deriv(watchlog_kafka_group_lag{${s}}[10m])) > 0)`,
      ),
      ipOwners(ctx.db, ctx.row.cluster_id),
    ]);
  const out: Reason[] = [];
  const off = valueOf(offline) ?? 0;
  if (off > 0)
    out.push({
      severity: 'critical',
      code: 'offline_partitions',
      facts: { n: off, topic: offTopic[0]?.labels.topic ?? null },
    });
  const gone = valueOf(lostBrokers) ?? 0;
  if (gone > 0) out.push({ severity: 'critical', code: 'broker_down', facts: { n: gone } });
  if (lost.length) {
    const top = [...lost].sort((a, b) => (b.points[0]?.[1] ?? 0) - (a.points[0]?.[1] ?? 0))[0]!;
    const group = top.labels.group ?? '';
    const [growth, since] = await Promise.all([
      instant(ctx, `sum(deriv(watchlog_kafka_group_lag{${s},group="${esc(group)}"}[5m]))`),
      lastMembersAt(ctx, group),
    ]);
    const leftAt =
      since ?? (extra(ctx).last_members ?? []).find((m) => m.group === group)?.left_at ?? null;
    const { ended, last } = await formerMembers(ctx, group, leftAt, owners);
    const first = ended[0];
    out.push({
      severity: 'critical',
      code: 'group_no_members',
      facts: {
        group,
        groups: lost.length,
        lag: Math.round(top.points[0]?.[1] ?? 0),
        perMin: perMin(valueOf(growth) ?? 0),
        sinceAt: leftAt,
        since: leftAt ? ago(leftAt, ctx.now) : null,
        member: first?.name ?? last,
        how: first?.how ?? null,
        when: first?.at ? ago(first.at, ctx.now) : null,
      },
      links: ended.map((e) => ({ kind: e.kind, id: e.id, name: e.name })),
    });
  }
  const ur = valueOf(under) ?? 0;
  if (ur > 0)
    out.push({
      severity: 'warning',
      code: 'under_replicated',
      facts: { n: ur, topic: underTopic[0]?.labels.topic ?? null },
    });
  if (growing.length) {
    const rates = await instant(
      ctx,
      `sum by (${by}, topic) (deriv(watchlog_kafka_group_lag{${s}}[10m]))`,
    );
    for (const g of [...growing]
      .sort((a, b) => (b.points[0]?.[1] ?? 0) - (a.points[0]?.[1] ?? 0))
      .slice(0, 3)) {
      const r = rates.find(
        (x) => x.labels.group === g.labels.group && x.labels.topic === g.labels.topic,
      );
      out.push({
        severity: 'warning',
        code: 'group_lag_growing',
        facts: {
          group: g.labels.group ?? '',
          topic: g.labels.topic ?? '',
          lag: Math.round(g.points[0]?.[1] ?? 0),
          perMin: perMin(r?.points[0]?.[1] ?? 0),
        },
      });
    }
  }
  return out;
}

export const kafkaPage: IntegrationPage = {
  id: 'kafka',
  tabs: [
    { id: 'overview', title: 'integrations.kafka.tabs.overview', panels: overview },
    { id: 'topics', title: 'integrations.kafka.tabs.topics', panels: topics },
    {
      id: 'consumer_groups',
      title: 'integrations.kafka.tabs.consumer_groups',
      panels: consumerGroups,
    },
    { id: 'brokers', title: 'integrations.kafka.tabs.brokers', panels: brokersTab },
    { id: 'internals', title: 'integrations.kafka.tabs.internals', panels: internals },
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
    const inQ = `sum by (service) (rate(watchlog_kafka_topic_end_offset{${s}}[5m]))`;
    const [msgIn, lag, offline, spark] = await Promise.all([
      vm.query(scope, inQ),
      vm.query(
        scope,
        `max by (service) (sum by (service, group) (watchlog_kafka_group_lag{${s}}))`,
      ),
      vm.query(scope, `max by (service) (watchlog_kafka_partitions_offline{${s}})`),
      vm.queryRange(scope, inQ, end - SPARK_RANGE, end, 300),
    ]);
    const val = (rows: QuerySeries[], id: string) =>
      rows.find((r) => r.labels.service === id)?.points[0]?.[1] ?? null;
    const out = new Map<string, RowMetrics>();
    for (const id of ids) {
      const off = val(offline, id);
      out.set(id, {
        keyMetrics: [
          { id: 'in', labelKey: `${P}.messagesIn`, value: val(msgIn, id), unit: 'per_second' },
          { id: 'lag', labelKey: `${P}.largestLag`, value: val(lag, id), unit: 'count' },
          {
            id: 'offline',
            labelKey: `${P}.offline`,
            value: off,
            unit: 'count',
            severity: (off ?? 0) > 0 ? 'critical' : undefined,
          },
        ],
        spark: spark.find((x) => x.labels.service === id)?.points ?? [],
      });
    }
    return out;
  },

  reasons,
};
