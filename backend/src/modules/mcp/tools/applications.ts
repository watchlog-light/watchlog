// SPDX-License-Identifier: AGPL-3.0-only
// list_applications and get_application (SPEC §4.12, ADR-135): the services WatchLog
// monitors (Redis, PostgreSQL, MySQL, MongoDB, Nginx, Traefik, RabbitMQ, Kafka…), their health with its reasons, and
// who connects to them, on Kubernetes clusters and Docker fleets.
import { Type } from 'typebox';
import { clusterField, resolveCluster, type ClusterRef } from '../clusters.js';
import { name, text, ToolError } from '../output.js';
import { ClusterArg, defineTool, describe, NameArg, notFound, summary } from './common.js';

const MAX_REASONS = 10;
const MAX_CONNECTED = 15;

interface ApiApplication {
  id: string;
  type: string;
  name: string;
  version: string | null;
  cluster: ClusterRef;
  where: { group: string | null; host: string | null; address: string | null };
  health: 'ok' | 'warning' | 'critical' | 'unknown';
  reason: { code: string; facts: Record<string, string | number | null> };
  /** The most severe active finding when it decides the health. */
  finding?: ApiReason | null;
  members: { up: number; total: number };
  monitoredSince: string;
  lastReportAt: string | null;
}

interface ApiReason {
  severity: 'ok' | 'info' | 'warning' | 'critical';
  code: string;
  facts: Record<string, string | number | null>;
  links?: { kind: string; id: string; name: string }[];
}

interface ApiDetail {
  application: ApiApplication;
  reasons: ApiReason[];
  connected: {
    flows: boolean;
    items: {
      kind: 'workload' | 'container';
      name: string;
      namespace: string | null;
      workloadKind: string | null;
      composeService: string | null;
      connections: number;
      failed: number;
    }[];
  } | null;
  page: { id: string; tabs: { id: string; title: string }[] };
}

const fact = (v: string | number | null | undefined, max = 253) =>
  typeof v === 'number' ? v : text(v, max);

