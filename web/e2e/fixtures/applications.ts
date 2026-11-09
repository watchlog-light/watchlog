// SPDX-License-Identifier: AGPL-3.0-only
// Applications for the responsive suite (v0.3): a monitored PostgreSQL on Kubernetes with
// its page, services found on both kinds, connection tests in each state, and a service's
// access and log. The shapes are the API's (GET /applications/:id, /panels,
// POST /applications/probes, GET /applications/:id/access) as of slice 5; they let the
// suite draw the connect flow without writing to the dashboard's database.

export const FIXTURE_APP_ID = '01a1c000-0000-7000-8000-00000000e2e1';

interface Cluster {
  id: string;
  name: string;
  kind: 'kubernetes' | 'docker';
}

const now = () => Math.floor(Date.now() / 1000);
const series = (base: number, jitter: number, n = 60) =>
  Array.from({ length: n }, (_, i) => [
    now() - (n - i) * 60,
    Math.max(0, base + Math.sin(i / 5) * jitter),
  ]);

export function application(kube: Cluster) {
  return {
    id: FIXTURE_APP_ID,
    type: 'postgres',
    name: 'payments/postgres',
    version: '16.4',
    cluster: kube,
    where: { group: 'payments', host: null, address: null },
    target: {
      kind: 'workload',
      namespace: 'payments',
      workload_kind: 'StatefulSet',
      workload: 'postgres',
      port: 5432,
    },
    health: 'warning',
    reason: { code: 'connected', facts: { up: 1, members: 2 } },
    members: { up: 1, total: 2 },
    monitoredSince: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    lastReportAt: new Date().toISOString(),
  };
}

export function applicationDetail(kube: Cluster) {
  return {
    application: application(kube),
    reasons: [
      { severity: 'warning', code: 'connected', facts: { up: 1, members: 2 } },
      {
        severity: 'warning',
        code: 'member_down',
        facts: { member: 'postgres-1', error: 'dial tcp 10.244.2.7:5432: i/o timeout' },
        links: [{ kind: 'workload', id: 'payments/StatefulSet/postgres', name: 'postgres-1' }],
      },
      {
        severity: 'info',
        code: 'needs_permission',
        facts: { tab: 'queries', missing: 'pg_stat_statements' },
      },
    ],
    connected: {
      flows: true,
      items: [
        {
          kind: 'workload',
          name: 'api',
          namespace: 'payments',
          workloadKind: 'Deployment',
          composeService: null,
          connections: 12840,
          failed: 14,
        },
        {
          kind: 'workload',
          name: 'worker',
          namespace: 'payments',
          workloadKind: 'Deployment',
          composeService: null,
          connections: 4210,
          failed: 0,
        },
      ],
    },
    page: { id: 'generic', tabs: [{ id: 'overview', title: 'integrations.tabs.overview' }] },
    range: 3600,
  };
}

export function applicationPanels() {
  const P = 'integrations.generic.panels';
  return {
    tab: 'overview',
    range: 3600,
    panels: [
      {
        id: 'summary',
        title: `${P}.summary`,
        kind: 'stat',
        span: 2,
        state: 'ok',
        tiles: [
          { id: 'members', labelKey: `${P}.membersUp`, value: '1/2', severity: 'warning' },
          { id: 'connect', labelKey: `${P}.connectTime`, value: 0.0021, unit: 'seconds' },
          { id: 'scrape', labelKey: `${P}.scrapeTime`, value: 0.0043, unit: 'seconds' },
        ],
      },
      {
        id: 'connect',
        title: `${P}.connect`,
        kind: 'line',
        span: 1,
        unit: 'seconds',
        state: 'ok',
        series: [{ name: 'postgres-0', points: series(0.002, 0.0008) }],
      },
      {
        id: 'reachable',
        title: `${P}.reachable`,
        kind: 'line',
        span: 1,
        unit: 'count',
        state: 'ok',
        series: [
          { nameKey: `${P}.series.reachable`, points: series(1.5, 0.5), severity: 'ok' },
          { nameKey: `${P}.series.members`, points: series(2, 0), dashed: true },
        ],
      },
    ],
    ignored: [],
  };
}

