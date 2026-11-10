// SPDX-License-Identifier: AGPL-3.0-only
// The Nginx page (v0.3 slice 10, SPEC §4.12): ingress-nginx's own series on Kubernetes
// (upstreams from its backend Services, their readiness and rollouts, certificates),
// plain Nginx in Docker from the eBPF HTTP series found by its Compose service and port
// (upstreams from its edges, connect failures), the hints for stub_status and
// ingress-nginx's metrics, the list's numbers, and default rules firing on both.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { VictoriaQueryClient } from '../src/lib/victoria.js';
import { lookupEvaluator } from '../src/modules/alerts/rules.js';
import { bursts } from '../src/modules/integrations/pages/nginx.js';
import {
  TEST_VM_URL,
  closeTestContext,
  createTestContext,
  setupAdmin,
  type TestContext,
} from './helpers.js';
import { testWorker } from './support/alerts.js';
import { encode, type TestSeries } from './support/remote-write.js';

const RUN = `nginx-page-${Date.now()}`;
const MIN = 60_000;
const NOW = Math.floor(Date.now() / 15_000) * 15_000;
const vm = new VictoriaQueryClient(TEST_VM_URL);

let ctx: TestContext;
let cookie: string;

const api = (method: string, url: string, payload?: object) =>
  ctx.app.inject({
    method: method as 'GET',
    url: `/api/v1${url}`,
    cookies: { wl_session: cookie },
    ...(payload ? { payload } : {}),
  });

beforeEach(async () => {
  ctx = await createTestContext();
  cookie = await setupAdmin(ctx.app);
  await ctx.db.updateTable('orgs').set({ plan: 'pro' }).execute();
});
afterEach(() => closeTestContext(ctx));
afterAll(async () => {
  await fetch(
    `${TEST_VM_URL}/api/v1/admin/tsdb/delete_series?match[]=${encodeURIComponent(`{run="${RUN}"}`)}`,
    { method: 'POST' },
  );
});

async function cluster(name: string, kind: 'kubernetes' | 'docker') {
  const res = await api('POST', '/clusters', { name, kind });
  return { id: res.json().cluster.id as string, token: res.json().token.value as string };
}

/** 30 minutes of a series, every 15 s, from `value(i)`. */
async function write(
  clusterId: string,
  name: string,
  labels: Record<string, string>,
  value: (i: number) => number,
) {
  const series: TestSeries[] = [];
  for (let i = 0, t = NOW - 30 * MIN; t <= NOW; i++, t += 15_000) {
    series.push({
      labels: { __name__: name, run: RUN, ...labels },
      value: value(i),
      timestampMs: t,
    });
  }
  await vm.write({ clusterId }, encode(series));
}

async function status(token: string, host: string, targets: object[]) {
  const r = await ctx.app.inject({
    method: 'POST',
    url: '/ingest/v1/integrations/status',
    headers: { authorization: `Bearer ${token}`, 'x-watchlog-agent': 'integrations' },
    payload: {
      host,
      mode: host ? 'docker' : 'kubernetes',
      version: 't',
      config_version: '',
      self: {},
      targets,
    },
  });
  expect(r.statusCode, r.body).toBe(204);
}

async function object(
  clusterId: string,
  kind: string,
  namespace: string,
  name: string,
  spec: object,
  st: object,
) {
  await ctx.db
    .insertInto('objects')
    .values({
      id: newId(),
      cluster_id: clusterId,
      source: 'kubernetes',
      kind,
      namespace,
      name,
      uid: newId(),
      node: 'w1',
      spec_summary: JSON.stringify(spec),
      status_summary: JSON.stringify(st),
    })
    .execute();
}

const tabOf = (id: string) => async (t: string) =>
  (await api('GET', `/applications/${id}/panels?tab=${t}`)).json().panels as {
    id: string;
    state: string;
    [k: string]: unknown;
  }[];
type Tile = { id: string; value: unknown; severity?: string; sub?: { values?: object } };