/** Integrations' own reasons (SPEC §4.12): what the code means; the facts say how much. */
const INTEGRATION_SENTENCES: Record<string, string> = {
  // Redis
  memory_near_max: 'Memory is near maxmemory (facts.pct).',
  evicting: 'Keys are being evicted to make room (facts.n in 15 minutes).',
  no_maxmemory: "No maxmemory is set: memory can grow until the container's limit.",
  slow_keys_command: 'KEYS appears in the slow log; it blocks the server while it walks every key.',
  replica_down: 'A replica is disconnected from its primary.',
  save_failed: 'The last RDB save or AOF write failed.',
  clients_rejected: 'Connections were refused at maxclients (facts.n in 15 minutes).',
  clients_blocked: 'Clients are blocked waiting (BLPOP, XREAD, WAIT).',
  // PostgreSQL
  connections_near_max:
    'Connections are near max_connections (facts.pct); facts.top names the clients holding most.',
  long_query: 'A client query has been running longer than 5 minutes (facts.duration).',
  idle_in_transaction:
    'Sessions are idle inside a transaction (facts.n, the longest facts.duration): they hold locks and block vacuum.',
  lock_waits:
    "Sessions are waiting for locks (facts.n); facts.who holds them (facts.holder, its workload or container), with facts.table, how long the worst one waited (facts.duration or facts.longest) and how long the holder's transaction has been open (facts.held); facts.idle is 1 when the holder sits idle in its transaction.",
  // PostgreSQL and MySQL, 1.2
  statement_slower:
    'A top statement (facts.statement: facts.query) runs facts.x times slower than its usual (mean facts.mean), with no rise in calls, since facts.sinceAt (unix seconds).',
  long_transaction:
    'A transaction of facts.who (facts.holder) has been open for facts.age (idle for facts.idle when set) and blocks facts.blocks sessions; facts.xmin is 1 when it holds back vacuum (PostgreSQL), facts.history is the undo it keeps (MySQL).',
  slot_fills_disk:
    "Replication slot facts.slot keeps WAL that fills the data volume in facts.eta at its last hour's growth.",
  waits_mostly:
    'Over the last 15 minutes facts.pct% of the active sessions waited on facts.wait (facts.sessions active on average).',
  sequence_near_max:
    'Sequence facts.sequence is at facts.pct% of its maximum: inserts fail when it runs out.',
  setting_risky: 'A setting that risks data or performance is set: facts.name.',
  pending_restart: 'facts.n settings were changed and wait for a restart.',
  connections_vs_memory:
    'max_connections (facts.max) with work_mem and shared_buffers could need facts.need, above twice the memory limit (facts.mem).',
  connection_leak:
    'facts.who (facts.holder) keeps facts.n connections that all sit idle for at least facts.idle: probably a connection leak; connections are at facts.pct% of the limit.',
  history_list_long:
    "InnoDB's history list is long (facts.n): a long transaction keeps purge from cleaning up.",
  binlog_fills_disk:
    "The binary logs fill the data volume in facts.eta at their last hour's growth.",
  buffer_pool_vs_memory:
    'innodb_buffer_pool_size (facts.pool) is close to the memory limit (facts.mem).',
  redo_nearly_full:
    "The redo log is facts.pct% full: writes stall when the checkpoint can't keep up.",
  deadlocks: 'Deadlocks happened in the last 15 minutes (facts.n).',
  replica_lag: 'A replica is behind its primary (facts.duration).',
  slot_retains_wal: 'An inactive replication slot (facts.slot) keeps WAL on disk (facts.size).',
  wraparound_risk:
    'Transaction ID age is high (facts.db, facts.n): at 2,000 M PostgreSQL stops accepting writes.',
  cache_hit_low: 'Few reads come from shared buffers (facts.pct%).',
  autovacuum_not_finishing:
    'Autovacuum is not finishing on some tables (facts.n, for example facts.table).',
  statements_unavailable: 'pg_stat_statements is not installed, so query statistics are missing.',
  // MySQL and MariaDB (the codes above that PostgreSQL shares mean the same)
  connections_refused:
    'Connections were refused at max_connections (facts.n in 15 minutes, max facts.max).',
  replica_stopped:
    'Replication stopped on facts.member: its facts.thread thread is not running (facts.error).',
  buffer_pool_hit_low: 'Few reads come from the InnoDB buffer pool (facts.pct%).',
  tmp_disk_tables_high:
    'Queries create temporary tables on disk (facts.perSec a second): sorts or GROUP BY that outgrow memory.',
  performance_schema_off:
    "performance_schema is off (MariaDB's default), so statement statistics are missing; performance_schema=ON and a restart turn it on.",
  table_stats_unavailable:
    "The user can't read mysql.innodb_table_stats, so table sizes are missing.",
  // MongoDB (replica_lag and connections_near_max above mean the same)
  no_primary: 'The replica set (facts.set) has no primary: writes fail until one is elected.',
  slow_collscan:
    'Slow operations scan whole collections (facts.perMin a minute, COLLSCAN on facts.ns, mean facts.mean): facts.client sends most of them (facts.holder, its workload or container).',
  cache_pressure:
    'The WiredTiger cache is under pressure (facts.pct% used, facts.dirtyPct% dirty): operations wait for eviction.',
  operations_queued: 'Operations wait for a ticket (facts.n queued).',
  collscan_fills_cache:
    'Collection scans on facts.ns, sent by facts.client (facts.holder, its workload or container), fill the WiredTiger cache (facts.cachePct%): facts.perMin slow ones a minute, each reading about facts.examined documents.',
  cursors_no_timeout:
    'Cursors that never time out are idle (facts.n, on facts.ns, idle facts.idle): each keeps its resources until its client closes it.',
  indexes_unused:
    'Indexes unused since the server started (facts.n; the largest facts.index on facts.ns).',
  access_control_off:
    'Access control is off: anyone who reaches the port can read and change data.',
  voting_members_even:
    'The replica set has an even number of voting members (facts.n): it can split with no majority.',
  single_member_set: 'The replica set (facts.set) has a single member: no failover.',
  fcv_behind: 'The feature compatibility version (facts.fcv) is behind the binary (facts.version).',
  mongos_only: "A mongos: only its own operations and connections are seen, not the shards'.",
  // Redis and Valkey (1.4, ADR-247)
  prefix_fills_memory:
    'Memory is at facts.memPct% of maxmemory and keys are evicted (facts.evictPerMin a minute, policy facts.policy): keys under facts.prefix grew from facts.from% to facts.pct% of memory in two hours; facts.noTtl% of them have no TTL.',
  prefix_holds_memory:
    'Memory is at facts.memPct% of maxmemory and keys are evicted (facts.evictPerMin a minute, policy facts.policy): keys under facts.prefix hold facts.pct% of memory; facts.noTtl% of them have no TTL.',
  main_thread_saturated:
    'The main thread is saturated (facts.pct% of one core); the costliest command in the slow log is facts.cmd, sent by facts.client.',
  save_wont_fit:
    "The next save's fork needs about facts.need of copy-on-write and facts.left is left under the memory limit: it may be killed.",
  stream_group_orphaned:
    'A stream group (facts.group on facts.stream, lag facts.lag) has no consumer reading: facts.consumer has read nothing for facts.idle (facts.holder, its workload or container).',
  client_buffer_near_limit:
    'A client (facts.client) has its output buffer at facts.pct% of its facts.class limit: Redis disconnects it at the limit.',
  backlog_short:
    'The replication backlog (facts.size) holds about facts.seconds s of writes: a longer disconnect forces a full resync.',
  cluster_unhealthy: 'The cluster is unhealthy: facts.failing slots fail.',
  sentinel_master_down: 'Sentinel considers a master down.',
  no_password: 'No password, and it listens on facts.bind.',
  noeviction_cache:
    'Policy noeviction on an instance used as a cache (facts.pct% of keys with a TTL): writes fail when full.',
  no_persistence_store:
    'No persistence at all on an instance used as a store: a restart loses facts.keys keys (facts.size).',
  thp_always: 'Transparent huge pages are always on this host.',
  overcommit_off: 'vm.overcommit_memory is 0 on this host: a save may fail to fork.',
  oplog_window_short:
    'The oplog holds only facts.duration of writes: a secondary down longer than that needs a full resync.',
  // Nginx
  errors_high:
    'Requests answer 5xx (facts.pct%); facts.upstream sends most of them (facts.upstreamPct%), facts.rollout its last rollout.',
  upstream_no_endpoints:
    'An upstream (facts.upstream) has no ready endpoint, so requests to it fail.',
  latency_high: 'The p95 response time is high (facts.p95).',
  connections_dropped:
    'Nginx dropped connections (facts.n in 15 minutes): worker_connections is reached.',
  certificate_expiring:
    'A certificate ingress-nginx or Traefik serves (facts.host) expires soon (facts.days days).',
  ingress_metrics_off:
    "ingress-nginx doesn't serve its metrics (--enable-metrics): requests come from eBPF and connections are missing; facts.command turns them on.",
  stub_status_missing:
    'Plain Nginx has no stub_status, so its connections are missing; facts.command is the configuration to add.',
  no_http_source: 'Added by address: no agent sees its HTTP traffic.',
  // Traefik (errors_high, latency_high and certificate_expiring above mean the same)
  no_server_up:
    "Traefik answers 503 itself (facts.answered a second): its service facts.service has no server up, so facts.backend (linked) gets no requests; the backend's own state says why.",
  config_reload_failed:
    "Traefik's last configuration reload failed (facts.at); it keeps serving the configuration loaded facts.lastOk.",
  metrics_off:
    "Traefik doesn't serve its Prometheus metrics: requests come from eBPF (plain HTTP only), and TLS traffic and Traefik's own 502/503/504 are missing; facts.command (facts.how) turns them on.",
  // RabbitMQ
  queue_no_consumers:
    'A queue (facts.queue, facts.ready messages, +facts.perMin a minute) has no consumers since facts.since; facts.consumer, a client that was connected to RabbitMQ, ended facts.how facts.when (links: the likely former consumers, ranked by when they ended).',
  queue_growing: 'A queue (facts.queue) grows although it has consumers (+facts.perMin a minute).',
  memory_alarm: 'A node (facts.member) is in a memory alarm: publishers are blocked.',
  disk_alarm: 'A node (facts.member) is in a disk alarm: publishers are blocked.',
  unacked_high: 'Many messages are delivered but not acknowledged (facts.n).',
  dead_letters_growing:
    'Messages are being dead-lettered (facts.n in 15 minutes, or facts.queue grows).',
  prometheus_plugin_off:
    'The rabbitmq_prometheus plugin is off on facts.n nodes; facts.command enables it, with no restart.',
  // Kafka (ADR-166)
  offline_partitions:
    'Kafka partitions have no leader (facts.n, e.g. in facts.topic): they can be neither written nor read.',
  under_replicated:
    'Kafka partitions have fewer in-sync replicas than replicas (facts.n, e.g. in facts.topic).',
  broker_down: 'Kafka brokers are missing from the cluster (facts.n fewer than in the last hour).',
  group_lag_growing:
    'A consumer group (facts.group) falls behind on facts.topic: lag facts.lag, growing by facts.perMin a minute, while it has members.',
  group_no_members:
    'A consumer group (facts.group, lag facts.lag, +facts.perMin a minute) has had no members since facts.since; facts.member, a member until then, ended facts.how facts.when (links: the likely former members, closest first).',
};