/** The same service with the PostgreSQL page (slice 8). */
export function postgresDetail(kube: Cluster) {
  const T = 'integrations.postgres.tabs';
  return {
    ...applicationDetail(kube),
    page: {
      id: 'postgres',
      tabs: [
        ...['overview', 'connections', 'queries', 'locks', 'replication', 'tables', 'vacuum'].map(
          (id) => ({ id, title: `${T}.${id}` }),
        ),
        { id: 'connection', title: 'integrations.tabs.connection' },
      ],
    },
  };
}

/** The PostgreSQL page's widest tabs: Overview (six tiles, two gauges) and Locks (six columns). */
export function postgresPanels(tab: 'overview' | 'locks') {
  const P = 'integrations.postgres.panels';
  const GB = 2 ** 30;
  const query =
    'UPDATE orders SET status = $1, updated_at = now() WHERE customer_id = $2 AND status IN ($3, $4)';
  if (tab === 'overview')
    return {
      tab,
      range: 3600,
      panels: [
        {
          id: 'summary',
          title: `${P}.summary`,
          kind: 'stat',
          span: 2,
          state: 'ok',
          tiles: [
            {
              id: 'connections',
              labelKey: `${P}.connections`,
              value: 92,
              unit: 'count',
              sub: { key: `${P}.ofMax`, values: { max: 100 } },
              severity: 'warning',
            },
            {
              id: 'tps',
              labelKey: `${P}.tps`,
              value: 1840,
              unit: 'per_second',
              sub: { key: `${P}.commitPct`, values: { pct: 99 } },
            },
            { id: 'cache', labelKey: `${P}.cacheHit`, value: 0.984, unit: 'ratio' },
            { id: 'lag', labelKey: `${P}.replicationLag`, value: 0.4, unit: 'seconds' },
            {
              id: 'size',
              labelKey: `${P}.size`,
              value: 48.2 * GB,
              unit: 'bytes',
              sub: { key: `${P}.perDay`, values: { growth: '310 MB' } },
            },
            {
              id: 'longest',
              labelKey: `${P}.longestQuery`,
              value: 412,
              unit: 'seconds',
              severity: 'critical',
            },
          ],
        },
        {
          id: 'connections',
          title: `${P}.connectionsOverTime`,
          kind: 'line',
          span: 1,
          unit: 'count',
          state: 'ok',
          series: [
            { nameKey: `${P}.series.connections`, points: series(80, 12) },
            { nameKey: `${P}.maxConnections`, points: series(100, 0), dashed: true },
          ],
        },
        {
          id: 'transactions',
          title: `${P}.transactions`,
          kind: 'stack',
          span: 1,
          unit: 'per_second',
          state: 'ok',
          series: [
            { nameKey: `${P}.series.commits`, points: series(1800, 300), severity: 'ok' },
            { nameKey: `${P}.series.rollbacks`, points: series(20, 10), severity: 'warning' },
          ],
        },
        {
          id: 'slowest',
          title: `${P}.slowest`,
          kind: 'table',
          span: 2,
          state: 'ok',
          note: { key: `${P}.statementsNote` },
          columns: [`${P}.cols.query`, `${P}.cols.mean`, `${P}.cols.calls1h`, `${P}.cols.total`],
          rows: [
            { cells: [query, '1.84 s', 1210, '2226.40 s'], severity: 'warning' },
            {
              cells: ['SELECT * FROM carts WHERE session_id = $1', '12.4 ms', 88_410, '1096.28 s'],
            },
          ],
        },
        {
          id: 'busiest',
          title: `${P}.busiest`,
          kind: 'bars',
          span: 1,
          unit: 'per_second',
          state: 'ok',
          items: [
            { label: 'orders', value: 1420 },
            { label: 'catalog_and_inventory_reporting', value: 380 },
          ],
        },
        {
          id: 'capacity',
          title: `${P}.capacity`,
          kind: 'gauge',
          span: 1,
          state: 'ok',
          items: [
            {
              labelKey: `${P}.maxConnections`,
              value: 92,
              max: 100,
              unit: 'count',
              warnAt: 0.9,
              note: { key: `${P}.reserved`, values: { n: 3 } },
            },
            {
              label: 'data-orders-postgres-0',
              value: 82 * GB,
              max: 100 * GB,
              unit: 'bytes',
              warnAt: 0.85,
              note: { key: `${P}.daysLeft`, values: { days: 58 } },
            },
          ],
        },
      ],
    };
  return {
    tab,
    range: 3600,
    panels: [
      {
        id: 'waits',
        title: `${P}.waits`,
        kind: 'stack',
        span: 2,
        unit: 'count',
        state: 'ok',
        series: [
          { name: 'Lock', points: series(3, 2), severity: 'warning' },
          { name: 'Client', points: series(40, 8) },
          { name: 'IO', points: series(2, 1) },
        ],
      },
      {
        id: 'blocking',
        title: `${P}.blocking`,
        kind: 'table',
        span: 2,
        state: 'ok',
        note: { key: `${P}.blockingNote` },
        columns: [
          `${P}.cols.blocked`,
          `${P}.cols.waitingFor`,
          `${P}.cols.for`,
          `${P}.cols.blockedBy`,
          `${P}.cols.blockedQuery`,
          `${P}.cols.blockingQuery`,
        ],
        rows: [
          {
            cells: [
              'payments/settlement-worker (active)',
              'Lock transactionid',
              '4 min',
              'payments/api (idle in transaction)',
              query,
              'SELECT * FROM orders WHERE id = $1 FOR UPDATE',
            ],
            severity: 'warning',
          },
        ],
      },
      {
        id: 'heat',
        title: `${P}.lockHeat`,
        kind: 'heat',
        span: 2,
        unit: 'count',
        state: 'ok',
        note: { key: `${P}.lockHeatNote` },
        points: Array.from({ length: 168 }, (_, i) => [
          Math.floor(Date.now() / 3_600_000 - 168 + i) * 3600,
          Math.max(0, Math.round(4 + Math.sin(i / 4) * 4)),
        ]),
      },
      {
        id: 'deadlocks',
        title: `${P}.deadlocks`,
        kind: 'line',
        span: 1,
        unit: 'count',
        state: 'ok',
        series: [
          { nameKey: `${P}.series.deadlocks`, points: series(0.2, 0.2), severity: 'critical' },
        ],
      },
      {
        id: 'locked',
        title: `${P}.lockedTables`,
        kind: 'bars',
        span: 1,
        unit: 'count',
        state: 'ok',
        items: [
          { label: 'orders', value: 14 },
          { label: 'order_line_items_archive_2026', value: 3 },
        ],
      },
    ],
    ignored: [],
  };
}

