// SPDX-License-Identifier: AGPL-3.0-only
// The Redis and Valkey page since 1.4 (ADR-247): what fills the memory (the key sampler's
// prefixes), which commands cost the main thread and who sends them, clients against their
// output-buffer limits, streams and their groups, persistence and whether the next save fits,
// replication, Sentinel and a cluster's slots. Values are never read; key names leave the agent
// only with the names switch on. Every number shown twice on a page is read once (aligned).
import { escapeLabelValue } from '../../query/catalog.js';
import type { QuerySeries } from '../../../lib/victoria.js';
import { clientOf, memoryLimit, ownersOf, processOf, rateWindow } from './db-deep.js';
import { duration } from './mysql.js';
import { ago, bytes, type Owner } from './owners.js';
import { instant, one, pointsOf, range, valueOf } from './query.js';
import { aligned } from './rabbitmq-tabs.js';
import type {
  ChecksPanel,
  FlowPanel,
  Link,
  PageContext,
  Panel,
  Severity,
  TablePanel,
  Text,
} from './types.js';

const P = 'integrations.redis.panels';
// 1.2's shared database words (a template, so the keys test reads only `${D}.…` uses).
const D = `integrations.db.panels`;
const RATE = '2m';

export interface SlowEntry {
  at: number;
  usec: number;
  member: string;
  command: string;
  client?: string;
  name?: string;
}
interface ClientDetail {
  addr: string;
  connections: number;
  blocked: number;
  subscribed: number;
  young: number;
  idle: number;
  omem: number;
  limit: number;
  class: string;
  cmd: string;
  name: string;
  member: string;
}
interface PrefixRow {
  prefix: string;
  type: string;
  ttl_share: number;
  member: string;
}
interface BigKey {
  key: string;
  prefix: string;
  type: string;
  bytes: number;
  elements: number;
  member: string;
}
interface Consumer {
  stream: string;
  group: string;
  consumer: string;
  pending: number;
  idle: number;
  inactive: number;
  member: string;
}
interface Setting {
  name: string;
  value: string;
  member: string;
}
interface LatencyEvent {
  event: string;
  at: number;
  latest_ms: number;
  max_ms: number;
  member: string;
}
interface SentinelMaster {
  master: string;
  status: string;
  address: string;
  replicas: number;
  sentinels: number;
  member: string;
}
interface ClusterNode {
  node: string;
  role: string;
  health: string;
  slots?: number;
  member: string;
}
export interface Extra {
  slowlog?: SlowEntry[];
  clients?: { addr: string; connections: number; member: string }[];
  client_detail?: ClientDetail[];
  prefixes?: PrefixRow[];
  largest_keys?: BigKey[];
  stream_consumers?: Consumer[];
  settings?: Setting[];
  latency_events?: LatencyEvent[];
  sentinel_masters?: SentinelMaster[];
  cluster_nodes?: ClusterNode[];
}
export const extraOf = (ctx: PageContext): Extra =>
  (ctx.row.status_details as { extra?: Extra }).extra ?? {};

/** Commands that read the whole keyspace or a whole collection: a finding in the slow log. */
export const ON_COMMANDS =
  /^(KEYS|SMEMBERS|HGETALL|LRANGE|ZRANGE|SUNION|SINTER|SDIFF|FLUSH|SORT)\b/;

const settingOf = (ex: Extra, name: string) =>
  (ex.settings ?? []).find((x) => x.name === name)?.value ?? null;

export const itemLink = (tab: string, id: string, name = id): Link => ({
  kind: 'item',
  tab,
  id,
  name: name.length > 60 ? `${name.slice(0, 60)}…` : name,
});

/** Per prefix: memory now and 2 h ago, keys, keys with a TTL (the sampler's last pass). */
export async function prefixStats(ctx: PageContext) {
  const s = one(ctx.row.id);
  const q = (e: string) => instant(ctx, `sum by (prefix) (${e})`);
  const [mem, mem2h, keys, ttl, used, used2h] = await Promise.all([
    q(`max by (prefix, member) (watchlog_redis_prefix_memory_bytes{${s}})`),
    q(`max by (prefix, member) (watchlog_redis_prefix_memory_bytes{${s}} offset 2h)`),
    q(`max by (prefix, member) (watchlog_redis_prefix_keys{${s}})`),
    q(`max by (prefix, member) (watchlog_redis_prefix_ttl_keys{${s}})`),
    instant(ctx, `max(watchlog_redis_memory_used_bytes{${s}})`),
    instant(ctx, `max(watchlog_redis_memory_used_bytes{${s}} offset 2h)`),
  ]);
  const m = (r: QuerySeries[]) =>
    new Map(r.map((x) => [x.labels.prefix ?? '', x.points[0]?.[1] ?? 0]));
  const [memM, mem2M, keysM, ttlM] = [m(mem), m(mem2h), m(keys), m(ttl)];
  // Shares are of the sampled total (the prefixes add up to the dataset, extrapolated).
  const total = [...memM.values()].reduce((a, b) => a + b, 0);
  const total2h = [...mem2M.values()].reduce((a, b) => a + b, 0);
  const types = new Map(extraOf(ctx).prefixes?.map((x) => [x.prefix, x.type]) ?? []);
  return {
    used: valueOf(used),
    used2h: valueOf(used2h),
    rows: [...memM.entries()]
      .map(([prefix, b]) => {
        const k = keysM.get(prefix) ?? 0;
        const before = mem2M.get(prefix);
        return {
          prefix,
          bytes: b,
          share: total > 0 ? b / total : 0,
          share2h: before !== undefined && total2h > 0 ? before / total2h : null,
          keys: k,
          ttl: k > 0 ? (ttlM.get(prefix) ?? 0) / k : null,
          type: types.get(prefix) ?? null,
        };
      })
      .sort((a, b) => b.bytes - a.bytes),
  };
}
export type PrefixStat = Awaited<ReturnType<typeof prefixStats>>['rows'][number];

/** "session:" → "session:*" as the page writes a prefix. */
export const star = (p: string) => (p === '(no prefix)' || p === 'other' ? p : `${p}*`);

/** Each client address's detail summed over members (the collector reports per member). */
function clientRows(ex: Extra, owners: Map<string, Owner>) {
  const out = new Map<
    string,
    {
      name: string;
      link?: Link;
      connections: number;
      blocked: number;
      subscribed: number;
      young: number;
      idle: number;
      omem: number;
      limit: number;
      cmd: string;
      cname: string;
    }
  >();
  for (const x of ex.client_detail ?? []) {
    const c = clientOf(owners, x.addr, x.name);
    const cur = out.get(c.name) ?? {
      ...c,
      connections: 0,
      blocked: 0,
      subscribed: 0,
      young: 0,
      idle: Number.POSITIVE_INFINITY,
      omem: 0,
      limit: 0,
      cmd: x.cmd,
      cname: x.name,
    };
    cur.connections += x.connections;
    cur.blocked += x.blocked;
    cur.subscribed += x.subscribed;
    cur.young += x.young;
    cur.idle = Math.min(cur.idle, x.idle);
    if (x.limit > 0 && (cur.limit === 0 || x.omem / x.limit > cur.omem / cur.limit)) {
      cur.omem = x.omem;
      cur.limit = x.limit;
    } else if (cur.limit === 0) cur.omem = Math.max(cur.omem, x.omem);
    out.set(c.name, cur);
  }
  return [...out.values()].sort((a, b) => b.connections - a.connections);
}

// ------------------------------------------------------------------------- Overview