/** WatchLog's sentence for a reason code; the facts come with it, cleaned. */
export function reasonSentence(r: { code: string; facts: Record<string, unknown> }): string {
  const f = r.facts;
  switch (r.code) {
    case 'waiting':
      return 'Monitored; waiting for the first report from its collector.';
    case 'collector_missing':
      return f.host
        ? 'No integrations collector has reported from its Docker host yet.'
        : 'No integrations collector has reported from this cluster yet.';
    case 'collector_silent':
      return 'Its integrations collector stopped reporting.';
    case 'unreachable':
      return "The collector can't connect to it.";
    case 'login_failed':
      return 'The collector connects, but its user or password is refused: the access in its settings needs fixing.';
    case 'connected':
      return Number(f.up) < Number(f.members)
        ? 'The collector reaches some of its members, not all.'
        : 'The collector connects to it.';
    case 'no_metrics':
      return f.hint
        ? `Connected, but none of its key numbers has data; not healthy until one does. The fix is the integration's hint (${String(f.hint)}): facts.command when given.`
        : "Connected, but none of its key numbers has data; not healthy until one does. Check the integrations collector's log (facts.command; on a server in Docker: docker logs --tail 50 watchlog-integrations).";
    case 'paused':
      return 'Monitoring is paused (facts.by, facts.at): nothing is read until someone resumes it in the service settings.';
    case 'member_down':
      return "One member can't be reached.";
    case 'needs_permission':
      return "A tab can't be filled: the collector's user lacks a privilege.";
    case 'source_unsupported':
      return "A tab can't be filled: the server doesn't have the command it reads (a managed service).";
    default:
      return INTEGRATION_SENTENCES[r.code] ?? 'See the facts.';
  }
}

