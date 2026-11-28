// SPDX-License-Identifier: AGPL-3.0-only
// The Redis and Valkey page (SPEC §4.12, v0.3 slice 7; 1.4, ADR-247): Overview, Memory,
// Commands, Clients, Streams (when there are any), Persistence, Replication and Alerts, with
// pages for one key prefix, one command and one stream group (redis-deep.ts). The reasons put
// the cause first: what fills the memory, what keeps the main thread busy, who sends it.
import { genericPage } from './generic.js';
import { clientOf } from './db-deep.js';
import { duration } from './mysql.js';
import { bytes, ipOwners } from './owners.js';
import { instant, one, some, SPARK_RANGE, valueOf } from './query.js';
import * as deep from './redis-deep.js';
import type { IntegrationPage, PageContext, Reason, RowMetrics } from './types.js';

const P = 'integrations.redis.panels';
async function reasons(ctx: PageContext): Promise<Reason[]> {
  const s = one(ctx.row.id);
  const [
    ratio,
    max,
    policy,
    evicted,
    rejected,
    blocked,
    saveFailed,
    replicaDown,
    mainThread,
    cow,
    rss,
    backlog,
    writes,
    replicas,
    keys,
    expiring,
    used,
    noPassword,
    thp,
    overcommit,
    clusterOk,
    clusterFailing,
    sentinelDown,
    bufferRatio,
    owners,
    prefixes,
    groups,
  ] = await Promise.all([
    instant(
      ctx,
      `max by (member) (watchlog_redis_memory_used_bytes{${s}} / (watchlog_redis_memory_max_bytes{${s}} > 0))`,
    ),
    instant(ctx, `max(watchlog_redis_memory_max_bytes{${s}})`),
    instant(ctx, `max by (policy) (watchlog_redis_maxmemory_policy_info{${s}})`),
    instant(ctx, `sum(rate(watchlog_redis_evicted_keys_total{${s}}[15m])) * 60`),
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
    instant(ctx, `max(rate(watchlog_redis_main_thread_cpu_seconds_total{${s}}[5m]))`),
    instant(ctx, `max(watchlog_redis_rdb_cow_bytes{${s}})`),
    instant(ctx, `max(watchlog_redis_memory_rss_bytes{${s}})`),
    instant(ctx, `max(watchlog_redis_repl_backlog_bytes{${s}})`),
    instant(ctx, `max(rate(watchlog_redis_replication_offset{${s}}[5m]))`),
    instant(ctx, `sum(watchlog_redis_connected_replicas{${s}})`),
    instant(ctx, `max(sum by (member) (watchlog_redis_keys{${s}}))`),
    instant(ctx, `max(sum by (member) (watchlog_redis_keys_expiring{${s}}))`),
    instant(ctx, `max(watchlog_redis_memory_used_bytes{${s}})`),
    instant(ctx, `max(watchlog_redis_no_password{${s}})`),
    instant(ctx, `max(watchlog_redis_host_thp_always{${s}})`),
    instant(ctx, `max(watchlog_redis_host_overcommit_memory{${s}})`),
    instant(ctx, `min(watchlog_redis_cluster_ok{${s}})`),
    instant(
      ctx,
      `max(watchlog_redis_cluster_slots_pfail{${s}}) + max(watchlog_redis_cluster_slots_fail{${s}})`,
    ),
    instant(ctx, `max(1 - watchlog_redis_sentinel_master_ok{${s}})`),
    instant(ctx, `max(watchlog_redis_client_output_buffer_ratio{${s}})`),
    ipOwners(ctx.db, ctx.row.cluster_id),
    deep.prefixStats(ctx),
    deep.groupStats(ctx),
  ]);
  const out: Reason[] = [];
  const ex = deep.extraOf(ctx);
  const top = ratio.sort((a, b) => (b.points[0]?.[1] ?? 0) - (a.points[0]?.[1] ?? 0))[0];
  const r = top?.points[0]?.[1] ?? null;
  const evMin = valueOf(evicted) ?? 0;
  const pol = policy[0]?.labels.policy ?? null;
  const k = valueOf(keys) ?? 0;
  const ttlShare = k > 0 ? (valueOf(expiring) ?? 0) / k : null;
  // What fills the memory: the largest prefix, grown in two hours, mostly without a TTL.
  const big = prefixes.rows.find((x) => x.prefix !== 'other');
  const grew = big && big.share2h !== null ? big.share - big.share2h : null;
  const pressed = evMin > 0 || (r !== null && r > 0.9);
  if (pressed && big && big.share >= 0.3 && ((grew ?? 0) >= 0.05 || (big.ttl ?? 1) < 0.5))
    out.push({
      severity: evMin > 0 ? 'warning' : 'info',
      code: 'prefix_fills_memory',
      facts: {
        prefix: deep.star(big.prefix),
        pct: Math.round(big.share * 100),
        from: big.share2h === null ? null : Math.round(big.share2h * 100),
        noTtl: big.ttl === null ? null : Math.round((1 - big.ttl) * 100),
        evictPerMin: evMin > 0 ? Math.round(evMin) : null,
        policy: pol,
      },
    });
  if (r !== null && r > 0.9)
    out.push({
      severity: r > 0.98 ? 'critical' : 'warning',
      code: 'memory_near_max',
      facts: { pct: Math.round(r * 100), member: top!.labels.member ?? null },
    });
  if (evMin > 0 && !out.some((x) => x.code === 'prefix_fills_memory'))
    out.push({ severity: 'warning', code: 'evicting', facts: { n: Math.round(evMin * 15) } });
  // The main thread: busy most of a core whatever the memory says; the costly command and its
  // sender from the slow log, when there is one.
  const mt = valueOf(mainThread);
  const slow = [...(ex.slowlog ?? [])].sort((a, b) => b.at - a.at);
  const on = slow.filter((x) => deep.ON_COMMANDS.test(x.command));
  if (mt !== null && mt >= 0.9) {
    const worst = on[0] ?? slow[0];
    out.push({
      severity: 'critical',
      code: 'main_thread_saturated',
      facts: {
        pct: Math.round(mt * 100),
        cmd: worst ? worst.command.split(' ')[0]! : null,
        client: worst?.client ? clientOf(owners, worst.client, worst.name).name : null,
        holder: worst?.client ? (owners.get(worst.client)?.name ?? null) : null,
      },
    });
  }
  if (on.length && !out.some((x) => x.code === 'main_thread_saturated')) {
    const w = on[0]!;
    out.push({
      severity: 'warning',
      code: 'slow_keys_command',
      facts: {
        n: on.length,
        cmd: w.command.split(' ')[0]!,
        client: w.client ? clientOf(owners, w.client, w.name).name : null,
      },
    });
  }
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
  if ((valueOf(replicaDown) ?? 0) > 0)
    out.push({ severity: 'critical', code: 'replica_down', facts: {} });
  if ((valueOf(saveFailed) ?? 0) > 0)
    out.push({ severity: 'critical', code: 'save_failed', facts: {} });
  const fit = await deep.nextSave(ctx, valueOf(cow), valueOf(rss));
  if (fit && !fit.fits)
    out.push({
      severity: 'warning',
      code: 'save_wont_fit',
      facts: { need: bytes(fit.need), left: bytes(fit.left) },
    });
  // Streams: a group with entries waiting and no consumer reading; the consumer that went quiet.
  for (const g of groups.filter(deep.orphaned).slice(0, 2)) {
    const gone = (ex.stream_consumers ?? [])
      .filter((c) => c.stream === g.stream && c.group === g.group)
      .sort(
        (a, b) => (b.inactive >= 0 ? b.inactive : b.idle) - (a.inactive >= 0 ? a.inactive : a.idle),
      )[0];
    const owner = gone
      ? [...owners.values()].find((o) => consumerOf(o.name, gone.consumer))
      : undefined;
    out.push({
      severity: 'critical',
      code: 'stream_group_orphaned',
      facts: {
        stream: g.stream,
        group: g.group,
        lag: g.lag ?? g.pending,
        consumer: gone?.consumer ?? null,
        idle: gone ? duration(gone.inactive >= 0 ? gone.inactive : gone.idle) : null,
        holder: owner?.name ?? null,
      },
      ...(owner?.id
        ? {
            links: [
              { kind: owner.kind as 'workload' | 'container', id: owner.id, name: owner.name },
            ],
          }
        : {}),
    });
  }
  const buf = valueOf(bufferRatio);
  if (buf !== null && buf > 0.8) {
    const near = (ex.client_detail ?? [])
      .filter((c) => c.limit > 0)
      .sort((a, b) => b.omem / b.limit - a.omem / a.limit)[0];
    out.push({
      severity: 'warning',
      code: 'client_buffer_near_limit',
      facts: {
        pct: Math.round(buf * 100),
        client: near ? clientOf(owners, near.addr, near.name).name : null,
        class: near?.class ?? null,
      },
    });
  }
  const b = valueOf(backlog);
  const wr = valueOf(writes);
  if ((valueOf(replicas) ?? 0) > 0 && b && wr && wr > 0 && b / wr < 60)
    out.push({
      severity: 'info',
      code: 'backlog_short',
      facts: { seconds: Math.round(b / wr), size: bytes(b) },
    });
  if (valueOf(clusterOk) === 0 || (valueOf(clusterFailing) ?? 0) > 0)
    out.push({
      severity: 'critical',
      code: 'cluster_unhealthy',
      facts: { failing: Math.round(valueOf(clusterFailing) ?? 0) },
    });
  if ((valueOf(sentinelDown) ?? 0) > 0)
    out.push({ severity: 'critical', code: 'sentinel_master_down', facts: {} });
  // Settings that hurt.
  const bind = (ex.settings ?? []).find((x) => x.name === 'bind')?.value ?? null;
  const prot = (ex.settings ?? []).find((x) => x.name === 'protected-mode')?.value ?? null;
  const localOnly =
    bind !== null &&
    bind !== '' &&
    bind.split(/\s+/).every((a) => /^-?(127\.|::1|localhost)/.test(a));
  if (valueOf(noPassword) === 1 && !localOnly && prot !== 'yes')
    out.push({ severity: 'warning', code: 'no_password', facts: { bind: bind || '*' } });
  if (pol === 'noeviction' && ttlShare !== null && ttlShare > 0.5 && k > 100)
    out.push({
      severity: 'warning',
      code: 'noeviction_cache',
      facts: { pct: Math.round(ttlShare * 100) },
    });
  const save = (ex.settings ?? []).find((x) => x.name === 'save')?.value;
  const aof = (ex.settings ?? []).find((x) => x.name === 'appendonly')?.value;
  if (save === '' && aof === 'no' && ttlShare !== null && ttlShare < 0.5 && k > 100)
    out.push({
      severity: 'warning',
      code: 'no_persistence_store',
      facts: { keys: Math.round(k), size: bytes(valueOf(used) ?? 0) },
    });
  if (valueOf(thp) === 1) out.push({ severity: 'info', code: 'thp_always', facts: {} });
  if (valueOf(overcommit) === 0) out.push({ severity: 'info', code: 'overcommit_off', facts: {} });
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

/** A stream consumer named after its pod or container ("billing-worker-1" for shop/billing-worker). */
export function consumerOf(owner: string, consumer: string): boolean {
  const name = owner.split('/').pop() ?? owner;
  return consumer === name || consumer.startsWith(`${name}-`) || name.startsWith(consumer);
}

export const redisPage: IntegrationPage = {
  id: 'redis',
  tabs: [
    { id: 'overview', title: 'integrations.redis.tabs.overview', panels: deep.overview },
    { id: 'memory', title: 'integrations.redis.tabs.memory', panels: deep.memoryTab },
    { id: 'commands', title: 'integrations.redis.tabs.commands', panels: deep.commandsTab },
    { id: 'clients', title: 'integrations.redis.tabs.clients', panels: deep.clientsTab },
    // Only when the sampler found streams (1.4).
    {
      id: 'streams',
      title: 'integrations.redis.tabs.streams',
      panels: deep.streamsTab,
      onlyWhen: deep.hasStreams,
    },
    {
      id: 'persistence',
      title: 'integrations.redis.tabs.persistence',
      panels: deep.persistenceTab,
    },
    {
      id: 'replication',
      title: 'integrations.redis.tabs.replication',
      panels: deep.replicationTab,
    },
    { id: 'alerts', title: 'integrations.db.tabs.alerts', panels: async () => [], view: 'alerts' },
    // One key prefix, one command, one stream group at their own addresses (1.4).
    {
      id: 'prefix',
      title: 'integrations.redis.tabs.prefix',
      panels: deep.prefixPage,
      hidden: true,
    },
    {
      id: 'command',
      title: 'integrations.redis.tabs.command',
      panels: deep.commandPage,
      hidden: true,
    },
    { id: 'group', title: 'integrations.redis.tabs.group', panels: deep.groupPage, hidden: true },
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
