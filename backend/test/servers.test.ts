// SPDX-License-Identifier: AGPL-3.0-only
// Server fleets' pages (ADR-207): the servers, a server with its workloads of the three
// sources, and one workload with its last hour of exits, on series shaped as the 0.9 agent
// sends them (measured on Ubuntu 24.04 and Rocky 9 in slice 1) and a container snapshot.
import { gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crashLoopSince } from '../src/modules/servers/routes.js';
import {
  assembleWorkloads,
  isSystemUnit,
  parseWorkloadId,
} from '../src/modules/servers/workloads.js';
import {
  closeTestContext,
  createTestContext,
  setupAdmin,
  TEST_VM_URL,
  type TestContext,
} from './helpers.js';
import { encode, type TestSeries } from './support/remote-write.js';

const RUN = `srv-${Date.now()}`;
const HOST = 'app-1';

afterAll(async () => {
  await fetch(
    `${TEST_VM_URL}/api/v1/admin/tsdb/delete_series?match[]=${encodeURIComponent(`{run="${RUN}"}`)}`,
    { method: 'POST' },
  );
});

describe('workload assembly', () => {
  const s = (labels: Record<string, string>, v: number) => ({
    labels,
    points: [[0, v]] as [number, number][],
  });
  const empty = {
    serviceState: [],
    serviceCpu: [],
    serviceMemory: [],
    serviceMemoryLimit: [],
    serviceRestarts10m: [],
    serviceRestarts24h: [],
    serviceFailedExits10m: [],
    serviceOom10m: [],
    serviceLastExit: [],
    groupInstances: [],
    groupCpu: [],
    groupMemory: [],
    groupFailedExits10m: [],
    groupFailedExits24h: [],
    groupOom10m: [],
    listen: [],
    containerCpu: [],
    containerRestarts24h: [],
  };

  it('names the three sources, their problems and ports, problems first', () => {
    const by = assembleWorkloads(
      {
        ...empty,
        serviceState: [
          s({ host: HOST, unit: 'nginx.service', state: 'active', sub: 'running' }, 1),
          s({ host: HOST, unit: 'billing.service', state: 'failed', sub: 'failed' }, 1),
          s({ host: HOST, unit: 'ssh.service', state: 'active', sub: 'running' }, 1),
        ],
        serviceLastExit: [s({ host: HOST, unit: 'billing.service' }, 3)],
        groupInstances: [
          s({ host: HOST, unit: 'pm2-app.service', group: 'api', by: 'pm2' }, 4),
          s({ host: HOST, unit: '', group: 'billing.jar', by: 'java' }, 1),
        ],
        groupFailedExits10m: [s({ host: HOST, group: 'api' }, 5)],
        listen: [
          s({ host: HOST, source: 'service', workload: 'nginx.service', port: '443' }, 1),
          s({ host: HOST, source: 'service', workload: 'nginx.service', port: '80' }, 1),
          s({ host: HOST, source: 'process', workload: 'api', port: '3000' }, 1),
        ],
      },
      [
        {
          node: HOST,
          name: 'redis',
          status: { state: 'running', health: 'healthy' },
          memoryBytes: 1,
          memoryLimitBytes: null,
          ports: [6379],
          compose: 'app',
        },
      ],
    );
    const list = by.get(HOST)!;
    expect(
      list
        .map((w) => w.id)
        .slice(0, 2)
        .sort(),
    ).toEqual(['process:api', 'service:billing.service']);
    const get = (id: string) => list.find((w) => w.id === id)!;
    expect(get('service:billing.service').problem).toEqual({
      kind: 'failed',
      severity: 'critical',
      code: 3,
    });
    expect(get('process:api')).toMatchObject({
      unit: 'pm2-app.service',
      note: 'pm2',
      instances: 4,
      ports: [3000],
      problem: { kind: 'crash_looping' },
    });
    expect(get('service:nginx.service')).toMatchObject({
      state: 'active · running',
      ports: [80, 443],
    });
    expect(get('process:billing.jar').unit).toBeNull();
    expect(get('container:redis')).toMatchObject({
      note: 'compose:app',
      state: 'running · healthy',
      problem: null,
    });
    expect(get('service:ssh.service').system).toBe(true);
    expect(get('service:nginx.service').system).toBe(false);
  });

  it('parses workload ids and knows the OS services', () => {
    expect(parseWorkloadId('process:pool www')).toEqual({ source: 'process', name: 'pool www' });
    expect(parseWorkloadId('pod:x')).toBeNull();
    expect(parseWorkloadId('service:')).toBeNull();
    expect(isSystemUnit('systemd-journald.service')).toBe(true);
    expect(isSystemUnit('watchlog-agent.service')).toBe(true);
    expect(isSystemUnit('orders.service')).toBe(false);
  });

  it('dates a crash loop from its first crash, and only while it lasts', () => {
    const pts = (crashes: number[]) => crashes.map((c, i) => [1000 + i * 60, c, 0, 0, 0]);
    expect(crashLoopSince(pts([0, 0, 1, 0, 1, 1, 1, 1]))).toBe(1000 + 2 * 60);
    expect(crashLoopSince(pts([1, 1, 1, ...Array(12).fill(0)]))).toBeNull();
    expect(crashLoopSince(pts([0, 0, 0]))).toBeNull();
  });
});