const cleanFacts = (facts: Record<string, string | number | null>) =>
  Object.fromEntries(
    Object.entries(facts)
      .slice(0, 12)
      .map(([k, v]) => [text(k, 64), fact(v, k === 'error' ? 512 : 253)]),
  );

const where = (a: ApiApplication) =>
  a.cluster.kind === 'kubernetes'
    ? { namespace: name(a.where.group), address: name(a.where.address) }
    : {
        host: name(a.where.host),
        composeProject: name(a.where.group),
        address: name(a.where.address),
      };

const appField = (a: ApiApplication) => ({
  id: a.id,
  type: a.type,
  name: name(a.name),
  version: text(a.version, 64),
  ...where(a),
  health: a.health,
  reason: {
    code: a.reason.code,
    sentence: reasonSentence(a.reason),
    facts: cleanFacts(a.reason.facts),
  },
  // Why the health is what it is, when a finding (not reachability) decides it.
  ...(a.finding
    ? {
        finding: {
          severity: a.finding.severity,
          code: a.finding.code,
          sentence: reasonSentence(a.finding),
          facts: cleanFacts(a.finding.facts),
        },
      }
    : {}),
  members: a.members,
  lastReportAt: a.lastReportAt,
});

export const listApplicationsTool = defineTool({
  name: 'list_applications',
  title: 'List monitored services',
  description: describe(
    'The services WatchLog monitors in a cluster or Docker fleet: databases, caches, queues and web servers (Redis, PostgreSQL, MySQL and MariaDB, MongoDB, Nginx, Traefik, RabbitMQ, Kafka), problems first.',
    "Each has its type, version, where it runs (namespace on Kubernetes; host and Compose project on Docker), health (ok, warning, critical, unknown) with a reason code, a sentence and facts, and how many of its members (pods or containers) the collector reaches. Pass `cluster` to see one cluster; leave it out to see every cluster the token can read. Use get_application for one service's reasons and who connects to it.",
    'Example question: "Is any of our databases unhealthy?"',
  ),
  input: Type.Object(
    {
      cluster: ClusterArg,
      type: Type.Optional(
        Type.Union(
          [
            Type.Literal('redis'),
            Type.Literal('postgres'),
            Type.Literal('nginx'),
            Type.Literal('rabbitmq'),
            Type.Literal('mysql'),
            Type.Literal('mongodb'),
            Type.Literal('traefik'),
            Type.Literal('kafka'),
            Type.Literal('php-fpm'),
            Type.Literal('elasticsearch'),
          ],
          { description: 'Only services of this type.' },
        ),
      ),
    },
    { additionalProperties: false },
  ),
  summarize: (a) => summary(a.cluster, a.type),
  async run(args, { api }) {
    const cluster = args.cluster ? await resolveCluster(api, args.cluster) : null;
    const { applications } = await api.get<{ applications: ApiApplication[] }>(
      '/applications',
      cluster ? { cluster: cluster.id } : undefined,
    );
    const items = applications.filter((a) => !args.type || a.type === args.type);
    return {
      body: {
        ...(cluster ? { cluster: clusterField(cluster) } : {}),
        counts: {
          total: items.length,
          critical: items.filter((a) => a.health === 'critical').length,
          warning: items.filter((a) => a.health === 'warning').length,
        },
      },
      list: {
        key: 'applications',
        items: items.map((a) => ({
          ...appField(a),
          ...(cluster ? {} : { cluster: clusterField(a.cluster) }),
        })),
        total: items.length,
        noun: 'services',
        narrow: 'Problems come first. Pass `cluster` or `type` to narrow it.',
      },
    };
  },
});