export async function overview(input: PageContext): Promise<Panel[]> {
  const ctx = aligned(input);
  const s = one(ctx.row.id);
  const [
    used,
    max,
    policy,
    hits,
    misses,
    hitUsual,
    ops,
    opsUsual,
    calls,
    slowest,
    clients,
    blocked,
    maxclients,
    evicted,
    evictedYesterday,
    frag,
    keys,
    expiring,
    lastSave,
    saveOk,
    aof,
    aofOk,
    primary,
    replicaLag,
    linkUp,
    replicasOnline,
    rejected,
    usedSeries,
    maxSeries,
    evictSeries,
    expireSeries,
    owners,
    prefixes,
    hitSeries,
  ] = await Promise.all([
    instant(ctx, `max(watchlog_redis_memory_used_bytes{${s}})`),
    instant(ctx, `max(watchlog_redis_memory_max_bytes{${s}})`),
    instant(ctx, `max by (policy) (watchlog_redis_maxmemory_policy_info{${s}})`),
    instant(ctx, `sum(rate(watchlog_redis_keyspace_hits_total{${s}}[15m]))`),
    instant(ctx, `sum(rate(watchlog_redis_keyspace_misses_total{${s}}[15m]))`),
    instant(
      ctx,
      `sum(rate(watchlog_redis_keyspace_hits_total{${s}}[6h] offset 15m)) / (sum(rate(watchlog_redis_keyspace_hits_total{${s}}[6h] offset 15m)) + sum(rate(watchlog_redis_keyspace_misses_total{${s}}[6h] offset 15m)))`,
    ),
    instant(ctx, `sum(rate(watchlog_redis_commands_processed_total{${s}}[${RATE}]))`),
    instant(ctx, `sum(rate(watchlog_redis_commands_processed_total{${s}}[6h] offset 15m))`),
    instant(ctx, `sum by (command) (rate(watchlog_redis_command_calls_total{${s}}[15m]))`),
    instant(
      ctx,
      `topk(1, sum by (command) (rate(watchlog_redis_command_usec_total{${s}}[15m])) / (sum by (command) (rate(watchlog_redis_command_calls_total{${s}}[15m])) > 0) / 1e6)`,
    ),
    instant(ctx, `max(watchlog_redis_connected_clients{${s}})`),
    instant(ctx, `sum(watchlog_redis_blocked_clients{${s}})`),
    instant(ctx, `max(watchlog_redis_maxclients{${s}})`),
    instant(ctx, `sum(rate(watchlog_redis_evicted_keys_total{${s}}[5m])) * 60`),
    instant(ctx, `sum(rate(watchlog_redis_evicted_keys_total{${s}}[1h] offset 1d)) * 60`),
    instant(ctx, `max(watchlog_redis_mem_fragmentation_ratio{${s}})`),
    instant(ctx, `max(sum by (member) (watchlog_redis_keys{${s}}))`),
    instant(ctx, `max(sum by (member) (watchlog_redis_keys_expiring{${s}}))`),
    instant(ctx, `max(watchlog_redis_rdb_last_save_timestamp_seconds{${s}})`),
    instant(ctx, `min(watchlog_redis_rdb_last_save_ok{${s}})`),
    instant(ctx, `max(watchlog_redis_aof_enabled{${s}})`),
    instant(ctx, `min(watchlog_redis_aof_last_write_ok{${s}})`),
    instant(ctx, `max(watchlog_redis_is_primary{${s}})`),
    instant(ctx, `max(watchlog_redis_replica_offset_lag_bytes{${s}})`),
    instant(ctx, `min(watchlog_redis_master_link_up{${s}})`),
    instant(ctx, `sum(watchlog_redis_replica_online{${s}})`),
    instant(ctx, `sum(increase(watchlog_redis_rejected_connections_total{${s}}[24h]))`),
    range(ctx, `max(watchlog_redis_memory_used_bytes{${s}})`),
    range(ctx, `max(watchlog_redis_memory_max_bytes{${s}} > 0)`),
    range(ctx, `sum(rate(watchlog_redis_evicted_keys_total{${s}}[${RATE}]))`),
    range(ctx, `sum(rate(watchlog_redis_expired_keys_total{${s}}[${RATE}]))`),
    ownersOf(ctx),
    prefixStats(ctx),
    range(
      ctx,
      `sum(rate(watchlog_redis_keyspace_hits_total{${s}}[${RATE}])) / (sum(rate(watchlog_redis_keyspace_hits_total{${s}}[${RATE}])) + sum(rate(watchlog_redis_keyspace_misses_total{${s}}[${RATE}])) > 0)`,
    ),
  ]);
  const ex = extraOf(ctx);
  const u = valueOf(used);
  const m = valueOf(max) || null;
  const ratio = u !== null && m ? u / m : null;
  const h = valueOf(hits) ?? 0;
  const mi = valueOf(misses) ?? 0;
  const hit = h + mi > 0 ? h / (h + mi) : null;
  const evMin = valueOf(evicted) ?? 0;
  const k = valueOf(keys);
  const exp = valueOf(expiring);
  const ttlShare = k ? (exp ?? 0) / k : null;
  const pol = policy[0]?.labels.policy ?? null;
  const totalCalls = calls.reduce((a, x) => a + (x.points[0]?.[1] ?? 0), 0);
  const topCmds = [...calls]
    .map((x) => ({ c: x.labels.command ?? '', n: x.points[0]?.[1] ?? 0 }))
    .filter((x) => x.c !== 'other')
    .sort((a, b) => b.n - a.n)
    .slice(0, 2);
  const slow = [...(ex.slowlog ?? [])].sort((a, b) => b.at - a.at);
  // The check reads the last hour: old entries stay in the slow log until they rotate out.
  const onSlow = slow.filter(
    (x) => ON_COMMANDS.test(x.command) && x.at * 1000 >= ctx.now - 3_600_000,
  );
  const isPrimary = valueOf(primary) !== 0;
  const cl = clientRows(ex, owners);
  const top = prefixes.rows.filter((x) => x.prefix !== 'other');
  const grew = top[0] && top[0].share2h !== null ? top[0].share - top[0].share2h : null;
  const at = valueOf(lastSave);

  // Memory against maxmemory with the largest prefix's memory beneath it.
  const topSeries = top[0]
    ? await range(
        ctx,
        `sum(max by (member) (watchlog_redis_prefix_memory_bytes{${s}, prefix="${escapeLabelValue(top[0].prefix)}"}))`,
      )
    : [];
  // When evictions started in this range: the first point of the last run above zero.
  const ev = pointsOf(evictSeries[0]);
  let evStart: number | null = null;
  for (let i = ev.length - 1; i >= 0; i--) {
    if ((ev[i]![1] ?? 0) <= 0) break;
    evStart = ev[i]![0];
  }
  const markers =
    evStart && ev[0] && evStart > ev[0][0]
      ? [
          {
            at: evStart,
            text: { key: `${P}.marker.evictions` } as Text,
            severity: 'warning' as Severity,
          },
        ]
      : [];

  const flow: FlowPanel = {
    id: 'flow',
    title: `${P}.flow.title`,
    kind: 'flow',
    span: 2,
    state: u === null ? 'empty' : 'ok',
    note: { key: `${P}.flow.note` },
    columns: [
      {
        id: 'clients',
        title: { key: `${D}.flow.clients`, values: { n: cl.length } },
        value: valueOf(clients),
        unit: 'count',
        valueKey: `${D}.flow.connections`,
        rows: cl.slice(0, 3).map((x) => ({
          name: x.name,
          value: x.connections,
          unit: 'count' as const,
          ...(x.link ? { link: x.link } : {}),
          ...(x.cmd
            ? {
                text: {
                  key: `${P}.flow.runs`,
                  values: { n: x.connections, cmd: x.cmd.toUpperCase() },
                },
              }
            : {}),
        })),
        next: valueOf(ops),
      },
      {
        id: 'commands',
        title: { key: `${P}.flow.commands` },
        value: valueOf(ops),
        unit: 'per_second',
        valueKey: `${P}.flow.cmdPerSecond`,
        rows: [
          ...topCmds.map((x) => ({
            name: x.c.toUpperCase(),
            value: totalCalls > 0 ? x.n / totalCalls : null,
            unit: 'ratio' as const,
          })),
          ...(slowest[0]
            ? [
                {
                  name: '',
                  nameKey: `${P}.flow.slowest`,
                  value: null,
                  unit: 'seconds' as const,
                  text: {
                    key: `${P}.flow.slowestText`,
                    values: {
                      cmd: (slowest[0].labels.command ?? '').toUpperCase(),
                      ms: Math.round((slowest[0].points[0]?.[1] ?? 0) * 1e5) / 100,
                    },
                  },
                  ...(ON_COMMANDS.test((slowest[0].labels.command ?? '').toUpperCase())
                    ? { severity: 'warning' as Severity }
                    : {}),
                },
              ]
            : []),
          { name: '', nameKey: `${P}.flow.hit`, value: hit, unit: 'ratio' as const },
        ],
        next: null,
      },
      {
        id: 'memory',
        title: { key: `${P}.flow.memory` },
        value: ratio,
        unit: 'ratio',
        valueKey: m ? `${P}.flow.ofMaxmemory` : `${P}.flow.noMax`,
        ...(evMin > 0
          ? { severity: 'warning' as Severity }
          : ratio !== null && ratio > 0.9
            ? { severity: 'warning' as Severity }
            : {}),
        rows: [
          ...top.slice(0, 2).map((x, i) => ({
            name: star(x.prefix),
            value: x.share,
            unit: 'ratio' as const,
            ...(i === 0 && grew !== null && grew > 0.05
              ? {
                  text: { key: `${P}.flow.grew`, values: { pct: Math.round(x.share * 100) } },
                  severity: 'warning' as Severity,
                }
              : {}),
          })),
          {
            name: '',
            nameKey: `${P}.flow.fragmentation`,
            value: valueOf(frag),
            unit: 'load' as const,
          },
          {
            name: '',
            nameKey: `${P}.flow.evicted`,
            value: null,
            unit: 'count' as const,
            text: {
              key: `${P}.flow.perMin`,
              values: { n: Math.round(evMin).toLocaleString('en') },
            },
            ...(evMin > 0 ? { severity: 'warning' as Severity } : {}),
          },
        ],
      },
      {
        id: 'persistence',
        title: { key: isPrimary ? `${P}.flow.persistence` : `${P}.flow.persistenceReplica` },
        value: at ? Math.max(0, Math.floor(ctx.now / 1000) - at) : null,
        unit: 'seconds',
        valueKey: `${P}.flow.sinceSave`,
        ...(valueOf(saveOk) === 0 ? { severity: 'critical' as Severity } : {}),
        rows: [
          {
            name: '',
            nameKey: `${P}.flow.aof`,
            value: null,
            unit: 'count' as const,
            text: {
              key:
                (valueOf(aof) ?? 0) > 0
                  ? (valueOf(aofOk) ?? 1) > 0
                    ? `${P}.flow.aofOk`
                    : `${P}.flow.aofFailed`
                  : `${P}.flow.off`,
            },
            ...((valueOf(aof) ?? 0) > 0 && valueOf(aofOk) === 0
              ? { severity: 'critical' as Severity }
              : {}),
          },
          {
            name: '',
            nameKey: `${P}.flow.replica`,
            value: null,
            unit: 'bytes' as const,
            text: isPrimary
              ? (valueOf(replicasOnline) ?? 0) > 0
                ? { key: `${P}.flow.inSync`, values: { size: bytes(valueOf(replicaLag) ?? 0) } }
                : { key: `${P}.flow.noReplica` }
              : { key: valueOf(linkUp) === 1 ? `${P}.flow.linkUp` : `${P}.flow.linkDown` },
            ...(!isPrimary && valueOf(linkUp) === 0 ? { severity: 'critical' as Severity } : {}),
          },
          {
            name: '',
            nameKey: `${P}.flow.blocked`,
            value: valueOf(blocked) ?? 0,
            unit: 'count' as const,
          },
        ],
      },
    ],
  };

  const checks: ChecksPanel = {
    id: 'checks',
    title: `${D}.checks.title`,
    kind: 'checks',
    span: 1,
    layout: 'side',
    state: u === null ? 'empty' : 'ok',
    items: [
      {
        id: 'memory',
        labelKey: `${P}.checks.memory`,
        state: ratio !== null && ratio > 0.9 ? (ratio > 0.98 ? 'fail' : 'warn') : 'pass',
        value: m
          ? { key: `${D}.checks.pct`, values: { pct: Math.round((ratio ?? 0) * 100) } }
          : { key: `${P}.checks.noMax` },
      },
      {
        id: 'evicted',
        labelKey: `${P}.checks.evicted`,
        state: evMin > 0 ? 'fail' : 'pass',
        value: { key: `${P}.checks.perMin`, values: { n: Math.round(evMin).toLocaleString('en') } },
        link: { kind: 'tab', tab: 'memory', name: 'memory' },
      },
      {
        id: 'slowlog',
        labelKey: `${P}.checks.slowlog`,
        state: onSlow.length ? 'warn' : 'pass',
        value: onSlow.length
          ? {
              key: `${P}.checks.times`,
              values: { cmd: onSlow[0]!.command.split(' ')[0]!, n: onSlow.length },
            }
          : { key: `${D}.checks.none` },
        link: { kind: 'tab', tab: 'commands', name: 'commands' },
      },
      {
        id: 'maxmemory',
        labelKey: `${P}.checks.maxmemory`,
        state: m ? 'pass' : 'warn',
        value: m
          ? { key: `${P}.checks.maxOf`, values: { size: bytes(m), policy: pol } }
          : { key: `${P}.checks.notSet` },
      },
      {
        id: 'replica',
        labelKey: `${P}.checks.replica`,
        state: isPrimary ? 'pass' : valueOf(linkUp) === 0 ? 'fail' : 'pass',
        value: isPrimary
          ? (valueOf(replicasOnline) ?? 0) > 0
            ? { key: `${P}.checks.behind`, values: { size: bytes(valueOf(replicaLag) ?? 0) } }
            : { key: `${P}.flow.noReplica` }
          : { key: valueOf(linkUp) === 1 ? `${P}.flow.linkUp` : `${P}.flow.linkDown` },
        link: { kind: 'tab', tab: 'replication', name: 'replication' },
      },
      {
        id: 'save',
        labelKey: `${P}.checks.save`,
        state: valueOf(saveOk) === 0 ? 'fail' : 'pass',
        value:
          at && at > 0
            ? { key: `${P}.checks.ago`, values: { ago: ago(at, ctx.now) } }
            : { key: `${P}.checks.never` },
        link: { kind: 'tab', tab: 'persistence', name: 'persistence' },
      },
      {
        id: 'rejected',
        labelKey: `${P}.checks.rejected`,
        state: (valueOf(rejected) ?? 0) > 0 ? 'fail' : 'pass',
        value: { key: `${P}.checks.n`, values: { n: Math.round(valueOf(rejected) ?? 0) } },
      },
      {
        id: 'fragmentation',
        labelKey: `${P}.checks.fragmentation`,
        state: (valueOf(frag) ?? 0) > 1.5 && (u ?? 0) > 100 * 2 ** 20 ? 'warn' : 'pass',
        value: {
          key: `${P}.checks.ratio`,
          values: { r: valueOf(frag) === null ? '–' : (valueOf(frag) ?? 0).toFixed(2) },
        },
      },
    ],
  };

  return [
    flow,
    {
      id: 'summary',
      title: `${D}.tiles.title`,
      kind: 'stat',
      span: 2,
      state: u === null ? 'empty' : 'ok',
      tiles: [
        {
          id: 'memory',
          labelKey: `${P}.memory`,
          value: ratio ?? u,
          unit: ratio !== null ? 'ratio' : 'bytes',
          sub: m
            ? { key: `${P}.tiles.ofMax`, values: { used: bytes(u ?? 0), max: bytes(m) } }
            : { key: `${P}.noMax` },
          ...(ratio !== null && ratio > 0.9 ? { severity: 'warning' as Severity } : {}),
        },
        {
          id: 'hit',
          labelKey: `${P}.hitRate`,
          value: hit,
          unit: 'ratio',
          sub:
            valueOf(hitUsual) !== null
              ? { key: `${P}.tiles.was`, values: { pct: Math.round(valueOf(hitUsual)! * 100) } }
              : undefined,
          ...(hit !== null && valueOf(hitUsual) !== null && hit < valueOf(hitUsual)! - 0.1
            ? { severity: 'warning' as Severity }
            : {}),
        },
        {
          id: 'ops',
          labelKey: `${P}.tiles.commands`,
          value: valueOf(ops),
          unit: 'per_second',
          sub:
            valueOf(opsUsual) !== null
              ? { key: `${P}.tiles.usual`, values: { n: Math.round(valueOf(opsUsual)!) } }
              : undefined,
        },
        {
          id: 'evicted',
          labelKey: `${P}.tiles.evicted`,
          value: Math.round(evMin),
          unit: 'count',
          sub: {
            key: `${P}.tiles.yesterday`,
            values: { n: Math.round(valueOf(evictedYesterday) ?? 0) },
          },
          ...(evMin > 0 ? { severity: 'warning' as Severity } : {}),
        },
        {
          id: 'clients',
          labelKey: `${P}.clients`,
          value: valueOf(clients),
          unit: 'count',
          sub: valueOf(maxclients)
            ? { key: `${P}.tiles.ofMaxclients`, values: { n: Math.round(valueOf(maxclients)!) } }
            : undefined,
        },
        {
          id: 'ttl',
          labelKey: `${P}.tiles.ttl`,
          value: ttlShare,
          unit: 'ratio',
          sub:
            top[0] && top[0].ttl !== null
              ? {
                  key: `${P}.tiles.prefixTtl`,
                  values: { prefix: star(top[0].prefix), pct: Math.round(top[0].ttl * 100) },
                }
              : undefined,
        },
      ],
    },
    {
      id: 'memory',
      title: `${P}.charts.memory`,
      kind: 'line',
      span: 1,
      unit: 'bytes',
      state: usedSeries.length ? 'ok' : 'empty',
      ...(markers.length ? { markers } : {}),
      series: [
        { nameKey: `${P}.series.used`, points: pointsOf(usedSeries[0]) },
        ...(top[0] && topSeries[0]
          ? [
              {
                name: star(top[0].prefix),
                points: pointsOf(topSeries[0]),
                severity: 'warning' as Severity,
              },
            ]
          : []),
        ...(maxSeries[0]
          ? [{ nameKey: `${P}.maxmemory`, points: pointsOf(maxSeries[0]), dashed: true }]
          : []),
      ],
    },
    {
      // The design's "Hit rate and evictions": the hit rate, with the moment evictions began
      // marked (one unit a chart; evictions are the tile beside and the Memory tab's chart).
      id: 'hits',
      title: `${P}.charts.hitRate`,
      kind: 'line',
      span: 1,
      unit: 'ratio',
      state: hitSeries.length ? 'ok' : 'empty',
      ...(markers.length ? { markers } : {}),
      series: [{ nameKey: `${P}.series.hitRate`, points: pointsOf(hitSeries[0]) }],
    },
    checks,
    prefixTable(prefixes.rows, false),
  ];
}

