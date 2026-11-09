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

const PASSWORD = 'wl_mon_Qx7fK2mT9bLr4Wc8Nz3Hd5Vp1';
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
