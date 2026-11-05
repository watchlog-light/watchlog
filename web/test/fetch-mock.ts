// SPDX-License-Identifier: AGPL-3.0-only
import { vi } from 'vitest';

export type Route = { status: number; body?: unknown };
export type Routes = Record<string, Route | Route[]>;

/** Stubs fetch with responses keyed by "METHOD /api/v1/path"; arrays are consumed in order. */
export function mockFetch(routes: Routes) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = String(input);
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const entry = routes[`${method} ${path}`];
    const route = Array.isArray(entry) ? entry.shift() : entry;
    if (!route) throw new TypeError(`unexpected request ${method} ${path}`);
    const isProblem = route.status >= 400;
    return new Response(route.body === undefined ? null : JSON.stringify(route.body), {
      status: route.status,
      headers:
        route.body === undefined
          ? {}
          : { 'content-type': isProblem ? 'application/problem+json' : 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

export const USER = {
  id: '01a18f0e-a6c2-71ef-a7b4-42d765746d40',
  email: 'ada@example.com',
  name: 'Ada Admin',
  locale: 'en',
  role: 'owner' as const,
  org: {
    id: '01a18f0e-a6c2-71ef-a7b4-42d765746d41',
    name: 'Default',
    slug: 'default',
    plan: 'community' as const,
  },
};

export const problem = (status: number, detail: string) => ({
  status,
  body: { type: 'about:blank', title: 'Error', status, detail },
});
