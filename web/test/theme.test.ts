// SPDX-License-Identifier: AGPL-3.0-only
// The theme (ADR-228): System follows the computer live, Light and Dark stick, the choice is
// kept in this browser and on the user, and a failed save changes nothing on screen.
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { mockFetch, problem, USER } from './fetch-mock';

type Listener = (e: { matches: boolean }) => void;

/** A controllable `prefers-color-scheme: dark` query. */
function stubScheme(dark: boolean) {
  const listeners = new Set<Listener>();
  const query = {
    matches: dark,
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => query),
  );
  return {
    listeners,
    set(d: boolean) {
      query.matches = d;
      for (const l of listeners) l({ matches: d });
    },
  };
}

async function load() {
  vi.resetModules();
  return import('@/composables/useTheme');
}

describe('useTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('follows the computer while the choice is System, live', async () => {
    const scheme = stubScheme(false);
    const { useTheme } = await load();
    const { choice, resolved } = useTheme();
    expect(choice.value).toBe('system');
    expect(resolved.value).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    scheme.set(true);
    await nextTick();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('keeps Light and Dark, stops listening and stores the choice', async () => {
    const scheme = stubScheme(true);
    const { useTheme, THEME_KEY } = await load();
    const { setChoice } = useTheme();
    setChoice('light');
    await nextTick();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
    expect(scheme.listeners.size).toBe(0);
    scheme.set(false);
    setChoice('dark');
    await nextTick();
    expect(document.documentElement.dataset.theme).toBe('dark');
    setChoice('system');
    await nextTick();
    expect(scheme.listeners.size).toBe(1);
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('starts from the stored choice and ignores junk', async () => {
    stubScheme(true);
    localStorage.setItem('watchlog.theme', 'light');
    expect((await load()).useTheme().resolved.value).toBe('light');
    localStorage.setItem('watchlog.theme', 'purple');
    expect((await load()).useTheme().choice.value).toBe('system');
  });

  it('works when storage throws (private windows)', async () => {
    stubScheme(true);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const { useTheme } = await load();
    const { choice, setChoice } = useTheme();
    expect(choice.value).toBe('system');
    setChoice('light');
    expect(choice.value).toBe('light');
    vi.restoreAllMocks();
  });
});

describe('auth store and the theme', () => {
  beforeEach(() => {
    localStorage.clear();
    stubScheme(true);
  });
  afterEach(() => vi.unstubAllGlobals());

  async function store() {
    const { useTheme } = await load();
    const { useAuthStore } = await import('@/stores/auth');
    setActivePinia(createPinia());
    return { auth: useAuthStore(), theme: useTheme() };
  }

  it("takes the user's saved theme when the session loads", async () => {
    localStorage.setItem('watchlog.theme', 'dark');
    mockFetch({
      'GET /api/v1/setup': { status: 200, body: { required: false } },
      'GET /api/v1/auth/config': problem(404, 'Not Found'),
      'GET /api/v1/me': { status: 200, body: { user: { ...USER, theme: 'light' } } },
    });
    const { auth, theme } = await store();
    await auth.ensureLoaded();
    await nextTick();
    expect(theme.choice.value).toBe('light');
    expect(localStorage.getItem('watchlog.theme')).toBe('light');
  });

  it('applies a change at once and saves it on the user', async () => {
    const { calls } = mockFetch({
      'GET /api/v1/setup': { status: 200, body: { required: false } },
      'GET /api/v1/auth/config': problem(404, 'Not Found'),
      'GET /api/v1/me': { status: 200, body: { user: USER } },
      'PATCH /api/v1/me/preferences': { status: 200, body: { user: { ...USER, theme: 'light' } } },
    });
    const { auth, theme } = await store();
    await auth.ensureLoaded();
    const saving = auth.setTheme('light');
    expect(theme.resolved.value).toBe('light');
    await saving;
    expect(calls.at(-1)).toMatchObject({
      method: 'PATCH',
      path: '/api/v1/me/preferences',
      body: { theme: 'light' },
    });
    expect(auth.user?.theme).toBe('light');
  });

  it('keeps the new theme quietly when saving fails', async () => {
    mockFetch({
      'GET /api/v1/setup': { status: 200, body: { required: false } },
      'GET /api/v1/auth/config': problem(404, 'Not Found'),
      'GET /api/v1/me': { status: 200, body: { user: USER } },
      'PATCH /api/v1/me/preferences': problem(500, 'Internal Server Error'),
    });
    const { auth, theme } = await store();
    await auth.ensureLoaded();
    await expect(auth.setTheme('dark')).resolves.toBeUndefined();
    expect(theme.choice.value).toBe('dark');
    expect(localStorage.getItem('watchlog.theme')).toBe('dark');
  });

  it('asks nothing of the server while signed out', async () => {
    const { calls } = mockFetch({});
    const { auth, theme } = await store();
    await auth.setTheme('light');
    expect(theme.choice.value).toBe('light');
    expect(calls).toHaveLength(0);
  });
});
