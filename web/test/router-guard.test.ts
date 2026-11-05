// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { installAuthGuard, routes, type AuthState } from '@/router';

function routerWith(state: Partial<AuthState> & { fail?: boolean }) {
  const auth: AuthState = {
    user: state.user ?? null,
    setupRequired: state.setupRequired ?? false,
    ensureLoaded: () => (state.fail ? Promise.reject(new Error('down')) : Promise.resolve()),
  };
  const router = createRouter({ history: createMemoryHistory(), routes });
  installAuthGuard(router, () => auth);
  return router;
}

async function landOn(router: ReturnType<typeof routerWith>, path: string) {
  await router.push(path);
  return router.currentRoute.value;
}

describe('auth guard', () => {
  it('sends everything to /setup while first-run setup is required', async () => {
    const router = routerWith({ setupRequired: true });
    expect((await landOn(router, '/nodes')).name).toBe('setup');
    expect((await landOn(router, '/login')).name).toBe('setup');
  });

  it('sends anonymous visitors to sign-in and remembers where they were going', async () => {
    const route = await landOn(routerWith({}), '/containers');
    expect(route.name).toBe('login');
    expect(route.query.redirect).toBe('/containers');
  });

  it('does not add a redirect for the home page', async () => {
    const route = await landOn(routerWith({}), '/');
    expect(route.name).toBe('login');
    expect(route.query.redirect).toBeUndefined();
  });

  it('lets signed-in users through and keeps them away from sign-in and setup', async () => {
    const router = routerWith({ user: { id: 'u1' } });
    expect((await landOn(router, '/alerts')).name).toBe('alerts');
    expect((await landOn(router, '/login')).path).toBe('/');
    expect((await landOn(router, '/setup')).path).toBe('/');
  });

  it('sends visitors from /setup to sign-in once setup is done', async () => {
    expect((await landOn(routerWith({}), '/setup')).name).toBe('login');
  });

  it('falls back to the sign-in page when the backend is unreachable', async () => {
    const route = await landOn(routerWith({ fail: true }), '/nodes');
    expect(route.name).toBe('login');
  });
});
