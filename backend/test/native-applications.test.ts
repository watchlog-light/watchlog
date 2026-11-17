// SPDX-License-Identifier: AGPL-3.0-only
// Applications on servers (ADR-212): services installed on a server found from the agents'
// listening sockets and process groups (names as measured on Ubuntu 24.04, Debian 12 and
// Rocky 9 in 0.9 slice 1), monitored by the server's own collector on loopback; and the
// PHP-FPM integration's page, reasons and list numbers on VictoriaMetrics.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kindOfImage, kindOfNative } from '../src/modules/integrations/discovery.js';
import { closeTestContext, createTestContext, setupAdmin, type TestContext } from './helpers.js';
import { addCluster, deleteTestSeries } from './support/mcp-fixtures.js';
import type { TestSeries } from './support/remote-write.js';

afterAll(deleteTestSeries);

const HOST = 'app-1';

function gauge(name: string, labels: Record<string, string>, value: number): TestSeries[] {
  const end = Math.floor(Date.now() / 15_000) * 15_000 - 30_000;
  return Array.from({ length: 40 }, (_, i) => ({
    labels: { __name__: name, host: HOST, ...labels },
    value,
    timestampMs: end - (39 - i) * 15_000,
  }));
}

function counter(name: string, labels: Record<string, string>, rate: number): TestSeries[] {
  const now = Math.floor(Date.now() / 15_000) * 15_000;
  const out: TestSeries[] = [];
  for (let i = 0, t = now - 20 * 60_000; t <= now; i++, t += 15_000) {
    out.push({ labels: { __name__: name, ...labels }, value: i * 15 * rate, timestampMs: t });
  }
  return out;
}

describe('what a server runs, by name', () => {
  it.each([
    ['postgresql@16-main.service', 'postgres'],
    ['postgresql-16.service', 'postgres'],
    ['postgres', 'postgres'],
    ['mariadb.service', 'mysql'],
    ['mysqld', 'mysql'],
    ['redis-server.service', 'redis'],
    ['valkey', 'redis'],
    ['mongod.service', 'mongodb'],
    ['rabbitmq-server.service', 'rabbitmq'],
    ['nginx.service', 'nginx'],
    ['traefik', 'traefik'],
    ['php8.3-fpm.service', 'php-fpm'],
    ['php-fpm.service', 'php-fpm'],
    ['pool www', 'php-fpm'],
  ])('%s is %s', (name, type) => {
    expect(kindOfNative(name)?.type).toBe(type);
  });

  it('tells PHP-FPM images by their tag', () => {
    expect(kindOfImage('php:8.3-fpm-alpine')?.type).toBe('php-fpm');
    expect(kindOfImage('bitnami/php-fpm:8.3')?.type).toBe('php-fpm');
    expect(kindOfImage('php:8.3-apache')).toBeUndefined();
    expect(kindOfImage('php:8.3-cli')).toBeUndefined();
  });
});