/** Found and not monitored: a PostgreSQL on Kubernetes, a Redis on a Docker host. */
export function discovered(kube: Cluster, docker: Cluster, host: string) {
  return {
    discovered: [
      {
        key: 'k-orders',
        cluster: kube,
        type: 'postgres',
        name: 'shop/orders',
        image: 'postgres:16-alpine',
        version: '16',
        product: null,
        port: 5432,
        confidence: 'image',
        members: 1,
        host: null,
        group: 'shop',
        target: {
          kind: 'workload',
          namespace: 'shop',
          workload_kind: 'Deployment',
          workload: 'orders',
          port: 5432,
        },
      },
      {
        key: 'd-sessions',
        cluster: docker,
        type: 'redis',
        name: 'storefront/sessions',
        image: 'redis:7.2-alpine',
        version: '7.2',
        product: null,
        port: 6379,
        confidence: 'image',
        members: 1,
        host,
        group: 'storefront',
        target: {
          kind: 'compose',
          host,
          compose_project: 'storefront',
          compose_service: 'sessions',
          port: 6379,
        },
      },
    ],
    ignored: [],
  };
}

const PROBE_ID = '01a1c000-0000-7000-8000-00000000e2e2';
export const PROBE_URL = new RegExp(`/api/v1/applications/probes/${PROBE_ID}$`);