/** "What fills the memory": prefixes by their share, with keys, TTL share, type and growth. */
function prefixTable(rows: PrefixStat[], full: boolean): TablePanel {
  return {
    id: 'prefixes',
    title: `${P}.prefixTable.title`,
    kind: 'table',
    span: full ? 2 : 1,
    ...(full ? {} : { layout: 'main' as const }),
    state: rows.length ? 'ok' : 'empty',
    note: { key: `${P}.prefixTable.note` },
    ...(full ? {} : { more: { key: `${P}.prefixTable.all`, tab: 'memory' } }),
    columns: [
      `${P}.cols.prefix`,
      `${P}.cols.share`,
      `${P}.cols.keys`,
      `${P}.cols.withTtl`,
      `${P}.cols.growth2h`,
      `${P}.cols.type`,
    ],
    rows: (full ? rows : rows.slice(0, 5)).map((x) => {
      const g = x.share2h === null ? null : Math.round((x.share - x.share2h) * 100);
      return {
        cells: [
          star(x.prefix),
          `${Math.round(x.share * 100)}%`,
          compact(x.keys),
          x.ttl === null ? '–' : `${Math.round(x.ttl * 100)}%`,
          g === null ? '–' : g === 0 ? '0' : `${g > 0 ? '+' : '−'}${Math.abs(g)} pt`,
          x.type ?? '–',
        ],
        ...(x.prefix !== 'other' ? { link: itemLink('prefix', x.prefix, star(x.prefix)) } : {}),
        ...((g ?? 0) >= 5 && (x.ttl ?? 1) < 0.5 ? { severity: 'warning' as Severity } : {}),
      };
    }),
  };
}

