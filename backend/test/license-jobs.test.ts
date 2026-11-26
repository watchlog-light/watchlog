// SPDX-License-Identifier: AGPL-3.0-only
// The licence's upkeep in the alert-worker (ADR-232): units recorded only while a key is
// set; one email to every Owner 30 days before the end, never twice, waiting without an
// email server; the units count reads what was recorded. Clock injected, Mailpit for mail.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import {
  runLicenseJobs,
  sendExpiringEmail,
  type LicenseJobDeps,
} from '../src/modules/license/jobs.js';
import { LicenseService } from '../src/modules/license/service.js';
import { countUnits } from '../src/modules/license/units.js';
import {
  closeTestContext,
  createTestContext,
  createUserSession,
  testConfig,
  type TestContext,
} from './helpers.js';
import { DAY, licenseKey, TEST_KEYS } from './license-keys.js';
import { mailpitMessages, mailpitText, TEST_SMTP_URL } from './support/mock-providers.js';

const NOW = Date.now();
let ctx: TestContext;
let smtp: { smtp?: { transport: string; from: string } };

beforeEach(async () => {
  ctx = await createTestContext();
  smtp = { smtp: { transport: TEST_SMTP_URL, from: 'WatchLog <alerts@acme.test>' } };
});
afterEach(() => closeTestContext(ctx));

function deps(key?: string): LicenseJobDeps {
  const config = { ...testConfig(), license: key ? { key } : {} };
  return {
    db: ctx.db,
    license: new LicenseService({ config, db: ctx.db, trusted: [TEST_KEYS.x], now: () => NOW }),
    settings: async () => smtp as never,
    log: { debug: () => {}, warn: () => {} },
  };
}

async function agent(orgId: string, mode: 'node' | 'docker', n: number) {
  const cluster = newId();
  await ctx.db
    .insertInto('clusters')
    .values({
      id: cluster,
      org_id: orgId,
      name: `c-${cluster.slice(-6)}`,
      kind: mode === 'node' ? 'kubernetes' : 'server',
    })
    .execute();
  for (let i = 0; i < n; i++) {
    await ctx.db
      .insertInto('agent_instances')
      .values({
        id: newId(),
        cluster_id: cluster,
        org_id: orgId,
        node: `n${i}`,
        mode,
        agent_version: '0.15.0',
        // Within NOW's own hour, also in an hour's first minute.
        last_seen_at: new Date(NOW),
      })
      .execute();
  }
}

describe('the licence jobs', () => {
  it('without a key: nothing recorded, nothing sent', async () => {
    const { orgId } = await createUserSession(ctx.db, { role: 'owner' });
    await agent(orgId, 'node', 3);
    expect(await runLicenseJobs(deps(), NOW)).toEqual({ usage: 0, emailed: 0 });
    expect(await ctx.db.selectFrom('usage_hourly').selectAll().execute()).toEqual([]);
  });

  it('with a key: the hour’s nodes and servers recorded, and counted as units', async () => {
    const { orgId } = await createUserSession(ctx.db, { role: 'owner' });
    await agent(orgId, 'node', 3);
    await agent(orgId, 'docker', 2);
    const r = await runLicenseJobs(deps(licenseKey(NOW)), NOW);
    expect(r.usage).toBe(1);
    const u = await countUnits(ctx.db, NOW, 4);
    expect(u).toMatchObject({ used: 5, over: true });
    expect(u.peak?.parts).toEqual({ nodes: 3, servers: 2 });
  });

  it('30 days before the end: one email to every Owner, never twice; it waits for an email server', async () => {
    const a = `owner-${newId()}@acme.test`;
    const b = `owner-${newId()}@acme.test`;
    const admin = `admin-${newId()}@acme.test`;
    const { orgId } = await createUserSession(ctx.db, { role: 'owner', email: a });
    await createUserSession(ctx.db, { role: 'owner', email: b });
    await createUserSession(ctx.db, { role: 'admin', email: admin, orgId });
    const key = licenseKey(NOW, {
      expiresAt: new Date(NOW + 20 * DAY).toISOString(),
      customer: 'Acme GmbH',
    });
    smtp = {};
    expect(await sendExpiringEmail(deps(key))).toBe(0);
    expect(await ctx.db.selectFrom('license_notices').selectAll().execute()).toEqual([]);
    smtp = { smtp: { transport: TEST_SMTP_URL, from: 'WatchLog <alerts@acme.test>' } };
    expect(await sendExpiringEmail(deps(key))).toBe(2);
    expect(await sendExpiringEmail(deps(key))).toBe(0);
    const mails = await mailpitMessages(a);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.Subject).toMatch(/^Your WatchLog licence ends on /);
    const text = await mailpitText(mails[0]!.ID);
    expect(text).toContain('Acme GmbH');
    expect(text).toMatch(/nothing\s+is\s+deleted/);
    expect(await mailpitMessages(b)).toHaveLength(1);
    expect(await mailpitMessages(admin)).toHaveLength(0);
    // A key far from its end, or ended: no email.
    expect(await sendExpiringEmail(deps(licenseKey(NOW)))).toBe(0);
  });
});
