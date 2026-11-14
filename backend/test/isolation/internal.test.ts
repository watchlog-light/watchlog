// SPDX-License-Identifier: AGPL-3.0-only
// The internal API in the isolation suite (ADR-177, ADR-178, ADR-182): its own app on its
// own listener. Every route is classified (INTERNAL_ROUTES); each answers 404 on the
// public listener (Cloud and Community) and 401 without the internal token, also for an
// unknown path; the previous token works during a rotation; and it reaches an org only
// by its id, through the owner's connection, never through a session.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createDb } from '../../src/db/index.js';
import { buildInternalApp, internalTokenMatches } from '../../src/modules/internal/app.js';
import { EntitlementsService } from '../../src/modules/entitlements/service.js';
import { SetupState } from '../../src/modules/setup/service.js';
import { testConfig } from '../helpers.js';
import { cloudWorld, seedOrg, type CloudWorld, type SeededOrg } from './cloud.js';
import { INTERNAL_ROUTES } from './classification.js';
import { inject } from 'vitest';

const TOKEN = 'i'.repeat(48);
const PREVIOUS = 'p'.repeat(48);
/** The Cloud admin's own token (SR-5); TOKEN is the billing service's. */
const ADMIN = 'a'.repeat(48);
const isAdminRoute = (route: string) => route.split(' ')[1]!.startsWith('/internal/admin');

let w: CloudWorld;
let A: SeededOrg;
let internal: FastifyInstance;
const internalRoutes: string[] = [];

beforeAll(async () => {
  w = await cloudWorld();
  A = await seedOrg(w, 'zzalpha');
  internal = await buildInternalApp(
    { token: TOKEN, previousToken: PREVIOUS, adminToken: ADMIN, host: '127.0.0.1', port: 0 },
    {
      systemDb: w.owner,
      entitlements: w.app.entitlements!,
      logLevel: 'silent',
      onRoute: (r) => {
        for (const m of [r.method].flat()) if (m !== 'HEAD') internalRoutes.push(`${m} ${r.url}`);
      },
    },
  );
  await internal.ready();
}, 120_000);

afterAll(async () => {
  await internal?.close();
  await w?.close();
});

const pathOf = (route: string, orgId: string) =>
  route.split(' ')[1]!.replace(':id', orgId) +
  (route.endsWith('/usage') ? '?from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z' : '');
const methodOf = (route: string) => route.split(' ')[0] as 'GET' | 'PUT';
const bodyOf = (route: string) =>
  methodOf(route) === 'PUT' ? { plan: 'pro', source: 'staff' } : undefined;