export function compact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)} k`;
  return Math.round(n).toLocaleString('en');
}

// ------------------------------------------------------------------------- Memory

export async function memoryTab(input: PageContext): Promise<Panel[]> {
  const ctx = aligned(input);
  const s = one(ctx.row.id);
  const [
    dataset,
    overhead,
    rss,
    used,
    usedNow,
    maxNow,
    policy,
    frag,
    growth,
    keys,
    expiring,
    expired,
    evicted,
    sampled,
    prefixes,
  ] = await Promise.all([
    range(ctx, `max(watchlog_redis_memory_dataset_bytes{${s}})`),
    range(ctx, `max(watchlog_redis_memory_overhead_bytes{${s}})`),
    range(ctx, `max(watchlog_redis_memory_rss_bytes{${s}})`),
    range(ctx, `max(watchlog_redis_memory_used_bytes{${s}})`),
    instant(ctx, `max(watchlog_redis_memory_used_bytes{${s}})`),
    instant(ctx, `max(watchlog_redis_memory_max_bytes{${s}})`),
    instant(ctx, `max by (policy) (watchlog_redis_maxmemory_policy_info{${s}})`),
    instant(ctx, `max(watchlog_redis_mem_fragmentation_ratio{${s}})`),
    instant(ctx, `max(deriv(watchlog_redis_memory_used_bytes{${s}}[1h]))`),
    range(ctx, `max(sum by (member) (watchlog_redis_keys{${s}}))`),
    range(ctx, `max(sum by (member) (watchlog_redis_keys_expiring{${s}}))`),
    range(ctx, `sum(rate(watchlog_redis_expired_keys_total{${s}}[${RATE}]))`),
    range(ctx, `sum(rate(watchlog_redis_evicted_keys_total{${s}}[${RATE}]))`),
    instant(ctx, `max(watchlog_redis_sampler_keys{${s}})`),
    prefixStats(ctx),
  ]);
  const ex = extraOf(ctx);
  const fragPoints = pointsOf(rss[0]).map(([t, v], i) => {
    const u = pointsOf(used[0])[i]?.[1];
    return [t, v !== null && u !== null && u !== undefined ? Math.max(0, v - u) : null] as [
      number,
      number | null,
    ];
  });
  const noTtl = pointsOf(keys[0]).map(([t, v], i) => {
    const e = pointsOf(expiring[0])[i]?.[1];
    return [t, v !== null && e !== null && e !== undefined ? Math.max(0, v - e) : null] as [
      number,
      number | null,
    ];
  });
  const maxB = valueOf(maxNow) ?? 0;
  const u = valueOf(usedNow) ?? 0;
  const g = valueOf(growth);
  const fullIn = maxB > 0 && g && g > 0 && u < maxB ? (maxB - u) / g : null;
  const fr = valueOf(frag);
  const pol = policy[0]?.labels.policy ?? null;
  const big = [...(ex.largest_keys ?? [])].sort((a, b) => b.bytes - a.bytes);
  const seen = new Set<string>();
  const bigUnique = big.filter((x) => {
    const k = `${x.key}\u0000${x.bytes}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return [
    {
      id: 'breakdown',
      title: `${P}.breakdown`,
      kind: 'stack',
      span: 1,
      unit: 'bytes',
      state: dataset.length ? 'ok' : 'empty',
      series: [
        { nameKey: `${P}.series.dataset`, points: pointsOf(dataset[0]) },
        { nameKey: `${P}.series.overhead`, points: pointsOf(overhead[0]) },
        { nameKey: `${P}.series.fragmentation`, points: fragPoints },
      ],
    },
    {
      id: 'capacity',
      title: `${P}.capacity`,
      kind: 'gauge',
      span: 1,
      state: valueOf(usedNow) === null ? 'empty' : 'ok',
      note: pol ? { key: `${P}.policy`, values: { policy: pol } } : undefined,
      items: [
        ...(maxB > 0
          ? [
              {
                labelKey: `${P}.maxmemory`,
                value: u,
                max: maxB,
                unit: 'bytes' as const,
                warnAt: 0.9,
                note:
                  fullIn !== null
                    ? { key: `${P}.mem.fullIn`, values: { d: duration(fullIn) } }
                    : { key: `${D}.capacity.notGrowing` },
              },
            ]
          : []),
        ...(fr !== null
          ? [
              {
                labelKey: `${P}.fragmentation`,
                value: fr,
                max: 3,
                unit: 'load' as const,
                warnAt: 0.5,
                note: { key: `${P}.fragmentationNote` },
              },
            ]
          : []),
      ],
    },
    {
      ...prefixTable(prefixes.rows, true),
      note: { key: `${P}.prefixTable.sampled`, values: { n: compact(valueOf(sampled) ?? 0) } },
    },
    {
      id: 'largest',
      title: `${P}.largest.title`,
      kind: 'table',
      span: 2,
      state: bigUnique.length ? 'ok' : 'empty',
      note: { key: `${P}.largest.note` },
      columns: [`${P}.cols.key`, `${P}.cols.type`, `${P}.cols.size`, `${P}.cols.elements`],
      rows: bigUnique.slice(0, 15).map((x) => ({
        cells: [x.key, x.type, bytes(x.bytes), x.elements ? compact(x.elements) : '–'],
        link: itemLink('prefix', x.prefix, star(x.prefix)),
      })),
    },
    {
      id: 'churn',
      title: `${P}.churn`,
      kind: 'line',
      span: 1,
      unit: 'per_second',
      state: expired.length ? 'ok' : 'empty',
      series: [
        { nameKey: `${P}.series.expired`, points: pointsOf(expired[0]) },
        { nameKey: `${P}.series.evicted`, points: pointsOf(evicted[0]), severity: 'warning' },
      ],
    },
    {
      id: 'no-ttl',
      title: `${P}.mem.noTtl`,
      kind: 'line',
      span: 1,
      unit: 'count',
      state: keys.length ? 'ok' : 'empty',
      note: { key: `${P}.mem.noTtlNote` },
      series: [
        { nameKey: `${P}.series.keys`, points: pointsOf(keys[0]) },
        { nameKey: `${P}.series.noTtl`, points: noTtl, severity: 'warning' },
      ],
    },
  ];
}

// ------------------------------------------------------------------------- Commands

