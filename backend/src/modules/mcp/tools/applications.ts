// SPDX-License-Identifier: AGPL-3.0-only
// list_applications and get_application (SPEC §4.12, ADR-135): the services WatchLog
// monitors (Redis, PostgreSQL, Nginx, RabbitMQ…), their health with its reasons, and
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
  lock_waits: 'Sessions are waiting for locks (facts.n); facts.who holds them.',
  deadlocks: 'Deadlocks happened in the last 15 minutes (facts.n).',
  replica_lag: 'A replica is behind its primary (facts.duration).',
  slot_retains_wal: 'An inactive replication slot (facts.slot) keeps WAL on disk (facts.size).',
  wraparound_risk:
    'Transaction ID age is high (facts.db, facts.n): at 2,000 M PostgreSQL stops accepting writes.',
  cache_hit_low: 'Few reads come from shared buffers (facts.pct %).',
  autovacuum_not_finishing:
    'Autovacuum is not finishing on some tables (facts.n, for example facts.table).',
  statements_unavailable: 'pg_stat_statements is not installed, so query statistics are missing.',
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
    case 'paused':
      return 'Monitoring is paused.';
    case 'member_down':
      return "One member can't be reached.";
    case 'needs_permission':
      return "A tab can't be filled: the collector's user lacks a privilege.";
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
  members: a.members,
  lastReportAt: a.lastReportAt,
});

export const listApplicationsTool = defineTool({
  name: 'list_applications',
  title: 'List monitored services',
  description: describe(
    'The services WatchLog monitors in a cluster or Docker fleet: databases, caches, queues and web servers (Redis, PostgreSQL, Nginx, RabbitMQ), problems first.',
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
            Type.Literal('mongodb'),
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
    'One monitored service (Redis, PostgreSQL, Nginx, RabbitMQ…): its health, every reason WatchLog sees (most severe first, each with a code, a sentence, facts and the workloads or containers it points to), and the workloads or containers that connect to it over the last hour, with connection and failed-connect counts (from network flows; `connected.flows` is false when the agents report none).',
    'Pass `name` as list_applications shows it ("shop/redis" on Kubernetes, "billing/postgres" for a Compose service, or a container name), or its id.',
    'Example question: "Why is payments/postgres critical, and which services use it?"',
  ),
  input: Type.Object(
    {
      cluster: ClusterArg,
      name: NameArg('The service name from list_applications, or its id.'),
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
    return {
      body: {
        cluster: clusterField(cluster),
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