export const getApplicationTool = defineTool({
  name: 'get_application',
  title: 'Get a monitored service',
  description: describe(
    'One monitored service (Redis, PostgreSQL, MySQL, MongoDB, Nginx, Traefik, RabbitMQ, Kafka…): its health, every reason WatchLog sees (most severe first, each with a code, a sentence, facts and the workloads or containers it points to), and the workloads or containers that connect to it over the last hour, with connection and failed-connect counts (from network flows; `connected.flows` is false when the agents report none).',
    'Pass `name` as list_applications shows it ("shop/redis" on Kubernetes, "billing/postgres" for a Compose service, or a container name), or its id.',
    'For RabbitMQ it adds `rabbitmq`: the queues that need a look (type, ready, unacked, in and out a second, consumers, how busy, drains in) and the clients that connected in the last 24 hours (bytes each way, a "mostly" guess from the traffic direction, how they ended); pass `queue` for one queue\'s facts, timeline and probable cause. RabbitMQ\'s metrics do not say which client consumes which queue.',
    'For PostgreSQL and MySQL it adds `database`: what the database waited on over the last 15 minutes (the share of active sessions by wait: cpu, io, lock, client, other), the statements that cost the most (calls a second, mean time now and as usual, share of the time, "sent mostly by" when one client clearly sends it, a "probably missing an index" or "N× slower" hint), and who blocks whom (the blocking tree, root blocker first, with each session\'s client, state and how long). Pass `statement` (a queryid or digest from those lists) for one statement\'s facts, its mean time over the last hour, its senders and the tables it names. Statement text is normalised (no values).',
    'Example question: "Why is payments/postgres critical, and which services use it?"',
  ),
  input: Type.Object(
    {
      cluster: ClusterArg,
      name: NameArg('The service name from list_applications, or its id.'),
      queue: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 255,
          description:
            'RabbitMQ only: one queue\'s detail ("orders", or "billing/orders" outside the default vhost).',
        }),
      ),
      statement: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 64,
          pattern: '^[-0-9a-zA-Z]+$',
          description:
            "PostgreSQL or MySQL only: one statement's detail, by its queryid or digest.",
        }),
      ),
    },
    { additionalProperties: false },
  ),
  summarize: (a) => summary(a.cluster, a.name),
  async run(args, { api }) {
    const cluster = await resolveCluster(api, args.cluster);
    const { applications } = await api.get<{ applications: ApiApplication[] }>('/applications', {
      cluster: cluster.id,
    });
    const wanted = args.name.trim();
    const match = applications.filter((a) => a.id === wanted || a.name === wanted);
    if (match.length !== 1) {
      throw new ToolError(
        match.length === 0
          ? 'No monitored service with this name in this cluster.'
          : 'Several services have this name: pass the id.',
        'Take the name or id from list_applications.',
        {
          name: name(wanted),
          services: (match.length ? match : applications).slice(0, 20).map((a) => ({
            id: a.id,
            type: a.type,
            name: name(a.name),
          })),
        },
      );
    }
    const d = await api.get<ApiDetail>(`/applications/${match[0]!.id}`).catch((err: unknown) =>
      notFound(err, 'The service is no longer monitored.', 'Run list_applications again.', {
        name: name(wanted),
      }),
    );
    const rabbit =
      d.page.id === 'rabbitmq' ? await rabbitmqOf(api, match[0]!.id, args.queue) : null;
    const database =
      d.page.id === 'postgres' || d.page.id === 'mysql'
        ? await databaseOf(api, match[0]!.id, args.statement)
        : null;
    return {
      body: {
        cluster: clusterField(cluster),
        ...(rabbit ? { rabbitmq: rabbit } : {}),
        ...(database ? { database } : {}),
        application: {
          ...appField(d.application),
          monitoredSince: d.application.monitoredSince,
          pages: d.page.id === 'generic' ? 'reachability only' : d.page.tabs.map((t) => t.id),
        },
        reasons: d.reasons.slice(0, MAX_REASONS).map((r) => ({
          severity: r.severity,
          code: r.code,
          sentence: reasonSentence(r),
          facts: cleanFacts(r.facts),
          ...(r.links?.length
            ? {
                links: r.links.slice(0, 5).map((l) => ({
                  kind: l.kind,
                  id: name(l.id),
                  name: name(l.name),
                })),
              }
            : {}),
        })),
        connected: d.connected
          ? {
              flows: d.connected.flows,
              window: '1h',
              items: d.connected.items.slice(0, MAX_CONNECTED).map((c) => ({
                kind: c.kind,
                name: name(c.name),
                ...(c.kind === 'workload'
                  ? { namespace: name(c.namespace), workloadKind: text(c.workloadKind, 64) }
                  : {
                      composeProject: name(c.namespace),
                      composeService: name(c.composeService),
                    }),
                connections: c.connections,
                failed: c.failed,
              })),
            }
          : null,
      },
    };
  },
});