export async function commandsTab(input: PageContext): Promise<Panel[]> {
  const ctx = aligned(input);
  const s = one(ctx.row.id);
  const w = rateWindow(ctx);
  const [calls, stats, buckets, main, owners] = await Promise.all([
    range(
      ctx,
      `topk(10, sum by (command) (rate(watchlog_redis_command_calls_total{${s}}[${RATE}])))`,
    ),
    commandStats(ctx),
    instant(ctx, `sum by (le) (watchlog_redis_command_latency_bucket{${s}})`),
    range(ctx, `max(rate(watchlog_redis_main_thread_cpu_seconds_total{${s}}[${w}]))`),
    ownersOf(ctx),
  ]);
  const ex = extraOf(ctx);
  const p = processOf(ctx);
  const proc = p ? await range(ctx, p.cpu.replaceAll('$w', w)) : [];
  const sorted = buckets
    .map((b) => ({ le: Number(b.labels.le), n: b.points[0]?.[1] ?? 0 }))
    .filter((b) => Number.isFinite(b.le))
    .sort((a, b) => a.le - b.le);
  const total = sorted.at(-1)?.n ?? 0;
  const label = (le: number) =>
    le < 1e-3 ? `≤${Math.round(le * 1e6)} µs` : `≤${+(le * 1e3).toFixed(1)} ms`;
  const hist = sorted.map((b, i) => ({
    label: label(b.le),
    share: total ? (b.n - (sorted[i - 1]?.n ?? 0)) / total : 0,
  }));
  const old = (Number((ctx.row.version ?? '').split('.')[0]) || 99) < 7;
  const slow = [...(ex.slowlog ?? [])].sort((a, b) => b.at - a.at).slice(0, 20);
  const first = main[0]?.points ?? [];
  return [
    {
      id: 'main-thread',
      title: `${P}.mainThread.title`,
      kind: 'line',
      span: 2,
      unit: 'ratio',
      state: main.length ? 'ok' : 'empty',
      note: { key: `${P}.mainThread.note` },
      series: [
        { nameKey: `${P}.series.mainThread`, points: pointsOf(main[0]) },
        ...(proc[0] ? [{ nameKey: `${P}.series.process`, points: pointsOf(proc[0]) }] : []),
        ...(first.length
          ? [
              {
                nameKey: `${P}.series.oneCore`,
                points: first.map(([t]) => [t, 1] as [number, number]),
                dashed: true,
              },
            ]
          : []),
      ],
    },
    {
      id: 'commands',
      title: `${P}.commandTable.title`,
      kind: 'table',
      span: 2,
      state: stats.length ? 'ok' : 'empty',
      note: { key: old ? `${P}.commandTable.noPercentiles` : `${P}.commandTable.note` },
      columns: [
        `${P}.cols.command`,
        `${P}.cols.callsPerSecond`,
        `${P}.cols.mean`,
        `${P}.cols.p50`,
        `${P}.cols.p99`,
        `${P}.cols.p999`,
        `${P}.cols.failures`,
      ],
      // The commands that ran or failed in the 15 minutes.
      rows: stats
        .filter((x) => x.calls > 0 || x.failed > 0)
        .map((x) => ({
          cells: [
            x.command.toUpperCase(),
            x.calls < 10 ? +x.calls.toFixed(2) : Math.round(x.calls),
            x.mean === null ? '–' : us(x.mean),
            x.p50 === null ? '–' : us(x.p50),
            x.p99 === null ? '–' : us(x.p99),
            x.p999 === null ? '–' : us(x.p999),
            x.failed > 0 ? +x.failed.toFixed(2) : 0,
          ],
          ...(x.command !== 'other'
            ? { link: itemLink('command', x.command, x.command.toUpperCase()) }
            : {}),
          ...(ON_COMMANDS.test(x.command.toUpperCase())
            ? { severity: 'warning' as Severity }
            : x.failed > 0
              ? { severity: 'warning' as Severity }
              : {}),
        })),
    },
    {
      id: 'calls',
      title: `${P}.calls`,
      kind: 'stack',
      span: 1,
      unit: 'per_second',
      state: calls.length ? 'ok' : 'empty',
      series: calls.map((c) => ({
        name: (c.labels.command ?? '').toUpperCase(),
        points: pointsOf(c),
      })),
    },
    {
      id: 'latency',
      title: `${P}.latency`,
      kind: 'hist',
      span: 1,
      state: hist.length ? 'ok' : 'empty',
      note: old ? { key: `${P}.noHistogram`, values: { version: ctx.row.version } } : undefined,
      buckets: hist.slice(-12),
    },
    slowlogPanel(slow, owners, ctx.now),
  ];
}

const us = (sec: number) =>
  sec >= 1e-3 ? `${+(sec * 1e3).toFixed(1)} ms` : `${Math.round(sec * 1e6)} µs`;

/** Per command (15 min): calls a second, mean, percentiles (7.0+), failures a second. */
export async function commandStats(ctx: PageContext) {
  const s = one(ctx.row.id);
  const [calls, usec, failed, pct] = await Promise.all([
    instant(ctx, `sum by (command) (rate(watchlog_redis_command_calls_total{${s}}[15m]))`),
    instant(ctx, `sum by (command) (rate(watchlog_redis_command_usec_total{${s}}[15m]))`),
    instant(ctx, `sum by (command) (rate(watchlog_redis_command_failed_total{${s}}[15m]))`),
    instant(ctx, `max by (command, quantile) (watchlog_redis_command_latency_seconds{${s}})`),
  ]);
  const m = (r: QuerySeries[]) =>
    new Map(r.map((x) => [x.labels.command ?? '', x.points[0]?.[1] ?? 0]));
  const [c, u, f] = [m(calls), m(usec), m(failed)];
  const q = (cmd: string, quantile: string) =>
    pct.find((x) => x.labels.command === cmd && x.labels.quantile === quantile)?.points[0]?.[1] ??
    null;
  return [...c.entries()]
    .map(([command, n]) => ({
      command,
      calls: n,
      mean: n > 0 ? (u.get(command) ?? 0) / n / 1e6 : null,
      p50: q(command, '0.5'),
      p99: q(command, '0.99'),
      p999: q(command, '0.999'),
      failed: f.get(command) ?? 0,
    }))
    .sort((a, b) => b.calls - a.calls);
}

function slowlogPanel(slow: SlowEntry[], owners: Map<string, Owner>, now: number): TablePanel {
  return {
    id: 'slowlog',
    title: `${P}.slowlog`,
    kind: 'table',
    span: 2,
    state: slow.length ? 'ok' : 'empty',
    note: { key: `${P}.slowlogNote` },
    columns: [
      `${P}.cols.command`,
      `${P}.cols.duration`,
      `${P}.cols.sentBy`,
      `${P}.cols.member`,
      `${P}.cols.when`,
    ],
    rows: slow.map((x) => ({
      cells: [
        x.command,
        x.usec >= 1000 ? `${(x.usec / 1000).toFixed(1)} ms` : `${x.usec} µs`,
        x.client ? clientOf(owners, x.client, x.name).name : (x.name ?? '–'),
        x.member,
        ago(x.at, now),
      ],
      severity:
        ON_COMMANDS.test(x.command) || x.usec > 100_000 ? ('warning' as Severity) : undefined,
    })),
  };
}

// ------------------------------------------------------------------------- Clients

export async function clientsTab(input: PageContext): Promise<Panel[]> {
  const ctx = aligned(input);
  const s = one(ctx.row.id);
  const [connected, blocked, received, rejected, now, maxc, owners] = await Promise.all([
    range(ctx, `max(watchlog_redis_connected_clients{${s}})`),
    range(ctx, `sum(watchlog_redis_blocked_clients{${s}})`),
    range(ctx, `sum(rate(watchlog_redis_connections_received_total{${s}}[${RATE}]))`),
    range(ctx, `sum(rate(watchlog_redis_rejected_connections_total{${s}}[${RATE}]))`),
    instant(ctx, `max(watchlog_redis_connected_clients{${s}})`),
    instant(ctx, `max(watchlog_redis_maxclients{${s}})`),
    ownersOf(ctx),
  ]);
  const ex = extraOf(ctx);
  const rows = clientRows(ex, owners);
  const m = valueOf(maxc);
  return [
    {
      id: 'by-workload',
      title: `${P}.clientTable.title`,
      kind: 'table',
      span: 2,
      state: rows.length ? 'ok' : 'empty',
      note: { key: `${P}.clientTable.note` },
      columns: [
        `${P}.cols.client`,
        `${P}.cols.connections`,
        `${P}.cols.blocked`,
        `${P}.cols.subscribed`,
        `${P}.cols.idle`,
        `${P}.cols.outputBuffer`,
        `${P}.cols.opened`,
        `${P}.cols.lastCommand`,
      ],
      rows: rows.map((x) => {
        const near = x.limit > 0 && x.omem / x.limit > 0.8;
        return {
          cells: [
            x.name,
            x.connections,
            x.blocked,
            x.subscribed,
            Number.isFinite(x.idle) ? duration(x.idle) : '–',
            x.limit > 0 ? `${bytes(x.omem)} / ${bytes(x.limit)}` : bytes(x.omem),
            x.young,
            x.cmd ? x.cmd.toUpperCase() : '–',
          ],
          ...(x.link ? { link: x.link } : {}),
          ...(near
            ? { severity: 'critical' as Severity }
            : x.blocked > 0
              ? { severity: 'info' as Severity }
              : {}),
        };
      }),
    },
    {
      id: 'connections',
      title: `${P}.connections`,
      kind: 'line',
      span: 1,
      unit: 'count',
      state: connected.length ? 'ok' : 'empty',
      series: [
        { nameKey: `${P}.series.connected`, points: pointsOf(connected[0]) },
        { nameKey: `${P}.series.blocked`, points: pointsOf(blocked[0]), severity: 'warning' },
      ],
    },
    {
      id: 'churn',
      title: `${P}.clientChurn`,
      kind: 'line',
      span: 1,
      unit: 'per_second',
      state: received.length ? 'ok' : 'empty',
      series: [
        { nameKey: `${P}.series.received`, points: pointsOf(received[0]) },
        { nameKey: `${P}.series.rejected`, points: pointsOf(rejected[0]), severity: 'critical' },
      ],
    },
    {
      id: 'capacity',
      title: `${P}.clientsCapacity`,
      kind: 'gauge',
      span: 2,
      state: m ? 'ok' : 'empty',
      items: m
        ? [
            {
              labelKey: `${P}.maxclients`,
              value: valueOf(now) ?? 0,
              max: m,
              unit: 'count',
              warnAt: 0.8,
            },
          ]
        : [],
    },
  ];
}

// ------------------------------------------------------------------------- Streams

