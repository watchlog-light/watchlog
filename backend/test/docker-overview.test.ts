// SPDX-License-Identifier: AGPL-3.0-only
// The Docker overview (Docker parity of the overview redesign): container problems in
// the alert texts' words, change markers from snapshots, and the overview's counts,
// problems, events and changes for a fleet.
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { dockerMarkers } from '../src/modules/ingest/docker-markers.js';
import { dockerProblem, dockerProblems } from '../src/modules/overview/docker-problems.js';
import { closeTestContext, createTestContext, setupAdmin, type TestContext } from './helpers.js';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const row = (name: string, status: object, node = 'h1') => ({
  node,
  name,
  spec_summary: {},
  status_summary: status,
});

describe('Docker container problems', () => {
  it('finds OOM kills, restart loops, unhealthy and recently failed containers', () => {
    const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();
    expect(
      dockerProblem({ state: 'exited', oom_killed: true, finished_at: ago(1) }, NOW)?.ruleKey,
    ).toBe('docker.container.oom');
    // Docker keeps the flag on a running container after one of its processes was killed.
    expect(dockerProblem({ state: 'running', oom_killed: true }, NOW)).toBeNull();
    expect(
      dockerProblem({ state: 'exited', oom_killed: true, finished_at: ago(30) }, NOW),
    ).toBeNull();
    expect(dockerProblem({ state: 'restarting', exit_code: 1 }, NOW)?.ruleKey).toBe(
      'docker.container.restarting',
    );
    expect(dockerProblem({ state: 'running', health: 'unhealthy' }, NOW)?.severity).toBe('warning');
    const exited = (h: number) =>
      dockerProblem(
        { state: 'exited', exit_code: 3, finished_at: new Date(NOW - h * 3600_000).toISOString() },
        NOW,
      );
    expect(exited(2)?.ruleKey).toBe('docker.container.exited');
    expect(exited(30)).toBeNull(); // long gone
    expect(dockerProblem({ state: 'exited', exit_code: 0 }, NOW)).toBeNull();
    expect(dockerProblem({ state: 'running', health: 'healthy' }, NOW)).toBeNull();
  });

  it('words them as the alert texts and leaves out containers an alert names', () => {
    const rows = [
      row('fx-crashloop', { state: 'restarting', exit_code: 1, restart_count: 9 }),
      row('fx-unhealthy', {
        state: 'running',
        health: 'unhealthy',
        health_detail: { failing_streak: 4, probes: [{ output: 'connection refused' }] },
      }),
      row('fx-oom', {
        state: 'exited',
        exit_code: 137,
        oom_killed: true,
        restart_count: 2,
        finished_at: new Date(NOW - 60_000).toISOString(),
      }),
      row('elsewhere', { state: 'restarting', exit_code: 1 }, 'gone-host'),
    ];
    const alert = {
      id: 'a1',
      ruleId: 'r',
      ruleKey: 'docker.container.unhealthy',
      ruleName: 'x',
      severity: 'warning',
      silenced: false,
      labels: { node: 'h1', container: 'fx-unhealthy' },
      details: {},
      startedAt: new Date(NOW),
      firedAt: new Date(NOW),
    };
    const items = dockerProblems(rows, [alert], 'fleet', NOW, () => '64m');
    expect(items.map((p) => [p.title, p.why, p.severity, p.type])).toEqual([
      [
        'fx-crashloop keeps restarting',
        'h1 · exited with code 1 · 9 restarts',
        'critical',
        'crashloop',
      ],
      [
        'fx-oom was killed for using too much memory',
        'h1 · OOMKilled · limit 64m · 2 restarts',
        'critical',
        'oom',
      ],
      [
        'elsewhere keeps restarting',
        'gone-host · exited with code 1 · 0 restarts',
        'critical',
        'crashloop',
      ],
    ]);
    expect(items[0]!.object).toEqual({ kind: 'Container', namespace: 'h1', name: 'fx-crashloop' });
    expect(dockerProblems(rows, [], 'fleet', NOW)).toHaveLength(4);
    // A host that stopped reporting: its containers' state is stale, not a problem.
    expect(
      dockerProblems(rows, [], 'fleet', NOW, undefined, new Set(['h1'])).map((p) => p.object?.name),
    ).toEqual(['fx-crashloop', 'fx-unhealthy', 'fx-oom']);
  });
});