describe('Server fleet routes', () => {
  let ctx: TestContext;
  let cookie: string;
  let cluster: { id: string; token: string };
  let kube: string;

  beforeEach(async () => {
    ctx = await createTestContext();
    cookie = await setupAdmin(ctx.app);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/clusters',
      cookies: { wl_session: cookie },
      payload: { name: 'acme-servers', kind: 'server' },
    });
    cluster = { id: res.json().cluster.id, token: res.json().token.value };
    const k = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/clusters',
      cookies: { wl_session: cookie },
      payload: { name: 'prod', kind: 'kubernetes' },
    });
    kube = k.json().cluster.id;
  });

  afterEach(() => closeTestContext(ctx));

  const api = (url: string) =>
    ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, cookies: { wl_session: cookie } });

  async function seed() {
    const h = { authorization: `Bearer ${cluster.token}`, 'x-watchlog-agent': HOST };
    const now = Date.now();
    const out: TestSeries[] = [];
    // Every minute for 12 minutes; api crashes every minute from minute 6 (a loop).
    for (let i = 0; i <= 12; i++) {
      const t = now - (12 - i) * 60_000;
      const add = (name: string, labels: Record<string, string>, value: number) =>
        out.push({
          labels: { __name__: name, host: HOST, run: RUN, ...labels },
          value,
          timestampMs: t,
        });
      add(
        'watchlog_server_info',
        { os: 'Debian GNU/Linux 12 (bookworm)', kernel: '6.1.0-53', systemd: '252' },
        1,
      );
      add('watchlog_node_cpu_count', {}, 4);
      add('watchlog_node_memory_bytes', { state: 'total' }, 8e9);
      add('watchlog_node_memory_bytes', { state: 'available' }, 2e9);
      add('watchlog_service_state', { unit: 'nginx.service', state: 'active', sub: 'running' }, 1);
      add(
        'watchlog_service_state',
        { unit: 'pm2-app.service', state: 'active', sub: 'running' },
        1,
      );
      add('watchlog_service_cpu_seconds_total', { unit: 'nginx.service' }, 10 + i * 6);
      add('watchlog_service_memory_working_set_bytes', { unit: 'nginx.service' }, 40e6);
      add(
        'watchlog_listen_info',
        { source: 'service', workload: 'nginx.service', proto: 'tcp', port: '80' },
        1,
      );
      add(
        'watchlog_process_group_instances',
        { group: 'api', unit: 'pm2-app.service', by: 'pm2' },
        1,
      );
      add(
        'watchlog_process_group_memory_rss_bytes',
        { group: 'api', unit: 'pm2-app.service' },
        60e6,
      );
      add(
        'watchlog_process_group_exits_total',
        { group: 'api', unit: 'pm2-app.service', exit: 'error' },
        Math.max(0, i - 6),
      );
      add(
        'watchlog_process_group_starts_total',
        { group: 'api', unit: 'pm2-app.service' },
        Math.max(0, i - 6),
      );
      add(
        'watchlog_process_group_releases_total',
        { group: 'api', unit: 'pm2-app.service' },
        i >= 5 ? 1 : 0,
      );
    }
    const w = await ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/write',
      headers: { ...h, 'content-type': 'application/x-protobuf', 'content-encoding': 'snappy' },
      payload: encode(out),
    });
    expect(w.statusCode).toBe(204);
    const o = await ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/objects',
      headers: { ...h, 'content-type': 'application/json', 'content-encoding': 'gzip' },
      payload: gzipSync(
        JSON.stringify({
          kind: 'snapshot',
          source: 'docker',
          node: HOST,
          inventory: {
            host: {
              docker_version: '27.3.1',
              api_version: '1.47',
              os: 'linux',
              arch: 'arm64',
              kernel_version: '6.1.0',
            },
            containers: [
              {
                id: 'c'.repeat(64),
                name: 'redis',
                image: 'redis:7',
                state: 'running',
                status: 'Up',
                health: 'healthy',
                restart_count: 0,
                exit_code: 0,
                oom_killed: false,
                created_at: 1793400000,
                ports: [{ public_port: 6379, private_port: 6379, protocol: 'tcp' }],
                compose_project: 'app',
                compose_service: 'redis',
              },
            ],
          },
        }),
      ),
    });
    expect(o.statusCode).toBe(204);
    await fetch(`${TEST_VM_URL}/internal/force_flush`);
  }

  it('lists the servers with their facts, workloads and problems', async () => {
    await seed();
    const res = await api(`/clusters/${cluster.id}/servers`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.servers).toHaveLength(1);
    expect(body.servers[0]).toMatchObject({
      name: HOST,
      servicesAvailable: true,
      os: 'Debian GNU/Linux 12 (bookworm)',
      systemd: '252',
      docker: '27.3.1',
      cores: 4,
      workloads: { services: 2, processes: 1, containers: 1 },
      problemCount: 1,
      problems: [{ id: 'process:api', kind: 'crash_looping' }],
    });
    const all = (await api(`/clusters/${cluster.id}/servers?workloads=1`)).json().workloads;
    expect(all[0]).toMatchObject({ id: 'process:api', server: HOST });
    expect(all).toHaveLength(4);
    expect(body.workloads).toBeUndefined();
    expect(body.totals).toMatchObject({
      servers: 1,
      needAttention: 1,
      crashLooping: 1,
      containers: 1,
    });

    const one = await api(`/clusters/${cluster.id}/servers/${HOST}`);
    expect(one.statusCode).toBe(200);
    expect(
      one
        .json()
        .events.map((e: { kind: string; workloadId: string }) => `${e.kind} ${e.workloadId}`),
    ).toEqual(expect.arrayContaining(['exited process:api', 'release process:api']));

    const wl = await api(`/clusters/${cluster.id}/servers/${HOST}/workloads`);
    expect(
      wl
        .json()
        .workloads.map((w: { id: string }) => w.id)
        .sort(),
    ).toEqual([
      'container:redis',
      'process:api',
      'service:nginx.service',
      'service:pm2-app.service',
    ]);
    expect(
      wl.json().workloads.find((w: { id: string }) => w.id === 'service:nginx.service').ports,
    ).toEqual([80]);

    const api1 = await api(`/clusters/${cluster.id}/servers/${HOST}/workloads/process:api`);
    expect(api1.statusCode).toBe(200);
    const d = api1.json();
    expect(d.workload).toMatchObject({ note: 'pm2', unit: 'pm2-app.service' });
    expect(d.related.map((w: { id: string }) => w.id)).toEqual(['service:pm2-app.service']);
    const exits = d.timeline.points.reduce((n: number, p: number[]) => n + p[1]!, 0);
    expect(exits).toBeGreaterThanOrEqual(4);
    expect(d.timeline.releases.length).toBeGreaterThanOrEqual(1);
    expect(d.crashLoopSince).toBeGreaterThan(0);

    const parent = await api(
      `/clusters/${cluster.id}/servers/${HOST}/workloads/service:pm2-app.service`,
    );
    expect(parent.json().related.map((w: { id: string }) => w.id)).toEqual(['process:api']);
  });

  it('answers 404 and 400 where it should', async () => {
    await seed();
    expect((await api(`/clusters/${cluster.id}/servers/nope`)).statusCode).toBe(404);
    expect((await api(`/clusters/${cluster.id}/servers/${HOST}/workloads/pod:x`)).statusCode).toBe(
      400,
    );
    expect(
      (await api(`/clusters/${cluster.id}/servers/${HOST}/workloads/process:none`)).statusCode,
    ).toBe(404);
    // A Kubernetes cluster has no servers.
    expect((await api(`/clusters/${kube}/servers`)).json().servers).toEqual([]);
    expect((await api(`/clusters/${kube}/servers/${HOST}`)).statusCode).toBe(404);
  });
});