export interface GroupStat {
  stream: string;
  group: string;
  lag: number | null;
  pending: number;
  consumers: number;
  active: number;
  oldest: number;
}
export async function groupStats(ctx: PageContext): Promise<GroupStat[]> {
  const s = one(ctx.row.id);
  const q = (m: string) => instant(ctx, `max by (stream, group) (${m}{${s}})`);
  const [lag, pending, consumers, active, oldest] = await Promise.all([
    q('watchlog_redis_stream_group_lag'),
    q('watchlog_redis_stream_group_pending'),
    q('watchlog_redis_stream_group_consumers'),
    q('watchlog_redis_stream_group_active_consumers'),
    q('watchlog_redis_stream_group_oldest_pending_seconds'),
  ]);
  const key = (x: QuerySeries) => `${x.labels.stream ?? ''}\u0000${x.labels.group ?? ''}`;
  const m = (r: QuerySeries[]) => new Map(r.map((x) => [key(x), x.points[0]?.[1] ?? 0]));
  const [l, p, c, a, o] = [m(lag), m(pending), m(consumers), m(active), m(oldest)];
  return pending
    .map((x) => {
      const k = key(x);
      return {
        stream: x.labels.stream ?? '',
        group: x.labels.group ?? '',
        lag: l.has(k) ? l.get(k)! : null,
        pending: p.get(k) ?? 0,
        consumers: c.get(k) ?? 0,
        active: a.get(k) ?? 0,
        oldest: o.get(k) ?? 0,
      };
    })
    .sort((x, y) => (y.lag ?? y.pending) - (x.lag ?? x.pending));
}

/** A group nobody serves: entries waiting and no consumer read in 5 minutes. */
export const orphaned = (g: GroupStat) => ((g.lag ?? 0) > 0 || g.pending > 0) && g.active === 0;

export async function hasStreams(ctx: PageContext): Promise<boolean> {
  const r = await instant(
    ctx,
    `count(last_over_time(watchlog_redis_stream_length{${one(ctx.row.id)}}[30m]))`,
  );
  return (valueOf(r) ?? 0) > 0;
}

export async function streamsTab(input: PageContext): Promise<Panel[]> {
  const ctx = aligned(input);
  const s = one(ctx.row.id);
  const [groups, lengths, lag] = await Promise.all([
    groupStats(ctx),
    range(ctx, `max by (stream) (watchlog_redis_stream_length{${s}})`),
    range(ctx, `max by (stream, group) (watchlog_redis_stream_group_lag{${s}})`),
  ]);
  const ex = extraOf(ctx);
  const consumers = [...(ex.stream_consumers ?? [])].sort((a, b) => b.idle - a.idle);
  return [
    {
      id: 'groups',
      title: `${P}.streams.groups`,
      kind: 'table',
      span: 2,
      state: groups.length ? 'ok' : 'empty',
      note: { key: `${P}.streams.groupsNote` },
      columns: [
        `${P}.cols.stream`,
        `${P}.cols.group`,
        `${P}.cols.consumers`,
        `${P}.cols.lag`,
        `${P}.cols.pending`,
        `${P}.cols.oldestPending`,
      ],
      rows: groups.map((g) => ({
        cells: [
          g.stream,
          g.group,
          `${g.active} / ${g.consumers}`,
          g.lag === null ? '–' : compact(g.lag),
          compact(g.pending),
          g.pending > 0 ? duration(g.oldest) : '–',
        ],
        link: itemLink('group', `${g.stream}\u0000${g.group}`, `${g.stream} · ${g.group}`),
        ...(orphaned(g)
          ? { severity: 'critical' as Severity }
          : (g.lag ?? 0) > 1000
            ? { severity: 'warning' as Severity }
            : {}),
      })),
    },
    {
      id: 'length',
      title: `${P}.streams.length`,
      kind: 'line',
      span: 1,
      unit: 'count',
      state: lengths.length ? 'ok' : 'empty',
      series: lengths.map((x) => ({ name: x.labels.stream ?? '', points: pointsOf(x) })),
    },
    {
      id: 'lag',
      title: `${P}.streams.lag`,
      kind: 'line',
      span: 1,
      unit: 'count',
      state: lag.length ? 'ok' : 'empty',
      note: { key: `${P}.streams.lagNote` },
      series: lag.map((x) => ({
        name: `${x.labels.stream ?? ''} · ${x.labels.group ?? ''}`,
        points: pointsOf(x),
      })),
    },
    consumerTable(consumers),
  ];
}

function consumerTable(consumers: Consumer[]): TablePanel {
  return {
    id: 'consumers',
    title: `${P}.streams.consumers`,
    kind: 'table',
    span: 2,
    state: consumers.length ? 'ok' : 'empty',
    note: { key: `${P}.streams.consumersNote` },
    columns: [
      `${P}.cols.stream`,
      `${P}.cols.group`,
      `${P}.cols.consumer`,
      `${P}.cols.pending`,
      `${P}.cols.lastRead`,
    ],
    rows: consumers.map((c) => {
      const seen = c.inactive >= 0 ? c.inactive : c.idle;
      return {
        cells: [c.stream, c.group, c.consumer, c.pending, duration(seen)],
        ...(seen >= 300 ? { severity: 'critical' as Severity } : {}),
      };
    }),
  };
}

// ------------------------------------------------------------------------- Persistence

export async function persistenceTab(input: PageContext): Promise<Panel[]> {
  const ctx = aligned(input);
  const s = one(ctx.row.id);
  const [
    saveOk,
    saveAt,
    saveDur,
    fork,
    cow,
    rss,
    aofOn,
    aofOk,
    aofSize,
    rewrites,
    delayed,
    changes,
    threshold,
  ] = await Promise.all([
    instant(ctx, `min(watchlog_redis_rdb_last_save_ok{${s}})`),
    instant(ctx, `max(watchlog_redis_rdb_last_save_timestamp_seconds{${s}})`),
    instant(ctx, `max(watchlog_redis_rdb_last_save_duration_seconds{${s}})`),
    instant(ctx, `max(watchlog_redis_fork_seconds{${s}})`),
    instant(ctx, `max(watchlog_redis_rdb_cow_bytes{${s}})`),
    instant(ctx, `max(watchlog_redis_memory_rss_bytes{${s}})`),
    instant(ctx, `max(watchlog_redis_aof_enabled{${s}})`),
    instant(ctx, `min(watchlog_redis_aof_last_write_ok{${s}})`),
    range(ctx, `max(watchlog_redis_aof_bytes{${s}})`),
    instant(ctx, `max(increase(watchlog_redis_aof_rewrites_total{${s}}[${ctx.range}s]))`),
    instant(ctx, `max(increase(watchlog_redis_aof_delayed_fsync_total{${s}}[${ctx.range}s]))`),
    range(ctx, `max(watchlog_redis_rdb_changes_since_last_save{${s}})`),
    instant(ctx, `max(watchlog_redis_latency_monitor_threshold_ms{${s}})`),
  ]);
  const ex = extraOf(ctx);
  const fit = await nextSave(ctx, valueOf(cow), valueOf(rss));
  const ok = valueOf(saveOk);
  const at = valueOf(saveAt);
  const on = (valueOf(aofOn) ?? 0) > 0;
  const save = settingOf(ex, 'save');
  const events = [...(ex.latency_events ?? [])].sort((a, b) => a.at - b.at);
  const monitorOff = valueOf(threshold) === 0;
  return [
    {
      id: 'state',
      title: `${P}.persistence`,
      kind: 'stat',
      span: 2,
      state: ok === null && at === null ? 'empty' : 'ok',
      tiles: [
        {
          id: 'rdb',
          labelKey: `${P}.lastSave`,
          value: ok === null ? null : ok > 0 ? 'ok' : 'failed',
          sub:
            at && at > 0
              ? { key: `${P}.savedAgo`, values: { ago: ago(at, ctx.now) } }
              : save === ''
                ? { key: `${P}.persist.saveOff` }
                : undefined,
          severity: ok === 0 ? 'critical' : undefined,
        },
        {
          id: 'duration',
          labelKey: `${P}.persist.duration`,
          value: valueOf(saveDur),
          unit: 'seconds',
        },
        { id: 'fork', labelKey: `${P}.persist.fork`, value: valueOf(fork), unit: 'seconds' },
        {
          id: 'aof',
          labelKey: `${P}.aof`,
          value: !on ? 'off' : (valueOf(aofOk) ?? 1) > 0 ? 'ok' : 'failed',
          severity: on && valueOf(aofOk) === 0 ? 'critical' : undefined,
        },
      ],
    },
    {
      id: 'next-save',
      title: `${P}.persist.nextSave`,
      kind: 'facts',
      span: 1,
      state: fit ? 'ok' : 'empty',
      note: { key: fit ? `${P}.persist.nextSaveNote` : `${P}.persist.noLimit` },
      rows: fit
        ? [
            { labelKey: `${P}.persist.cow`, value: fit.need, unit: 'bytes' },
            { labelKey: `${P}.persist.left`, value: fit.left, unit: 'bytes' },
            {
              labelKey: `${P}.persist.verdict`,
              value: null,
              text: { key: fit.fits ? `${P}.persist.fits` : `${P}.persist.wontFit` },
            },
          ]
        : [],
    },
    {
      id: 'aof',
      title: `${P}.persist.aofSize`,
      kind: 'line',
      span: 1,
      unit: 'bytes',
      state: aofSize.length ? 'ok' : 'empty',
      note: on
        ? {
            key: `${P}.persist.aofNote`,
            values: {
              rewrites: Math.round(valueOf(rewrites) ?? 0),
              delayed: Math.round(valueOf(delayed) ?? 0),
            },
          }
        : { key: `${P}.persist.aofOff` },
      series: [{ nameKey: `${P}.series.aof`, points: pointsOf(aofSize[0]) }],
    },
    {
      id: 'changes',
      title: `${P}.changes`,
      kind: 'line',
      span: 1,
      unit: 'count',
      state: changes.length ? 'ok' : 'empty',
      series: [{ nameKey: `${P}.series.changes`, points: pointsOf(changes[0]) }],
    },
    {
      id: 'latency-events',
      title: `${P}.latencyEvents.title`,
      kind: 'timeline',
      span: 1,
      state: events.length ? 'ok' : monitorOff ? 'needs_permission' : 'empty',
      ...(monitorOff
        ? { missing: { key: `${P}.latencyEvents.off` } }
        : { note: { key: `${P}.latencyEvents.note` } }),
      events: events
        .filter((e) => e.at * 1000 >= ctx.now - ctx.range * 1000)
        .map((e) => ({
          at: e.at,
          text: {
            key: `${P}.latencyEvents.event`,
            values: { event: e.event, ms: e.latest_ms, max: e.max_ms },
          },
          sourceKey: `${P}.latencyEvents.source`,
          severity: 'warning' as Severity,
        })),
    },
  ];
}