describe('Docker change markers', () => {
  const c = (uid: string, name: string, image = 'nginx:1.29', project = 'demo') => ({
    uid,
    name,
    image,
    project,
  });
  it('marks re-created containers, image changes and Compose projects up or down', () => {
    expect(dockerMarkers('h1', [], [c('1', 'demo-web-1')])).toEqual([]);
    const markers = dockerMarkers(
      'h1',
      [
        c('1', 'demo-web-1'),
        c('2', 'demo-db-1', 'postgres:16'),
        c('3', 'old-api-1', 'api:1', 'old'),
      ],
      [
        c('9', 'demo-web-1'),
        c('8', 'demo-db-1', 'postgres:17'),
        c('7', 'shop-cart-1', 'cart:1', 'shop'),
      ],
    );
    expect(markers).toEqual([
      {
        kind: 'recreate',
        target: 'Container/h1/demo-web-1',
        namespace: 'demo',
        details: { image: 'nginx:1.29' },
      },
      {
        kind: 'image',
        target: 'Container/h1/demo-db-1',
        namespace: 'demo',
        details: { from: 'postgres:16', to: 'postgres:17' },
      },
      { kind: 'compose', target: 'Compose/h1/shop', namespace: 'shop', details: { action: 'up' } },
      { kind: 'compose', target: 'Compose/h1/old', namespace: 'old', details: { action: 'down' } },
    ]);
  });
});

describe('Docker overview API', () => {
  let ctx: TestContext;
  afterEach(() => closeTestContext(ctx));

  it('counts containers, lists their problems, events and changes', async () => {
    ctx = await createTestContext();
    const cookie = await setupAdmin(ctx.app);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/clusters',
      cookies: { wl_session: cookie },
      payload: { name: 'fleet', kind: 'docker' },
    });
    const id = res.json().cluster.id as string;
    const headers = {
      authorization: `Bearer ${res.json().token.value}`,
      'x-watchlog-agent': 'h1',
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    };
    const ctr = (n: string, name: string, extra: object = {}) => ({
      id: n.repeat(64),
      name,
      image: 'nginx:1.29',
      state: 'running',
      status: 'Up',
      restart_count: 0,
      exit_code: 0,
      oom_killed: false,
      created_at: 1793400000,
      compose_project: 'demo',
      compose_service: name,
      ...extra,
    });
    // The host reports (containers of hosts that stopped reporting are not problems).
    await ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/heartbeat',
      headers: { authorization: headers.authorization, 'x-watchlog-agent': 'h1' },
      payload: { agent_version: 'dev', mode: 'docker', node: 'h1', capabilities: {}, series: 10 },
    });
    const snapshot = (containers: object[]) =>
      ctx.app.inject({
        method: 'POST',
        url: '/ingest/v1/objects',
        headers,
        payload: gzipSync(
          JSON.stringify({
            kind: 'snapshot',
            source: 'docker',
            node: 'h1',
            inventory: {
              host: {
                docker_version: '29.9.2',
                api_version: '1.56',
                os: 'linux',
                arch: 'arm64',
                kernel_version: '6.8',
              },
              containers,
            },
          }),
        ),
      });
    expect(
      (
        await snapshot([
          ctr('a', 'demo-web-1'),
          ctr('b', 'fx-crashloop', {
            state: 'restarting',
            exit_code: 1,
            restart_count: 5,
            compose_project: undefined,
          }),
          ctr('c', 'stopped-job', { state: 'exited', exit_code: 0, compose_project: undefined }),
        ])
      ).statusCode,
    ).toBe(204);
    // demo-web-1 re-created with a new image.
    await snapshot([
      ctr('d', 'demo-web-1', { image: 'nginx:1.30' }),
      ctr('b', 'fx-crashloop', {
        state: 'restarting',
        exit_code: 1,
        restart_count: 6,
        compose_project: undefined,
      }),
      ctr('c', 'stopped-job', { state: 'exited', exit_code: 0, compose_project: undefined }),
    ]);
    const t = new Date(Date.now() - 60_000).toISOString();
    await ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/events',
      headers: { authorization: headers.authorization, 'x-watchlog-agent': 'h1' },
      payload: {
        events: ['fx-crashloop', 'demo-web-1'].map((name) => ({
          uid: `${name}:Died`,
          host: 'h1',
          involved: { kind: 'Container', name },
          type: 'Warning',
          reason: 'Died',
          message: 'Exited with code 1',
          count: 3,
          first_ts: t,
          last_ts: t,
        })),
      },
    });

    const o = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/clusters/${id}/overview`,
        cookies: { wl_session: cookie },
      })
    ).json();
    expect(o.kind).toBe('docker');
    expect(o.facts).toMatchObject({ dockerVersions: ['29.9.2'], nodes: 1 });
    expect(o.kpis.pods).toMatchObject({ running: 2, pending: 1, failed: 0, total: 3 });
    expect(o.problems.items.map((p: { title: string }) => p.title)).toEqual([
      'fx-crashloop keeps restarting',
    ]);
    expect(o.health).toBe('critical');
    expect(o.events.map((e: { name: string; covered: boolean }) => [e.name, e.covered])).toEqual(
      expect.arrayContaining([
        ['fx-crashloop', true],
        ['demo-web-1', false],
      ]),
    );
    expect(o.changes).toEqual([
      expect.objectContaining({ kind: 'image', target: 'Container/h1/demo-web-1' }),
    ]);
    expect(o.pods.find((p: { name: string }) => p.name === 'fx-crashloop').failing).toBe(
      'Restarting',
    );
  });
});
