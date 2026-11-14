// SPDX-License-Identifier: AGPL-3.0-only
// Alerting API (Phase 3 slice 5): status (ADR-088), alerts, silences, rules and
// channels, against mock providers and Mailpit (ADR-082).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EvaluatorLookup } from '../src/modules/alerts/engine.js';
import { ensureDefaultRules } from '../src/modules/alerts/rules.js';
import {
  closeTestContext,
  createTestContext,
  createUserSession,
  setupAdmin,
  type TestContext,
} from './helpers.js';
import { testWorker } from './support/alerts.js';
import { TEST_SMTP_URL, startMockProviders, type MockProviders } from './support/mock-providers.js';

let ctx: TestContext;
let mock: MockProviders;
let cookie: string;
let orgId: string;
let clusterId: string;

const api = (method: string, url: string, payload?: object, as = cookie) =>
  ctx.app.inject({
    method: method as 'GET',
    url: `/api/v1${url}`,
    cookies: { wl_session: as },
    ...(payload ? { payload } : {}),
  });

beforeEach(async () => {
  mock = await startMockProviders();
  ctx = await createTestContext({
    telegramApiUrl: mock.url,
    smtp: { url: TEST_SMTP_URL, from: 'WatchLog <alerts@watchlog.test>' },
    publicUrl: 'https://watchlog.example.com',
  });
  cookie = await setupAdmin(ctx.app);
  const created = await api('POST', '/clusters', { name: 'prod', kind: 'kubernetes' });
  clusterId = created.json().cluster.id;
  orgId = (await ctx.db.selectFrom('orgs').select('id').executeTakeFirstOrThrow()).id;
});
afterEach(async () => {
  await closeTestContext(ctx);
  await mock.close();
});

/** A worker whose test rule fires for the given workloads. */
function fakeWorker(active: Set<string>) {
  const lookup: EvaluatorLookup = (rule) =>
    rule.rule_key === 'k8s.pod.crashloop'
      ? {
          kinds: ['kubernetes'],
          evaluate: async () =>
            [...active].map((w) => ({
              fingerprint: `pod:wl-test/Deployment/${w}`,
              severity: 'critical' as const,
              labels: {
                namespace: 'wl-test',
                workload: w,
                workload_kind: 'Deployment',
                pod: `${w}-1`,
              },
              details: {
                summary: 'main: Error (exit 1), 6 restarts',
                pods: [`${w}-1`],
                podCount: 1,
              },
            })),
        }
      : undefined;
  const clock = { now: Date.now() };
  const worker = testWorker(ctx.db, clock, lookup, {
    prepareOrg: (id) => ensureDefaultRules(ctx.db, id),
  });
  return {
    clock,
    worker,
    async cycles(n: number) {
      for (let i = 0; i < n; i++) {
        await worker.runCycle();
        clock.now += 30_000;
      }
    },
  };
}

describe('alerting status (ADR-088)', () => {
  it('is not running until a worker completes a cycle', async () => {
    const before = await api('GET', '/alerting/status');
    expect(before.json()).toEqual({
      running: false,
      lastCycleAt: null,
      workers: 0,
      publicUrlConfigured: true,
      smtpConfigured: true,
    });
    const w = fakeWorker(new Set());
    await w.cycles(1);
    expect((await api('GET', '/alerting/status')).json()).toMatchObject({
      running: true,
      workers: 1,
    });
    // A worker that stopped 3 minutes ago no longer counts.
    await ctx.db
      .updateTable('alert_worker_heartbeats')
      .set({
        last_cycle_at: new Date(Date.now() - 180_000),
        updated_at: new Date(Date.now() - 180_000),
      })
      .execute();
    expect((await api('GET', '/alerting/status')).json()).toMatchObject({
      running: false,
      workers: 0,
    });
    await w.worker.stop();
  });
});