/**
 * Whether the next save's fork fits (1.4): the last save's copy-on-write against the memory left
 * under the process's limit. Null when no limit is known (the page says so).
 */
export async function nextSave(ctx: PageContext, cow: number | null, rss: number | null) {
  const limit = await memoryLimit(ctx);
  if (!limit || cow === null || rss === null || cow <= 0) return null;
  const left = Math.max(0, limit - rss);
  return { need: cow, left, fits: cow < left };
}

// ------------------------------------------------------------------------- Replication

export async function replicationTab(input: PageContext): Promise<Panel[]> {
  const ctx = aligned(input);
  const s = one(ctx.row.id);
  const [primary, linkUp, linkDown, replicas, lag, backlog, writes, roles, clusterOk, slots] =
    await Promise.all([
      instant(ctx, `max(watchlog_redis_is_primary{${s}})`),
      instant(ctx, `min(watchlog_redis_master_link_up{${s}})`),
      instant(ctx, `max(watchlog_redis_master_link_down_seconds{${s}})`),
      instant(ctx, `sum(watchlog_redis_replica_online{${s}})`),
      range(ctx, `max by (replica) (watchlog_redis_replica_offset_lag_bytes{${s}})`),
      instant(ctx, `max(watchlog_redis_repl_backlog_bytes{${s}})`),
      instant(ctx, `max(rate(watchlog_redis_replication_offset{${s}}[5m]))`),
      range(ctx, `max by (member) (watchlog_redis_is_primary{${s}})`),
      instant(ctx, `min(watchlog_redis_cluster_ok{${s}})`),
      instant(ctx, `max by (__name__) ({__name__=~"watchlog_redis_cluster_slots_.*", ${s}})`),
    ]);
  const ex = extraOf(ctx);
  const b = valueOf(backlog);
  const wr = valueOf(writes);
  const covers = b && wr && wr > 0 ? b / wr : null;
  // Role changes: a member's primary flag flipping within the range.
  const events: { at: number; member: string; primary: boolean }[] = [];
  for (const x of roles) {
    const pts = pointsOf(x).filter((p): p is [number, number] => p[1] !== null);
    for (let i = 1; i < pts.length; i++)
      if (pts[i]![1] !== pts[i - 1]![1])
        events.push({ at: pts[i]![0], member: x.labels.member ?? '', primary: pts[i]![1] === 1 });
  }
  const masters = ex.sentinel_masters ?? [];
  const nodes = uniqueNodes(ex.cluster_nodes ?? []);
  const slot = (k: string) =>
    slots.find((x) => x.labels.__name__ === `watchlog_redis_cluster_slots_${k}`)?.points[0]?.[1] ??
    null;
  const owned = nodes.filter((n) => n.role === 'master').map((n) => n.slots ?? 0);
  const imbalance = owned.length > 1 ? Math.max(...owned) / Math.max(1, Math.min(...owned)) : null;
  const isPrimary = valueOf(primary) !== 0;
  return [
    {
      id: 'state',
      title: `${P}.replication`,
      kind: 'stat',
      span: 2,
      state: valueOf(primary) === null ? 'empty' : 'ok',
      tiles: [
        {
          id: 'role',
          labelKey: `${P}.replicationTab.role`,
          value: isPrimary ? 'primary' : 'replica',
          sub: isPrimary
            ? { key: `${P}.replicationTab.replicas`, values: { n: valueOf(replicas) ?? 0 } }
            : undefined,
        },
        {
          id: 'link',
          labelKey: `${P}.replicationTab.link`,
          value: isPrimary ? null : valueOf(linkUp) === 1 ? 'up' : 'down',
          ...(isPrimary
            ? { sub: { key: `${P}.replicationTab.isPrimary` } }
            : valueOf(linkDown)
              ? {
                  sub: {
                    key: `${P}.replicationTab.downFor`,
                    values: { d: duration(valueOf(linkDown)!) },
                  },
                }
              : {}),
          ...(!isPrimary && valueOf(linkUp) === 0 ? { severity: 'critical' as Severity } : {}),
        },
        {
          id: 'backlog',
          labelKey: `${P}.replicationTab.backlog`,
          value: covers,
          unit: 'seconds',
          sub: b ? { key: `${P}.replicationTab.backlogOf`, values: { size: bytes(b) } } : undefined,
          ...(covers !== null && covers < 60 ? { severity: 'warning' as Severity } : {}),
        },
        {
          id: 'writes',
          labelKey: `${P}.replicationTab.writes`,
          value: wr,
          unit: 'bytes_per_second',
        },
      ],
    },
    {
      id: 'lag',
      title: `${P}.replicationLag`,
      kind: 'line',
      span: 1,
      unit: 'bytes',
      state: lag.length ? 'ok' : 'empty',
      note: { key: `${P}.lagNote` },
      series: lag.map((x) => ({ name: x.labels.replica ?? '', points: pointsOf(x) })),
    },
    {
      id: 'roles',
      title: `${P}.replicationTab.roleChanges`,
      kind: 'timeline',
      span: 1,
      state: events.length ? 'ok' : 'empty',
      events: events.map((e) => ({
        at: e.at,
        text: {
          key: e.primary
            ? `${P}.replicationTab.becamePrimary`
            : `${P}.replicationTab.becameReplica`,
          values: { member: e.member },
        },
        sourceKey: `${P}.replicationTab.source`,
        severity: 'warning' as Severity,
      })),
    },
    ...(masters.length
      ? [
          {
            id: 'sentinel',
            title: `${P}.sentinel.title`,
            kind: 'table',
            span: 2,
            state: 'ok',
            note: { key: `${P}.sentinel.note` },
            columns: [
              `${P}.cols.master`,
              `${P}.cols.status`,
              `${P}.cols.address`,
              `${P}.cols.replicas`,
              `${P}.cols.sentinels`,
            ],
            rows: masters.map((x) => ({
              cells: [x.master, x.status, x.address, x.replicas, x.sentinels],
              ...(x.status !== 'ok' ? { severity: 'critical' as Severity } : {}),
            })),
          } as Panel,
        ]
      : []),
    ...(valueOf(clusterOk) !== null
      ? [
          {
            id: 'cluster',
            title: `${P}.cluster.title`,
            kind: 'facts',
            span: 1,
            state: 'ok',
            rows: [
              { labelKey: `${P}.cluster.state`, value: valueOf(clusterOk) === 1 ? 'ok' : 'fail' },
              { labelKey: `${P}.cluster.assigned`, value: slot('assigned'), unit: 'count' },
              {
                labelKey: `${P}.cluster.failing`,
                value: (slot('pfail') ?? 0) + (slot('fail') ?? 0),
                unit: 'count',
              },
              ...(imbalance !== null
                ? [
                    {
                      labelKey: `${P}.cluster.imbalance`,
                      value: Math.round(imbalance * 100) / 100,
                      unit: 'load' as const,
                    },
                  ]
                : []),
            ],
          } as Panel,
          {
            id: 'nodes',
            title: `${P}.cluster.nodes`,
            kind: 'table',
            span: 1,
            state: nodes.length ? 'ok' : 'empty',
            note: { key: `${P}.cluster.nodesNote` },
            columns: [`${P}.cols.node`, `${P}.cols.role`, `${P}.cols.health`, `${P}.cols.slots`],
            rows: nodes.map((n) => ({
              cells: [n.node, n.role, n.health, n.slots ?? '–'],
              ...(n.health !== 'online' ? { severity: 'critical' as Severity } : {}),
            })),
          } as Panel,
        ]
      : []),
  ];
}

const uniqueNodes = (rows: ClusterNode[]) => {
  const m = new Map<string, ClusterNode>();
  for (const r of rows) if (!m.has(r.node)) m.set(r.node, r);
  return [...m.values()].sort((a, b) => a.node.localeCompare(b.node));
};

// ------------------------------------------------------------------------- one prefix

