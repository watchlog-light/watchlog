// SPDX-License-Identifier: AGPL-3.0-only
// A server's own events (0.9.2, ADR-207/208 amended): its 0.9.2 agent sends its services'
// and process groups' events like Docker's; they are stored, grouped per day by workload and
// reason with their count, listed with each one's workload id, filtered by server, workload
// and kind, faceted by workload, and "Hide system" leaves out the OS's own by identity, never
// a foreign process named like ours. The server page and a workload page read them.
import { afterEach, describe, expect, it } from 'vitest';
import { versionAtLeast } from '../src/modules/servers/routes.js';
import { closeTestContext, createTestContext, setupAdmin, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
});

describe('server events', () => {
  it("tell a 0.9.2 agent's server by its version", () => {
    expect(versionAtLeast('0.9.2', '0.9.2')).toBe(true);
    expect(versionAtLeast('0.10.0', '0.9.2')).toBe(true);
    expect(versionAtLeast('v1.0.0-rc.1', '0.9.2')).toBe(true);
    expect(versionAtLeast('0.9.1', '0.9.2')).toBe(false);
    expect(versionAtLeast('dev', '0.9.2')).toBe(false);
    expect(versionAtLeast(null, '0.9.2')).toBe(false);
  });

  it('are stored, grouped, listed with their workload, filtered, faceted and hidden by identity', async () => {
    ctx = await createTestContext();
    const cookie = await setupAdmin(ctx.app);
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/clusters',
      cookies: { wl_session: cookie },
      payload: { name: 'fleet', kind: 'server' },
    });
    const id = created.json().cluster.id as string;
    const token = created.json().token.value as string;
    const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
    const ev = (
      kind: string,
      name: string,
      reason: string,
      type: string,
      count: number,
      uid: string,
      msg: string,
    ) => ({
      uid,
      host: 'web-1',
      involved: { kind, name },
      type,
      reason,
      message: msg,
      count,
      first_ts: at(20),
      last_ts: at(2),
      reporting_controller: 'watchlog-agent',
    });
    const post = (events: object[]) =>
      ctx.app.inject({
        method: 'POST',
        url: '/ingest/v1/events',
        headers: { authorization: `Bearer ${token}`, 'x-watchlog-agent': 'web-1' },
        payload: { events },
      });
    // Two runs of the agent the same day: their counts add up on one row.
    expect(
      (
        await post([
          ev('Process', 'activity2', 'FailedExit', 'Warning', 4, 'sv-a', 'exited with code 1'),
          ev(
            'Process',
            'activity2',
            'CrashLoop',
            'Warning',
            1,
            'sv-b',
            '3 failed exits in 10 minutes',
          ),
          ev(
            'Service',
            'orders.service',
            'Failed',
            'Warning',
            1,
            'sv-c',
            'failed (exit-code, exit code 3)',
          ),
          ev('Service', 'cron.service', 'Restarted', 'Warning', 1, 'sv-d', 'systemd restarted it'),
          ev('Process', 'bash', 'Appeared', 'Normal', 2, 'sv-e', 'started'),
          // Another product's agent, named like ours: an ordinary process group.
          ev('Process', 'watchlog-agent', 'FailedExit', 'Warning', 1, 'sv-f', 'exited with code 2'),
        ])
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await post([
          ev('Process', 'activity2', 'FailedExit', 'Warning', 3, 'sv-a2', 'killed by SIGKILL (9)'),
        ])
      ).statusCode,
    ).toBe(204);

    const get = async (url: string) => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/clusters/${id}${url}`,
        cookies: { wl_session: cookie },
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json();
    };
    const all = await get('/events?limit=50');
    const fe = all.events.find(
      (e: { reason: string; involvedName: string }) =>
        e.reason === 'FailedExit' && e.involvedName === 'activity2',
    );
    expect(fe).toMatchObject({
      involvedKind: 'Process',
      host: 'web-1',
      count: 7,
      workload: 'process:activity2',
      message: 'killed by SIGKILL (9)',
    });
    expect(
      all.events.find((e: { involvedName: string }) => e.involvedName === 'orders.service')
        .workload,
    ).toBe('service:orders.service');

    const byWorkload = await get('/events?workloads=process:activity2');
    expect(byWorkload.events.map((e: { reason: string }) => e.reason).sort()).toEqual([
      'CrashLoop',
      'FailedExit',
    ]);
    const services = await get('/events?kinds=Service');
    expect(
      services.events.every((e: { involvedKind: string }) => e.involvedKind === 'Service'),
    ).toBe(true);

    // Hide system: cron.service (the OS's unit) and bash (a shell) go; the foreign
    // watchlog-agent stays.
    const shown = (await get('/events?system=hide&limit=50')).events.map(
      (e: { involvedName: string }) => e.involvedName,
    );
    expect(shown).not.toContain('cron.service');
    expect(shown).not.toContain('bash');
    expect(shown).toContain('watchlog-agent');
    expect(shown).toContain('orders.service');

    const sum = await get(
      `/events/summary?from=${Math.floor(Date.now() / 1000) - 3600}&system=hide`,
    );
    expect(sum.facets.workloads.map((w: { value: string }) => w.value)).toContain(
      'process:activity2',
    );
    expect(sum.facets.workloads.map((w: { value: string }) => w.value)).not.toContain(
      'process:bash',
    );
    expect(sum.facets.hosts).toEqual([expect.objectContaining({ value: 'web-1' })]);

    // The server page reads the stored events, and says so (the server known by its heartbeat).
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/ingest/v1/heartbeat',
          headers: { authorization: `Bearer ${token}` },
          payload: {
            agent_version: '0.9.2',
            mode: 'docker',
            node: 'web-1',
            series: 500,
            capabilities: {},
          },
        })
      ).statusCode,
    ).toBe(204);
    const server = await get('/servers/web-1');
    expect(server.eventsStored).toBe(true);
    expect(
      server.events.filter((e: { kind: string }) => e.kind === 'event').length,
    ).toBeGreaterThanOrEqual(6);
    expect(server.events.find((e: { reason?: string }) => e.reason === 'Failed')).toMatchObject({
      workloadId: 'service:orders.service',
      type: 'Warning',
      message: 'failed (exit-code, exit code 3)',
    });
  });
});
