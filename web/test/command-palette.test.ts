// SPDX-License-Identifier: AGPL-3.0-only
// The ⌘K command palette (ADR-169): matching, grouping, links and recent picks as pure
// functions (with a 15,000-name list for speed); then the dialog: the shortcut and the top
// bar's button, the combobox and grouped listbox roles, the debounced search, ↑ ↓ Enter,
// Escape returning focus, the live region, recent picks, and switching cluster.
import type { Cluster, SearchResult } from '@watchlog/api-types';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import AppTopBar from '@/components/layout/AppTopBar.vue';
import CommandPalette from '@/components/layout/CommandPalette.vue';
import {
  addRecent,
  groupItems,
  inOrder,
  loadRecent,
  matchRank,
  opensPalette,
  rankItems,
  RECENT_MAX,
  resultLink,
  saveRecent,
  type PaletteItem,
} from '@/lib/palette';
import { useAuthStore } from '@/stores/auth';
import { useClustersStore } from '@/stores/clusters';
import { mockFetch, USER, type Routes } from './fetch-mock';
import { createPlugins } from './helpers';

const cluster = (id: string, name: string, kind: Cluster['kind']): Cluster => ({
  id,
  name,
  kind,
  status: 'active',
  nodeCount: 1,
  agentVersion: 'dev',
  firstSeenAt: null,
  lastSeenAt: null,
  createdAt: '2026-11-01T00:00:00Z',
  ingestFailure: null,
});
const KIND = cluster('01a191fb-b18c-75a0-be51-47fcaa9eadde', 'kind-demo', 'kubernetes');
const FLEET = cluster('01a18f2a-22a8-7457-94af-5a66bca41e97', 'edge-fleet', 'docker');

const result = (r: Partial<SearchResult> & Pick<SearchResult, 'kind' | 'name'>): SearchResult => ({
  namespace: null,
  host: null,
  type: null,
  id: null,
  match: 'prefix',
  ...r,
});

describe('matching', () => {
  it('ranks exact, prefix, substring, path, letters, then one typo', () => {
    expect(matchRank('web', 'web')).toBe(0);
    expect(matchRank('payments api', 'payments-api-7d9f8c6b5-x2k4q')).toBe(1);
    expect(matchRank('api', 'payments-api-7d9f8c6b5-x2k4q')).toBe(2);
    expect(matchRank('shop/pay', 'payments-api', 'shop')).toBe(3);
    expect(matchRank('pay7d9', 'payments-api-7d9f8c6b5-x2k4q')).toBe(4);
    expect(matchRank('shp pay', 'payments-api', 'shop')).toBe(5);
    expect(matchRank('paymetns', 'payments-api-7d9f8c6b5-x2k4q')).toBe(6);
    expect(matchRank('Service Map', 'Service Map')).toBe(0);
    expect(matchRank('checkout', 'payments-api')).toBeNull();
    expect(matchRank('   ', 'web')).toBeNull();
    // Short words get no typo: "wbe" would match too much.
    expect(matchRank('wbe', 'web')).toBeNull();
    expect(inOrder('pay', 'p-a-y')).toBe(true);
    expect(inOrder('yap', 'pay')).toBe(false);
  });

  it('sorts the matches best first, shorter labels first', () => {
    const items = ['payments-api-worker', 'payments-api', 'shop-payments-api', 'checkout'].map(
      (label) => ({ label }),
    );
    expect(rankItems(items, 'payments api').map((i) => i.label)).toEqual([
      'payments-api',
      'payments-api-worker',
      'shop-payments-api',
    ]);
  });

  it('ranks 15,000 pod names without a noticeable pause', () => {
    const names = Array.from({ length: 15_000 }, (_, i) => ({
      label: `team-${i % 60}-payments-api-${i}-7d9f8c6b5-${(i * 7919).toString(36)}`,
    }));
    const t = performance.now();
    for (const q of ['p', 'pay', 'payments api', 'pay7d9', 'paymetns-api', 'zzzz'])
      rankItems(names, q);
    // Six full passes; a keystroke needs one (and the browser only ranks pages and clusters).
    expect(performance.now() - t).toBeLessThan(600);
  });
});