describe('the internal API (its own listener)', () => {
  it('classifies every route of its route table, and none is gone', () => {
    expect([...internalRoutes].sort()).toEqual([...INTERNAL_ROUTES].sort());
  });

  it('answers 404 on the public listener, signed in or not', async () => {
    const cookie = await A.session();
    for (const route of INTERNAL_ROUTES) {
      for (const headers of [
        {},
        { authorization: `Bearer ${TOKEN}` },
        { cookie: `wl_session=${cookie}` },
      ]) {
        const r = await w.app.inject({
          method: methodOf(route),
          url: pathOf(route, A.orgId),
          headers,
          ...(bodyOf(route) ? { payload: bodyOf(route) } : {}),
        });
        expect(r.statusCode, route).toBe(404);
      }
    }
  });

  it('answers 404 in Community too (no internal routes, no internal listener)', async () => {
    const db = createDb(inject('databaseUrl'));
    const community = await buildApp(testConfig(), { db, setup: new SetupState() });
    try {
      expect(community.entitlements).toBeNull();
      for (const route of INTERNAL_ROUTES) {
        const r = await community.inject({
          method: methodOf(route),
          url: pathOf(route, A.orgId),
          headers: { authorization: `Bearer ${TOKEN}` },
          ...(bodyOf(route) ? { payload: bodyOf(route) } : {}),
        });
        expect(r.statusCode, route).toBe(404);
      }
    } finally {
      await community.close();
      await db.destroy();
    }
  });

  it('answers 401 without the token, with a wrong one or a session, also on unknown paths', async () => {
    const cookie = await A.session();
    for (const route of [...INTERNAL_ROUTES, 'GET /internal/nothing-here']) {
      for (const headers of [
        {},
        { authorization: 'Bearer wrong' },
        { authorization: `Bearer ${TOKEN}x` },
        { authorization: TOKEN },
        // The other caller's token (SR-5): billing's on the admin API, the admin's elsewhere.
        { authorization: `Bearer ${isAdminRoute(route) ? TOKEN : ADMIN}` },
        { authorization: `Bearer ${isAdminRoute(route) ? PREVIOUS : ADMIN}` },
        { cookie: `wl_session=${cookie}` },
      ]) {
        const r = await internal.inject({
          method: methodOf(route),
          url: pathOf(route, A.orgId),
          headers,
          ...(bodyOf(route) ? { payload: bodyOf(route) } : {}),
        });
        expect(r.statusCode, `${route} ${JSON.stringify(headers)}`).toBe(401);
        expect(r.body).not.toContain('zzalpha');
      }
    }
  });

  it('accepts the token and the previous one; an unknown org is 404', async () => {
    for (const token of [TOKEN, PREVIOUS]) {
      const r = await internal.inject({
        method: 'GET',
        url: `/internal/orgs/${A.orgId}/entitlements`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ orgId: A.orgId, plan: 'pro', source: 'staff' });
    }
    for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      const r = await internal.inject({
        method: 'GET',
        url: `/internal/orgs/${id}/usage?from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(r.statusCode).toBe(404);
    }
  });

  it("each caller's token reaches only its own routes (SR-5)", async () => {
    const as = (token: string, url: string) =>
      internal.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${token}`, 'x-watchlog-staff': 'staff@watchlog.io' },
      });
    expect((await as(ADMIN, '/internal/admin/orgs')).statusCode).toBe(200);
    expect((await as(TOKEN, '/internal/admin/orgs')).statusCode).toBe(401);
    expect((await as(TOKEN, '/internal/admin/orgs?x=/internal/orgs')).statusCode).toBe(401);
    expect((await as(TOKEN, `/internal/orgs/${A.orgId}/entitlements`)).statusCode).toBe(200);
    expect((await as(ADMIN, `/internal/orgs/${A.orgId}/entitlements`)).statusCode).toBe(401);
    // Without an admin token configured, the admin API is off.
    const off = await buildInternalApp(
      { token: TOKEN, host: '127.0.0.1', port: 0 },
      { systemDb: w.owner, entitlements: w.app.entitlements!, logLevel: 'silent' },
    );
    try {
      for (const t of [TOKEN, ADMIN]) {
        const r = await off.inject({
          method: 'GET',
          url: '/internal/admin/orgs',
          headers: { authorization: `Bearer ${t}`, 'x-watchlog-staff': 'staff@watchlog.io' },
        });
        expect(r.statusCode).toBe(401);
      }
    } finally {
      await off.close();
    }
  });

  it('names only allowed staff when WATCHLOG_STAFF_EMAILS is set (SR-5)', async () => {
    const strict = await buildInternalApp(
      {
        token: TOKEN,
        adminToken: ADMIN,
        staffEmails: ['grace@watchlog.io'],
        host: '127.0.0.1',
        port: 0,
      },
      { systemDb: w.owner, entitlements: w.app.entitlements!, logLevel: 'silent' },
    );
    try {
      const as = (staff: string) =>
        strict.inject({
          method: 'GET',
          url: '/internal/admin/orgs',
          headers: { authorization: `Bearer ${ADMIN}`, 'x-watchlog-staff': staff },
        });
      expect((await as('Grace@watchlog.io')).statusCode).toBe(200);
      expect((await as('mallory@watchlog.io')).statusCode).toBe(403);
    } finally {
      await strict.close();
    }
  });

  it('compares the token in constant time (both values every call), never accepting empty', () => {
    const cfg = { token: TOKEN, previousToken: undefined };
    expect(internalTokenMatches(TOKEN, cfg)).toBe(true);
    expect(internalTokenMatches('', cfg)).toBe(false);
    expect(internalTokenMatches(`\u0000${TOKEN}`, cfg)).toBe(false);
    expect(internalTokenMatches(PREVIOUS, cfg)).toBe(false);
    expect(internalTokenMatches(PREVIOUS, { token: TOKEN, previousToken: PREVIOUS })).toBe(true);
  });

  it('shares the entitlements cache with the public app: a PUT is seen at once', async () => {
    const own = new EntitlementsService(w.owner);
    expect((await own.get(A.orgId)).plan).toBe('pro');
    const r = await internal.inject({
      method: 'PUT',
      url: `/internal/orgs/${A.orgId}/entitlements`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { plan: 'pro', source: 'beta', betaUntil: '2027-01-31T00:00:00Z' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      plan: 'pro',
      source: 'beta',
      betaUntil: '2027-01-31T00:00:00.000Z',
    });
    expect((await w.app.entitlements!.get(A.orgId)).source).toBe('beta');
  });
});
