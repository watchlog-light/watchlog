// SPDX-License-Identifier: AGPL-3.0-only
// "Busy, retrying…" and polling that pauses (ADR-206): a 429 or a 503 that clears by itself
// keeps the data and retries; polling stops while the tab is hidden and spreads by ±20 %.
import { flushPromises, mount } from '@vue/test-utils';
import { effectScope, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, isBusy, ProblemType, retryAfterSeconds } from '@/api/client';
import BusyNote from '@/components/ui/BusyNote.vue';
import { useLoader } from '@/composables/useLoader';
import { useRangeQuery } from '@/composables/useRangeQuery';
import { jittered, usePolling } from '@/composables/usePolling';
import { anyBusy, busyDelay, holdBusy } from '@/lib/busy';
import { mockFetch } from './fetch-mock';
import { createPlugins } from './helpers';

let visibility: DocumentVisibilityState = 'visible';
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setVisibility(v: DocumentVisibilityState) {
  visibility = v;
  document.dispatchEvent(new Event('visibilitychange'));
}

const busy503 = () => new ApiError(503, { type: ProblemType.demoBusy, title: 'x', status: 503 }, 5);

describe('what counts as busy', () => {
  it('is a 429, or a 503 that says it clears by itself', () => {
    expect(isBusy(new ApiError(429))).toBe(true);
    expect(isBusy(busy503())).toBe(true);
    expect(isBusy(new ApiError(503, undefined))).toBe(true); // a proxy's page, not our JSON
    expect(isBusy(new ApiError(503, { type: 'about:blank', title: 'x', status: 503 }, 2))).toBe(
      true,
    );
    // Metrics storage down or not set up: an error, as before.
    expect(isBusy(new ApiError(503, { type: 'about:blank', title: 'x', status: 503 }))).toBe(false);
    expect(isBusy(new ApiError(500))).toBe(false);
    expect(isBusy(new ApiError(0))).toBe(false);
    expect(isBusy(new Error('x'))).toBe(false);
  });

  it('reads Retry-After as seconds or as a date', () => {
    expect(retryAfterSeconds(null)).toBeUndefined();
    expect(retryAfterSeconds('5')).toBe(5);
    const now = Date.parse('2026-11-17T12:00:00Z');
    expect(retryAfterSeconds('Tue, 17 Nov 2026 12:00:20 GMT', now)).toBe(20);
    expect(retryAfterSeconds('soon')).toBeUndefined();
  });

  it('backs off 2, 4, 8, 16 then 30 s, never sooner than Retry-After, spread up to 20 %', () => {
    const none = () => 0;
    expect([0, 1, 2, 3, 4, 9].map((n) => busyDelay(n, undefined, none))).toEqual([
      2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
    expect(busyDelay(0, 5, none)).toBe(5_000);
    expect(busyDelay(0, 5, () => 1)).toBe(6_000);
  });

  it('spreads a polling interval by ±20 %', () => {
    expect(jittered(15_000, () => 0)).toBe(12_000);
    expect(jittered(15_000, () => 0.5)).toBe(15_000);
    expect(jittered(15_000, () => 1)).toBe(18_000);
  });
});

describe('usePolling', () => {
  it('ticks about once an interval, never two at once', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    let release!: () => void;
    const tick = vi.fn(() => new Promise<void>((r) => (release = r)));
    const scope = effectScope();
    const poll = scope.run(() => usePolling(tick, 10_000))!;
    poll.start();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(tick).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(1);
    // Still running: the next one is planned only once this one finished.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(tick).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).toHaveBeenCalledTimes(2);
    scope.stop();
    release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('pauses while the tab is hidden and refreshes at once when it is visible again', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const tick = vi.fn(async () => {});
    const scope = effectScope();
    const poll = scope.run(() => usePolling(tick, 10_000))!;
    poll.start();
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(tick).toHaveBeenCalledTimes(0);
    setVisibility('visible');
    await flushPromises();
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).toHaveBeenCalledTimes(2);
    // Hidden briefly between ticks: nothing missed, nothing extra.
    setVisibility('hidden');
    setVisibility('visible');
    await flushPromises();
    expect(tick).toHaveBeenCalledTimes(2);
    scope.stop();
  });
});

describe('useLoader with a busy answer', () => {
  it('keeps the data, shows no error, says busy, and retries after Retry-After', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('first')
      .mockRejectedValueOnce(busy503())
      .mockResolvedValueOnce('second');
    const scope = effectScope();
    const page = scope.run(() => useLoader(fetcher))!;
    await page.load();
    await page.load();
    expect(page.data.value).toBe('first');
    expect(page.error.value).toBeUndefined();
    expect(page.busy.value).toBe(true);
    expect(anyBusy.value).toBe(true);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(page.data.value).toBe('second');
    expect(page.busy.value).toBe(false);
    expect(anyBusy.value).toBe(false);
    scope.stop();
  });

  it('stays on the skeleton, never an empty or error state, when the first load is busy', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ApiError(429))
      .mockRejectedValueOnce(new ApiError(429))
      .mockResolvedValueOnce('data');
    const scope = effectScope();
    const page = scope.run(() => useLoader(fetcher))!;
    await page.load();
    expect(page.pending.value).toBe(true);
    expect(page.error.value).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000); // first backoff
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_000); // then 4 s
    expect(page.data.value).toBe('data');
    expect(page.pending.value).toBe(false);
    scope.stop();
  });

  it('stops retrying and gives its mark back when the page goes away', async () => {
    const fetcher = vi.fn<() => Promise<string>>().mockRejectedValue(new ApiError(429));
    const scope = effectScope();
    const page = scope.run(() => useLoader(fetcher))!;
    await page.load();
    expect(anyBusy.value).toBe(true);
    scope.stop();
    expect(anyBusy.value).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('still shows an error for a 503 that does not clear by itself', async () => {
    const down = new ApiError(503, { type: 'about:blank', title: 'x', status: 503 });
    const scope = effectScope();
    const page = scope.run(() => useLoader(() => Promise.reject(down)))!;
    await page.load();
    expect(page.error.value).toBe(down);
    expect(page.busy.value).toBe(false);
    scope.stop();
  });
});