interface ApiQueue {
  vhost: string;
  queue: string;
  name: string;
  type: string | null;
  ready: number;
  unacked: number;
  in: number | null;
  out: number | null;
  consumers: number | null;
  busy: number | null;
  drain: { state: string; seconds?: number };
  severity?: string;
}

/** RabbitMQ's queues that need a look, its clients, and one queue when asked (1.1.0). */
async function rabbitmqOf(
  api: { get<T>(path: string, query?: Record<string, string>): Promise<T> },
  id: string,
  queue?: string,
) {
  const soft = <T>(p: Promise<T>) => p.catch(() => null);
  const [q, c] = await Promise.all([
    soft(api.get<{ queues: ApiQueue[]; total: number }>(`/applications/${id}/rabbitmq/queues`)),
    soft(api.get<{ clients: Record<string, unknown>[] }>(`/applications/${id}/rabbitmq/clients`)),
  ]);
  const row = (x: ApiQueue) => ({
    name: name(x.name),
    type: x.type,
    ready: x.ready,
    unacked: x.unacked,
    inPerSecond: x.in,
    outPerSecond: x.out,
    consumers: x.consumers,
    busy: x.busy,
    drainsIn: x.drain.state === 'eta' ? `${x.drain.seconds}s` : x.drain.state,
    ...(x.severity ? { severity: x.severity } : {}),
  });
  let one: unknown = null;
  if (queue) {
    const slash = queue.indexOf('/');
    const vhost = slash > 0 ? queue.slice(0, slash) : '/';
    const qn = slash > 0 ? queue.slice(slash + 1) : queue;
    one = await soft(
      api.get(`/applications/${id}/rabbitmq/queues/${encodeURIComponent(qn)}`, { vhost }),
    );
    if (!one && slash > 0)
      one = await soft(api.get(`/applications/${id}/rabbitmq/queues/${encodeURIComponent(queue)}`));
  }
  return {
    queues: q
      ? {
          total: q.total,
          needALook: q.queues
            .filter((x) => x.severity)
            .slice(0, 20)
            .map(row),
          deepest: [...q.queues]
            .sort((a, b) => b.ready - a.ready)
            .slice(0, 10)
            .map(row),
          note: 'The 200 deepest queues of each node and every queue with messages and no consumer.',
        }
      : null,
    clients: c ? c.clients.slice(0, 30) : null,
    ...(queue
      ? { queue: one ?? { error: 'Queue not found among the queues WatchLog reads.' } }
      : {}),
  };
}