const item = (kind: PaletteItem['kind'], label: string, rank: number): PaletteItem => ({
  key: `${kind}:${label}`,
  kind,
  label,
  detail: '',
  to: '/',
  rank,
});

describe('grouping and links', () => {
  it('puts the group with the best match first, and typos only when nothing else matches', () => {
    const groups = groupItems([
      item('pod', 'node-42-x', 4),
      item('page', 'Nodes', 2),
      item('node', 'node-42', 0),
      item('workload', 'notify', 6),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(['node', 'page', 'pod']);
    expect(groupItems([item('workload', 'notify', 6)]).map((g) => g.kind)).toEqual(['workload']);
  });

  it('opens each kind on its page, in its cluster', () => {
    const id = KIND.id;
    expect(
      resultLink(
        result({ kind: 'workload', name: 'web', namespace: 'shop', type: 'Deployment' }),
        id,
      ),
    ).toEqual({
      name: 'workloads',
      query: { cluster: id, view: 'pods', wkind: 'Deployment', wns: 'shop', wname: 'web' },
    });
    expect(resultLink(result({ kind: 'pod', name: 'web-1', namespace: 'shop' }), id)).toEqual({
      name: 'pod',
      params: { namespace: 'shop', name: 'web-1' },
      query: { cluster: id },
    });
    expect(resultLink(result({ kind: 'node', name: 'n1' }), id)).toMatchObject({ name: 'node' });
    expect(resultLink(result({ kind: 'host', name: 'h1' }), id)).toMatchObject({
      name: 'docker-host',
      params: { host: 'h1' },
    });
    expect(resultLink(result({ kind: 'container', name: 'c1', host: 'h1' }), id)).toMatchObject({
      name: 'docker-container',
      params: { host: 'h1', name: 'c1' },
    });
    expect(resultLink(result({ kind: 'compose_project', name: 'shop' }), id)).toEqual({
      name: 'containers',
      query: { cluster: id, project: 'shop' },
    });
    expect(resultLink(result({ kind: 'application', name: 'shop/redis', id: 'a1' }), id)).toEqual({
      name: 'application',
      params: { id: 'a1' },
      query: { cluster: id },
    });
  });
});

describe('recent picks and shortcuts', () => {
  beforeEach(() => localStorage.clear());

  it('keeps the last five, newest first, without duplicates or ranks', () => {
    let list = loadRecent('u1');
    for (const n of ['a', 'b', 'c', 'a', 'd', 'e', 'f']) list = addRecent(list, item('pod', n, 3));
    expect(list.map((i) => i.label)).toEqual(['f', 'e', 'd', 'a', 'c']);
    expect(list).toHaveLength(RECENT_MAX);
    expect('rank' in list[0]!).toBe(false);
    saveRecent('u1', list);
    expect(loadRecent('u1').map((i) => i.label)).toEqual(['f', 'e', 'd', 'a', 'c']);
    expect(loadRecent('u2')).toEqual([]);
    localStorage.setItem('watchlog.palette.recent.u1', '{not json');
    expect(loadRecent('u1')).toEqual([]);
    localStorage.setItem('watchlog.palette.recent.u1', JSON.stringify([{ key: 1 }, null]));
    expect(loadRecent('u1')).toEqual([]);
  });

  it('opens on ⌘K and Ctrl+K anywhere, and on / outside a field', () => {
    const key = (init: KeyboardEventInit, target?: HTMLElement) => {
      const e = new KeyboardEvent('keydown', init);
      if (target) Object.defineProperty(e, 'target', { value: target });
      return opensPalette(e);
    };
    const input = document.createElement('input');
    const button = document.createElement('button');
    expect(key({ key: 'k', metaKey: true })).toBe(true);
    expect(key({ key: 'K', ctrlKey: true }, input)).toBe(true);
    expect(key({ key: 'k' })).toBe(false);
    expect(key({ key: 'k', metaKey: true, shiftKey: true })).toBe(false);
    expect(key({ key: '/' }, button)).toBe(true);
    expect(key({ key: '/' }, input)).toBe(false);
    expect(key({ key: '/', metaKey: true }, button)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------

const searchPath = (id: string, q: string) =>
  `GET /api/v1/clusters/${id}/search?q=${encodeURIComponent(q)}&limit=40`;

async function setup(path: string, routes: Routes = {}) {
  const { calls } = mockFetch({
    'GET /api/v1/clusters': { status: 200, body: { clusters: [KIND, FLEET] } },
    ...routes,
  });
  const p = await createPlugins();
  useAuthStore().user = USER;
  const clusters = useClustersStore();
  await clusters.load();
  // The cluster guard isn't installed here: select what the link names.
  clusters.select(new URLSearchParams(path.split('?')[1]).get('cluster') ?? KIND.id);
  await p.router.push(path);
  const Host = defineComponent({
    setup: () => () => h('div', [h(AppTopBar, { title: 'T' }), h(CommandPalette)]),
  });
  const w = mount(Host, {
    attachTo: document.body,
    global: { plugins: [p.router, p.i18n, p.pinia] },
  });
  mounted = w;
  await flushPromises();
  return { w, router: p.router, clusters, calls };
}

/** An option's two lines, as a screen reader reads them. */
const text = (o: Element) =>
  [...o.querySelectorAll('span.block')].map((s) => s.textContent?.trim()).join(' ');
let mounted: { unmount(): void } | null = null;
const $ = <T extends Element = HTMLElement>(s: string) => document.querySelector<T>(s);
const input = () => $<HTMLInputElement>('[data-testid="palette-input"]')!;
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(text);
const groupNames = () =>
  [...document.querySelectorAll('[data-testid^="palette-group-"]')].map((g) =>
    g.getAttribute('data-testid')!.replace('palette-group-', ''),
  );
const status = () => $('[data-testid="palette-status"]')?.textContent?.trim();
const press = async (key: string, init: KeyboardEventInit = {}, el: EventTarget = window) => {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  await flushPromises();
};
async function type(text: string, wait = true) {
  input().value = text;
  input().dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();
  if (!wait) return;
  await new Promise((r) => setTimeout(r, 200)); // the 150 ms debounce
  await flushPromises();
}

describe('the palette', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('opens from the top bar button as a combobox with a grouped listbox, and returns focus', async () => {
    await setup(`/?cluster=${KIND.id}`);
    const button = $<HTMLButtonElement>('[data-testid="palette-open"]')!;
    expect(button.getAttribute('aria-label')).toBe('Search');
    expect(button.getAttribute('aria-keyshortcuts')).toMatch(/^(Meta|Control)\+K$/);
    button.focus();
    button.click();
    await flushPromises();
    expect($('[role="dialog"]')).not.toBeNull();
    expect(input().getAttribute('role')).toBe('combobox');
    expect(input().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(input());
    expect($('[role="listbox"]')).not.toBeNull();
    // Empty: the pages of this kind and the clusters.
    expect(groupNames()).toEqual(['page', 'cluster']);
    expect(options()).toContain('Workloads Page');
    expect(options()).not.toContain('Hosts Page');
    expect(options()).toContain('kind-demo Kubernetes cluster · selected');
    expect(status()).toBe('No recent picks');

    await press('Escape', {}, input());
    expect($('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('searches the cluster 150 ms after typing, groups the answer and announces the count', async () => {
    const { calls, router } = await setup(`/?cluster=${KIND.id}`, {
      [searchPath(KIND.id, 'web')]: {
        status: 200,
        body: {
          query: 'web',
          truncated: false,
          results: [
            result({
              kind: 'workload',
              name: 'web',
              namespace: 'shop',
              type: 'Deployment',
              match: 'exact',
            }),
            result({ kind: 'pod', name: 'web-674987bb67-b24ww', namespace: 'shop' }),
            result({
              kind: 'application',
              name: 'shop/web-cache',
              namespace: 'shop',
              type: 'redis',
              id: 'app-1',
              match: 'substring',
            }),
          ],
        },
      },
    });
    await press('k', { ctrlKey: true });
    expect($('[role="dialog"]')).not.toBeNull();
    await type('w', false);
    await type('we', false);
    await type('web');
    // Only the last query went out (the debounce), and its answer is grouped.
    expect(calls.filter((c) => c.path.includes('/search'))).toHaveLength(1);
    expect(groupNames()).toEqual(['workload', 'pod', 'application']);
    expect(options()).toEqual([
      'web Deployment · shop',
      'web-674987bb67-b24ww Pod · shop',
      'shop/web-cache Redis · shop',
    ]);
    expect($('[data-testid="palette-group-workload"] img[data-logo="kubernetes"]')).not.toBeNull();
    expect($('[data-testid="palette-group-application"] img[data-logo="redis"]')).not.toBeNull();
    expect(status()).toBe('3 results');

    // The best match is highlighted; ↓ moves; Enter opens.
    const highlighted = () => text($('[data-highlighted]')!);
    expect(highlighted()).toBe('web Deployment · shop');
    await press('ArrowDown', {}, input());
    expect(highlighted()).toBe('web-674987bb67-b24ww Pod · shop');
    expect(input().getAttribute('aria-activedescendant')).toBe($('[data-highlighted]')!.id);
    await press('Enter', {}, input());
    await flushPromises();
    expect($('[role="dialog"]')).toBeNull();
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('pod'));
    expect(router.currentRoute.value.params).toEqual({
      namespace: 'shop',
      name: 'web-674987bb67-b24ww',
    });

    // It is the first recent pick next time.
    await press('k', { metaKey: true });
    expect(groupNames()[0]).toBe('recent');
    expect(options()[0]).toBe('web-674987bb67-b24ww Pod · shop');
    expect(status()).toBe('1 recent pick');
  });

  it('says when nothing matches, and when the search fails', async () => {
    await setup(`/?cluster=${KIND.id}`, {
      [searchPath(KIND.id, 'zzzz')]: {
        status: 200,
        body: { query: 'zzzz', truncated: false, results: [] },
      },
      [searchPath(KIND.id, 'qqqq')]: { status: 503, body: { title: 'down', status: 503 } },
    });
    await press('k', { ctrlKey: true });
    await type('zzzz');
    expect($('[data-testid="palette-empty"]')?.textContent).toContain('Nothing matches “zzzz”');
    expect(status()).toBe('No results');
    await type('qqqq');
    expect(status()).toBe("The search didn't answer. Pages and clusters are still listed.");
  });

  it("lists a Docker fleet's hosts, containers and Compose projects, and switches cluster", async () => {
    const { router, clusters } = await setup(`/?cluster=${FLEET.id}`, {
      [searchPath(FLEET.id, 'kind')]: {
        status: 200,
        body: { query: 'kind', truncated: false, results: [] },
      },
      [searchPath(FLEET.id, 'shop')]: {
        status: 200,
        body: {
          query: 'shop',
          truncated: false,
          results: [
            result({ kind: 'compose_project', name: 'shop', host: 'docker-01', match: 'exact' }),
            result({ kind: 'container', name: 'shop-api-1', namespace: 'shop', host: 'docker-01' }),
            result({ kind: 'host', name: 'shop-host', match: 'prefix' }),
          ],
        },
      },
    });
    await press('k', { ctrlKey: true });
    expect(options()).toContain('Hosts Page');
    expect(options()).not.toContain('Nodes Page');
    await type('shop');
    // Equal ranks keep the kinds' order: hosts before containers.
    expect(groupNames()).toEqual(['compose_project', 'host', 'container']);
    expect(options()).toEqual([
      'shop Compose project · docker-01',
      'shop-host Docker host',
      'shop-api-1 Container · shop on docker-01',
    ]);
    expect($('[data-testid="palette-group-container"] img[data-logo="docker"]')).not.toBeNull();

    // Another cluster: picking it selects it.
    await type('kind');
    expect(options()).toEqual(['kind-demo Kubernetes cluster']);
    await press('Enter', {}, input());
    await flushPromises();
    expect(clusters.selectedId).toBe(KIND.id);
    await vi.waitFor(() => expect(router.currentRoute.value.query.cluster).toBe(KIND.id));
  });

  it('opens on / outside a field, not while typing in one', async () => {
    await setup(`/settings?cluster=${KIND.id}`);
    const field = document.createElement('input');
    document.body.appendChild(field);
    await press('/', {}, field);
    expect($('[role="dialog"]')).toBeNull();
    await press('/', {}, document.body);
    expect($('[role="dialog"]')).not.toBeNull();
  });
});
