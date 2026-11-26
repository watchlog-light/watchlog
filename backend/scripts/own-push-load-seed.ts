// SPDX-License-Identifier: AGPL-3.0-only
// Seeds the own-metrics push load test (deploy/test/own-push-load, 1.0.3): Cloud orgs on Pro,
// each with a Server fleet (its agent's token) and own-metrics tokens. Two steps, around the
// backend's start:
//   tsx scripts/own-push-load-seed.ts role  <owner url> <app role> <app password>
//   tsx scripts/own-push-load-seed.ts orgs  <owner url> <backend url> <orgs> <tokens> <state.json>
// The state file holds tokens of a throwaway database: it is written where the caller says
// and never printed.
import { writeFileSync } from 'node:fs';
import { sql } from 'kysely';
import { grantAppRole } from '../src/db/app-role.js';
import { createDb } from '../src/db/index.js';
import { newId } from '../src/lib/ids.js';
import { createSession } from '../src/modules/auth/sessions.js';
import { issueMetricToken } from '../src/modules/own-metrics/tokens.js';

const [step, ownerUrl, ...rest] = process.argv.slice(2);
if (!ownerUrl || (step !== 'role' && step !== 'orgs')) {
  console.error('usage: own-push-load-seed.ts role|orgs <owner url> …');
  process.exit(2);
}
const owner = createDb(ownerUrl);

if (step === 'role') {
  const [role, password] = rest;
  if (!role || !/^[a-z_]+$/.test(role) || !password || /'/.test(password)) process.exit(2);
  const has = await sql<{ n: number }>`SELECT 1 AS n FROM pg_roles WHERE rolname = ${role}`.execute(
    owner,
  );
  if (has.rows.length === 0)
    await sql
      .raw(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`)
      .execute(owner);
  else await sql.raw(`ALTER ROLE ${role} LOGIN PASSWORD '${password}'`).execute(owner);
  await grantAppRole(ownerUrl, role);
  console.log(`role ${role} granted`);
} else {
  const [api, orgsArg, tokensArg, out] = rest;
  const orgs = Number(orgsArg);
  const tokens = Number(tokensArg);
  if (!api || !out || !(orgs > 0) || !(tokens > 0)) process.exit(2);
  const state: {
    id: string;
    host: string;
    clusterId: string;
    clusterToken: string;
    tokens: string[];
  }[] = [];
  for (let i = 1; i <= orgs; i++) {
    const orgId = newId();
    const userId = newId();
    await owner
      .insertInto('orgs')
      .values({ id: orgId, name: `Load ${i}`, slug: `load-${i}-${orgId.slice(0, 8)}`, plan: 'pro' })
      .execute();
    await owner
      .insertInto('users')
      .values({
        id: userId,
        email: `owner-${i}-${orgId.slice(0, 8)}@load.example`,
        name: `Owner ${i}`,
        password_hash: 'x',
      })
      .execute();
    await owner
      .insertInto('memberships')
      .values({ id: newId(), org_id: orgId, user_id: userId, role: 'owner' })
      .execute();
    await owner
      .insertInto('entitlements')
      .values({
        org_id: orgId,
        plan: 'pro',
        source: 'staff',
        users: 10,
        retention_days: 30,
        pro_features: true,
      })
      .execute();
    const session = (await createSession(owner, userId)).token;
    const res = await fetch(`${api}/api/v1/clusters`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `wl_session=${session}` },
      body: JSON.stringify({ name: 'fleet', kind: 'server' }),
    });
    if (!res.ok)
      throw new Error(`org ${i}: POST /clusters answered ${res.status} ${await res.text()}`);
    const made = (await res.json()) as { cluster: { id: string }; token: { value: string } };
    const mine: string[] = [];
    for (let k = 1; k <= tokens; k++)
      mine.push((await issueMetricToken(owner, made.cluster.id, `load ${k}`, userId)).value);
    state.push({
      id: orgId,
      host: `web-${i}`,
      clusterId: made.cluster.id,
      clusterToken: made.token.value,
      tokens: mine,
    });
  }
  writeFileSync(out, JSON.stringify({ orgs: state }), { mode: 0o600 });
  console.log(`${orgs} orgs, ${orgs * tokens} own-metrics tokens`);
}
await owner.destroy();
