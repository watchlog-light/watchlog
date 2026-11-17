// SPDX-License-Identifier: AGPL-3.0-only
// An anomaly alert's page and "Was this worth an alert?" (ADR-200; v0.8 slice 4), for a
// Kubernetes cluster and a Docker fleet: GET /alerts/:id/anomaly (the hero: now, the usual range
// at this hour, the usual band), POST and DELETE /alerts/:id/anomaly-feedback. "Normal for us"
// widens exactly that series' bucket and ends the alert's period; undo restores it. Owners and
// Admins answer, Viewers read; each answer and undo is audited. The gate: Pro answers, Cloud
// Free gets 403 `pro-feature`, Community 404. Cloud's RLS is the isolation suite's
// (cross-org.test.ts, "anomaly feedback"). The clock is injected.
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { newId } from '../src/lib/ids.js';
import { createSession } from '../src/modules/auth/sessions.js';
import { ensureAnomalyRule, ANOMALY_RULE_KEY } from '../src/modules/anomaly/alerts.js';
import { seriesHash, subjectOf } from '../src/modules/anomaly/keys.js';
import { bucketOf, scoreOf, spreadOf } from '../src/modules/anomaly/stats.js';
import { insertCluster } from '../src/modules/clusters/service.js';
import { ensureDefaultRules } from '../src/modules/alerts/rules.js';
import type { Database } from '../src/db/index.js';
import { closeTestContext, createTestContext, setupAdmin, type TestContext } from './helpers.js';

const MIN = 60_000;
const DAY = 86_400_000;
/** A Tuesday, 14:12 UTC. */
const NOW = Date.UTC(2026, 10, 17, 14, 12, 0);
const STARTED = NOW - 10 * MIN;
const BUCKET = bucketOf(STARTED);

let ctx: TestContext | undefined;
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined;
});

const CLOUD: Partial<Config> = {
  edition: 'cloud',
  cookieSecure: 'always',
  accounts: { turnstile: {}, supportEmail: 'support@watchlog.io', sampleUrl: 'https://x' },
};
const offline = (async () => new Response('offline', { status: 599 })) as typeof fetch;

async function member(db: Database, orgId: string, role: 'admin' | 'viewer') {
  const id = newId();
  await db
    .insertInto('users')
    .values({
      id,
      email: `${id}@x.test`,
      name: role === 'admin' ? 'Ada Admin' : 'Vic',
      password_hash: 'x',
    })
    .execute();
  await db
    .insertInto('memberships')
    .values({ id: newId(), org_id: orgId, user_id: id, role })
    .execute();
  return (await createSession(db, id)).token;
}

/** A Cloud org signed up through the API (Free), made Pro unless `free`. */
async function cloudOrg(free = false) {
  ctx = await createTestContext(CLOUD, { fetch: offline, now: () => NOW });
  const c = ctx;
  const res = await c.app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { email: `owner-${newId()}@acme.example`, password: 'a long enough password' },
  });
  expect(res.statusCode, res.body).toBe(201);
  const owner = res.cookies.find((x) => x.name === 'wl_session')!.value;
  const me = await c.app.inject({
    method: 'GET',
    url: '/api/v1/me',
    cookies: { wl_session: owner },
  });
  const orgId = me.json().user.org.id as string;
  if (!free) await c.app.entitlements!.put(orgId, { plan: 'pro', source: 'staff' });
  return {
    c,
    orgId,
    owner,
    admin: await member(c.db, orgId, 'admin'),
    viewer: await member(c.db, orgId, 'viewer'),
  };
}

const SERIES = {
  kubernetes: {
    key: 'workload.http.latency.p95',
    subject: {
      dst_kind: 'workload',
      dst_namespace: 'shop',
      dst_workload_kind: 'Deployment',
      dst_workload: 'checkout',
    },
    median: 0.15,
    mad: 0.01,
    value: 2.4,
    unit: 'seconds' as const,
  },
  server: {
    key: 'container.memory.working_set',
    subject: { host: 'docker-01', container: 'shop-web-1' },
    median: 230 * 2 ** 20,
    mad: 5 * 2 ** 20,
    value: 900 * 2 ** 20,
    unit: 'bytes' as const,
  },
};

