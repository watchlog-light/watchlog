// SPDX-License-Identifier: AGPL-3.0-only
// The RabbitMQ page (SPEC §4.12, v0.3 slice 11; 1.1.0, ADR-243): Overview, Queues, Clients,
// Nodes and Alerts, and a page for each queue, from the rabbitmq_prometheus series the
// collector reads on every node (node totals; per queue `rabbitmq_detailed_queue_*`, the 200
// deepest and every idle queue with messages; exchanges) and the agents' network flows.
// Reasons: a queue growing with no consumers, linked to the clients that were connected to
// RabbitMQ and ended (OOM-killed, crash-looping, exited) when it lost them, with when memory
// reaches the high watermark at this rate; a queue growing anyway; memory and disk alarms;
// unacked messages; dead letters; and the plugin check. The tabs are in rabbitmq-tabs.ts,
// the queue's page in rabbitmq-queue.ts.
import { genericPage } from './generic.js';
import { destination, ownComponents, SOURCE } from './connected.js';
import { ago } from './owners.js';
import { instant, one, some, SPARK_RANGE, valueOf } from './query.js';
import { queueName, QBY, UNACKED_HIGH, watermarkIn } from './rabbitmq-queues.js';
import { queuePage } from './rabbitmq-queue.js';
import { clientsTab, nodesTab, overview, queueCount, queuesTab } from './rabbitmq-tabs.js';
import type { QuerySeries } from '../../../lib/victoria.js';
import type { IntegrationPage, PageContext, Reason, RowMetrics } from './types.js';

const P = 'integrations.rabbitmq.panels';
const DAY = 86_400;
/** Dead-letter queue names, as a MetricsQL regex (the same as rabbitmq-queues.ts's DLQ). */
export const DLQ_RE = '(?i).*(dead.?letter|\\\\.dlq|\\\\.dlx|-dlq|_dlq).*';

interface Node {
  member?: string;
  node?: string;
  cluster?: string;
  plugin?: boolean;
}
/** The nodes the collector last reported, with whether their metrics plugin is on. */
export const nodesOf = (ctx: PageContext): Node[] =>
  (ctx.row.status_details as { extra?: { rabbitmq?: Node[] } } | null)?.extra?.rabbitmq ?? [];

export { queueName };

/**
 * Each queue's ready messages per second over the last 5 minutes, from its own series,
 * evaluated at a 30 s boundary (the heavy scrape's interval): the Ready card and the
 * findings use this one value, so they never say 180 and 181 a minute.
 */
export async function queueGrowth(ctx: PageContext): Promise<Map<string, number>> {
  if (!ctx.vm) return new Map();
  const at = Math.floor(ctx.now / 1000 / 30) * 30;
  const rows = await ctx.vm.query(
    ctx.scope,
    `sum by (${QBY}) (deriv(rabbitmq_detailed_queue_messages_ready{${one(ctx.row.id)}}[5m]))`,
    at,
  );
  return new Map(rows.map((r) => [queueName(r.labels), r.points[0]?.[1] ?? 0]));
}