describe('process-group rules (ADR-207)', () => {
  let ctx: TestContext;
  let cookie: string;
  let cluster: { id: string; token: string };

  beforeEach(async () => {
    ctx = await createTestContext();
    cookie = await setupAdmin(ctx.app);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/clusters',
      cookies: { wl_session: cookie },
      payload: { name: 'acme-servers', kind: 'server' },
    });
    cluster = { id: res.json().cluster.id, token: res.json().token.value };
  });

  afterEach(() => closeTestContext(ctx));

  const put = (rules: object[]) =>
    ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/clusters/${cluster.id}/process-rules`,
      cookies: { wl_session: cookie },
      payload: { rules },
    });
  const agent = (etag?: string) =>
    ctx.app.inject({
      method: 'GET',
      url: '/ingest/v1/process-rules',
      headers: {
        authorization: `Bearer ${cluster.token}`,
        'x-watchlog-agent': HOST,
        ...(etag ? { 'if-none-match': etag } : {}),
      },
    });

  it('stores the ordered list, checks each rule, and serves it to the agents with an ETag', async () => {
    const first = await agent();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ rules: [] });

    const rules = [
      { exe: 'python*', args: '-m (\\w+)', name: 'py $1' },
      { unit: 'pm2-*.service', name: 'pm2 apps' },
    ];
    const ok = await put(rules);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().rules).toEqual(rules);

    const got = await agent(first.headers.etag as string);
    expect(got.statusCode).toBe(200);
    expect(got.json().rules).toEqual(rules);
    expect((await agent(got.headers.etag as string)).statusCode).toBe(304);

    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/clusters/${cluster.id}/process-rules`,
      cookies: { wl_session: cookie },
    });
    expect(read.json()).toMatchObject({ rules, matches: [] });

    for (const [bad, why] of [
      [{ name: 'x' }, 'matches on'],
      [{ args: '(?=a)b', name: 'x' }, 'lookaround'],
      [{ args: '(', name: 'x' }, 'not a valid'],
      [{ args: '-m (\\w+)', name: '$2' }, '1 capture'],
    ] as const) {
      const res = await put([bad]);
      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toContain(why);
    }
    expect(
      (await put(Array.from({ length: 51 }, () => ({ exe: 'x', name: 'x' })))).statusCode,
    ).toBe(400);
    // Unchanged after the refusals.
    expect((await agent(got.headers.etag as string)).statusCode).toBe(304);
  });
});