describe('Applications on servers', () => {
  let ctx: TestContext;
  let cookie: string;

  beforeEach(async () => {
    ctx = await createTestContext();
    cookie = await setupAdmin(ctx.app);
  });
  afterEach(() => closeTestContext(ctx));

  const api = (method: string, url: string, payload?: object) =>
    ctx.app.inject({
      method: method as 'GET',
      url: `/api/v1${url}`,
      cookies: { wl_session: cookie },
      ...(payload ? { payload } : {}),
    });

  it('discovers installed services, monitors one on loopback, and fills the PHP-FPM page', async () => {
    const fleet = await addCluster(ctx, cookie, 'acme-servers', 'server');
    const listen = (source: string, workload: string, port: number) =>
      gauge('watchlog_listen_info', { source, workload, proto: 'tcp', port: String(port) }, 1);
    await fleet.write(
      [
        ...listen('service', 'postgresql@16-main.service', 5432),
        ...listen('service', 'mariadb.service', 3306),
        ...listen('service', 'redis-server.service', 6379),
        ...listen('service', 'nginx.service', 80),
        ...listen('service', 'nginx.service', 443),
        // A container's published port, held by the runtime: the container's own discovery.
        ...listen('service', 'docker.service', 8080),
        // An app on a port no service type owns: nothing to offer.
        ...listen('process', 'api', 3000),
        // PHP-FPM on a socket only: offered on the status listener the docs set up.
        ...gauge(
          'watchlog_process_group_instances',
          { group: 'pool www', unit: 'php8.3-fpm.service', by: 'php-fpm' },
          5,
        ),
      ],
      HOST,
    );
    const found = (await api('GET', '/applications/discovered')).json().discovered as {
      type: string;
      name: string;
      port: number;
      product: string | null;
      host: string;
      target: Record<string, unknown>;
    }[];
    const names = found.map((d) => `${d.type} ${d.name}:${d.port}`).sort();
    expect(names).toEqual([
      'mysql app-1/mariadb.service:3306',
      'nginx app-1/nginx.service:80',
      'php-fpm app-1/pool www:9001',
      'postgres app-1/postgresql@16-main.service:5432',
      'redis app-1/redis-server.service:6379',
    ]);
    expect(found.find((d) => d.type === 'mysql')!.product).toBe('mariadb');
    const php = found.find((d) => d.type === 'php-fpm')!;
    expect(php.target).toEqual({
      kind: 'native',
      host: HOST,
      source: 'process',
      workload: 'pool www',
      port: 9001,
    });

    // Monitor: the server's own collector reads it on loopback.
    const created = await api('POST', '/applications', {
      clusterId: fleet.id,
      type: 'php-fpm',
      target: php.target,
    });
    expect(created.statusCode, created.body).toBe(201);
    const app = created.json().application;
    expect(app).toMatchObject({
      name: 'app-1/pool www',
      where: { host: HOST, address: '127.0.0.1:9001' },
    });
    const config = await ctx.app.inject({
      method: 'GET',
      url: `/ingest/v1/integrations/config?host=${HOST}`,
      headers: {
        authorization: `Bearer ${fleet.token}`,
        'x-watchlog-agent': `integrations:${HOST}`,
      },
    });
    expect(config.json().targets).toEqual([
      expect.objectContaining({
        type: 'php-fpm',
        members: [{ name: 'pool www', address: '127.0.0.1:9001' }],
      }),
    ]);
    // Monitored: no longer offered.
    const again = (await api('GET', '/applications/discovered')).json().discovered;
    expect(again.map((d: { type: string }) => d.type)).not.toContain('php-fpm');

    // The pool ran out of workers: its page and reasons say so.
    const svc = { service: app.id, service_type: 'php-fpm', member: 'pool www', pool: 'www' };
    await fleet.write(
      [
        ...gauge('watchlog_phpfpm_processes', { ...svc, state: 'active' }, 19),
        ...gauge('watchlog_phpfpm_processes', { ...svc, state: 'idle' }, 1),
        ...gauge('watchlog_phpfpm_listen_queue', svc, 4),
        ...counter('watchlog_phpfpm_accepted_connections_total', svc, 12),
        ...counter('watchlog_phpfpm_max_children_reached_total', svc, 0.05),
        ...gauge('watchlog_phpfpm_request_duration_seconds', { ...svc, quantile: '0.95' }, 1.8),
      ],
      HOST,
    );
    const status = (state: string, extra: object = {}) =>
      ctx.app.inject({
        method: 'POST',
        url: '/ingest/v1/integrations/status',
        headers: {
          authorization: `Bearer ${fleet.token}`,
          'x-watchlog-agent': `integrations:${HOST}`,
        },
        payload: {
          host: HOST,
          mode: 'server',
          version: '0.9.0',
          config_version: 'x',
          self: {},
          targets: [{ id: app.id, state, ...extra }],
        },
      });
    expect((await status('ok', { members: [{ name: 'pool www', up: true }] })).statusCode).toBe(
      204,
    );
    const detail = (await api('GET', `/applications/${app.id}`)).json();
    expect(detail.page.id).toBe('php-fpm');
    expect(detail.reasons.map((r: { code: string }) => r.code)).toContain('phpfpm_max_children');
    const panels = (
      await api('GET', `/applications/${app.id}/panels?tab=overview&range=3600`)
    ).json();
    const tiles = Object.fromEntries(
      panels.panels[0].tiles.map((t: { id: string; value: unknown }) => [t.id, t.value]),
    );
    expect(tiles.busy).toBe('19/20');
    expect(tiles.queue).toBe(4);
    expect(tiles.rps).toBeCloseTo(12, 0);
    expect(tiles.reached).toBeGreaterThanOrEqual(30);
    const metrics = (await api('GET', '/applications/metrics')).json().metrics[app.id];
    expect(metrics.keyMetrics.map((m: { id: string; value: number }) => m.id)).toEqual([
      'busy',
      'rps',
      'queue',
    ]);
    expect(metrics.keyMetrics[0].value).toBeCloseTo(0.95, 2);

    // The catalog keys the default rules use, on the same series.
    const now = Math.floor(Date.now() / 1000);
    const last = async (metric: string) => {
      const r = await api('POST', '/query/range', {
        clusterId: fleet.id,
        metric,
        scope: { service: app.id },
        from: now - 300,
        to: now,
      });
      expect(r.statusCode, r.body).toBe(200);
      const pts = (r.json().series[0]?.points ?? []) as [number, number | null][];
      return pts.filter((x) => x[1] !== null).at(-1)?.[1] ?? null;
    };
    expect(await last('php-fpm.processes.busy_ratio')).toBeCloseTo(0.95, 2);
    expect(await last('php-fpm.listen_queue')).toBe(4);
    expect(await last('php-fpm.max_children_reached.increase')).toBeGreaterThan(0);
    expect(await last('php-fpm.request.duration.p95')).toBeCloseTo(1.8, 1);

    // Without the status page (another pool, on its TCP port): the page and reasons say how
    // to turn it on. (A service's findings are cached 15 s, so not the same service.)
    const second = (
      await api('POST', '/applications', {
        clusterId: fleet.id,
        type: 'php-fpm',
        target: {
          kind: 'native',
          host: HOST,
          source: 'service',
          workload: 'php8.3-fpm.service',
          port: 9000,
        },
      })
    ).json().application;
    await ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/integrations/status',
      headers: {
        authorization: `Bearer ${fleet.token}`,
        'x-watchlog-agent': `integrations:${HOST}`,
      },
      payload: {
        host: HOST,
        mode: 'server',
        version: '0.9.0',
        config_version: 'x',
        self: {},
        targets: [
          {
            id: second.id,
            state: 'ok',
            members: [
              {
                name: 'php8.3-fpm.service',
                up: true,
                error: 'the status page is off: set pm.status_path',
              },
            ],
            permissions: [{ tab: 'overview', missing: 'pm.status_path' }],
          },
        ],
      },
    });
    const off = (await api('GET', `/applications/${second.id}`)).json();
    expect(
      off.reasons.map((r: { code: string }) => r.code),
      JSON.stringify(off.reasons),
    ).toContain('phpfpm_status_off');
    const offPanels = (
      await api('GET', `/applications/${second.id}/panels?tab=overview&range=3600`)
    ).json();
    expect(offPanels.panels[0], JSON.stringify(offPanels.panels[0])).toMatchObject({
      state: 'needs_permission',
      missing: { key: 'integrations.php-fpm.missing.overview' },
    });
  });
});