describe('alerts and silences', () => {
  it('lists firing alerts, pages the history and shows one alert with its messages', async () => {
    const active = new Set(['web', 'api']);
    const w = fakeWorker(active);
    await w.cycles(5);
    const firing = (await api('GET', '/alerts')).json();
    expect(firing.counts).toEqual({
      firing: 2,
      critical: 2,
      warning: 0,
      pending: 0,
      silenced: 0,
      held: 0,
    });
    expect(firing.alerts[0]).toMatchObject({
      state: 'firing',
      severity: 'critical',
      rule: { key: 'k8s.pod.crashloop', name: 'Pod CrashLoopBackOff' },
      cluster: { id: clusterId, name: 'prod' },
      summary: 'main: Error (exit 1), 6 restarts',
      podCount: 1,
    });
    expect(firing.alerts[0].title).toMatch(/^(web|api) is crash-looping$/);
    expect(firing.alerts[0].why).toBe('main: Error (exit 1), 6 restarts');

    active.clear();
    await w.cycles(2);
    active.add('web');
    await w.cycles(5);
    active.clear();
    await w.cycles(2);
    await w.worker.stop();

    const page1 = (await api('GET', '/alerts?view=history&limit=2')).json();
    expect(page1.alerts).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = (
      await api('GET', `/alerts?view=history&limit=2&cursor=${page1.nextCursor}`)
    ).json();
    expect(page2.alerts).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    expect(new Set([...page1.alerts, ...page2.alerts].map((a: { id: string }) => a.id)).size).toBe(
      3,
    );
    expect((await api('GET', '/alerts?view=history&cursor=nope')).statusCode).toBe(400);

    const web = page1.alerts.find(
      (a: { labels: { workload: string } }) => a.labels.workload === 'web',
    );
    const detail = (await api('GET', `/alerts/${web.id}`)).json();
    expect(detail.alert.state).toBe('resolved');
    expect(detail.history).toHaveLength(1); // the first episode of web
    expect(detail.notifications).toEqual([]); // no channel yet
    expect((await api('GET', '/alerts/00000000-0000-7000-8000-000000000000')).statusCode).toBe(404);
  });

  it('silences matching alerts, counts them and ends the silence on DELETE', async () => {
    const active = new Set(['web', 'api']);
    const w = fakeWorker(active);
    await w.cycles(5);
    const viewer = await createUserSession(ctx.db, { role: 'viewer', orgId });
    const body = {
      matchers: { workload: 'web', cluster: clusterId },
      durationMinutes: 60,
      comment: 'deploying',
    };
    expect((await api('POST', '/silences', body, viewer.cookie)).statusCode).toBe(403);
    expect((await api('POST', '/silences', { ...body, matchers: {} })).statusCode).toBe(400);
    const created = await api('POST', '/silences', body);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ active: true, matching: 1, comment: 'deploying' });

    await w.cycles(1);
    const list = (await api('GET', '/alerts')).json();
    expect(list.counts).toEqual({
      firing: 1,
      critical: 1,
      warning: 0,
      pending: 0,
      silenced: 1,
      held: 0,
    });
    expect((await api('GET', '/silences')).json().silences).toHaveLength(1);

    expect((await api('DELETE', `/silences/${created.json().id}`)).statusCode).toBe(204);
    expect((await api('DELETE', `/silences/${created.json().id}`)).statusCode).toBe(404);
    expect((await api('GET', '/silences')).json().silences).toEqual([]);
    expect((await api('GET', '/silences?all=true')).json().silences[0].active).toBe(false);
    await w.worker.stop();
  });
});

describe('delivery status per alert', () => {
  it("shows each channel's latest firing message on the alert", async () => {
    const hook = (
      await api('POST', '/alert-channels', {
        type: 'webhook',
        name: 'Bridge',
        settings: { url: `${mock.url}/webhook` },
      })
    ).json().channel;
    const w = fakeWorker(new Set(['web']));
    await w.cycles(5);
    await w.worker.stop();
    const [a] = (await api('GET', '/alerts')).json().alerts;
    expect(a.deliveries).toEqual([
      { channelId: hook.id, name: 'Bridge', type: 'webhook', status: 'pending', error: null },
    ]);
  });
});

describe('alert rules', () => {
  it('lists the defaults and validates changes', async () => {
    const { rules } = (await api('GET', '/alert-rules')).json();
    expect(rules.length).toBeGreaterThanOrEqual(14);
    const crash = rules.find((r: { ruleKey: string }) => r.ruleKey === 'k8s.pod.crashloop');
    const disk = rules.find((r: { ruleKey: string }) => r.ruleKey === 'node.disk.usage');
    expect(crash).toMatchObject({
      source: 'state',
      condition: null,
      forSeconds: 120,
      enabled: true,
    });
    expect(disk).toMatchObject({
      source: 'metric',
      unit: 'ratio',
      condition: { op: '>', value: 0.85, critical: 0.95 },
      appliesTo: ['kubernetes', 'docker'],
    });

    const patch = (id: string, body: object) => api('PATCH', `/alert-rules/${id}`, body);
    expect((await patch(crash.id, { condition: { op: '>', value: 1 } })).statusCode).toBe(400);
    expect((await patch(crash.id, { name: 'x' })).statusCode).toBe(400);
    expect(
      (await patch(disk.id, { condition: { op: '>', value: 0.9, critical: 0.8 } })).json().detail,
    ).toMatch(/critical threshold/);
    expect(
      (await patch(disk.id, { channelIds: ['00000000-0000-7000-8000-000000000000'] })).statusCode,
    ).toBe(400);
    const ok = await patch(disk.id, {
      condition: { op: '>', value: 0.8, critical: 0.9 },
      forSeconds: 300,
      enabled: false,
    });
    expect(ok.json()).toMatchObject({
      condition: { value: 0.8, critical: 0.9 },
      forSeconds: 300,
      enabled: false,
    });
    // An empty change answers the rule as it is (it was a 500: an UPDATE with no columns).
    const same = await patch(disk.id, {});
    expect(same.statusCode).toBe(200);
    expect(same.json()).toMatchObject({ forSeconds: 300, enabled: false });
    expect((await api('DELETE', `/alert-rules/${crash.id}`)).statusCode).toBe(409);
  });
});

