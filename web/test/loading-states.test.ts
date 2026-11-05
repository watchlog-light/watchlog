// SPDX-License-Identifier: AGPL-3.0-only
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import ClusterSettingsPage from '@/views/ClusterSettingsPage.vue';
import ContainersPage from '@/views/ContainersPage.vue';
import SettingsPage from '@/views/SettingsPage.vue';
import { CONTAINERS, FLEET } from './docker-fixtures';
import { problem, USER } from './fetch-mock';
import { createPlugins } from './helpers';

type Reply = { status: number; body?: unknown };

/** fetch stub whose responses arrive only when the test releases them. */
function controlledFetch() {
  const pending: { path: string; release: (r: Reply) => void }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (input: RequestInfo | URL) =>
        new Promise<Response>((resolve) => {
          pending.push({
            path: String(input),
            release: (r) =>
              resolve(
                new Response(JSON.stringify(r.body ?? null), {
                  status: r.status,
                  headers: {
                    'content-type':
                      r.status >= 400 ? 'application/problem+json' : 'application/json',
                  },
                }),
              ),
          });
        }),
    ),
  );
  /** Answers every request waiting for `path`. */
  async function reply(path: string, r: Reply) {
    for (const p of pending.filter((x) => x.path === path)) {
      pending.splice(pending.indexOf(p), 1);
      p.release(r);
    }
    await flushPromises();
  }
  return { reply, pending };
}

const base = `/api/v1/clusters/${FLEET.id}`;
const ok = (body: unknown) => ({ status: 200, body });

async function mountPage(component: object, path: string) {
  const plugins = await createPlugins(path);
  useAuthStore().user = USER;
  const wrapper = mount(component, {
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
  });
  await flushPromises();
  return wrapper;
}

async function answerDocker(net: ReturnType<typeof controlledFetch>) {
  await net.reply('/api/v1/clusters', ok({ clusters: [FLEET] }));
  await net.reply(
    `${base}/docker/containers?range=3600`,
    ok({ containers: CONTAINERS, range: 3600, step: 60 }),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const has = (w: ReturnType<typeof mount>, id: string) => w.find(`[data-testid="${id}"]`).exists();

describe('Containers page loading states', () => {
  it('shows no skeleton for a response under 150 ms', async () => {
    const net = controlledFetch();
    const w = await mountPage(ContainersPage, '/containers');
    await vi.advanceTimersByTimeAsync(100);
    expect(has(w, 'containers-skeleton')).toBe(false);
    await answerDocker(net);
    await vi.advanceTimersByTimeAsync(200);
    expect(has(w, 'containers-skeleton')).toBe(false);
    expect(has(w, 'container-list')).toBe(true);
    w.unmount();
  });

  it('shows the skeleton once loading passes 150 ms, then the data', async () => {
    const net = controlledFetch();
    const w = await mountPage(ContainersPage, '/containers');
    await vi.advanceTimersByTimeAsync(160);
    expect(has(w, 'containers-skeleton')).toBe(true);
    expect(has(w, 'skeleton-table')).toBe(true);
    await answerDocker(net);
    expect(has(w, 'containers-skeleton')).toBe(false);
    expect(has(w, 'container-list')).toBe(true);
    w.unmount();
  });

  it('keeps the data on polling with a small indicator, and offers Retry when it fails', async () => {
    const net = controlledFetch();
    const w = await mountPage(ContainersPage, '/containers');
    await answerDocker(net);

    await vi.advanceTimersByTimeAsync(30_000); // poll
    await vi.advanceTimersByTimeAsync(1_000);
    expect(has(w, 'containers-skeleton')).toBe(false);
    expect(has(w, 'container-list')).toBe(true);
    expect(has(w, 'refreshing')).toBe(true);

    await net.reply(`${base}/docker/containers?range=3600`, problem(503, 'down'));
    expect(has(w, 'refreshing')).toBe(false);
    expect(has(w, 'container-list')).toBe(true); // old data stays
    expect(w.get('[data-testid="error-state"]').text()).toContain('could not be loaded');

    await w.get('[data-testid="retry"]').trigger('click');
    await flushPromises(); // the request leaves after the fleet is known
    await net.reply(
      `${base}/docker/containers?range=3600`,
      ok({ containers: CONTAINERS, range: 3600, step: 60 }),
    );
    expect(has(w, 'error-state')).toBe(false);
    w.unmount();
  });

  it('shows a full error state with Retry when the first load fails', async () => {
    const net = controlledFetch();
    const w = await mountPage(ContainersPage, '/containers');
    await net.reply('/api/v1/clusters', problem(500, 'boom'));
    expect(has(w, 'error-state')).toBe(true);
    expect(has(w, 'container-list')).toBe(false);
    expect(w.text()).not.toContain('No Docker hosts connected'); // error ≠ empty

    await w.get('[data-testid="retry"]').trigger('click');
    await answerDocker(net);
    expect(has(w, 'error-state')).toBe(false);
    expect(has(w, 'container-list')).toBe(true);
    w.unmount();
  });
});

describe('Settings loading states', () => {
  it('cluster list: delayed skeleton, then error with Retry, then the list', async () => {
    const net = controlledFetch();
    const w = await mountPage(SettingsPage, '/settings');
    expect(has(w, 'cluster-list-skeleton')).toBe(false);
    await vi.advanceTimersByTimeAsync(160);
    expect(has(w, 'cluster-list-skeleton')).toBe(true);

    await net.reply('/api/v1/clusters', problem(500, 'boom'));
    expect(has(w, 'cluster-list-skeleton')).toBe(false);
    expect(w.text()).not.toContain('No Docker fleet yet'); // not the empty state
    await w.get('[data-testid="retry"]').trigger('click');
    await net.reply('/api/v1/clusters', ok({ clusters: [FLEET] }));
    expect(w.get('[data-testid="cluster-list"]').text()).toContain('acceptance');
    w.unmount();
  });

  it('cluster detail: skeleton header while loading, "not found" on 404', async () => {
    const net = controlledFetch();
    const w = await mountPage(ClusterSettingsPage, `/settings/clusters/${FLEET.id}`);
    await vi.advanceTimersByTimeAsync(160);
    expect(has(w, 'skeleton-header')).toBe(true);
    await net.reply(`/api/v1/clusters/${FLEET.id}`, problem(404, 'missing'));
    expect(has(w, 'skeleton-header')).toBe(false);
    expect(has(w, 'error-state')).toBe(false);
    expect(w.text()).toContain('does not exist');
    w.unmount();
  });
});
