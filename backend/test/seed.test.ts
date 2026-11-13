// SPDX-License-Identifier: AGPL-3.0-only
// The seed file (WATCHLOG_SEED_FILE, ADR-122): alert rules applied at start, once, matched
// by name and never overwritten. This is how the read-only demo gets its configuration.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, inject, it } from 'vitest';
import { insertCluster } from '../src/modules/clusters/service.js';
import { tokenPrefix, verifyClusterToken } from '../src/modules/clusters/tokens.js';
import { sha256 } from '../src/lib/tokens.js';
import { ensureDemoUser } from '../src/modules/demo/service.js';
import { applySeed, loadSeedFile, SeedFileError, type Seed } from '../src/modules/seed/seed.js';
import {
  closeTestContext,
  createTestContext,
  setupAdmin,
  TEST_SECRET_KEY,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined as unknown as TestContext;
});

const dir = mkdtempSync(join(tmpdir(), 'watchlog-seed-'));
function file(name: string, content: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

const NODE_MEMORY = {
  name: 'Node memory above 75%',
  metric: 'node.memory.utilization',
  clusterId: null,
  scope: {},
  condition: { op: '>', value: 0.75, critical: 0.9 },
  forSeconds: 300,
  severity: 'warning',
};
const SEED = {
  alertRules: [
    NODE_MEMORY,
    {
      ...NODE_MEMORY,
      name: 'Shop pods keep restarting',
      metric: 'pod.restarts',
      clusterId: 'sample-cluster',
      scope: { namespaces: ['shop'] },
      condition: { op: '>', value: 3, critical: 10 },
      forSeconds: 0,
      enabled: false,
    },
    { ...NODE_MEMORY, name: 'Not a metric', metric: 'no.such.metric' },
    { ...NODE_MEMORY, name: 'Unknown cluster', clusterId: 'elsewhere' },
  ],
} as Seed;

const quiet = { info: () => {}, error: () => {} };
async function threshold() {
  return ctx.db
    .selectFrom('alert_rules')
    .select(['name', 'cluster_id', 'enabled', 'condition'])
    .where('type', '=', 'threshold')
    .orderBy('name')
    .execute();
}

describe('seed file', () => {
  it('is read and checked: unreadable or invalid files name the path and the problem', async () => {
    expect(await loadSeedFile(file('ok.json', SEED))).toEqual(SEED);
    expect(await loadSeedFile(file('empty.json', {}))).toEqual({});
    const fails = async (path: string) => {
      const err = await loadSeedFile(path).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SeedFileError);
      expect((err as Error).message).toContain(path);
      return (err as Error).message;
    };
    expect(await fails(join(dir, 'missing.json'))).toContain('cannot read');
    expect(await fails(file('bad.json', '{"alertRules": ['))).toContain('not valid JSON');
    expect(
      await fails(file('severity.json', { alertRules: [{ ...NODE_MEMORY, severity: 'loud' }] })),
    ).toContain('/alertRules/0/severity');
    // No channels (secrets stay out of seed files), no unknown keys.
    expect(await fails(file('channels.json', { channels: [] }))).toContain('invalid');
    expect(await fails(file('twice.json', { alertRules: [NODE_MEMORY, NODE_MEMORY] }))).toContain(
      'twice',
    );
  });

  it('creates each rule once, in demo mode, and never overwrites an edit', async () => {
    ctx = await createTestContext({ demoMode: true });
    await ensureDemoUser(ctx.db);
    const org = await ctx.db.selectFrom('orgs').select('id').executeTakeFirstOrThrow();
    const cluster = await insertCluster(ctx.db, org.id, 'sample-cluster', 'kubernetes');

    const first = await applySeed(ctx.db, SEED, quiet);
    expect(first.created).toEqual(['Node memory above 75%', 'Shop pods keep restarting']);
    expect(first.failed).toEqual([
      { name: 'Not a metric', reason: 'Unknown metric "no.such.metric"' },
      { name: 'Unknown cluster', reason: 'no cluster "elsewhere"' },
    ]);
    expect(await threshold()).toMatchObject([
      { name: 'Node memory above 75%', cluster_id: null, enabled: true },
      { name: 'Shop pods keep restarting', cluster_id: cluster.id, enabled: false },
    ]);

    // An edit made since (by an admin before the demo, or by hand) stays.
    await ctx.db
      .updateTable('alert_rules')
      .set({ condition: JSON.stringify({ op: '>', value: 0.5 }) })
      .where('name', '=', 'Node memory above 75%')
      .execute();
    // The next start: nothing new, nothing changed.
    const second = await applySeed(ctx.db, SEED, quiet);
    expect(second.created).toEqual([]);
    expect(second.existing).toEqual(['Node memory above 75%', 'Shop pods keep restarting']);
    const rules = await threshold();
    expect(rules).toHaveLength(2);
    expect(rules[0]!.condition).toEqual({ op: '>', value: 0.5 });

    // Visitors see the seeded rules.
    const enter = await ctx.app.inject({ method: 'POST', url: '/api/v1/demo/session' });
    const visitor = enter.cookies.find((c) => c.name === 'wl_session')!.value;
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/alert-rules',
      cookies: { wl_session: visitor },
    });
    const names = list.json().rules.map((r: { name: string }) => r.name);
    expect(names).toEqual(expect.arrayContaining(['Node memory above 75%']));
  });

  it('registers a seeded Docker fleet by its token hash, once, and a rule may name it (ADR-170)', async () => {
    ctx = await createTestContext({ demoMode: true });
    await ensureDemoUser(ctx.db);
    const token = `wl_ct_${'Dk9'.repeat(14)}z`;
    const fleet = {
      name: 'demo-docker',
      kind: 'docker' as const,
      tokenSha256: sha256(token).toString('hex'),
      tokenPrefix: tokenPrefix(token),
    };
    const seed = {
      clusters: [fleet],
      alertRules: [
        {
          ...NODE_MEMORY,
          name: 'Fleet memory',
          metric: 'host.memory.utilization',
          clusterId: 'demo-docker',
        },
      ],
    } as Seed;
    expect(await loadSeedFile(file('fleet.json', seed))).toEqual(seed);
    const first = await applySeed(ctx.db, seed, quiet);
    expect(first.failed).toEqual([]);
    expect(first.created).toEqual(['Fleet memory']);
    const owner = await verifyClusterToken(ctx.db, token);
    expect(owner).not.toBeNull();
    const cluster = await ctx.db.selectFrom('clusters').selectAll().executeTakeFirstOrThrow();
    expect(cluster).toMatchObject({ id: owner!.clusterId, name: 'demo-docker', kind: 'docker' });
    // The next start changes nothing; the token itself is nowhere in the database.
    await applySeed(ctx.db, seed, quiet);
    expect(await ctx.db.selectFrom('clusters').selectAll().execute()).toHaveLength(1);
    expect(await ctx.db.selectFrom('cluster_tokens').selectAll().execute()).toHaveLength(1);
    // A revoked token stays revoked, and a cluster of that name but another kind is left alone.
    await ctx.db.updateTable('cluster_tokens').set({ revoked_at: new Date() }).execute();
    await applySeed(ctx.db, seed, quiet);
    expect(await verifyClusterToken(ctx.db, token)).toBeNull();
    const other = `wl_ct_${'Kx7'.repeat(14)}q`;
    const org = await ctx.db.selectFrom('orgs').select('id').executeTakeFirstOrThrow();
    await insertCluster(ctx.db, org.id, 'sample-cluster', 'kubernetes');
    await applySeed(
      ctx.db,
      {
        clusters: [
          {
            ...fleet,
            name: 'sample-cluster',
            tokenSha256: sha256(other).toString('hex'),
            tokenPrefix: tokenPrefix(other),
          },
        ],
      } as Seed,
      quiet,
    );
    expect(await verifyClusterToken(ctx.db, other)).toBeNull();
    // A cluster named twice, or a token instead of its hash, stops the start.
    const twice = await loadSeedFile(file('twice.json', { clusters: [fleet, fleet] })).catch(
      (e: Error) => e,
    );
    expect((twice as Error).message).toContain('names the cluster "demo-docker" twice');
    const plain = await loadSeedFile(
      file('plain.json', { clusters: [{ ...fleet, tokenSha256: token }] }),
    ).catch((e: Error) => e);
    expect(plain).toBeInstanceOf(SeedFileError);
  });

  it('waits for first-run setup when there is no org, then applies', async () => {
    ctx = await createTestContext({}, { seed: { alertRules: [NODE_MEMORY] } as Seed });
    expect((await applySeed(ctx.db, { alertRules: [NODE_MEMORY] } as Seed, quiet)).waiting).toBe(
      true,
    );
    expect(await threshold()).toEqual([]);
    await setupAdmin(ctx.app);
    expect((await threshold()).map((r) => r.name)).toEqual(['Node memory above 75%']);
  });

  it('stops the backend at start when the file is unreadable or invalid', () => {
    const start = (seedFile: string) =>
      spawnSync(join(process.cwd(), 'node_modules/.bin/tsx'), ['src/server.ts'], {
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DATABASE_URL: inject('databaseUrl'),
          WATCHLOG_SECRET_KEY: TEST_SECRET_KEY,
          WATCHLOG_SEED_FILE: seedFile,
          PORT: '1',
        },
        encoding: 'utf8',
        timeout: 30_000,
      });
    const missing = start(join(dir, 'nope.json'));
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(`cannot read seed file ${join(dir, 'nope.json')}`);
    const invalid = start(file('bad-start.json', { alertRules: [{ name: 'x' }] }));
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toMatch(/seed file .*bad-start\.json is invalid at \/alertRules\/0/);
  });
});