export function probe(over: Record<string, unknown> = {}) {
  return {
    id: PROBE_ID,
    status: 'pending',
    method: 'generated',
    username: 'watchlog',
    attempts: 0,
    result: null,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    ...over,
  };
}

// Made up, in the generated format (wl_mon_ and 25 characters).
const PASSWORD = 'wl_mon_EXAMPLExEXAMPLExEXAMPLEx';
export const generatedCommand =
  `kubectl exec -n shop deployment/orders -- psql -U postgres -v ON_ERROR_STOP=1 ` +
  `-c "CREATE ROLE watchlog LOGIN PASSWORD '${PASSWORD}'" -c "GRANT pg_monitor TO watchlog"`;

export const failure = (code: string, error: string | null, missing: string[] = []) => ({
  ok: false,
  code,
  error,
  version: null,
  facts: {},
  excess: [],
  missing,
});

export const success = (
  version: string,
  facts: Record<string, string | number>,
  excess: string[] = [],
) => ({
  ok: true,
  code: 'ok',
  error: null,
  version,
  facts,
  excess,
  missing: [],
});

export const roleCommands = [
  'kubectl create role watchlog-read-orders-db -n watchlog --verb=get --resource=secrets --resource-name=orders-db',
  'kubectl create rolebinding watchlog-read-orders-db -n watchlog --role=watchlog-read-orders-db --serviceaccount=watchlog:watchlog-agent-integrations',
];
export const fileCommands = [
  'sudo install -d -m 0700 /etc/watchlog/secrets',
  "sudo sh -c 'umask 077; cat > /etc/watchlog/secrets/sessions-redis'   # paste the password, then Ctrl-D",
];

/** A service's access and log, as the settings drawer reads it. */
export function access() {
  const at = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  return {
    access: {
      method: 'generated',
      username: 'watchlog',
      reference: null,
      setBy: 'Ada Admin',
      setAt: at(50),
      verifiedAt: at(49),
    },
    settings: { queryText: true, paused: false },
    events: [
      { action: 'verified', user: null, ip: null, at: at(49), details: {} },
      { action: 'credential_set', user: 'Ada Admin', ip: '10.0.4.17', at: at(50), details: {} },
      { action: 'monitored', user: 'Ada Admin', ip: '10.0.4.17', at: at(50), details: {} },
    ],
  };
}

/** The rules of the fixture service, for its alerts block and the rule editor. */
export function serviceRules(kube: Cluster) {
  const base = {
    type: 'threshold',
    ruleKey: null,
    source: 'metric',
    clusterId: kube.id,
    appliesTo: ['kubernetes', 'docker'],
    scope: { service: FIXTURE_APP_ID },
    renotifySeconds: 14400,
    severity: 'warning',
    channelIds: [],
    evalError: null,
    service: { id: FIXTURE_APP_ID, name: 'payments/postgres', type: 'postgres' },
  };
  return [
    {
      ...base,
      id: '01a1c000-0000-7000-8000-00000000e2e3',
      name: 'Service unreachable',
      unit: 'ratio',
      metric: 'service.reachable.ratio',
      condition: { op: '<', value: 1, critical: 0.01 },
      forSeconds: 120,
      enabled: true,
      firing: 1,
    },
    {
      ...base,
      id: '01a1c000-0000-7000-8000-00000000e2e4',
      name: 'Service slow to connect',
      unit: 'seconds',
      metric: 'service.connect.time',
      condition: { op: '>', value: 0.5 },
      forSeconds: 300,
      enabled: false,
      firing: 0,
    },
  ];
}

