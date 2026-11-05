// SPDX-License-Identifier: AGPL-3.0-only
import { gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  createUserSession,
  setupAdmin,
  TEST_VM_URL,
  type TestContext,
} from './helpers.js';
import { encode, type TestSeries } from './support/remote-write.js';

const RUN = `dq-${Date.now()}`;
const HOST = 'web-01';

afterAll(async () => {
  await fetch(
    `${TEST_VM_URL}/api/v1/admin/tsdb/delete_series?match[]=${encodeURIComponent(`{run="${RUN}"}`)}`,
    {
      method: 'POST',
    },
  );
});

function snapshot(containers: object[]) {
  return {
    kind: 'snapshot',
    source: 'docker',
    node: HOST,
    inventory: {
      host: {
        docker_version: '29.9.2',
        api_version: '1.56',
        os: 'linux',
        arch: 'arm64',
        kernel_version: '6.8.0',
      },
      containers,
    },
  };
}

const container = (id: string, name: string, extra: object = {}) => ({
  id: id.repeat(64 / id.length),
  name,
  image: 'redis:7-alpine',
  state: 'running',
  status: 'Up 5 minutes',
  restart_count: 0,
  exit_code: 0,
  oom_killed: false,
  created_at: 1793400000,
  started_at: '2026-10-31T00:00:00Z',
  ports: [{ public_port: 6379, private_port: 6379, protocol: 'tcp' }],
  compose_project: 'demo',
  compose_service: 'cache',
  ...extra,
});

