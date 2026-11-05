// SPDX-License-Identifier: AGPL-3.0-only
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { mockFetch, problem, USER } from './fetch-mock';

describe('auth store', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.unstubAllGlobals());

  it('loads the signed-in user once', async () => {
    const { calls } = mockFetch({
      'GET /api/v1/setup': { status: 200, body: { required: false } },
      'GET /api/v1/me': { status: 200, body: { user: USER } },
    });
    const auth = useAuthStore();
    await Promise.all([auth.ensureLoaded(), auth.ensureLoaded()]);
    await auth.ensureLoaded();
    expect(auth.user?.email).toBe(USER.email);
    expect(calls).toHaveLength(2);
  });

  it('treats 401 from /me as signed out', async () => {
    mockFetch({
      'GET /api/v1/setup': { status: 200, body: { required: false } },
      'GET /api/v1/me': problem(401, 'Sign in to continue'),
    });
    const auth = useAuthStore();
    await auth.ensureLoaded();
    expect(auth.user).toBeNull();
    expect(auth.setupRequired).toBe(false);
  });

  it('does not ask for /me while setup is required', async () => {
    const { calls } = mockFetch({ 'GET /api/v1/setup': { status: 200, body: { required: true } } });
    const auth = useAuthStore();
    await auth.ensureLoaded();
    expect(auth.setupRequired).toBe(true);
    expect(calls.map((c) => c.path)).toEqual(['/api/v1/setup']);
  });

  it('retries loading after a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')));
    const auth = useAuthStore();
    await expect(auth.ensureLoaded()).rejects.toMatchObject({ status: 0 });
    expect(auth.loaded).toBe(false);
  });

  it('signs in, completes setup and signs out', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/auth/login': { status: 200, body: { user: USER } },
      'POST /api/v1/setup': { status: 201, body: { user: USER } },
      'POST /api/v1/auth/logout': { status: 204 },
    });
    const auth = useAuthStore();
    await auth.login({ email: USER.email, password: 'secret password' });
    expect(auth.user?.name).toBe(USER.name);
    await auth.logout();
    expect(auth.user).toBeNull();
    auth.setupRequired = true;
    await auth.completeSetup({
      code: 'ABCD',
      name: 'Ada',
      email: USER.email,
      password: 'x'.repeat(10),
    });
    expect(auth.setupRequired).toBe(false);
    expect(calls[0]).toMatchObject({ body: { email: USER.email, password: 'secret password' } });
  });

  it('surfaces problem details as ApiError', async () => {
    mockFetch({ 'POST /api/v1/auth/login': problem(401, 'Invalid email or password') });
    const auth = useAuthStore();
    const err = await auth.login({ email: 'x@example.com', password: 'nope' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(err.problem.detail).toBe('Invalid email or password');
  });
});
