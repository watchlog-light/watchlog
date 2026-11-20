// SPDX-License-Identifier: AGPL-3.0-only
// Certificates and scheduled jobs (0.10.0, ADR-222 to ADR-224): the agents' inventory
// snapshots on the objects endpoint, what the backend keeps of them (renewals, runs, hourly
// counts, gone jobs), and the read routes, for a Server fleet and a Kubernetes cluster.
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { createTestContext, setupAdmin, type TestContext } from './helpers.js';
import { mcpClient } from './support/mcp.js';

let ctx: TestContext;
afterEach(async () => {
  await ctx?.app.close();
});

const DAY = 86_400;
const fp = (c: string) => c.repeat(64);

function cert(id: string, name: string, notAfter: number, f: string, over: object = {}) {
  return {
    id,
    names: [name],
    subject: name,
    issuer: 'WL Test CA',
    serial: '1f',
    notBefore: notAfter - 90 * DAY,
    notAfter,
    fingerprint: f,
    keyType: 'ECDSA',
    keyBits: 256,
    chain: 'complete',
    endpoints: [
      {
        kind: 'Service',
        workload: 'nginx.service',
        port: 443,
        proto: 'tls',
        fingerprint: f,
        notAfter,
      },
    ],
    ...over,
  };
}

function job(id: string, name: string, runs: object[], over: object = {}) {
  return {
    id,
    kind: 'timer',
    name,
    unit: name.replace('.timer', '.service'),
    schedule: '*-*-* 03:00:00',
    enabled: true,
    runs,
    every: DAY,
    state: 'working',
    failedStreak: 0,
    missedRuns: 0,
    ...over,
  };
}