/** A baseline, an open period and its firing anomaly alert, as the workers write them. */
async function anomalyAlert(c: TestContext, orgId: string, kind: 'kubernetes' | 'server') {
  const cluster = await insertCluster(c.db, orgId, `acme-${kind}`, kind);
  const s = SERIES[kind];
  const subject = subjectOf(s.subject);
  const hash = seriesHash(s.key, subject);
  await c.db
    .insertInto('anomaly_baselines')
    .values({
      org_id: orgId,
      cluster_id: cluster.id,
      series_hash: hash,
      metric: s.key,
      subject: JSON.stringify(subject),
      medians: Array(168).fill(s.median),
      mads: Array(168).fill(s.mad),
      minutes: Array(168).fill(120),
      first_seen: new Date(NOW - 10 * DAY),
      last_seen: new Date(NOW),
    })
    .execute();
  const spread = spreadOf(s.median, s.mad, s.unit);
  const period = await c.db
    .insertInto('anomaly_periods')
    .values({
      org_id: orgId,
      cluster_id: cluster.id,
      series_hash: hash,
      metric: s.key,
      subject: JSON.stringify(subject),
      started_at: new Date(STARTED),
      bucket: BUCKET,
      median: s.median,
      usual_low: Math.max(0, s.median - 2 * spread),
      usual_high: s.median + 2 * spread,
      peak_score: scoreOf(s.value, s.median, s.mad, s.unit),
      peak_value: s.value,
      peak_at: new Date(STARTED + 5 * MIN),
      last_value: s.value * 0.9,
      last_at: new Date(NOW - MIN),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await ensureDefaultRules(c.db, orgId);
  await ensureAnomalyRule(c.db, orgId, true);
  const rule = await c.db
    .selectFrom('alert_rules')
    .select('id')
    .where('org_id', '=', orgId)
    .where('rule_key', '=', ANOMALY_RULE_KEY)
    .executeTakeFirstOrThrow();
  const alertId = newId();
  await c.db
    .insertInto('alert_states')
    .values({
      id: alertId,
      org_id: orgId,
      rule_id: rule.id,
      cluster_id: cluster.id,
      fingerprint: `anomaly:${kind}`,
      state: 'firing',
      severity: 'warning',
      labels: JSON.stringify({ metric: s.key }),
      details: JSON.stringify({ period: period.id, key: s.key }),
      started_at: new Date(STARTED),
      fired_at: new Date(STARTED),
    })
    .execute();
  return { clusterId: cluster.id, alertId, periodId: period.id, hash, s };
}

const call = (
  c: TestContext,
  cookie: string,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  payload?: object,
) =>
  c.app.inject({
    method,
    url: `/api/v1${url}`,
    cookies: { wl_session: cookie },
    ...(payload ? { payload } : {}),
  });

async function audits(c: TestContext, orgId: string) {
  return c.db
    .selectFrom('audit_events')
    .select(['action', 'actor_name', 'details'])
    .where('org_id', '=', orgId)
    .where('action', 'in', ['anomaly_feedback_given', 'anomaly_feedback_undone'])
    .orderBy('at')
    .execute();
}

describe('an anomaly alert’s page and its feedback', () => {
  for (const kind of ['kubernetes', 'server'] as const) {
    it(`${kind}: the hero reads now, the usual range and band; "normal for us" widens exactly that bucket and ends the period; undo restores it; roles and audit`, async () => {
      const { c, orgId, owner, admin, viewer } = await cloudOrg();
      const a = await anomalyAlert(c, orgId, kind);

      // Any member reads the page, Viewers too.
      const hero = await call(c, viewer, 'GET', `/alerts/${a.alertId}/anomaly`);
      expect(hero.statusCode, hero.body).toBe(200);
      const h = hero.json();
      expect(h).toMatchObject({
        alert: { id: a.alertId, state: 'firing' },
        cluster: { id: a.clusterId, kind },
        key: a.s.key,
        bucket: BUCKET,
        value: a.s.value * 0.9,
        peakValue: a.s.value,
        since: new Date(STARTED).toISOString(),
        until: null,
        feedback: null,
      });
      expect(h.object.kind).toBe(kind === 'kubernetes' ? 'workload' : 'container');
      // Six hours of usual bands, one an hour, around the median.
      expect(h.chart.band.length).toBeGreaterThanOrEqual(6);
      for (const b of h.chart.band) {
        expect(b.low).toBeLessThan(a.s.median);
        expect(b.high).toBeGreaterThan(a.s.median);
      }

      // Viewers can't answer or undo.
      expect(
        (
          await call(c, viewer, 'POST', `/alerts/${a.alertId}/anomaly-feedback`, {
            answer: 'normal',
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await call(c, viewer, 'DELETE', `/alerts/${a.alertId}/anomaly-feedback`)).statusCode,
      ).toBe(403);

      // An Admin: "No, this is normal for us".
      const res = await call(c, admin, 'POST', `/alerts/${a.alertId}/anomaly-feedback`, {
        answer: 'normal',
      });
      expect(res.statusCode, res.body).toBe(201);
      const fb = res.json().feedback;
      expect(fb).toMatchObject({ answer: 'normal', by: 'Ada Admin' });
      // The widened range: the value it reached scores 4 or less, so it is within 4 spreads of
      // the median, and the usual range (2 spreads) reaches half way to it.
      const half = a.s.median + (a.s.value - a.s.median) / 2 - a.s.value * 1e-6;
      expect(fb.widenedHigh).toBeGreaterThanOrEqual(half);
      const rows = await c.db
        .selectFrom('anomaly_feedback')
        .selectAll()
        .where('org_id', '=', orgId)
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ bucket: BUCKET, answer: 'normal', value: a.s.value });
      // Exactly that bucket, that series: the value now scores 4 or less there.
      expect(Buffer.compare(rows[0]!.series_hash, a.hash)).toBe(0);
      expect(
        scoreOf(a.s.value, a.s.median, a.s.mad, a.s.unit, undefined, rows[0]!.min_spread!),
      ).toBeLessThanOrEqual(4);
      // The period ended now: the next evaluation resolves the alert.
      const p = await c.db
        .selectFrom('anomaly_periods')
        .select('ended_at')
        .where('id', '=', a.periodId)
        .executeTakeFirstOrThrow();
      expect(p.ended_at?.getTime()).toBe(NOW);
      // Shown on the page; a second answer waits for an undo.
      const after = (await call(c, viewer, 'GET', `/alerts/${a.alertId}/anomaly`)).json();
      expect(after.feedback).toMatchObject({ answer: 'normal', by: 'Ada Admin' });
      expect(
        after.chart.band.find((b: { from: string }) => bucketOf(Date.parse(b.from)) === BUCKET)
          .high,
      ).toBeGreaterThanOrEqual(half);
      expect(
        after.chart.band.find((b: { from: string }) => bucketOf(Date.parse(b.from)) !== BUCKET)
          .high,
      ).toBeLessThan(a.s.value);
      expect(
        (
          await call(c, owner, 'POST', `/alerts/${a.alertId}/anomaly-feedback`, {
            answer: 'useful',
          })
        ).statusCode,
      ).toBe(409);

      // The Owner undoes it: the widening is gone.
      expect(
        (await call(c, owner, 'DELETE', `/alerts/${a.alertId}/anomaly-feedback`)).statusCode,
      ).toBe(204);
      const undone = await c.db
        .selectFrom('anomaly_feedback')
        .select(['undone_at', 'undone_by_name'])
        .where('org_id', '=', orgId)
        .executeTakeFirstOrThrow();
      expect(undone.undone_at?.getTime()).toBe(NOW);
      const back = (await call(c, viewer, 'GET', `/alerts/${a.alertId}/anomaly`)).json();
      expect(back.feedback).toBeNull();
      expect(back.chart.band.every((b: { high: number }) => b.high < a.s.value)).toBe(true);
      expect(
        (await call(c, owner, 'DELETE', `/alerts/${a.alertId}/anomaly-feedback`)).statusCode,
      ).toBe(404);

      // "Yes, keep alerting": stored for tuning, nothing widened.
      const yes = await call(c, owner, 'POST', `/alerts/${a.alertId}/anomaly-feedback`, {
        answer: 'useful',
      });
      expect(yes.statusCode).toBe(201);
      expect(yes.json().feedback.widenedHigh).toBeUndefined();

      // Every answer and undo is audited, with who and what.
      const log = await audits(c, orgId);
      expect(log.map((e) => [e.action, e.actor_name])).toEqual([
        ['anomaly_feedback_given', 'Ada Admin'],
        ['anomaly_feedback_undone', expect.stringContaining('owner-')],
        ['anomaly_feedback_given', expect.stringContaining('owner-')],
      ]);
      expect(log[0]!.details).toMatchObject({
        alert: a.alertId,
        cluster: a.clusterId,
        metric: a.s.key,
        answer: 'normal',
        bucket: BUCKET,
      });
    });
  }

  it('another rule’s alert, or an unknown id: 404', async () => {
    const { c, orgId, owner } = await cloudOrg();
    await anomalyAlert(c, orgId, 'kubernetes');
    const crash = await c.db
      .selectFrom('alert_rules')
      .select('id')
      .where('org_id', '=', orgId)
      .where('rule_key', '=', 'k8s.pod.crashloop')
      .executeTakeFirstOrThrow();
    const cluster = await c.db
      .selectFrom('clusters')
      .select('id')
      .where('org_id', '=', orgId)
      .executeTakeFirstOrThrow();
    const other = newId();
    await c.db
      .insertInto('alert_states')
      .values({
        id: other,
        org_id: orgId,
        rule_id: crash.id,
        cluster_id: cluster.id,
        fingerprint: 'x',
        state: 'firing',
        severity: 'critical',
        started_at: new Date(STARTED),
      })
      .execute();
    for (const id of [other, newId()]) {
      expect((await call(c, owner, 'GET', `/alerts/${id}/anomaly`)).statusCode).toBe(404);
      expect(
        (await call(c, owner, 'POST', `/alerts/${id}/anomaly-feedback`, { answer: 'normal' }))
          .statusCode,
      ).toBe(404);
      expect((await call(c, owner, 'DELETE', `/alerts/${id}/anomaly-feedback`)).statusCode).toBe(
        404,
      );
    }
  });
});

describe('the gate (ADR-195, ADR-200)', () => {
  it('Cloud Free: 403 pro-feature on both platforms, nothing read or written', async () => {
    const { c, orgId, owner } = await cloudOrg(true);
    for (const kind of ['kubernetes', 'server'] as const) {
      const a = await anomalyAlert(c, orgId, kind);
      for (const [method, url, body] of [
        ['GET', `/alerts/${a.alertId}/anomaly`, undefined],
        ['POST', `/alerts/${a.alertId}/anomaly-feedback`, { answer: 'normal' }],
        ['DELETE', `/alerts/${a.alertId}/anomaly-feedback`, undefined],
      ] as const) {
        const r = await call(c, owner, method, url, body);
        expect(r.statusCode, `${method} ${url}`).toBe(403);
        expect(r.json().type).toBe('urn:watchlog:problem:pro-feature');
      }
    }
    expect(await c.db.selectFrom('anomaly_feedback').select('id').execute()).toEqual([]);
  });

  it('Community: 404 on both platforms, as if the routes weren’t there', async () => {
    ctx = await createTestContext({}, { now: () => NOW });
    const cookie = await setupAdmin(ctx.app);
    const org = await ctx.db.selectFrom('orgs').select('id').executeTakeFirstOrThrow();
    for (const kind of ['kubernetes', 'server'] as const) {
      const a = await anomalyAlert(ctx, org.id, kind);
      for (const [method, url, body] of [
        ['GET', `/alerts/${a.alertId}/anomaly`, undefined],
        ['POST', `/alerts/${a.alertId}/anomaly-feedback`, { answer: 'normal' }],
        ['DELETE', `/alerts/${a.alertId}/anomaly-feedback`, undefined],
      ] as const) {
        expect((await call(ctx, cookie, method, url, body)).statusCode, `${method} ${url}`).toBe(
          404,
        );
      }
    }
  });
});