interface ApiPanel {
  id: string;
  kind: string;
  state: string;
  rows?: Record<string, unknown>[];
  nodes?: Record<string, unknown>[];
  series?: { nameKey?: string; name?: string; points: [number, number | null][] }[];
  items?: { label: string; value: number }[];
}

const panelOf = (panels: ApiPanel[] | undefined, id: string) => panels?.find((p) => p.id === id);
const lastOf = (points: [number, number | null][] | undefined) =>
  points?.filter((p) => p[1] !== null).at(-1)?.[1] ?? null;

/** A database's waits, costliest statements and blocking tree, and one statement when asked (1.2). */
async function databaseOf(
  api: { get<T>(path: string, query?: Record<string, string>): Promise<T> },
  id: string,
  statement?: string,
) {
  const soft = <T>(p: Promise<T>) => p.catch(() => null);
  const now = Math.floor(Date.now() / 1000);
  const tab = (t: string, extra: Record<string, string> = {}) =>
    soft(
      api.get<{ panels: ApiPanel[] }>(`/applications/${id}/panels`, {
        tab: t,
        range: '3600',
        ...extra,
      }),
    );
  const [waits, queries, locks, one] = await Promise.all([
    tab('waits', { from: String(now - 900), to: String(now) }),
    tab('queries'),
    tab('locks'),
    statement ? tab('statement', { statement }) : Promise.resolve(null),
  ]);
  const summary = panelOf(waits?.panels, 'summary');
  const stmtRow = (r: Record<string, unknown>) => ({
    id: r.id,
    text: text(String(r.text ?? ''), 300),
    callsPerSecond: r.calls,
    meanSeconds: r.mean,
    usualSeconds: r.usual,
    share: r.share,
    ...(r.sentBy ? { sentMostlyBy: name(String((r.sentBy as { name: string }).name)) } : {}),
    ...(r.hint ? { hint: r.hint } : {}),
  });
  return {
    waitsLast15Minutes: summary?.rows ?? null,
    statements: (panelOf(queries?.panels, 'top')?.rows ?? []).slice(0, 10).map(stmtRow),
    blocking: (panelOf(locks?.panels, 'tree')?.nodes ?? []).slice(0, 20).map((n) => ({
      depth: n.depth,
      client: name(String(n.name ?? '')),
      state: n.state,
      seconds: n.seconds,
      transactionSeconds: n.xact,
      ...(n.query ? { query: text(String(n.query), 300) } : {}),
    })),
    note: 'Statement text is normalised; "sent mostly by" appears only when one client sends at least 70% of a statement.',
    ...(statement
      ? {
          statement: one
            ? {
                facts: panelOf(one.panels, 'facts')?.rows ?? null,
                meanSecondsNow: lastOf(panelOf(one.panels, 'mean')?.series?.[0]?.points),
                meanSecondsLastHour:
                  panelOf(one.panels, 'mean')?.series?.[0]?.points.slice(-12) ?? null,
                senders:
                  panelOf(one.panels, 'senders')?.items?.map((x) => ({
                    client: name(x.label),
                    share: x.value,
                  })) ?? null,
                tables: panelOf(one.panels, 'tables')?.rows ?? null,
              }
            : { error: 'Statement not found among the top statements WatchLog reads.' },
        }
      : {}),
  };
}
