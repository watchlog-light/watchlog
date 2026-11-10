// SPDX-License-Identifier: AGPL-3.0-only
// The 15 s answer cache (ADR-146): one computation per subject while fresh, shared by
// requests in flight, computed again after 15 s, and failures never kept.
import { describe, expect, it } from 'vitest';
import { AnswerCache, CAUSES_CACHE_MS } from '../src/modules/causes/cache.js';

describe('AnswerCache', () => {
  it('keeps an answer 15 s per key', async () => {
    const clock = { now: 1_000_000 };
    const cache = new AnswerCache<number>(CAUSES_CACHE_MS, () => clock.now);
    let runs = 0;
    const compute = async () => ++runs;
    expect(await cache.get('a', compute)).toBe(1);
    clock.now += 14_999;
    expect(await cache.get('a', compute)).toBe(1);
    expect(await cache.get('b', compute)).toBe(2);
    clock.now += 1;
    expect(await cache.get('a', compute)).toBe(3);
  });

  it('shares a computation in flight', async () => {
    const cache = new AnswerCache<string>();
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const compute = async () => {
      runs++;
      await gate;
      return 'answer';
    };
    const both = Promise.all([cache.get('k', compute), cache.get('k', compute)]);
    release();
    expect(await both).toEqual(['answer', 'answer']);
    expect(runs).toBe(1);
  });

  it('does not keep a failure', async () => {
    const cache = new AnswerCache<string>();
    await expect(cache.get('k', () => Promise.reject(new Error('down')))).rejects.toThrow('down');
    expect(await cache.get('k', async () => 'ok')).toBe('ok');
  });

  it('drops old entries when it grows', async () => {
    const clock = { now: 0 };
    const cache = new AnswerCache<number>(10, () => clock.now);
    for (let i = 0; i < 500; i++) await cache.get(`k${i}`, async () => i);
    clock.now = 100;
    await cache.get('new', async () => 1);
    expect(cache.size).toBe(1);
  });
});
