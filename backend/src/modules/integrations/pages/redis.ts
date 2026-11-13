// SPDX-License-Identifier: AGPL-3.0-only
// The Redis page (SPEC §4.12, v0.3 slice 7): Overview, Memory, Commands, Clients, and
// Persistence and replication, from the collector's Redis series; the slow log and the
// clients by workload from its status. Reasons: memory near max, evicting, no maxmemory,
// slow KEYS commands, replica down, save failed, clients rejected or blocked.
import { genericPage } from './generic.js';
import { ago, bytes, ipOwners } from './owners.js';
import { instant, one, pointsOf, range, some, SPARK_RANGE, valueOf } from './query.js';
import type { IntegrationPage, PageContext, Panel, Reason, RowMetrics, Severity } from './types.js';

const P = 'integrations.redis.panels';
const RATE = '2m';

interface SlowEntry {
  at: number;
  usec: number;
  member: string;
  command: string;
  client?: string;
}
interface ClientEntry {
  addr: string;
  connections: number;
  member: string;
}
const extra = (ctx: PageContext) =>
  ((ctx.row.status_details as { extra?: { slowlog?: SlowEntry[]; clients?: ClientEntry[] } })
    .extra ?? {}) as { slowlog?: SlowEntry[]; clients?: ClientEntry[] };

const majorVersion = (v: string | null) => Number((v ?? '').split('.')[0]) || 0;