export async function prefixPage(input: PageContext): Promise<Panel[]> {
  const ctx = aligned(input);
  const prefix = ctx.params?.prefix ?? '';
  const sel = `${one(ctx.row.id)}, prefix="${escapeLabelValue(prefix)}"`;
  const [stats, mem, keys, ttl, at] = await Promise.all([
    prefixStats(ctx),
    range(ctx, `sum(max by (member) (watchlog_redis_prefix_memory_bytes{${sel}}))`),
    range(ctx, `sum(max by (member) (watchlog_redis_prefix_keys{${sel}}))`),
    range(ctx, `sum(max by (member) (watchlog_redis_prefix_ttl_keys{${sel}}))`),
    instant(ctx, `max(watchlog_redis_sampler_timestamp_seconds{${one(ctx.row.id)}})`),
  ]);
  const ex = extraOf(ctx);
  const x = stats.rows.find((r) => r.prefix === prefix);
  const big = (ex.largest_keys ?? [])
    .filter((k) => k.prefix === prefix)
    .sort((a, b) => b.bytes - a.bytes);
  return [
    {
      id: 'facts',
      title: `${P}.prefix.facts`,
      kind: 'facts',
      span: 2,
      state: x ? 'ok' : 'empty',
      note: { key: `${P}.prefixTable.note` },
      rows: [
        { labelKey: `${P}.cols.prefix`, value: star(prefix) },
        { labelKey: `${P}.prefix.memory`, value: x?.bytes ?? null, unit: 'bytes' },
        { labelKey: `${P}.cols.share`, value: x?.share ?? null, unit: 'ratio' },
        { labelKey: `${P}.prefix.share2h`, value: x?.share2h ?? null, unit: 'ratio' },
        { labelKey: `${P}.cols.keys`, value: x ? Math.round(x.keys) : null, unit: 'count' },
        { labelKey: `${P}.cols.withTtl`, value: x?.ttl ?? null, unit: 'ratio' },
        { labelKey: `${P}.cols.type`, value: x?.type ?? null },
        {
          labelKey: `${P}.prefix.sampledAt`,
          value: valueOf(at) ? ago(valueOf(at)!, ctx.now) : null,
        },
      ],
    },
    {
      id: 'memory',
      title: `${P}.prefix.memoryOverTime`,
      kind: 'line',
      span: 1,
      unit: 'bytes',
      state: mem.length ? 'ok' : 'empty',
      series: [{ nameKey: `${P}.series.used`, points: pointsOf(mem[0]) }],
    },
    {
      id: 'keys',
      title: `${P}.prefix.keysOverTime`,
      kind: 'line',
      span: 1,
      unit: 'count',
      state: keys.length ? 'ok' : 'empty',
      series: [
        { nameKey: `${P}.series.keys`, points: pointsOf(keys[0]) },
        { nameKey: `${P}.series.withTtl`, points: pointsOf(ttl[0]) },
      ],
    },
    {
      id: 'largest',
      title: `${P}.largest.title`,
      kind: 'table',
      span: 2,
      state: big.length ? 'ok' : 'empty',
      note: { key: `${P}.largest.note` },
      columns: [`${P}.cols.key`, `${P}.cols.type`, `${P}.cols.size`, `${P}.cols.elements`],
      rows: big.map((k) => ({
        cells: [k.key, k.type, bytes(k.bytes), k.elements ? compact(k.elements) : '–'],
      })),
    },
  ];
}

// ------------------------------------------------------------------------- one command

export async function commandPage(input: PageContext): Promise<Panel[]> {
  const ctx = aligned(input);
  const cmd = (ctx.params?.command ?? '').toLowerCase();
  const sel = `${one(ctx.row.id)}, command="${escapeLabelValue(cmd)}"`;
  const [stats, calls, mean, pct, failed, owners] = await Promise.all([
    commandStats(ctx),
    range(ctx, `sum(rate(watchlog_redis_command_calls_total{${sel}}[${RATE}]))`),
    range(
      ctx,
      `sum(rate(watchlog_redis_command_usec_total{${sel}}[${RATE}])) / sum(rate(watchlog_redis_command_calls_total{${sel}}[${RATE}])) / 1e6`,
    ),
    range(ctx, `max by (quantile) (watchlog_redis_command_latency_seconds{${sel}})`),
    range(ctx, `sum(rate(watchlog_redis_command_failed_total{${sel}}[${RATE}]))`),
    ownersOf(ctx),
  ]);
  const ex = extraOf(ctx);
  const x = stats.find((r) => r.command === cmd);
  const slow = (ex.slowlog ?? []).filter((e) => e.command.split(' ')[0]!.toLowerCase() === cmd);
  return [
    {
      id: 'facts',
      title: `${P}.command.facts`,
      kind: 'facts',
      span: 2,
      state: x ? 'ok' : 'empty',
      rows: [
        { labelKey: `${P}.cols.command`, value: cmd.toUpperCase() },
        { labelKey: `${P}.cols.callsPerSecond`, value: x?.calls ?? null, unit: 'per_second' },
        { labelKey: `${P}.cols.mean`, value: x?.mean ?? null, unit: 'seconds' },
        { labelKey: `${P}.cols.p50`, value: x?.p50 ?? null, unit: 'seconds' },
        { labelKey: `${P}.cols.p99`, value: x?.p99 ?? null, unit: 'seconds' },
        { labelKey: `${P}.cols.p999`, value: x?.p999 ?? null, unit: 'seconds' },
        { labelKey: `${P}.cols.failures`, value: x?.failed ?? null, unit: 'per_second' },
      ],
    },
    {
      id: 'calls',
      title: `${P}.command.callsOverTime`,
      kind: 'line',
      span: 1,
      unit: 'per_second',
      state: calls.length ? 'ok' : 'empty',
      series: [
        { nameKey: `${D}.series.calls`, points: pointsOf(calls[0]) },
        { nameKey: `${P}.series.failures`, points: pointsOf(failed[0]), severity: 'critical' },
      ],
    },
    {
      id: 'latency',
      title: `${P}.command.latencyOverTime`,
      kind: 'line',
      span: 1,
      unit: 'seconds',
      state: mean.length ? 'ok' : 'empty',
      series: [
        { nameKey: `${D}.series.mean`, points: pointsOf(mean[0]) },
        ...pct
          .sort((a, b) => Number(a.labels.quantile) - Number(b.labels.quantile))
          .map((q) => ({
            name: `p${+(Number(q.labels.quantile ?? 0) * 100).toFixed(1)}`,
            points: pointsOf(q),
          })),
      ],
    },
    slowlogPanel(slow, owners, ctx.now),
  ];
}

// ------------------------------------------------------------------------- one stream group

export async function groupPage(input: PageContext): Promise<Panel[]> {
  const ctx = aligned(input);
  const [stream, group] = (ctx.params?.group ?? '').split('\u0000');
  const sel = `${one(ctx.row.id)}, stream="${escapeLabelValue(stream ?? '')}", group="${escapeLabelValue(group ?? '')}"`;
  const [groups, lag, pending, length] = await Promise.all([
    groupStats(ctx),
    range(ctx, `max(watchlog_redis_stream_group_lag{${sel}})`),
    range(ctx, `max(watchlog_redis_stream_group_pending{${sel}})`),
    range(
      ctx,
      `max(watchlog_redis_stream_length{${one(ctx.row.id)}, stream="${escapeLabelValue(stream ?? '')}"})`,
    ),
  ]);
  const ex = extraOf(ctx);
  const g = groups.find((x) => x.stream === stream && x.group === group);
  const consumers = (ex.stream_consumers ?? []).filter(
    (c) => c.stream === stream && c.group === group,
  );
  return [
    {
      id: 'facts',
      title: `${P}.group.facts`,
      kind: 'facts',
      span: 2,
      state: g ? 'ok' : 'empty',
      rows: [
        { labelKey: `${P}.cols.stream`, value: stream ?? null },
        { labelKey: `${P}.cols.group`, value: group ?? null },
        { labelKey: `${P}.cols.lag`, value: g?.lag ?? null, unit: 'count' },
        { labelKey: `${P}.cols.pending`, value: g?.pending ?? null, unit: 'count' },
        { labelKey: `${P}.group.consumers`, value: g ? `${g.active} / ${g.consumers}` : null },
        {
          labelKey: `${P}.cols.oldestPending`,
          value: g && g.pending > 0 ? g.oldest : null,
          unit: 'seconds',
        },
      ],
    },
    {
      id: 'lag',
      title: `${P}.streams.lag`,
      kind: 'line',
      span: 1,
      unit: 'count',
      state: lag.length || pending.length ? 'ok' : 'empty',
      series: [
        { nameKey: `${P}.series.lag`, points: pointsOf(lag[0]), severity: 'warning' },
        { nameKey: `${P}.series.pending`, points: pointsOf(pending[0]) },
      ],
    },
    {
      id: 'length',
      title: `${P}.streams.length`,
      kind: 'line',
      span: 1,
      unit: 'count',
      state: length.length ? 'ok' : 'empty',
      series: [{ name: stream ?? '', points: pointsOf(length[0]) }],
    },
    consumerTable(consumers),
  ];
}