describe('a chart with a busy answer', () => {
  it('keeps its series, shows no error, and runs the query again', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    await createPlugins('/'); // the time range lives in the ui store
    const series = { metric: 'node.cpu.utilization', unit: '%', step: 60, series: [] };
    const { calls } = mockFetch({
      'POST /api/v1/query/range': [
        { status: 200, body: series },
        { status: 429, body: { type: 'about:blank', title: 'Too Many Requests', status: 429 } },
        { status: 200, body: { ...series, step: 120 } },
      ],
    });
    const scope = effectScope();
    const q = scope.run(() => useRangeQuery('c1', 'node.cpu.utilization', {}))!;
    await flushPromises();
    expect(q.data.value?.step).toBe(60);
    await q.refresh();
    expect(q.error.value).toBe(false);
    expect(q.busy.value).toBe(true);
    expect(q.data.value?.step).toBe(60);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toHaveLength(3);
    expect(q.data.value?.step).toBe(120);
    expect(q.busy.value).toBe(false);
    scope.stop();
  });
});

describe('BusyNote', () => {
  it('says "Busy, retrying…" while any request is busy, as a polite status', async () => {
    const { i18n } = await createPlugins('/');
    const w = mount(BusyNote, { global: { plugins: [i18n] } });
    expect(w.find('[data-testid="busy-note"]').exists()).toBe(false);
    expect(w.get('[role="status"]').attributes('aria-live')).toBe('polite');
    const give = holdBusy();
    await nextTick();
    expect(w.get('[data-testid="busy-note"]').text()).toContain('Busy, retrying…');
    give();
    give(); // once only
    await nextTick();
    expect(w.find('[data-testid="busy-note"]').exists()).toBe(false);
    expect(anyBusy.value).toBe(false);
  });
});
