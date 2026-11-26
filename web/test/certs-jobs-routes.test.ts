// SPDX-License-Identifier: AGPL-3.0-only
// Certificates and scheduled jobs have their own pages (0.13.0, ADR-230): the 0.10–0.12
// addresses under Applications redirect there, with their query (the cluster, the filter),
// so links in emails, alerts and bookmarks keep working.
import { describe, expect, it } from 'vitest';
import { NAV_ITEMS } from '@/router';
import { createPlugins } from './helpers';
import { mockFetch, USER } from './fetch-mock';

describe('the old addresses under Applications', () => {
  it.each([
    [
      '/applications/certificates?cluster=c1&show=attention',
      '/certificates',
      { cluster: 'c1', show: 'attention' },
    ],
    [
      '/applications/certificates/ab12cd34ef56ab78?cluster=c1',
      '/certificates/ab12cd34ef56ab78',
      { cluster: 'c1' },
    ],
    [
      '/applications/scheduled-jobs?cluster=c2&q=backup',
      '/scheduled-jobs',
      { cluster: 'c2', q: 'backup' },
    ],
    [
      '/applications/scheduled-jobs/0123456789abcdef?node=web-1',
      '/scheduled-jobs/0123456789abcdef',
      { node: 'web-1' },
    ],
  ])('%s → %s, query kept', async (from, path, query) => {
    mockFetch({
      'GET /api/v1/setup': { status: 200, body: { required: false } },
      'GET /api/v1/me': { status: 200, body: { user: USER } },
    });
    const { router } = await createPlugins('/');
    await router.push(from).catch(() => undefined);
    expect(router.currentRoute.value.path).toBe(path);
    expect(router.currentRoute.value.query).toEqual(query);
  });

  it('Applications is the services list alone; a monitored service keeps its page', async () => {
    const { router } = await createPlugins('/');
    expect(router.resolve('/applications/01a1d459-7a5b-7519-b0e7-f1cac2729b3a').name).toBe(
      'application',
    );
    expect(router.resolve('/certificates').name).toBe('certificates');
    expect(router.resolve('/scheduled-jobs').name).toBe('scheduled-jobs');
  });

  it('the sidebar groups: the top, Running here, Investigate, the end', () => {
    const by = (g: string) => NAV_ITEMS.filter((i) => i.group === g).map((i) => i.name);
    expect(by('running')).toEqual([
      'applications',
      'certificates',
      'scheduled-jobs',
      'network',
      'your-metrics',
    ]);
    expect(by('investigate')).toEqual(['events', 'what-changed', 'service-map', 'egress']);
    expect(by('end')).toEqual(['alerts', 'settings']);
  });
});