async function fire(defaultKey: string) {
  const rules = (await api('GET', '/alert-rules')).json().rules as {
    id: string;
    defaultKey: string;
    enabled: boolean;
  }[];
  const rule = rules.find((r) => r.defaultKey === defaultKey)!;
  expect(rule.enabled, defaultKey).toBe(true);
  const clock = { now: NOW - 10 * MIN };
  const worker = testWorker(ctx.db, clock, lookupEvaluator, { victoria: vm });
  for (let i = 0; i < 14; i++) {
    await worker.runCycle();
    clock.now += 30_000;
  }
  await worker.stop();
  return ctx.db
    .selectFrom('alert_states')
    .select(['labels', 'state'])
    .where('rule_id', '=', rule.id)
    .execute();
}

describe('the Nginx page', () => {
  it('reads ingress-nginx: upstreams, their endpoints and rollouts, certificates (Kubernetes)', async () => {
    const k8s = await cluster('prod', 'kubernetes');
    await object(
      k8s.id,
      'Service',
      'shop',
      'api',
      {},
      {
        ready_endpoints: 2,
        workloads: [{ kind: 'Deployment', name: 'api' }],
      },
    );
    await object(
      k8s.id,
      'Service',
      'shop',
      'cart',
      {},
      {
        ready_endpoints: 0,
        workloads: [{ kind: 'Deployment', name: 'cart' }],
      },
    );
    await ctx.db
      .insertInto('change_markers')
      .values({
        id: newId(),
        cluster_id: k8s.id,
        ts: new Date(NOW - 12 * MIN),
        kind: 'rollout',
        target: 'Deployment/shop/api',
        namespace: 'shop',
        details: JSON.stringify({ from: '3', to: '4' }),
      })
      .execute();
    const id = (
      await api('POST', '/applications', {
        clusterId: k8s.id,
        type: 'nginx',
        target: {
          kind: 'workload',
          namespace: 'ingress-nginx',
          workload_kind: 'Deployment',
          workload: 'ingress-nginx-controller',
          port: 80,
        },
        defaultAlerts: ['nginx_5xx_high', 'nginx_certificate_expiring'],
      })
    ).json().application.id as string;
    await status(k8s.token, '', [
      {
        id,
        state: 'ok',
        service_version: '1.12.1',
        product: 'ingress-nginx',
        members: [{ name: 'ingress-nginx-controller-1', up: true }],
        extra: { nginx: [{ flavour: 'ingress', metrics: true }] },
      },
    ]);
    const svc = (extra: Record<string, string> = {}) => ({
      service: id,
      service_type: 'nginx',
      member: 'ingress-nginx-controller-1',
      ...extra,
    });
    const api_ = { ingress_namespace: 'shop', ingress: 'shop', backend: 'api' };
    const cart = { ingress_namespace: 'shop', ingress: 'cart', backend: 'cart' };
    // api: 100 req/s, 10 % 503 in the last 10 minutes; cart: a few 503s (no endpoints).
    const burst = (i: number) => (i >= 80 ? 1 : 0);
    let ok = 0;
    let bad = 0;
    await Promise.all([
      write(
        k8s.id,
        'nginx_ingress_controller_requests',
        svc({ ...api_, status: '200' }),
        (i) => (ok += 1500 - 150 * burst(i)),
      ),
      write(
        k8s.id,
        'nginx_ingress_controller_requests',
        svc({ ...api_, status: '503' }),
        (i) => (bad += 150 * burst(i)),
      ),
      write(
        k8s.id,
        'nginx_ingress_controller_requests',
        svc({ ...cart, status: '503' }),
        (i) => i * 3,
      ),
      write(k8s.id, 'nginx_ingress_controller_requests', svc({ ...api_, status: '499' }), (i) => i),
      ...['0.1', '0.5', '1', '+Inf'].map((le, j) =>
        write(
          k8s.id,
          'nginx_ingress_controller_request_duration_seconds_bucket',
          svc({ ...api_, le }),
          (i) => i * [800, 1300, 1450, 1500][j]!,
        ),
      ),
      write(k8s.id, 'nginx_ingress_controller_response_size_sum', svc(api_), (i) => i * 15_000_000),
      ...(
        [
          ['active', 40],
          ['reading', 2],
          ['writing', 8],
          ['waiting', 30],
        ] as const
      ).map(([state, v]) =>
        write(
          k8s.id,
          'nginx_ingress_controller_nginx_process_connections',
          svc({ state }),
          () => v,
        ),
      ),
      write(
        k8s.id,
        'nginx_ingress_controller_nginx_process_connections_total',
        svc({ state: 'accepted' }),
        (i) => i * 100,
      ),
      write(
        k8s.id,
        'nginx_ingress_controller_nginx_process_connections_total',
        svc({ state: 'handled' }),
        (i) => i * 100 - Math.min(i, 60),
      ),
      write(
        k8s.id,
        'nginx_ingress_controller_ssl_expire_time_seconds',
        svc({ ingress_namespace: 'shop', tls_host: 'shop.example.com', secret_name: 'shop-tls' }),
        () => NOW / 1000 + 5.5 * 86_400,
      ),
      write(
        k8s.id,
        'nginx_ingress_controller_orphan_ingress',
        svc({ ingress_namespace: 'shop', ingress: 'cart', type: 'no-endpoint' }),
        () => 1,
      ),
    ]);
    await fetch(`${TEST_VM_URL}/internal/force_flush`);

    const d = (await api('GET', `/applications/${id}`)).json();
    expect(d.page.id).toBe('nginx');
    expect(d.page.tabs.map((t: { id: string }) => t.id)).toEqual([
      'overview',
      'errors',
      'latency',
      'connections',
      'connection',
    ]);
    const by = (code: string) => d.reasons.find((r: { code: string }) => r.code === code);
    expect(by('errors_high')).toMatchObject({
      severity: 'critical',
      facts: { upstream: 'shop/api', rollout: '12 min ago' },
      links: [{ kind: 'workload', id: 'shop/Deployment/api', name: 'api' }],
    });
    expect(by('upstream_no_endpoints')).toMatchObject({
      severity: 'critical',
      facts: { upstream: 'shop/cart' },
      links: [{ kind: 'workload', id: 'shop/Deployment/cart' }],
    });
    expect(by('certificate_expiring')).toMatchObject({
      facts: { host: 'shop.example.com', days: 5 },
    });
    expect(by('connections_dropped')).toBeTruthy();
    expect(by('stub_status_missing')).toBeUndefined();

    const tab = tabOf(id);
    const panel = (ps: Awaited<ReturnType<typeof tab>>, pid: string) =>
      ps.find((p) => p.id === pid)!;
    const ov = await tab('overview');
    const tiles = panel(ov, 'summary').tiles as Tile[];
    expect(tiles.find((t) => t.id === 'rps')!.value as number).toBeGreaterThan(90);
    expect(tiles.find((t) => t.id === 'upstreams')).toMatchObject({
      value: '1/2',
      severity: 'critical',
    });
    expect(tiles.find((t) => t.id === 'connections')).toMatchObject({
      value: 40,
      sub: { values: { n: 30 } },
    });
    expect(tiles.find((t) => t.id === 'bandwidth')!.value as number).toBeGreaterThan(0);
    expect((panel(ov, 'classes').series as { name: string }[]).map((s) => s.name)).toEqual([
      '2xx',
      '4xx',
      '5xx',
    ]);
    expect(
      (panel(ov, 'busiest').items as { label: string; severity?: string }[]).find(
        (x) => x.label === 'shop/cart',
      ),
    ).toMatchObject({ severity: 'critical' });

    const er = await tab('errors');
    expect((panel(er, 'codes').items as { label: string }[]).map((x) => x.label)).toEqual(
      expect.arrayContaining(['200', '503', '499']),
    );
    const bursts_ = panel(er, 'bursts').rows as { cells: string[] }[];
    expect(bursts_.some((r) => r.cells[0] === 'shop/api · during rollout')).toBe(true);

    const lat = await tab('latency');
    expect(panel(lat, 'duration').state).toBe('ok');
    expect((panel(lat, 'slowest').items as { label: string }[])[0]!.label).toBe('shop/api');

    const conn = await tab('connections');
    expect(panel(conn, 'states').state).toBe('ok');
    expect(
      (panel(conn, 'accepted').series as { points: [number, number | null][] }[])[1]!.points.some(
        ([, v]) => (v ?? 0) > 0,
      ),
    ).toBe(true);

    const list = (await api('GET', '/applications/metrics')).json().metrics[id];
    expect(list.keyMetrics.map((m: { id: string }) => m.id)).toEqual(['rps', '5xx', 'p95']);
    expect(list.keyMetrics[1].value).toBeGreaterThan(0.05);

    const firing = await fire('nginx_5xx_high');
    expect(firing).toEqual([
      expect.objectContaining({
        state: 'firing',
        labels: expect.objectContaining({
          service: id,
          service_name: 'ingress-nginx/ingress-nginx-controller',
        }),
      }),
    ]);
    expect((await fire('nginx_certificate_expiring'))[0]).toMatchObject({
      labels: expect.objectContaining({ tls_host: 'shop.example.com' }),
    });
  });

  it('reads plain Nginx in Docker from eBPF, and says how to add stub_status', async () => {
    const docker = await cluster('fleet', 'docker');
    const id = (
      await api('POST', '/applications', {
        clusterId: docker.id,
        type: 'nginx',
        target: {
          kind: 'compose',
          host: 'h1',
          compose_project: 'store',
          compose_service: 'web',
          port: 80,
        },
        defaultAlerts: ['nginx_5xx_high', 'nginx_upstream_down', 'nginx_latency_high'],
      })
    ).json().application.id as string;
    await status(docker.token, 'h1', [
      {
        id,
        state: 'ok',
        service_version: '',
        members: [{ name: 'store-web-1', up: true }],
        extra: { nginx: [{ flavour: 'plain', stub_status: '', stub_missing: 1 }] },
      },
    ]);
    const web = {
      host: 'h1',
      container: 'store-web-1',
      compose_project: 'store',
      compose_service: 'web',
    };
    const server = { ...web, port: '80' };
    const toApp = { ...web, dst_kind: 'container', dst: 'store-app-1', dst_port: '8080' };
    const toGone = { ...web, dst_kind: 'container', dst: 'store-old-1', dst_port: '8080' };
    await Promise.all([
      write(
        docker.id,
        'watchlog_http_server_requests_total',
        { ...server, code: '200', class: '2xx' },
        (i) => i * 900,
      ),
      write(
        docker.id,
        'watchlog_http_server_requests_total',
        { ...server, code: '502', class: '5xx' },
        (i) => i * 100,
      ),
      // Another port of the same container (say, its stub_status): not this service's.
      write(
        docker.id,
        'watchlog_http_server_requests_total',
        { ...web, port: '8081', code: '500', class: '5xx' },
        (i) => i * 5000,
      ),
      ...['0.25', '1', '2.5', '+Inf'].map((le, j) =>
        write(
          docker.id,
          'watchlog_http_server_request_duration_seconds_bucket',
          { ...server, le },
          (i) => i * [100, 200, 990, 1000][j]!,
        ),
      ),
      write(
        docker.id,
        'watchlog_http_requests_total',
        { ...toApp, code: '200', class: '2xx' },
        (i) => i * 900,
      ),
      write(
        docker.id,
        'watchlog_http_requests_total',
        { ...toApp, code: '502', class: '5xx' },
        (i) => i * 100,
      ),
      write(docker.id, 'watchlog_flow_connections_total', toApp, (i) => i * 10),
      write(docker.id, 'watchlog_flow_connect_failed_total', toApp, () => 0),
      write(docker.id, 'watchlog_flow_connections_total', toGone, (i) => i * 4),
      write(docker.id, 'watchlog_flow_connect_failed_total', toGone, (i) => i * 4),
    ]);
    await fetch(`${TEST_VM_URL}/internal/force_flush`);

    const d = (await api('GET', `/applications/${id}`)).json();
    const by = (code: string) => d.reasons.find((r: { code: string }) => r.code === code);
    expect(by('errors_high')).toMatchObject({
      severity: 'critical',
      facts: { pct: 10, upstream: 'store-app-1:8080' },
    });
    expect(by('stub_status_missing').facts.command).toContain('stub_status;');
    expect(by('upstream_no_endpoints')).toMatchObject({
      facts: { upstream: 'store-old-1:8080' },
      links: [{ kind: 'container', id: 'store-old-1' }],
    });
    expect(by('latency_high')).toBeTruthy();

    const tab = tabOf(id);
    const panel = (ps: Awaited<ReturnType<typeof tab>>, pid: string) =>
      ps.find((p) => p.id === pid)!;
    const tiles = panel(await tab('overview'), 'summary').tiles as Tile[];
    expect(tiles.find((t) => t.id === 'rps')!.value as number).toBeCloseTo(66.7, 0);
    expect(tiles.find((t) => t.id === '5xx')!.value as number).toBeCloseTo(0.1, 2);
    expect(tiles.find((t) => t.id === 'upstreams')).toMatchObject({ value: '1/2' });
    const conn = await tab('connections');
    expect(panel(conn, 'states')).toMatchObject({
      state: 'needs_permission',
      missing: { key: 'integrations.nginx.panels.missingStubStatus' },
    });
    const er = await tab('errors');
    expect((panel(er, 'by-upstream').series as { name: string }[]).map((s) => s.name)).toEqual([
      'store-app-1:8080',
    ]);

    const list = (await api('GET', '/applications/metrics')).json().metrics[id];
    expect(list.keyMetrics[0].value).toBeCloseTo(66.7, 0);
    expect(list.spark.length).toBeGreaterThan(0);

    // The rules see the eBPF series as this service's.
    expect(await fire('nginx_5xx_high')).toEqual([
      expect.objectContaining({
        state: 'firing',
        labels: expect.objectContaining({ service: id, service_name: 'store/web' }),
      }),
    ]);
    expect(await fire('nginx_upstream_down')).toEqual([
      expect.objectContaining({
        labels: expect.objectContaining({ service: id, dst: 'store-old-1' }),
      }),
    ]);

    // A rule for every Nginx, in every cluster: it sees this one; a type the metric
    // isn't, or both a service and a type, are refused.
    const every = {
      name: 'Every Nginx 5xx',
      metric: 'nginx.5xx.ratio',
      clusterId: null,
      scope: { serviceType: 'nginx' },
      condition: { op: '>', value: 0.05 },
      forSeconds: 0,
      severity: 'critical',
      channelIds: [],
    };
    const created = await api('POST', '/alert-rules', every);
    expect(created.statusCode, created.body).toBe(201);
    expect(
      (await api('POST', '/alert-rules', { ...every, scope: { serviceType: 'redis' } })).json()
        .detail,
    ).toBe('nginx.5xx.ratio is not a redis metric');
    expect(
      (
        await api('POST', '/alert-rules', {
          ...every,
          scope: { serviceType: 'nginx', service: id },
        })
      ).json().detail,
    ).toBe('A rule is about one service or every service of a type, not both');
    const reach = await api('POST', '/alert-rules', {
      ...every,
      name: 'Every Redis reachable',
      metric: 'service.reachable.ratio',
      scope: { serviceType: 'redis' },
      condition: { op: '<', value: 1 },
    });
    expect(reach.statusCode).toBe(201);
    const typeRule = (
      await ctx.db
        .selectFrom('alert_rules')
        .select('id')
        .where('name', '=', 'Every Nginx 5xx')
        .executeTakeFirstOrThrow()
    ).id;
    const clock = { now: NOW - 2 * MIN };
    const worker = testWorker(ctx.db, clock, lookupEvaluator, { victoria: vm });
    for (let i = 0; i < 3; i++) {
      await worker.runCycle();
      clock.now += 30_000;
    }
    await worker.stop();
    expect(
      await ctx.db
        .selectFrom('alert_states')
        .select(['labels', 'state'])
        .where('rule_id', '=', typeRule)
        .execute(),
    ).toEqual([
      expect.objectContaining({
        state: 'firing',
        labels: expect.objectContaining({ service: id, service_name: 'store/web' }),
      }),
    ]);

    // Once stub_status is found, the Connections tab fills and the hint goes.
    await status(docker.token, 'h1', [
      {
        id,
        state: 'ok',
        members: [{ name: 'store-web-1', up: true }],
        extra: { nginx: [{ flavour: 'plain', stub_status: ':8080/stub_status', stub_missing: 0 }] },
      },
    ]);
    const svc = { service: id, service_type: 'nginx', member: 'store-web-1' };
    await Promise.all([
      write(docker.id, 'watchlog_nginx_connections_active', svc, () => 12),
      ...['reading', 'writing', 'waiting'].map((state, j) =>
        write(docker.id, 'watchlog_nginx_connections', { ...svc, state }, () => [1, 3, 8][j]!),
      ),
      write(docker.id, 'watchlog_nginx_connections_accepted_total', svc, (i) => i * 10),
      write(docker.id, 'watchlog_nginx_connections_handled_total', svc, (i) => i * 10),
    ]);
    await fetch(`${TEST_VM_URL}/internal/force_flush`);
    const after = (await api('GET', `/applications/${id}`)).json();
    expect(after.reasons.map((r: { code: string }) => r.code)).not.toContain('stub_status_missing');
    expect(panel(await tab('connections'), 'states').state).toBe('ok');
    const t2 = panel(await tab('overview'), 'summary').tiles as Tile[];
    expect(t2.find((t) => t.id === 'connections')).toMatchObject({
      value: 12,
      sub: { values: { n: 8 } },
    });
  });

  it('says how to turn on ingress-nginx metrics, Helm or not, and uses eBPF meanwhile', async () => {
    const k8s = await cluster('prod', 'kubernetes');
    await object(
      k8s.id,
      'Pod',
      'ingress-nginx',
      'ingress-nginx-controller-abc',
      {
        workload: { kind: 'Deployment', name: 'ingress-nginx-controller' },
        labels: { 'app.kubernetes.io/instance': 'edge', 'app.kubernetes.io/managed-by': 'Helm' },
      },
      { pod_ip: '10.244.0.9', phase: 'Running' },
    );
    const id = (
      await api('POST', '/applications', {
        clusterId: k8s.id,
        type: 'nginx',
        target: {
          kind: 'workload',
          namespace: 'ingress-nginx',
          workload_kind: 'Deployment',
          workload: 'ingress-nginx-controller',
          port: 80,
        },
      })
    ).json().application.id as string;
    await status(k8s.token, '', [
      {
        id,
        state: 'ok',
        product: 'ingress-nginx',
        members: [{ name: 'ingress-nginx-controller-abc', up: true }],
        extra: { nginx: [{ flavour: 'ingress', metrics: false }] },
      },
    ]);
    await write(
      k8s.id,
      'watchlog_http_server_requests_total',
      {
        namespace: 'ingress-nginx',
        workload_kind: 'Deployment',
        workload: 'ingress-nginx-controller',
        port: '80',
        code: '200',
        class: '2xx',
      },
      (i) => i * 150,
    );
    await fetch(`${TEST_VM_URL}/internal/force_flush`);
    const d = (await api('GET', `/applications/${id}`)).json();
    expect(
      d.reasons.find((r: { code: string }) => r.code === 'ingress_metrics_off').facts.command,
    ).toBe(
      'helm upgrade edge ingress-nginx/ingress-nginx -n ingress-nginx --reuse-values --set controller.metrics.enabled=true',
    );
    const ov = await tabOf(id)('overview');
    const tiles = ov.find((p) => p.id === 'summary')!.tiles as Tile[];
    expect(tiles.find((t) => t.id === 'rps')!.value as number).toBeCloseTo(10, 0);
    // No 5xx at all is 0 %, on the page and in the list (not "—").
    expect(tiles.find((t) => t.id === '5xx')!.value).toBe(0);
    const row = (await api('GET', '/applications/metrics')).json().metrics[id];
    expect(row.keyMetrics.find((m: { id: string }) => m.id === '5xx').value).toBe(0);
    expect((await tabOf(id)('connections'))[0]).toMatchObject({
      state: 'needs_permission',
      missing: { key: 'integrations.nginx.panels.missingIngressMetrics' },
    });
  });
});

describe('error bursts', () => {
  it('finds periods at 5 % 5xx or more, and says when a rollout came just before', () => {
    const w = { start: 0, end: 600, step: 60 };
    const out = bursts(
      [
        {
          name: 'shop/api',
          points: [
            [0, 0],
            [60, 0.2],
            [120, 0.08],
            [180, 0.01],
            [240, 0.06],
            [300, null],
          ],
        },
        { name: 'shop/cart', points: [[0, 0.01]] },
      ],
      w,
      new Map([['shop/api', [30]]]),
    );
    expect(out).toEqual([
      { upstream: 'shop/api', start: 240, end: 300, peak: 0.06, rollout: true },
      { upstream: 'shop/api', start: 60, end: 180, peak: 0.2, rollout: true },
    ]);
  });
});