/**
 * A busy host: 19 services found, Valkey among them, two ignored. The monitored list
 * must stay on top, the found ones fold to three, and "needs a read-only user" must never
 * be cut.
 */
export function manyDiscovered(kube: Cluster, docker: Cluster, host: string) {
  const k8s = (ns: string, workload: string, type: 'redis' | 'postgres', image: string) => ({
    key: `k-${ns}-${workload}`,
    cluster: kube,
    type,
    name: `${ns}/${workload}`,
    image,
    version: image.split(':')[1]!.replace(/-alpine$/, ''),
    product: null,
    port: type === 'redis' ? 6379 : 5432,
    confidence: 'image',
    members: 1,
    host: null,
    group: ns,
    target: {
      kind: 'workload',
      namespace: ns,
      workload_kind: 'StatefulSet',
      workload,
      port: type === 'redis' ? 6379 : 5432,
    },
  });
  const box = (
    name: string,
    type: 'redis' | 'postgres',
    image: string,
    product: string | null = null,
  ) => ({
    key: `d-${name}`,
    cluster: docker,
    type,
    name,
    image,
    version: image.split(':')[1]!.replace(/-alpine$/, ''),
    product,
    port: type === 'redis' ? 6379 : 5432,
    confidence: 'image',
    members: 1,
    host,
    group: '',
    target: { kind: 'container', host, container: name, port: type === 'redis' ? 6379 : 5432 },
  });
  return {
    discovered: [
      k8s('shop', 'orders', 'postgres', 'postgres:16-alpine'),
      box('cache-valkey', 'redis', 'valkey/valkey:8.0', 'valkey'),
      k8s('shop', 'sessions', 'redis', 'redis:7-alpine'),
      k8s('pg-e2e', 'pg-gen', 'postgres', 'postgres:17-alpine'),
      k8s('pg-e2e', 'pg-ref', 'postgres', 'postgres:13-alpine'),
      k8s('redis-e2e', 'redis-acl', 'redis', 'redis:7.2-alpine'),
      k8s('redis-e2e', 'redis-auth', 'redis', 'redis:7.2-alpine'),
      k8s(
        'billing-and-invoicing-reporting',
        'ledger-postgres-primary',
        'postgres',
        'postgres:16-alpine',
      ),
      box('e2e-pg-file', 'postgres', 'postgres:16-alpine'),
      box('e2e-pg-gen', 'postgres', 'postgres:17-alpine'),
      box('e2e-redis-acl', 'redis', 'redis:7.2-alpine'),
      box('e2e-redis-file', 'redis', 'redis:7.2-alpine'),
      box('test-pg13', 'postgres', 'postgres:13-alpine'),
      box('test-pg17', 'postgres', 'postgres:17-alpine'),
      box('test-redis62', 'redis', 'redis:6.2-alpine'),
      box('test-redis72', 'redis', 'redis:7.2-alpine'),
      box('test-redisauth', 'redis', 'redis:7.2-alpine'),
      box('test-valkey8', 'redis', 'valkey/valkey:8.0', 'valkey'),
      box('test-postgres-1', 'postgres', 'postgres:16-alpine'),
    ],
    ignored: [
      {
        id: '01a1c000-0000-7000-8000-00000000e2f1',
        cluster: kube,
        scope: 'group',
        label: 'namespace load-test',
        createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      },
      {
        id: '01a1c000-0000-7000-8000-00000000e2f2',
        cluster: docker,
        scope: 'service',
        label: 'redis scratch-redis',
        createdAt: new Date(Date.now() - 7_200_000).toISOString(),
      },
    ],
  };
}

/** The Redis default alerts, as GET /applications/alert-defaults?type=redis answers. */
export const redisAlertDefaults = {
  defaults: [
    'unreachable',
    'slow_connect',
    'redis_memory_high',
    'redis_evicting',
    'redis_replica_down',
    'redis_save_failed',
    'redis_blocked_clients',
  ].map((key) => ({ key, name: key, severity: 'warning' })),
};