async function overview(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [
    used,
    max,
    hits,
    misses,
    ops,
    opsPeak,
    clients,
    blocked,
    evicted,
    keys,
    expiring,
    usedSeries,
    maxSeries,
    hitSeries,
    missSeries,
    owners,
  ] = await Promise.all([
    instant(ctx, `sum(watchlog_redis_memory_used_bytes{${s}})`),
    instant(ctx, `max(watchlog_redis_memory_max_bytes{${s}})`),
    instant(ctx, `sum(rate(watchlog_redis_keyspace_hits_total{${s}}[${RATE}]))`),
    instant(ctx, `sum(rate(watchlog_redis_keyspace_misses_total{${s}}[${RATE}]))`),
    instant(ctx, `sum(rate(watchlog_redis_commands_processed_total{${s}}[${RATE}]))`),
    instant(
      ctx,
      `max_over_time(sum(rate(watchlog_redis_commands_processed_total{${s}}[${RATE}]))[${ctx.range}s:1m])`,
    ),
    instant(ctx, `sum(watchlog_redis_connected_clients{${s}})`),
    instant(ctx, `sum(watchlog_redis_blocked_clients{${s}})`),
    instant(ctx, `sum(increase(watchlog_redis_evicted_keys_total{${s}}[24h]))`),
    instant(ctx, `sum(watchlog_redis_keys{${s}})`),
    instant(ctx, `sum(watchlog_redis_keys_expiring{${s}})`),
    range(ctx, `sum by (member) (watchlog_redis_memory_used_bytes{${s}})`),
    range(ctx, `max(watchlog_redis_memory_max_bytes{${s}} > 0)`),
    range(ctx, `sum(rate(watchlog_redis_keyspace_hits_total{${s}}[${RATE}]))`),
    range(ctx, `sum(rate(watchlog_redis_keyspace_misses_total{${s}}[${RATE}]))`),
    ipOwners(ctx.db, ctx.row.cluster_id),
  ]);
  const u = valueOf(used);
  const m = valueOf(max) || null;
  const h = valueOf(hits) ?? 0;
  const mi = valueOf(misses) ?? 0;
  const k = valueOf(keys);
  const e = valueOf(expiring);
  const ratio = u !== null && m ? u / m : null;
  // Newest first, whatever order the members reported in.
  const slow = [...(extra(ctx).slowlog ?? [])].sort((a, b) => b.at - a.at).slice(0, 20);
  const empty = u === null;
  return [
    {
      id: 'summary',
      title: `${P}.summary`,
      kind: 'stat',
      span: 2,
      state: empty ? 'empty' : 'ok',
      tiles: [
        {
          id: 'memory',
          labelKey: `${P}.memory`,
          value: u,
          unit: 'bytes',
          sub: m
            ? { key: `${P}.ofMax`, values: { max: bytes(m), pct: Math.round((ratio ?? 0) * 100) } }
            : { key: `${P}.noMax` },
          severity: ratio === null ? undefined : ratio > 0.9 ? 'warning' : 'ok',
        },
        {
          id: 'hit',
          labelKey: `${P}.hitRate`,
          value: h + mi > 0 ? h / (h + mi) : null,
          unit: 'ratio',
        },
        {
          id: 'ops',
          labelKey: `${P}.ops`,
          value: valueOf(ops),
          unit: 'per_second',
          sub: { key: `${P}.peak`, values: { peak: Math.round(valueOf(opsPeak) ?? 0) } },
        },
        {
          id: 'clients',
          labelKey: `${P}.clients`,
          value: valueOf(clients),
          unit: 'count',
          sub: { key: `${P}.blocked`, values: { n: valueOf(blocked) ?? 0 } },
          severity: (valueOf(blocked) ?? 0) > 0 ? 'warning' : undefined,
        },
        {
          id: 'evicted',
          labelKey: `${P}.evicted24h`,
          value: Math.round(valueOf(evicted) ?? 0),
          unit: 'count',
          severity: (valueOf(evicted) ?? 0) > 0 ? 'warning' : undefined,
        },
        {
          id: 'keys',
          labelKey: `${P}.keys`,
          value: k,
          unit: 'count',
          sub: k
            ? { key: `${P}.withTtl`, values: { pct: Math.round(((e ?? 0) / k) * 100) } }
            : undefined,
        },
      ],
    },
    {
      id: 'memory',
      title: `${P}.memoryOverTime`,
      kind: 'line',
      span: 1,
      unit: 'bytes',
      state: usedSeries.length ? 'ok' : 'empty',
      series: [
        ...usedSeries.map((x) => ({ name: x.labels.member ?? '', points: pointsOf(x) })),
        ...(maxSeries[0]
          ? [{ nameKey: `${P}.maxmemory`, points: pointsOf(maxSeries[0]), dashed: true }]
          : []),
      ],
    },
    {
      id: 'hits',
      title: `${P}.hitsMisses`,
      kind: 'stack',
      span: 1,
      unit: 'per_second',
      state: hitSeries.length ? 'ok' : 'empty',
      series: [
        { nameKey: `${P}.series.hits`, points: pointsOf(hitSeries[0]), severity: 'ok' },
        { nameKey: `${P}.series.misses`, points: pointsOf(missSeries[0]), severity: 'warning' },
      ],
    },
    {
      id: 'slowlog',
      title: `${P}.slowlog`,
      kind: 'table',
      span: 2,
      state: slow.length ? 'ok' : 'empty',
      note: { key: `${P}.slowlogNote` },
      columns: [
        `${P}.cols.command`,
        `${P}.cols.duration`,
        `${P}.cols.client`,
        `${P}.cols.member`,
        `${P}.cols.when`,
      ],
      rows: slow.map((x) => ({
        cells: [
          x.command,
          x.usec >= 1000 ? `${(x.usec / 1000).toFixed(1)} ms` : `${x.usec} µs`,
          x.client ? (owners.get(x.client)?.name ?? x.client) : '–',
          x.member,
          ago(x.at, ctx.now),
        ],
        severity:
          x.command.startsWith('KEYS') || x.usec > 100_000 ? ('warning' as Severity) : undefined,
      })),
    },
  ];
}