describe('Docker inventory, hosts, containers and query API', () => {
  let ctx: TestContext;
  let cookie: string;
  const clusters: { id: string; token: string }[] = [];

  beforeEach(async () => {
    ctx = await createTestContext();
    cookie = await setupAdmin(ctx.app);
    await ctx.db.updateTable('orgs').set({ plan: 'pro' }).execute(); // two clusters for isolation tests
    clusters.length = 0;
    for (const name of ['alpha', 'beta']) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/clusters',
        cookies: { wl_session: cookie },
        payload: { name, kind: 'docker' },
      });
      clusters.push({ id: res.json().cluster.id, token: res.json().token.value });
    }
  });

  afterEach(() => closeTestContext(ctx));

  const agentHeaders = (i: number) => ({
    authorization: `Bearer ${clusters[i]!.token}`,
    'x-watchlog-agent': HOST,
  });

  const postObjects = (body: object, i = 0, gzip = true) =>
    ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/objects',
      headers: {
        ...agentHeaders(i),
        'content-type': 'application/json',
        ...(gzip ? { 'content-encoding': 'gzip' } : {}),
      },
      payload: gzip ? gzipSync(JSON.stringify(body)) : JSON.stringify(body),
    });

  const writeMetrics = async (i: number, series: TestSeries[]) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/write',
      headers: {
        ...agentHeaders(i),
        'content-type': 'application/x-protobuf',
        'content-encoding': 'snappy',
      },
      payload: encode(series),
    });
    expect(res.statusCode).toBe(204);
    await fetch(`${TEST_VM_URL}/internal/force_flush`); // make fresh samples searchable
  };

  const api = (method: 'GET' | 'POST', url: string, payload?: object, as = cookie) =>
    ctx.app.inject({ method, url: `/api/v1${url}`, cookies: { wl_session: as }, payload });

  it('stores inventory snapshots and marks vanished containers deleted', async () => {
    expect(
      (await postObjects(snapshot([container('a', 'demo-cache-1'), container('b', 'worker')])))
        .statusCode,
    ).toBe(204);
    let live = await ctx.db
      .selectFrom('objects')
      .selectAll()
      .where('deleted_at', 'is', null)
      .execute();
    expect(live.map((o) => `${o.kind}:${o.name}`).sort()).toEqual([
      'DockerContainer:demo-cache-1',
      'DockerContainer:worker',
      'DockerHost:web-01',
    ]);
    expect(live.find((o) => o.name === 'demo-cache-1')).toMatchObject({
      namespace: 'demo',
      node: HOST,
      source: 'docker',
    });

    expect(
      (await postObjects(snapshot([container('a', 'demo-cache-1')]), 0, false)).statusCode,
    ).toBe(204);
    live = await ctx.db.selectFrom('objects').selectAll().where('deleted_at', 'is', null).execute();
    expect(live.map((o) => o.name).sort()).toEqual(['demo-cache-1', 'web-01']);

    // An empty snapshot (agent reports no containers) removes all of this host's containers.
    expect((await postObjects(snapshot([]))).statusCode).toBe(204);
    expect(
      (
        await postObjects({
          ...snapshot([]),
          inventory: { ...snapshot([]).inventory, containers: null },
        })
      ).statusCode,
    ).toBe(400);
  });

  // Shaped like fx-unhealthy captured on the Lima VM (agent fixture, already redacted).
  const probe = (t: string, exit = 1) => ({
    start: `2026-10-31T06:20:${t}.665Z`,
    end: `2026-10-31T06:20:${t}.696Z`,
    exit_code: exit,
    output: "wget: can't connect to remote host (127.0.0.1): Connection refused",
  });
  const unhealthyDetail = {
    status: 'unhealthy',
    failing_streak: 3,
    probes: [probe('06'), probe('11'), probe('16')],
    check: {
      command:
        "wget -qO- --header 'Authorization: Bearer ***' http://admin:***@127.0.0.1:9/health || exit 1",
      shell: true,
      interval_s: 5,
      timeout_s: 3,
      start_period_s: 2,
      retries: 3,
    },
  };
  const unhealthy = container('e', 'fx-unhealthy', {
    health: 'unhealthy',
    health_detail: unhealthyDetail,
  });

  it('keeps health details and the time the health status began; deltas touch only their containers', async () => {
    const containersOf = async () =>
      Object.fromEntries(
        (await api('GET', `/clusters/${clusters[0]!.id}/docker/containers`))
          .json()
          .containers.map((x: { name: string }) => [x.name, x]),
      );
    const oom = container('f', 'fx-oom', {
      state: 'exited',
      exit_code: 137,
      oom_killed: true,
      finished_at: '2026-10-31T06:20:04.881617728Z',
      error: '',
    });
    expect((await postObjects(snapshot([unhealthy, oom]))).statusCode).toBe(204);
    let byName = await containersOf();
    expect(byName['fx-unhealthy'].healthDetail).toMatchObject({
      status: 'unhealthy',
      failingStreak: 3,
      // Three failures with retries=3: unhealthy since the third failing probe ended.
      since: '2026-10-31T06:20:16.696Z',
      sinceEstimated: false,
      check: { intervalS: 5, timeoutS: 3, retries: 3, shell: true },
    });
    expect(byName['fx-unhealthy'].healthDetail.probes).toHaveLength(3);
    expect(byName['fx-unhealthy'].healthDetail.probes[2]).toMatchObject({
      exitCode: 1,
      output: expect.stringContaining('Connection refused'),
    });
    expect(byName['fx-oom']).toMatchObject({
      exitCode: 137,
      oomKilled: true,
      finishedAt: '2026-10-31T06:20:04.881617728Z',
      stateError: null,
      healthDetail: null,
      restarting: false,
    });

    // Unchanged status keeps its start time across snapshots.
    await postObjects(snapshot([unhealthy, oom]));
    expect((await containersOf())['fx-unhealthy'].healthDetail.since).toBe(
      '2026-10-31T06:20:16.696Z',
    );

    // A delta (health_status event) for one container: an observed change, and fx-oom stays.
    const before = Date.now();
    const healthy = {
      ...unhealthy,
      health: 'healthy',
      health_detail: { ...unhealthyDetail, status: 'healthy', failing_streak: 0 },
    };
    expect((await postObjects({ ...snapshot([healthy]), kind: 'delta' })).statusCode).toBe(204);
    byName = await containersOf();
    expect(Object.keys(byName).sort()).toEqual(['fx-oom', 'fx-unhealthy']);
    expect(byName['fx-unhealthy'].healthDetail.sinceEstimated).toBe(false);
    expect(Date.parse(byName['fx-unhealthy'].healthDetail.since)).toBeGreaterThanOrEqual(
      before - 1000,
    );
  });

  it('rejects oversized (gzip bomb) and invalid snapshots', async () => {
    const bomb = gzipSync(Buffer.alloc(20 << 20, 0x20)); // 20 MiB of spaces, tiny compressed
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/objects',
      headers: {
        ...agentHeaders(0),
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      payload: bomb,
    });
    expect(res.statusCode).toBe(413);
    expect((await postObjects({ kind: 'snapshot', source: 'docker' })).statusCode).toBe(400);
    expect((await postObjects(snapshot([container('a', 'x', { id: 'NOT-HEX' })]))).statusCode).toBe(
      400,
    );
  });

  it('lists hosts with container counts, agent status and current usage', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/heartbeat',
      headers: agentHeaders(0),
      payload: {
        agent_version: '1.0.0',
        mode: 'docker',
        node: HOST,
        capabilities: { cgroup: 'v2' },
        series: 10,
      },
    });
    await postObjects(
      snapshot([
        container('a', 'demo-cache-1'),
        container('b', 'crashy', { state: 'restarting' }),
        container('c', 'sick', { health: 'unhealthy' }),
        container('d', 'done', { state: 'exited' }),
      ]),
    );
    const t = Date.now() - 90_000;
    const node = (name: string, value: number, ts: number, extra: Record<string, string> = {}) => ({
      labels: { __name__: name, host: HOST, run: RUN, ...extra },
      value,
      timestampMs: ts,
    });
    await writeMetrics(0, [
      node('watchlog_node_cpu_seconds_total', 100, t, { mode: 'idle' }),
      node('watchlog_node_cpu_seconds_total', 100, t, { mode: 'user' }),
      node('watchlog_node_cpu_seconds_total', 115, t + 30_000, { mode: 'idle' }),
      node('watchlog_node_cpu_seconds_total', 145, t + 30_000, { mode: 'user' }),
      node('watchlog_node_memory_bytes', 1000, t + 30_000, { state: 'total' }),
      node('watchlog_node_memory_bytes', 250, t + 30_000, { state: 'available' }),
      node('watchlog_node_filesystem_bytes', 100, t + 30_000, { mount: '/', state: 'size' }),
      node('watchlog_node_filesystem_bytes', 40, t + 30_000, { mount: '/', state: 'avail' }),
      node('watchlog_node_load1', 0.75, t + 30_000),
      node('watchlog_node_boot_time_seconds', 1793400000, t + 30_000),
      node('watchlog_node_cpu_count', 4, t + 30_000),
    ]);

    const res = await api('GET', `/clusters/${clusters[0]!.id}/docker/hosts`);
    expect(res.statusCode).toBe(200);
    const [host] = res.json().hosts;
    expect(host).toMatchObject({
      name: HOST,
      status: 'active',
      agentVersion: '1.0.0',
      dockerVersion: '29.9.2',
      kernelVersion: '6.8.0',
      // running includes restarting and unhealthy-but-running containers
      containers: { total: 4, running: 3, stopped: 1, unhealthy: 1 },
      load1: 0.75,
    });
    expect(host.cpuUtilization).toBeCloseTo(45 / 60, 5);
    expect(host.memoryUtilization).toBeCloseTo(0.75, 5);
    expect(host.diskUtilization).toBeCloseTo(0.6, 5);
    // The Hosts page: totals, boot time, every mount with its size, trends; with heat=1
    // the containers, failing ones named.
    expect(host).toMatchObject({
      bootTime: 1793400000,
      cpu: { cores: 4 },
      memory: { usageBytes: 750, totalBytes: 1000 },
      disks: [{ mount: '/', sizeBytes: 100 }],
    });
    expect(host.disks[0].utilization).toBeCloseTo(0.6, 5);
    expect(host.cpuSeries.length).toBeGreaterThan(0);
    expect(host.heat).toBeUndefined();
    const withHeat = (
      await api('GET', `/clusters/${clusters[0]!.id}/docker/hosts?heat=1&range=900`)
    ).json();
    expect(withHeat).toMatchObject({ range: 900, step: 15, diskAlerts: [] });
    expect(
      withHeat.hosts[0].heat.map((c: { name: string; failing: string | null }) => [
        c.name,
        c.failing,
      ]),
    ).toEqual([
      ['demo-cache-1', null],
      ['crashy', 'Restarting'],
      ['sick', 'Unhealthy'],
    ]);

    // The other cluster sees nothing of it.
    const other = await api('GET', `/clusters/${clusters[1]!.id}/docker/hosts`);
    expect(other.json().hosts).toEqual([]);
  });

  it('lists containers with live CPU and memory', async () => {
    await postObjects(
      snapshot([
        container('a', 'demo-cache-1'),
        container('d', 'done', { state: 'exited' }),
        container('e', 'eaten', {
          state: 'exited',
          exit_code: 137,
          oom_killed: true,
          restart_count: 2,
          finished_at: new Date(Date.now() - 60_000).toISOString(),
          compose_project: undefined,
        }),
      ]),
    );
    const t = Date.now() - 90_000;
    const c = (name: string, value: number, ts: number) => ({
      labels: { __name__: name, host: HOST, container: 'demo-cache-1', run: RUN },
      value,
      timestampMs: ts,
    });
    await writeMetrics(0, [
      c('watchlog_container_cpu_seconds_total', 10, t),
      c('watchlog_container_cpu_seconds_total', 25, t + 30_000),
      c('watchlog_container_memory_working_set_bytes', 3_424_256, t + 30_000),
      c('watchlog_container_memory_limit_bytes', 134_217_728, t + 30_000),
      c('watchlog_container_cpu_limit_cores', 0.5, t + 30_000),
    ]);
    const res = await api('GET', `/clusters/${clusters[0]!.id}/docker/containers?host=${HOST}`);
    expect(res.statusCode).toBe(200);
    const byName = Object.fromEntries(
      res.json().containers.map((x: { name: string }) => [x.name, x]),
    );
    expect(byName['demo-cache-1']).toMatchObject({
      composeProject: 'demo',
      composeService: 'cache',
      image: 'redis:7-alpine',
      memoryBytes: 3_424_256,
      memoryLimitBytes: 134_217_728,
      cpuLimitCores: 0.5,
      ports: [{ publicPort: 6379, privatePort: 6379, protocol: 'tcp' }],
    });
    expect(byName['demo-cache-1'].cpuCores).toBeCloseTo(0.5, 5);
    expect(byName['done']).toMatchObject({ state: 'exited', cpuCores: null, memoryBytes: null });
    // The Containers page: a problem worded as the alert texts (for hosts that report),
    // series over the range.
    expect(byName['eaten'].problem).toBeNull(); // no heartbeat from the host yet
    await ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/heartbeat',
      headers: agentHeaders(0),
      payload: { agent_version: 'dev', mode: 'docker', node: HOST, capabilities: {}, series: 1 },
    });
    const again = (await api('GET', `/clusters/${clusters[0]!.id}/docker/containers`)).json();
    byName['eaten'] = again.containers.find((x: { name: string }) => x.name === 'eaten');
    expect(byName['done'].problem).toBeNull();
    expect(byName['eaten'].problem).toEqual({
      severity: 'critical',
      kind: 'OOMKilled',
      title: 'eaten was killed for using too much memory',
      reason: 'OOMKilled · 2 restarts',
      alertId: null,
    });
    expect(byName['demo-cache-1']).toMatchObject({ watchlog: false, problem: null });
    expect(byName['demo-cache-1'].cpuSeries.length).toBeGreaterThan(0);
    expect(res.json()).toMatchObject({ range: 3600, step: 60 });
  });

  it('answers range queries only with the requested cluster’s data', async () => {
    const t = Date.now() - 120_000;
    for (const [i, value] of [
      [0, 1],
      [1, 99],
    ] as const) {
      await writeMetrics(i, [
        {
          labels: { __name__: 'watchlog_node_load1', host: HOST, run: RUN },
          value,
          timestampMs: t,
        },
        {
          labels: { __name__: 'watchlog_node_load1', host: HOST, run: RUN },
          value,
          timestampMs: t + 15_000,
        },
      ]);
    }
    const query = (scope: object, clusterIdx = 0) =>
      api('POST', '/query/range', {
        clusterId: clusters[clusterIdx]!.id,
        metric: 'host.load1',
        scope,
        from: Math.floor(t / 1000) - 30,
        to: Math.floor(t / 1000) + 60,
      });

    const res = await query({ host: HOST });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ metric: 'host.load1', unit: 'load', step: 15 });
    const values = res
      .json()
      .series.flatMap((s: { points: [number, number][] }) => s.points.map((p) => p[1]));
    expect(values.length).toBeGreaterThan(0);
    expect(new Set(values)).toEqual(new Set([1]));

    // Injection attempt through a scope value stays inside the label matcher.
    const injected = await query({ host: `${HOST}"} or watchlog_node_load1{host="${HOST}` });
    expect(injected.statusCode).toBe(200);
    expect(injected.json().series).toEqual([]);

    const beta = await query({ host: HOST }, 1);
    const betaValues = beta
      .json()
      .series.flatMap((s: { points: [number, number][] }) => s.points.map((p) => p[1]));
    expect(new Set(betaValues)).toEqual(new Set([99]));
  });

  it('validates range queries and hides other orgs’ clusters', async () => {
    const base = { clusterId: clusters[0]!.id, metric: 'host.load1', from: 1000, to: 2000 };
    expect((await api('POST', '/query/range', { ...base, to: 500 })).statusCode).toBe(400);
    expect((await api('POST', '/query/range', { ...base, to: 1000 + 32 * 86400 })).statusCode).toBe(
      400,
    );
    expect((await api('POST', '/query/range', { ...base, metric: 'up' })).statusCode).toBe(400);
    // Unknown scope keys are stripped by validation and never reach the query.
    expect((await api('POST', '/query/range', { ...base, scope: { pod: 'x' } })).statusCode).toBe(
      200,
    );
    const stranger = await createUserSession(ctx.db, { role: 'owner' });
    expect((await api('POST', '/query/range', base, stranger.cookie)).statusCode).toBe(404);
    expect(
      (await api('GET', `/clusters/${clusters[0]!.id}/docker/hosts`, undefined, stranger.cookie))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await api(
          'GET',
          `/clusters/${clusters[0]!.id}/docker/containers`,
          undefined,
          stranger.cookie,
        )
      ).statusCode,
    ).toBe(404);
  });
});