/** The last time a queue had a consumer, from the last 6 hours (null: none in them). */
export async function lastConsumedAt(ctx: PageContext, q: string): Promise<number | null> {
  if (!ctx.vm) return null;
  const end = Math.floor(ctx.now / 1000);
  const rows = await ctx.vm.queryRange(
    ctx.scope,
    `sum(rabbitmq_detailed_queue_consumers{${one(ctx.row.id)},${q}})`,
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
const perMin = (perSecond: number) => Math.round(Math.abs(perSecond) * 60);

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

/** A client to check: a workload (its kind when the flows give it) or a container. */
export type Client =
  { namespace: string; workload: string; workload_kind?: string | null } | { container: string };

/**
 * How one client ended since `since` (unix seconds): a pod crash-looping or with a recent
 * last termination, a container that exited, restarted, or is gone; the termination
 * closest to lostAt. Null when it is running and didn't end. RabbitMQ's former consumers
 * and Kafka's former group members (ADR-145, ADR-166).
 */
export async function endedOf(
  ctx: PageContext,
  who: Client,
  lostAt: number | null,
  since = ctx.now / 1000 - DAY,
): Promise<Ended | null> {
  if ('workload' in who) {
    const pods = await ctx.db
      .selectFrom('objects')
      .select(['status_summary', 'spec_summary', 'deleted_at'])
      .where('cluster_id', '=', ctx.row.cluster_id)
      .where('kind', '=', 'Pod')
      .where('namespace', '=', who.namespace)
      .where((eb) =>
        eb.or([eb('deleted_at', 'is', null), eb('deleted_at', '>', new Date(since * 1000))]),
      )
      .execute();
    let best: { how: string; at: number | null } | null = null;
    let kind = who.workload_kind ?? null;
    for (const p of pods) {
      const w = (p.spec_summary as { workload?: { name?: string; kind?: string } }).workload;
      if (w?.name !== who.workload) continue;
      kind ??= w.kind ?? null;
      for (const ct of (p.status_summary as PodStatus).containers ?? []) {
        const t = ct.last_termination;
        const tAt = t?.finished_at ? Date.parse(t.finished_at) / 1000 : null;
        if (ct.state === 'waiting' && ct.reason === 'CrashLoopBackOff') {
          const how =
            t?.reason === 'OOMKilled' ? 'OOMKilled, CrashLoopBackOff' : 'CrashLoopBackOff';
          best = pick(best, { how, at: tAt }, lostAt);
        } else if (t && tAt !== null && tAt >= since) {
          best = pick(best, { how: t.reason || `Exited (${t.exit_code ?? '?'})`, at: tAt }, lostAt);
        }
      }
    }
    if (!best || !kind) return null;
    return {
      kind: 'workload',
      id: `${who.namespace}/${kind}/${who.workload}`,
      name: `${who.namespace}/${who.workload}`,
      ...best,
    };
  }
  const row = await ctx.db
    .selectFrom('objects')
    .select(['status_summary', 'deleted_at'])
    .where('cluster_id', '=', ctx.row.cluster_id)
    .where('kind', '=', 'DockerContainer')
    .where('name', '=', who.container)
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
  else if (st.state === 'restarting') how = st.oom_killed ? 'OOMKilled, restarting' : 'restarting';
  else if (st.state !== 'running') how = `Exited (${st.exit_code ?? '?'})`;
  else if (tAt !== null && tAt >= since && (st.restart_count ?? 0) > 0)
    how = st.oom_killed ? 'OOMKilled, restarted' : 'restarted';
  return how ? { kind: 'container', id: who.container, name: who.container, how, at: tAt } : null;
}

/** Closest first to lostAt (or newest first), at most five. */
export function rankEnded(out: Ended[], lostAt: number | null): Ended[] {
  const dist = (e: Ended) =>
    lostAt === null || e.at === null ? Infinity : Math.abs(e.at - lostAt);
  return [...out].sort((a, b) => dist(a) - dist(b) || (b.at ?? 0) - (a.at ?? 0)).slice(0, 5);
}

/**
 * The clients connected to the service's port in the last 24 hours (eBPF flows), not
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
    ctx.scope,
    `max by (${SOURCE}) (present_over_time(watchlog_flow_connections_total{${dst}${port ? `,dst_port="${port}"` : ''}}[24h]))`,
    Math.floor(ctx.now / 1000),
  );
  const out: Ended[] = [];
  for (const c of clients) {
    const l = c.labels;
    if (l.workload && l.namespace) {
      if (own.workloads.has(`${l.namespace}/${l.workload}`)) continue;
      const e = await endedOf(
        ctx,
        { namespace: l.namespace, workload: l.workload, workload_kind: l.workload_kind },
        lostAt,
      );
      if (e) out.push(e);
    } else if (l.container) {
      if (own.containers.has(l.container)) continue;
      const e = await endedOf(ctx, { container: l.container }, lostAt);
      if (e) out.push(e);
    }
  }
  return rankEnded(out, lostAt);
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
  // Streams keep what they hold, and dead-letter queues usually have no consumer: neither is
  // a queue that lost its consumers or falls behind (1.1.0). Dead letters have their own finding.
  const notThese = `unless on (${QBY}) (max by (${QBY}) (rabbitmq_detailed_queue_info{${s},type="stream"}) or max by (${QBY}) (rabbitmq_detailed_queue_messages_ready{${s},queue=~"${DLQ_RE}"}))`;
  const [idle, growing, alarms, unacked, dead, deadQueues] = await Promise.all([
    // Ready messages, no consumer, and more coming.
    instant(
      ctx,
      `((sum by (${QBY}) (rabbitmq_detailed_queue_messages_ready{${s}}) > 0) and (sum by (${QBY}) (rabbitmq_detailed_queue_consumers{${s}}) == 0) and (sum by (${QBY}) (deriv(rabbitmq_detailed_queue_messages_ready{${s}}[5m])) > 0)) ${notThese}`,
    ),
    instant(
      ctx,
      `((sum by (${QBY}) (deriv(rabbitmq_detailed_queue_messages_ready{${s}}[15m])) > 0.5) and (sum by (${QBY}) (rabbitmq_detailed_queue_consumers{${s}}) > 0) and (sum by (${QBY}) (rabbitmq_detailed_queue_messages_ready{${s}}) > 1000)) ${notThese}`,
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
    const lostAt = await lastConsumedAt(ctx, q);
    const [ended, growth, eta] = await Promise.all([
      endedClients(ctx, lostAt),
      queueGrowth(ctx),
      watermarkIn(ctx),
    ]);
    const first = ended[0];
    out.push({
      severity: 'critical',
      code: 'queue_no_consumers',
      facts: {
        queue: queueName(top.labels),
        // For the queue's page link: its vhost and name as RabbitMQ has them.
        vhost: top.labels.vhost ?? '/',
        queueRaw: top.labels.queue ?? '',
        // When the first node reaches its memory high watermark at this rate (seconds).
        watermarkIn: eta,
        queues: idle.length,
        ready: Math.round(top.points[0]?.[1] ?? 0),
        perMin: perMin(growth.get(queueName(top.labels)) ?? 0),
        // When it last had a consumer (unix seconds), within the last 6 hours; the page
        // writes "09:58 (3 min ago)" in the reader's time. null: none in 6 hours.
        sinceAt: lostAt,
        since: lostAt ? ago(lostAt, ctx.now) : null,
        consumer: first?.name ?? null,
        how: first?.how ?? null,
        when: first?.at ? ago(first.at, ctx.now) : null,
      },
      links: ended.map((e) => ({ kind: e.kind, id: e.id, name: e.name })),
    });
  }
  if (growing.length) {
    const [growth, eta] = await Promise.all([queueGrowth(ctx), watermarkIn(ctx)]);
    for (const g of growing.slice(0, 3)) {
      const name = queueName(g.labels);
      out.push({
        severity: 'warning',
        code: 'queue_growing',
        facts: {
          queue: name,
          vhost: g.labels.vhost ?? '/',
          queueRaw: g.labels.queue ?? '',
          perMin: perMin(growth.get(name) ?? g.points[0]?.[1] ?? 0),
          watermarkIn: eta,
        },
      });
    }
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
  const off = nodesOf(ctx).filter((n) => n.plugin === false);
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
    {
      id: 'queues',
      title: 'integrations.rabbitmq.tabs.queues',
      panels: queuesTab,
      count: queueCount,
    },
    { id: 'clients', title: 'integrations.rabbitmq.tabs.clients', panels: clientsTab },
    {
      id: 'nodes',
      title: 'integrations.rabbitmq.tabs.nodes',
      panels: nodesTab,
      count: async (ctx) => {
        const n = (ctx.row.status_details as { members?: unknown[] } | null)?.members?.length;
        return n ?? null;
      },
    },
    {
      id: 'alerts',
      title: 'integrations.rabbitmq.tabs.alerts',
      panels: async () => [],
      view: 'alerts',
    },
    // One queue's page, at /applications/:id/queues/:queue (?vhost=).
    { id: 'queue', title: 'integrations.rabbitmq.tabs.queue', panels: queuePage, hidden: true },
    {
      id: 'connection',
      title: 'integrations.tabs.connection',
      panels: genericPage.tabs[0]!.panels,
    },
  ],

  async listMetrics({ vm, scope, ids, now }) {
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
