// SPDX-License-Identifier: AGPL-3.0-only
// Healthy needs data (0.10.1): a connected service with no key number isn't Healthy, it has
// no metrics, with the one step that fixes it; on Kubernetes and on servers alike (ADR-124).
// And the cause of the dashes seen on a server's Nginx: its eBPF series weren't selected for
// a service installed on the server (target kind native).
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authorisedScope, VictoriaQueryClient } from '../src/lib/victoria.js';
import { nginxSource, sourceMatchers } from '../src/modules/query/nginx.js';
import { hasKeyData, needsData, NO_DATA_GRACE_MS } from '../src/modules/integrations/service.js';
import {
  TEST_VM_URL,
  closeTestContext,
  createTestContext,
  setupAdmin,
  type TestContext,
} from './helpers.js';
import { encode, type TestSeries } from './support/remote-write.js';

const NOW = Date.UTC(2026, 10, 20, 12);
const connected = {
  health: 'ok' as const,
  reason: { code: 'connected', facts: { up: 1, members: 1 } },
};
const old = new Date(NOW - 60 * 60_000);

describe('needsData', () => {
  it('a connected service without key numbers has no metrics, with the collector log as the step', () => {
    expect(
      needsData(connected, false, { monitoredSince: old, kind: 'server', host: 'web-1' }, NOW),
    ).toEqual({
      health: 'unknown',
      reason: {
        code: 'no_metrics',
        facts: {
          hint: null,
          command: 'journalctl -u watchlog-integrations -n 50',
          kind: 'server',
          host: 'web-1',
        },
      },
    });
    expect(
      needsData(connected, false, { monitoredSince: old, kind: 'kubernetes', host: null }, NOW)
        .reason.facts,
    ).toMatchObject({
      kind: 'kubernetes',
      host: null,
      command: 'kubectl -n watchlog logs -l app.kubernetes.io/component=integrations --tail 50',
    });
  });

  it('a hint that brings no numbers back (query statistics) is not the step', () => {
    const hint = { code: 'statements_unavailable', facts: {} };
    expect(
      needsData(connected, false, { monitoredSince: old, kind: 'server', host: 'h', hint }, NOW)
        .reason.facts,
    ).toMatchObject({ hint: null, command: 'journalctl -u watchlog-integrations -n 50' });
  });

  it("names the integration's own hint and its command when it has one", () => {
    const hint = { code: 'stub_status_missing', facts: { command: 'location /stub_status {…}' } };
    expect(
      needsData(connected, false, { monitoredSince: old, kind: 'server', host: 'h', hint }, NOW)
        .reason.facts,
    ).toMatchObject({ hint: 'stub_status_missing', command: 'location /stub_status {…}' });
  });

  it('keeps Healthy with data, when the store cannot say, and leaves other states alone', () => {
    const ctx = { monitoredSince: old, kind: 'server', host: 'h' };
    expect(needsData(connected, true, ctx, NOW)).toBe(connected);
    expect(needsData(connected, undefined, ctx, NOW)).toBe(connected);
    const down = { health: 'critical' as const, reason: { code: 'unreachable', facts: {} } };
    expect(needsData(down, false, ctx, NOW)).toBe(down);
    const some = { health: 'warning' as const, reason: { code: 'connected', facts: {} } };
    expect(needsData(some, false, ctx, NOW)).toBe(some);
  });

  it('just connected: still waiting, not "no metrics", for the first five minutes', () => {
    const recent = new Date(NOW - NO_DATA_GRACE_MS + 1000);
    expect(
      needsData(connected, false, { monitoredSince: recent, kind: 'server', host: 'h' }, NOW),
    ).toEqual({ health: 'unknown', reason: { code: 'waiting', facts: {} } });
  });

  it('hasKeyData: any key number with a value', () => {
    const k = (...v: (number | null)[]) => ({ keyMetrics: v.map((value) => ({ value })) });
    expect(hasKeyData(k(null, null, null))).toBe(false);
    expect(hasKeyData(k(null, 0, null))).toBe(true);
    expect(hasKeyData(k(Number.NaN))).toBe(false);
    expect(hasKeyData(undefined)).toBe(false);
  });
});