async function memory(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [dataset, overhead, rss, used, usedNow, maxNow, policy, frag, prefixes, expired, evicted] =
    await Promise.all([
      range(ctx, `sum(watchlog_redis_memory_dataset_bytes{${s}})`),
      range(ctx, `sum(watchlog_redis_memory_overhead_bytes{${s}})`),
      range(ctx, `sum(watchlog_redis_memory_rss_bytes{${s}})`),
      range(ctx, `sum(watchlog_redis_memory_used_bytes{${s}})`),
      instant(ctx, `max(watchlog_redis_memory_used_bytes{${s}})`),
      instant(ctx, `max(watchlog_redis_memory_max_bytes{${s}})`),
      instant(ctx, `max by (policy) (watchlog_redis_maxmemory_policy_info{${s}})`),
      instant(ctx, `max(watchlog_redis_mem_fragmentation_ratio{${s}})`),
      instant(ctx, `topk(20, max by (prefix) (watchlog_redis_prefix_memory_bytes{${s}}))`),
      range(ctx, `sum(rate(watchlog_redis_expired_keys_total{${s}}[${RATE}]))`),
      range(ctx, `sum(rate(watchlog_redis_evicted_keys_total{${s}}[${RATE}]))`),
    ]);
  // Fragmentation: what the OS gave beyond what Redis uses.
  const fragPoints = pointsOf(rss[0]).map(([t, v], i) => {
    const u = pointsOf(used[0])[i]?.[1];
    return [t, v !== null && u !== null && u !== undefined ? Math.max(0, v - u) : null] as [
      number,
      number | null,
    ];
  });
  const maxB = valueOf(maxNow) ?? 0;
  const fr = valueOf(frag);
  const pol = policy[0]?.labels.policy ?? null;
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
                value: valueOf(usedNow) ?? 0,
                max: maxB,
                unit: 'bytes' as const,
                warnAt: 0.9,
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
      id: 'prefixes',
      title: `${P}.prefixes`,
      kind: 'bars',
      span: 1,
      unit: 'bytes',
      state: prefixes.length ? 'ok' : 'empty',
      note: { key: `${P}.prefixesNote` },
      items: prefixes
        .map((x) => ({ label: x.labels.prefix ?? '', value: x.points[0]?.[1] ?? 0 }))
        .sort((a, b) => b.value - a.value),
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
  ];
}

