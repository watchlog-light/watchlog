// SPDX-License-Identifier: AGPL-3.0-only
// Alert delivery and notification error text can carry an SMTP host or user, or part of
// a webhook URL. API-token requests never get it (ADR-125); sessions still do.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { insertCluster } from '../src/modules/clusters/service.js';
import { closeTestContext, createTestContext, setupAdmin, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined as unknown as TestContext;
});

type Cred = { cookie?: string; token?: string };
const api = (method: string, url: string, cred: Cred, extra: object = {}) =>
  ctx.app.inject({
    method: method as 'GET',
    url: `/api/v1${url}`,
    ...(cred.cookie ? { cookies: { wl_session: cred.cookie } } : {}),
    ...(cred.token ? { headers: { authorization: `Bearer ${cred.token}` } } : {}),
    ...extra,
  });

const LEAK = 'SMTP 535 auth failed for alerts@smtp.internal.example:587 (user alerts)';

describe('alert errors and API tokens', () => {
  it('leaves notification and delivery errors out for a token, not for a session', async () => {
    ctx = await createTestContext();
    const cookie = await setupAdmin(ctx.app);
    const orgId = (await api('GET', '/me', { cookie })).json().user.org.id as string;
    const cluster = await insertCluster(ctx.db, orgId, 'prod-eu', 'kubernetes');
    const ruleId = (await api('GET', '/alert-rules', { cookie })).json().rules[0].id as string;

    // A firing alert whose email delivery failed with a revealing error.
    const channelId = randomUUID();
    await ctx.db
      .insertInto('alert_channels')
      .values({ id: channelId, org_id: orgId, type: 'email', name: 'On-call mail' })
      .execute();
    const alertId = randomUUID();
    await ctx.db
      .insertInto('alert_states')
      .values({
        id: alertId,
        org_id: orgId,
        cluster_id: cluster.id,
        rule_id: ruleId,
        fingerprint: 'wl-test/oom',
        severity: 'critical',
        state: 'firing',
        started_at: new Date(Date.now() - 600_000),
        fired_at: new Date(Date.now() - 600_000),
      })
      .execute();
    const notificationId = randomUUID();
    await ctx.db
      .insertInto('notifications')
      .values({
        id: notificationId,
        org_id: orgId,
        cluster_id: cluster.id,
        channel_id: channelId,
        rule_id: ruleId,
        kind: 'firing',
        status: 'failed',
        error: LEAK,
        dedupe_key: `firing:${alertId}`,
        payload: JSON.stringify({}),
      })
      .execute();
    await ctx.db
      .insertInto('notification_alerts')
      .values({ alert_state_id: alertId, notification_id: notificationId })
      .execute();

    const created = await api('POST', '/api-tokens', { cookie }, { payload: { name: 'reader' } });
    expect(created.statusCode, created.body).toBe(201);
    const token = created.json().value as string;

    // The session sees the error: it is the owner's own diagnosis.
    const bySession = await api('GET', `/alerts/${alertId}`, { cookie });
    expect(bySession.statusCode, bySession.body).toBe(200);
    expect(bySession.body).toContain('smtp.internal.example');

    // A token sees the delivery and its status, never the text.
    const detail = await api('GET', `/alerts/${alertId}`, { token });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.body).not.toContain('smtp.internal.example');
    const body = detail.json();
    expect(body.alert.deliveries).toEqual([
      expect.objectContaining({ channelId, status: 'failed', error: null }),
    ]);
    expect(body.notifications).toEqual([
      expect.objectContaining({ id: notificationId, status: 'failed', error: null }),
    ]);

    // The list's deliveries too.
    const list = await api('GET', '/alerts', { token });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.body).not.toContain('smtp.internal.example');
  });
});