describe("a server's Nginx: its eBPF series", () => {
  it('selects a service installed on a server by its host, unit and port', () => {
    const target = {
      kind: 'native' as const,
      host: 'ubuntu-8gb-nbg1-1',
      source: 'service' as const,
      workload: 'nginx.service',
      port: 80,
    };
    expect(sourceMatchers(target)).toBe(
      'host="ubuntu-8gb-nbg1-1",workload_kind="Service",workload="nginx.service"',
    );
    expect(nginxSource({ id: 'a', target, status_details: {} }).server).toBe(
      'host="ubuntu-8gb-nbg1-1",workload_kind="Service",workload="nginx.service",port="80"',
    );
    expect(sourceMatchers({ ...target, source: 'process', workload: 'nginx' })).toBe(
      'host="ubuntu-8gb-nbg1-1",workload_kind="ProcessGroup",workload="nginx"',
    );
  });
});

describe('the Applications API', () => {
  const RUN = `needs-data-${Date.now()}`;
  const MIN = 60_000;
  const T = Math.floor(Date.now() / 15_000) * 15_000;
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
  });
  afterEach(() => closeTestContext(ctx));
  afterAll(async () => {
    await fetch(
      `${TEST_VM_URL}/api/v1/admin/tsdb/delete_series?match[]=${encodeURIComponent(`{run="${RUN}"}`)}`,
      { method: 'POST' },
    );
  });

  async function cluster(name: string, kind: 'kubernetes' | 'server') {
    const res = await api('POST', '/clusters', { name, kind });
    return { id: res.json().cluster.id as string, token: res.json().token.value as string };
  }
  async function write(
    clusterId: string,
    name: string,
    labels: Record<string, string>,
    value: (i: number) => number,
  ) {
    const series: TestSeries[] = [];
    for (let i = 0, t = T - 30 * MIN; t <= T; i++, t += 15_000) {
      series.push({
        labels: { __name__: name, run: RUN, ...labels },
        value: value(i),
        timestampMs: t,
      });
    }
    await vm.write(authorisedScope(clusterId), encode(series));
  }
  async function status(token: string, host: string, targets: object[]) {
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/integrations/status',
      headers: { authorization: `Bearer ${token}`, 'x-watchlog-agent': 'integrations' },
      payload: {
        host,
        mode: host ? 'server' : 'kubernetes',
        version: 't',
        config_version: '',
        self: {},
        targets,
      },
    });
    expect(r.statusCode, r.body).toBe(204);
  }
  /** Monitored an hour ago, past the first minutes' grace. */
  const age = (id: string) =>
    ctx.db
      .updateTable('integrations')
      .set({ monitored_since: new Date(Date.now() - 60 * MIN) })
      .where('id', '=', id)
      .execute();

  const NATIVE = {
    kind: 'native',
    host: 'srv-1',
    source: 'service',
    workload: 'nginx.service',
    port: 80,
  };
  async function nativeNginx(stub = '') {
    const fleet = await cluster('fleet', 'server');
    // The agent saw it listen: what Monitor checks a server's target against.
    await write(
      fleet.id,
      'watchlog_listen_info',
      { host: 'srv-1', source: 'service', workload: 'nginx.service', proto: 'tcp', port: '80' },
      () => 1,
    );
    await fetch(`${TEST_VM_URL}/internal/force_flush`);
    const created = await api('POST', '/applications', {
      clusterId: fleet.id,
      type: 'nginx',
      target: NATIVE,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().application.id as string;
    await status(fleet.token, 'srv-1', [
      {
        id,
        state: 'ok',
        service_version: '',
        members: [{ name: 'nginx.service', up: true }],
        extra: { nginx: [{ flavour: 'plain', stub_status: stub, stub_missing: stub ? 0 : 1 }] },
      },
    ]);
    await age(id);
    return { fleet, id };
  }

  it('a server Nginx with no numbers: No metrics, with stub_status as the step, on the list and the page', async () => {
    const { id } = await nativeNginx();
    const list = (await api('GET', '/applications')).json().applications;
    expect(list[0]).toMatchObject({
      id,
      health: 'unknown',
      reason: {
        code: 'no_metrics',
        facts: { hint: 'stub_status_missing', kind: 'server', host: 'srv-1' },
      },
    });
    expect(list[0].reason.facts.command).toContain('stub_status;');
    const d = (await api('GET', `/applications/${id}`)).json();
    expect(d.application.health).toBe('unknown');
    const codes = d.reasons.map((r: { code: string }) => r.code);
    expect(codes[0]).toBe('no_metrics');
    // The hint is the step of No metrics, not said twice.
    expect(codes).not.toContain('stub_status_missing');
  });

  it("reads a server Nginx's requests from its unit's eBPF series, and it is Healthy", async () => {
    const { fleet, id } = await nativeNginx();
    const server = {
      host: 'srv-1',
      workload_kind: 'Service',
      workload: 'nginx.service',
      port: '80',
    };
    await Promise.all([
      write(
        fleet.id,
        'watchlog_http_server_requests_total',
        { ...server, code: '200', class: '2xx' },
        (i) => i * 60,
      ),
      // Port 443's TLS isn't readable; another unit's port 80 isn't this one's.
      write(
        fleet.id,
        'watchlog_http_server_requests_total',
        { ...server, workload: 'apache2.service', code: '500', class: '5xx' },
        (i) => i * 6000,
      ),
      ...['0.005', '0.05', '+Inf'].map((le, j) =>
        write(
          fleet.id,
          'watchlog_http_server_request_duration_seconds_bucket',
          { ...server, le },
          (i) => i * [50, 59, 60][j]!,
        ),
      ),
    ]);
    await fetch(`${TEST_VM_URL}/internal/force_flush`);
    const m = (await api('GET', '/applications/metrics')).json().metrics[id];
    const key = Object.fromEntries(
      m.keyMetrics.map((k: { id: string; value: number }) => [k.id, k.value]),
    );
    expect(key.rps).toBeCloseTo(4, 1);
    expect(key['5xx']).toBe(0);
    expect(key.p95).toBeGreaterThan(0);
    const list = (await api('GET', '/applications')).json().applications;
    expect(list[0]).toMatchObject({ id, health: 'ok', reason: { code: 'connected' } });
  });

  it('an HTTPS-only server Nginx with stub_status: its active connections are its number', async () => {
    const { fleet, id } = await nativeNginx(':80/nginx_status');
    await write(
      fleet.id,
      'watchlog_nginx_connections_active',
      { service: id, service_type: 'nginx', member: 'nginx.service' },
      () => 7,
    );
    await fetch(`${TEST_VM_URL}/internal/force_flush`);
    const m = (await api('GET', '/applications/metrics')).json().metrics[id];
    expect(m.keyMetrics).toEqual([
      {
        id: 'connections',
        labelKey: 'integrations.nginx.panels.connections',
        value: 7,
        unit: 'count',
      },
    ]);
    expect((await api('GET', '/applications')).json().applications[0].health).toBe('ok');
  });

  it('Kubernetes: a connected Redis with no numbers has no metrics; the step is the collector log', async () => {
    const kube = await cluster('prod', 'kubernetes');
    const id = (
      await api('POST', '/applications', {
        clusterId: kube.id,
        type: 'redis',
        target: {
          kind: 'workload',
          namespace: 'shop',
          workload_kind: 'StatefulSet',
          workload: 'redis',
          port: 6379,
        },
      })
    ).json().application.id as string;
    await status(kube.token, '', [
      { id, state: 'ok', service_version: '7.2', members: [{ name: 'redis-0', up: true }] },
    ]);
    await age(id);
    const list = (await api('GET', '/applications')).json().applications;
    expect(list[0]).toMatchObject({
      health: 'unknown',
      reason: { code: 'no_metrics', facts: { hint: null, kind: 'kubernetes' } },
    });
  });
});