async function commands(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [calls, slowest, buckets] = await Promise.all([
    range(
      ctx,
      `topk(20, sum by (command) (rate(watchlog_redis_command_calls_total{${s}}[${RATE}])))`,
    ),
    instant(
      ctx,
      `topk(15, sum by (command) (increase(watchlog_redis_command_usec_total{${s}}[${ctx.range}s])) / (sum by (command) (increase(watchlog_redis_command_calls_total{${s}}[${ctx.range}s])) > 0) / 1e6)`,
    ),
    instant(ctx, `sum by (le) (watchlog_redis_command_latency_bucket{${s}})`),
  ]);
  // LATENCY HISTOGRAM is cumulative; shares per bucket from the differences.
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
  const old = majorVersion(ctx.row.version) > 0 && majorVersion(ctx.row.version) < 7;
  return [
    {
      id: 'calls',
      title: `${P}.calls`,
      kind: 'stack',
      span: 2,
      unit: 'per_second',
      state: calls.length ? 'ok' : 'empty',
      series: calls.map((c) => ({ name: c.labels.command ?? '', points: pointsOf(c) })),
    },
    {
      id: 'slowest',
      title: `${P}.slowest`,
      kind: 'bars',
      span: 1,
      unit: 'seconds',
      state: slowest.length ? 'ok' : 'empty',
      items: slowest
        .map((x) => ({ label: x.labels.command ?? '', value: x.points[0]?.[1] ?? 0 }))
        .sort((a, b) => b.value - a.value),
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
  ];
}

async function clients(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [connected, blocked, now, maxc, owners] = await Promise.all([
    range(ctx, `sum(watchlog_redis_connected_clients{${s}})`),
    range(ctx, `sum(watchlog_redis_blocked_clients{${s}})`),
    instant(ctx, `max(watchlog_redis_connected_clients{${s}})`),
    instant(ctx, `max(watchlog_redis_maxclients{${s}})`),
    ipOwners(ctx.db, ctx.row.cluster_id),
  ]);
  const by = new Map<string, number>();
  for (const c of extra(ctx).clients ?? []) {
    const who = owners.get(c.addr)?.name ?? c.addr;
    by.set(who, (by.get(who) ?? 0) + c.connections);
  }
  const m = valueOf(maxc);
  return [
    {
      id: 'connections',
      title: `${P}.connections`,
      kind: 'line',
      span: 2,
      unit: 'count',
      state: connected.length ? 'ok' : 'empty',
      series: [
        { nameKey: `${P}.series.connected`, points: pointsOf(connected[0]) },
        { nameKey: `${P}.series.blocked`, points: pointsOf(blocked[0]), severity: 'warning' },
      ],
    },
    {
      id: 'by-workload',
      title: `${P}.byWorkload`,
      kind: 'bars',
      span: 1,
      unit: 'count',
      state: by.size ? 'ok' : 'empty',
      items: [...by]
        .map(([label, value]) => ({ label, value }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 15),
    },
    {
      id: 'capacity',
      title: `${P}.clientsCapacity`,
      kind: 'gauge',
      span: 1,
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

async function persistence(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [saveOk, saveAt, changes, aof, aofOk, primary, linkUp, replicasOnline, lag] =
    await Promise.all([
      instant(ctx, `min(watchlog_redis_rdb_last_save_ok{${s}})`),
      instant(ctx, `max(watchlog_redis_rdb_last_save_timestamp_seconds{${s}})`),
      instant(ctx, `max(watchlog_redis_rdb_changes_since_last_save{${s}})`),
      instant(ctx, `max(watchlog_redis_aof_enabled{${s}})`),
      instant(ctx, `min(watchlog_redis_aof_last_write_ok{${s}})`),
      instant(ctx, `max(watchlog_redis_is_primary{${s}})`),
      instant(ctx, `min(watchlog_redis_master_link_up{${s}})`),
      instant(ctx, `sum(watchlog_redis_replica_online{${s}})`),
      range(ctx, `max by (replica) (watchlog_redis_replica_offset_lag_bytes{${s}})`),
    ]);
  const ok = valueOf(saveOk);
  const at = valueOf(saveAt);
  const aofOn = (valueOf(aof) ?? 0) > 0;
  const link = valueOf(linkUp);
  const replicas = valueOf(replicasOnline);
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
          sub: at ? { key: `${P}.savedAgo`, values: { ago: ago(at, ctx.now) } } : undefined,
          severity: ok === 0 ? 'critical' : undefined,
        },
        {
          id: 'aof',
          labelKey: `${P}.aof`,
          value: !aofOn ? 'off' : (valueOf(aofOk) ?? 1) > 0 ? 'ok' : 'failed',
          severity: aofOn && valueOf(aofOk) === 0 ? 'critical' : undefined,
        },
        {
          id: 'replica',
          labelKey: `${P}.replication`,
          value:
            valueOf(primary) === 0
              ? link === 1
                ? 'replica, link up'
                : 'replica, link down'
              : `primary · ${replicas ?? 0} replicas online`,
          severity: valueOf(primary) === 0 && link === 0 ? 'critical' : undefined,
        },
        { id: 'changes', labelKey: `${P}.changes`, value: valueOf(changes), unit: 'count' },
      ],
    },
    {
      id: 'lag',
      title: `${P}.replicationLag`,
      kind: 'line',
      span: 2,
      unit: 'bytes',
      state: lag.length ? 'ok' : 'empty',
      note: { key: `${P}.lagNote` },
      series: lag.map((x) => ({ name: x.labels.replica ?? '', points: pointsOf(x) })),
    },
  ];
}

async function reasons(ctx: PageContext): Promise<Reason[]> {
  const s = one(ctx.row.id);
  const [ratio, max, evicted, rejected, blocked, saveFailed, replicaDown] = await Promise.all([
    instant(
      ctx,
      `max by (member) (watchlog_redis_memory_used_bytes{${s}} / (watchlog_redis_memory_max_bytes{${s}} > 0))`,
    ),
    instant(ctx, `max(watchlog_redis_memory_max_bytes{${s}})`),
    instant(ctx, `sum(increase(watchlog_redis_evicted_keys_total{${s}}[15m]))`),
    instant(ctx, `sum(increase(watchlog_redis_rejected_connections_total{${s}}[15m]))`),
    instant(ctx, `sum(watchlog_redis_blocked_clients{${s}})`),
    instant(
      ctx,
      `max((1 - watchlog_redis_rdb_last_save_ok{${s}}) or (1 - watchlog_redis_aof_last_write_ok{${s}}))`,
    ),
    instant(
      ctx,
      `max((1 - watchlog_redis_master_link_up{${s}}) or (1 - watchlog_redis_replica_online{${s}}))`,
    ),
  ]);
  const out: Reason[] = [];
  const top = ratio.sort((a, b) => (b.points[0]?.[1] ?? 0) - (a.points[0]?.[1] ?? 0))[0];
  const r = top?.points[0]?.[1] ?? null;
  if (r !== null && r > 0.9) {
    out.push({
      severity: r > 0.98 ? 'critical' : 'warning',
      code: 'memory_near_max',
      facts: { pct: Math.round(r * 100), member: top!.labels.member ?? null },
    });
  }
  if ((valueOf(evicted) ?? 0) > 0)
    out.push({
      severity: 'warning',
      code: 'evicting',
      facts: { n: Math.round(valueOf(evicted)!) },
    });
  if (valueOf(max) === 0) {
    const t = ctx.row.target;
    out.push({
      severity: 'info',
      code: 'no_maxmemory',
      facts: {},
      links:
        t.kind === 'workload'
          ? [
              {
                kind: 'workload',
                id: `${t.namespace}/${t.workload_kind}/${t.workload}`,
                name: t.workload,
              },
            ]
          : undefined,
    });
  }
  const keys = (extra(ctx).slowlog ?? []).filter((x) => x.command.startsWith('KEYS'));
  if (keys.length)
    out.push({ severity: 'warning', code: 'slow_keys_command', facts: { n: keys.length } });
  if ((valueOf(replicaDown) ?? 0) > 0)
    out.push({ severity: 'critical', code: 'replica_down', facts: {} });
  if ((valueOf(saveFailed) ?? 0) > 0)
    out.push({ severity: 'critical', code: 'save_failed', facts: {} });
  if ((valueOf(rejected) ?? 0) > 0)
    out.push({
      severity: 'warning',
      code: 'clients_rejected',
      facts: { n: Math.round(valueOf(rejected)!) },
    });
  if ((valueOf(blocked) ?? 0) > 0)
    out.push({ severity: 'info', code: 'clients_blocked', facts: { n: valueOf(blocked) } });
  return out;
}

export const redisPage: IntegrationPage = {
  id: 'redis',
  tabs: [
    { id: 'overview', title: 'integrations.redis.tabs.overview', panels: overview },
    { id: 'memory', title: 'integrations.redis.tabs.memory', panels: memory },
    { id: 'commands', title: 'integrations.redis.tabs.commands', panels: commands },
    { id: 'clients', title: 'integrations.redis.tabs.clients', panels: clients },
    { id: 'persistence', title: 'integrations.redis.tabs.persistence', panels: persistence },
    // Reachability, as every service has it.
    {
      id: 'connection',
      title: 'integrations.tabs.connection',
      panels: genericPage.tabs[0]!.panels,
    },
  ],

  async listMetrics({ vm, scope, ids, now }) {
    const s = some(ids);
    const end = Math.floor(now / 1000 / 300) * 300;
    const [used, max, hits, misses, ops, spark] = await Promise.all([
      vm.query(scope, `sum by (service) (watchlog_redis_memory_used_bytes{${s}})`),
      vm.query(scope, `max by (service) (watchlog_redis_memory_max_bytes{${s}})`),
      vm.query(scope, `sum by (service) (rate(watchlog_redis_keyspace_hits_total{${s}}[5m]))`),
      vm.query(scope, `sum by (service) (rate(watchlog_redis_keyspace_misses_total{${s}}[5m]))`),
      vm.query(scope, `sum by (service) (rate(watchlog_redis_commands_processed_total{${s}}[5m]))`),
      vm.queryRange(
        scope,
        `sum by (service) (rate(watchlog_redis_commands_processed_total{${s}}[5m]))`,
        end - SPARK_RANGE,
        end,
        300,
      ),
    ]);
    const at = (rows: typeof used, id: string) =>
      rows.find((r) => r.labels.service === id)?.points[0]?.[1] ?? null;
    const out = new Map<string, RowMetrics>();
    for (const id of ids) {
      const u = at(used, id);
      const m = at(max, id);
      const h = at(hits, id) ?? 0;
      const mi = at(misses, id) ?? 0;
      const ratio = u !== null && m ? u / m : null;
      out.set(id, {
        keyMetrics: [
          ratio !== null
            ? {
                id: 'memory',
                labelKey: `${P}.memoryPct`,
                value: ratio,
                unit: 'ratio',
                severity: ratio > 0.9 ? 'warning' : undefined,
              }
            : { id: 'memory', labelKey: `${P}.memory`, value: u, unit: 'bytes' },
          {
            id: 'hit',
            labelKey: `${P}.hitRate`,
            value: h + mi > 0 ? h / (h + mi) : null,
            unit: 'ratio',
          },
          { id: 'ops', labelKey: `${P}.ops`, value: at(ops, id), unit: 'per_second' },
        ],
        spark: spark.find((r) => r.labels.service === id)?.points ?? [],
      });
    }
    return out;
  },

  reasons,
};