describe('alert channels', () => {
  it('adds each type, keeps secrets write-only and uses the first channel for every rule', async () => {
    const slack = await api('POST', '/alert-channels', {
      type: 'slack',
      name: 'Ops Slack',
      settings: { webhookUrl: `${mock.url}/slack/T0/B0/secretpart` },
    });
    expect(slack.statusCode).toBe(201);
    expect(slack.body).not.toContain('secretpart');
    expect(slack.json().channel).toMatchObject({ secrets: { webhookUrl: '…part' } });
    const { rules } = (await api('GET', '/alert-rules')).json();
    expect(
      rules.every((r: { channelIds: string[] }) => r.channelIds.includes(slack.json().channel.id)),
    ).toBe(true);

    const hook = await api('POST', '/alert-channels', {
      type: 'webhook',
      name: 'PagerBridge',
      settings: { url: `${mock.url}/webhook` },
    });
    expect(hook.json().signingSecret).toMatch(/^[\w-]{32}$/); // shown once
    expect(hook.json().channel.ruleCount).toBe(0); // not the first channel

    const tg = await api('POST', '/alert-channels', {
      type: 'telegram',
      name: 'On-call',
      settings: { botToken: '123456:ABCdefGhIJKlmNoPQRstuVWXyz' },
    });
    expect(tg.json().channel.config).toEqual({ botName: 'watchlog_test_bot', connected: false });
    expect(tg.json().connect.link).toMatch(/^https:\/\/t\.me\/watchlog_test_bot\?start=/);
    mock.fail('/bot999', 401, '{"ok":false,"description":"Unauthorized"}');
    const badBot = await api('POST', '/alert-channels', {
      type: 'telegram',
      name: 'x',
      settings: { botToken: '999999:ABCdefGhIJKlmNoPQRstuVWXyz' },
    });
    expect(badBot.statusCode).toBe(400);
    expect(badBot.json().detail).toMatch(/Unauthorized/);

    const mail = await api('POST', '/alert-channels', {
      type: 'email',
      name: 'Team',
      settings: { recipients: ['team@example.com'] },
    });
    expect(mail.json().channel.config).toEqual({ recipients: ['team@example.com'] });
    expect(
      (await api('POST', '/alert-channels', { type: 'email', name: 'x', settings: {} })).statusCode,
    ).toBe(400);

    const list = (await api('GET', '/alert-channels')).json().channels;
    expect(list.map((c: { type: string }) => c.type)).toEqual([
      'slack',
      'webhook',
      'telegram',
      'email',
    ]);
    expect(JSON.stringify(list)).not.toContain('ABCdefGh');
  });

  it('sends a test, records the outcome, renames, reconnects Telegram and deletes', async () => {
    const hook = (
      await api('POST', '/alert-channels', {
        type: 'webhook',
        name: 'Hook',
        settings: { url: `${mock.url}/webhook` },
      })
    ).json().channel;
    const test = await api('POST', `/alert-channels/${hook.id}/test`);
    expect(test.json()).toEqual({ ok: true, error: null });
    expect(mock.to('/webhook')[0]!.headers['x-watchlog-event']).toBe('test');
    mock.fail('/webhook', 404, 'gone');
    const failed = await api('POST', `/alert-channels/${hook.id}/test`);
    expect(failed.json()).toEqual({ ok: false, error: 'Webhook answered 404: gone' });
    const after = (await api('GET', '/alert-channels')).json().channels[0];
    expect(after).toMatchObject({ lastError: 'Webhook answered 404: gone' });
    expect(after.verifiedAt).not.toBeNull();

    const renamed = await api('PATCH', `/alert-channels/${hook.id}`, { name: 'Bridge' });
    expect(renamed.json().name).toBe('Bridge');
    expect((await api('POST', `/alert-channels/${hook.id}/telegram/connect`)).statusCode).toBe(404);

    const viewer = await createUserSession(ctx.db, { role: 'viewer', orgId });
    expect(
      (await api('DELETE', `/alert-channels/${hook.id}`, undefined, viewer.cookie)).statusCode,
    ).toBe(403);
    expect((await api('DELETE', `/alert-channels/${hook.id}`)).statusCode).toBe(204);
    const { rules } = (await api('GET', '/alert-rules')).json();
    expect(rules.every((r: { channelIds: string[] }) => r.channelIds.length === 0)).toBe(true);
  });
});