async function setup(kind: 'server' | 'kubernetes') {
  ctx = await createTestContext();
  const cookie = await setupAdmin(ctx.app);
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/clusters',
    cookies: { wl_session: cookie },
    payload: { name: kind === 'server' ? 'fleet' : 'prod', kind },
  });
  const id = created.json().cluster.id as string;
  const token = created.json().token.value as string;
  const post = (body: object) =>
    ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/objects',
      headers: {
        authorization: `Bearer ${token}`,
        'x-watchlog-agent': kind === 'server' ? 'web-1' : 'cluster-agent',
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      payload: gzipSync(JSON.stringify({ source: 'inventory', ...body })),
    });
  const get = async (url: string) => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/clusters/${id}${url}`,
      cookies: { wl_session: cookie },
    });
    return { status: res.statusCode, body: res.json() };
  };
  return { id, post, get, cookie };
}

describe('certificates (ADR-222, ADR-224)', () => {
  it('are stored per server, worst first, renewals kept, unchanged until a round is done', async () => {
    const { id, post, get } = await setup('server');
    const now = Math.floor(Date.now() / 1000);
    const cov = { ports: 3, tlsPorts: 2, unserved: ['old.wl.test'], at: now };
    const first = await post({
      node: 'web-1',
      certificates: [
        cert('1111111111111111', 'shop.wl.test', now + 40 * DAY, fp('a')),
        cert('2222222222222222', 'api.wl.test', now + 2 * DAY, fp('b')),
        cert('3333333333333333', 'mail.wl.test', now + 200 * DAY, fp('c'), {
          chain: 'incomplete',
        }),
      ],
      certificateCoverage: cov,
      jobs: [job('9999999999999999', 'certbot.timer', [])],
    });
    expect(first.statusCode, first.body).toBe(204);

    let r = await get('/certificates');
    expect(r.status).toBe(200);
    expect(
      r.body.certificates.map(
        (c: { names: string[]; status: string }) => `${c.names[0]} ${c.status}`,
      ),
    ).toEqual(['api.wl.test expires_soon', 'mail.wl.test problem', 'shop.wl.test ok']);
    expect(r.body.certificates[0].renewalJob).toMatchObject({ name: 'certbot.timer' });
    expect(r.body.certificates[0].renewedDaysBefore).toBeNull();
    expect(r.body.coverage).toEqual([
      expect.objectContaining({
        node: 'web-1',
        certificates: expect.objectContaining({ unserved: ['old.wl.test'] }),
      }),
    ]);

    // Search (0.10): a certificate by any of its names.
    const found = await get('/search?q=mail');
    expect(found.body.results).toContainEqual(
      expect.objectContaining({
        kind: 'certificate',
        name: 'mail.wl.test',
        host: 'web-1',
        id: '3333333333333333',
      }),
    );

    // The agent restarted: its first snapshot comes before its first round (at 0).
    expect(
      (await post({ node: 'web-1', certificates: null, certificateCoverage: { at: 0 }, jobs: [] }))
        .statusCode,
    ).toBe(204);
    r = await get('/certificates?node=web-1');
    expect(r.body.certificates).toHaveLength(3);

    // api.wl.test renewed 2 days before it expired; mail.wl.test is gone from the server.
    expect(
      (
        await post({
          node: 'web-1',
          certificates: [
            cert('1111111111111111', 'shop.wl.test', now + 40 * DAY, fp('a')),
            cert('2222222222222222', 'api.wl.test', now + 90 * DAY, fp('d')),
          ],
          certificateCoverage: { ...cov, at: now + 60 },
        })
      ).statusCode,
    ).toBe(204);
    r = await get('/certificates');
    expect(r.body.certificates.map((c: { names: string[] }) => c.names[0])).toEqual([
      'shop.wl.test',
      'api.wl.test',
    ]);
    const api = r.body.certificates.find((c: { id: string }) => c.id === '2222222222222222');
    expect(api.renewedDaysBefore).toBeCloseTo(2, 0);
    const detail = await get('/certificates/2222222222222222?node=web-1');
    expect(detail.status).toBe(200);
    expect(
      detail.body.history.map((h: { fingerprint: string; current: boolean }) => [
        h.fingerprint[0],
        h.current,
      ]),
    ).toEqual([
      ['d', true],
      ['b', false],
    ]);
    expect((await get('/certificates/3333333333333333?node=web-1')).status).toBe(404);
    // Events (ADR-225): renewed, and about to expire (once a day however often it's sent).
    const events = await ctx.db
      .selectFrom('k8s_events')
      .select(['host', 'involved_kind', 'involved_name', 'reason', 'count', 'message'])
      .where('cluster_id', '=', id)
      .orderBy('reason')
      .orderBy('involved_name')
      .execute();
    expect(
      events.map((e) => `${e.host} ${e.involved_kind} ${e.involved_name} ${e.reason} ${e.count}`),
    ).toEqual([
      'web-1 Certificate api.wl.test CertificateExpiring 1',
      'web-1 Certificate api.wl.test CertificateRenewed 1',
    ]);
    expect(events[1]!.message).toMatch(/^renewed 2 days before it expired; valid until /);
    expect((await get('/certificates/2222222222222222?node=web-2')).status).toBe(404);

    // An agent older than 0.10 on another server: the tab says so.
    await ctx.db
      .insertInto('agent_instances')
      .values({
        id: newId(),
        cluster_id: id,
        node: 'web-2',
        mode: 'node',
        agent_version: '0.9.10',
        last_seen_at: new Date(),
      })
      .execute();
    r = await get('/certificates');
    expect(r.body.agentsWithout).toEqual([{ node: 'web-2', version: '0.9.10' }]);
  });

  it('refuses a malformed snapshot', async () => {
    const { post } = await setup('server');
    const bad = await post({
      node: 'web-1',
      certificates: [cert('nothex', 'x.wl.test', 1, fp('a'))],
      certificateCoverage: { at: 1 },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('scheduled jobs (ADR-223, ADR-224)', () => {
  it('keep new runs once and drop gone jobs', async () => {
    const { post, get } = await setup('server');
    const t = Math.floor(Date.now() / 1000 / 3600) * 3600 - 2 * 3600; // two hours ago, on the hour
    const backup = '0123456789abcdef';
    const snap = (runs: object[], over: object = {}) =>
      post({
        node: 'web-1',
        jobs: [
          job(backup, 'backup.timer', runs, over),
          job('fedcba9876543210', 'logrotate.timer', []),
        ],
      });

    expect(
      (
        await snap([
          { start: t, end: t + 60, code: 0, result: 'success' },
          { start: t + 600, result: 'running' },
        ])
      ).statusCode,
    ).toBe(204);
    // The next snapshot resends the first run, ends the second (failed), and adds a third.
    const next = [
      { start: t, end: t + 60, code: 0, result: 'success' },
      { start: t + 600, end: t + 900, code: 2, result: 'failed' },
      { start: t + 3600, end: t + 3610, code: 0, result: 'success' },
    ];
    expect((await snap(next, { state: 'working' })).statusCode).toBe(204);
    expect((await snap(next, { state: 'working' })).statusCode).toBe(204); // unchanged: counted once

    let r = await get('/scheduled-jobs');
    expect(r.status).toBe(200);
    const b = r.body.jobs.find((j: { id: string }) => j.id === backup);
    expect(b.lastRun).toMatchObject({ startedAt: t + 3600, result: 'success', seconds: 10 });
    expect(b.recent.map((x: { result: string }) => x.result)).toEqual([
      'success',
      'failed',
      'success',
    ]);
    expect(r.body.lastDay).toEqual({ runs: 3, failures: 1 });
    const d = await get(`/scheduled-jobs/${backup}?node=web-1`);
    expect(d.status).toBe(200);
    expect(d.body.runs.map((x: { result: string }) => x.result)).toEqual([
      'success',
      'failed',
      'success',
    ]);
    // A job that runs hourly or less often keeps its runs; only a frequent one gets hourly counts.
    expect(d.body.hours).toEqual([]);

    // Search (0.10): a job by name, with its server and id for its page.
    const found = await get('/search?q=backup');
    expect(found.body.results).toContainEqual(
      expect.objectContaining({
        kind: 'scheduled_job',
        name: 'backup.timer',
        host: 'web-1',
        id: backup,
        type: 'timer',
      }),
    );

    // logrotate.timer is no longer sent: gone from the list.
    expect(
      (await post({ node: 'web-1', jobs: [job(backup, 'backup.timer', next)] })).statusCode,
    ).toBe(204);
    r = await get('/scheduled-jobs?node=web-1');
    expect(r.body.jobs.map((j: { name: string }) => j.name)).toEqual(['backup.timer']);
    expect((await get('/scheduled-jobs/fedcba9876543210?node=web-1')).status).toBe(200);
  });

  it("keep a frequent job's last 14 runs", async () => {
    const { post, get } = await setup('server');
    const t = Math.floor(Date.now() / 1000) - 3600;
    const runs = Array.from({ length: 30 }, (_, i) => ({
      start: t + i * 60,
      end: t + i * 60 + 2,
      code: 0,
      result: 'success',
    }));
    expect(
      (
        await post({
          node: 'web-1',
          jobs: [
            job('aaaaaaaaaaaaaaaa', 'queue', runs, { kind: 'cron', every: 60, frequent: true }),
          ],
        })
      ).statusCode,
    ).toBe(204);
    const d = await get('/scheduled-jobs/aaaaaaaaaaaaaaaa?node=web-1');
    expect(d.body.runs).toHaveLength(14);
    expect(d.body.hours.reduce((n: number, h: { runs: number }) => n + h.runs, 0)).toBe(30);
  });

  it("a Kubernetes cluster's CronJobs and certificates have no server", async () => {
    const { post, get } = await setup('kubernetes');
    const now = Math.floor(Date.now() / 1000);
    expect(
      (
        await post({
          node: '',
          certificates: [
            cert('4444444444444444', 'shop.wl.test', now + 9 * DAY, fp('e'), {
              endpoints: [
                {
                  kind: 'Ingress',
                  workload: 'shop/web',
                  port: 443,
                  proto: 'tls',
                  sni: 'shop.wl.test',
                  fingerprint: fp('e'),
                  notAfter: now + 9 * DAY,
                },
              ],
            }),
          ],
          certificateCoverage: { at: now },
          jobs: [
            job(
              '5555555555555555',
              'shop/nightly',
              [{ start: now - 600, end: now - 590, code: 137, result: 'failed' }],
              {
                kind: 'cronjob',
                unit: undefined,
                source: 'CronJob',
                state: 'failed',
                failedStreak: 1,
              },
            ),
          ],
        })
      ).statusCode,
    ).toBe(204);
    const c = await get('/certificates');
    expect(c.body.certificates[0]).toMatchObject({
      node: '',
      status: 'expiring',
      endpoints: [{ kind: 'Ingress', sni: 'shop.wl.test' }],
    });
    const j = await get('/scheduled-jobs/5555555555555555');
    expect(j.body.job).toMatchObject({ kind: 'cronjob', name: 'shop/nightly', state: 'failed' });
    expect(j.body.runs[0]).toMatchObject({ code: 137, result: 'failed' });
    // The backend's own events for a CronJob: failed, then recovered.
    expect(
      (
        await post({
          node: '',
          jobs: [
            job(
              '5555555555555555',
              'shop/nightly',
              [{ start: now - 60, end: now - 50, code: 0, result: 'success' }],
              { kind: 'cronjob', source: 'CronJob', state: 'working' },
            ),
          ],
        })
      ).statusCode,
    ).toBe(204);
    const evs = await ctx.db
      .selectFrom('k8s_events')
      .select(['namespace', 'involved_kind', 'involved_name', 'reason', 'message'])
      .where('involved_kind', '=', 'CronJob')
      .orderBy('reason')
      .execute();
    expect(evs.map((e) => `${e.namespace}/${e.involved_name} ${e.reason} ${e.message}`)).toEqual([
      'shop/nightly JobFailed failed with exit code 137',
      'shop/nightly JobRecovered ran successfully again',
    ]);
  });

  it('are listed by MCP, with no command line in them', async () => {
    const { post, cookie } = await setup('server');
    const now = Math.floor(Date.now() / 1000);
    expect(
      (
        await post({
          node: 'web-1',
          certificates: [cert('6666666666666666', 'shop.wl.test', now - DAY, fp('f'))],
          certificateCoverage: { at: now },
          jobs: [
            job(
              '7777777777777777',
              'pg_dump',
              [{ start: now - 300, end: now - 290, code: 1, result: 'failed' }],
              {
                kind: 'cron',
                source: '/etc/cron.d/backup',
                schedule: '*/5 * * * *',
                state: 'failed',
                failedStreak: 1,
              },
            ),
          ],
        })
      ).statusCode,
    ).toBe(204);
    const mcp = await mcpClient(ctx, cookie);
    try {
      const c = await mcp.call('list_certificates', { cluster: 'fleet' });
      expect(c.isError, c.text).toBe(false);
      expect(c.data.certificates[0]).toMatchObject({
        server: 'web-1',
        status: 'expired',
        daysLeft: -1,
      });
      const j = await mcp.call('list_scheduled_jobs', { cluster: 'fleet', state: 'failed' });
      expect(j.isError, j.text).toBe(false);
      expect(j.data.jobs[0]).toMatchObject({
        name: 'pg_dump',
        kind: 'cron',
        failedInARow: 1,
        lastRun: { exitCode: 1 },
      });
    } finally {
      await mcp.close();
    }
  });
});
