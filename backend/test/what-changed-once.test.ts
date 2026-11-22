// SPDX-License-Identifier: AGPL-3.0-only
// What changed lists a series once (ADR-229): its strongest current change, with how many
// others it had. The demo's All clusters listed MongoDB's "WiredTiger cache used" four times.
import { describe, expect, it } from 'vitest';
import { oncePerSeries, sortRows } from '../src/modules/anomaly/read.js';

const row = (
  id: string,
  over: Partial<{
    key: string;
    subject: Record<string, string>;
    until: string | null;
    peakScore: number;
    since: string;
    cluster: string;
  }>,
) => ({
  id,
  key: 'mongodb.cache.used',
  subject: { service: 'svc-1' },
  until: '2026-11-22T08:00:00.000Z',
  peakScore: 3,
  since: '2026-11-22T07:00:00.000Z',
  cluster: 'c1',
  ...over,
});

describe('oncePerSeries', () => {
  it('keeps the change still out, else the furthest, and counts the rest', () => {
    const rows = [
      row('a', { peakScore: 6, since: '2026-11-22T01:00:00.000Z' }),
      row('b', { peakScore: 4, until: null, since: '2026-11-22T09:00:00.000Z' }),
      row('c', { peakScore: 5, since: '2026-11-22T03:00:00.000Z' }),
      row('d', { peakScore: 2 }),
      row('e', { key: 'search.p95', subject: { workload: 'search' }, peakScore: 8 }),
    ];
    const once = sortRows(oncePerSeries(rows), 'furthest');
    expect(once.map((r) => [r.id, r.more ?? 0])).toEqual([
      ['e', 0],
      ['b', 3],
    ]);
    // All ended: the furthest one.
    const ended = oncePerSeries(rows.filter((r) => r.id !== 'b' && r.id !== 'e'));
    expect(ended.map((r) => [r.id, r.more])).toEqual([['a', 2]]);
  });

  it('labels in any order are one series; the same series in two clusters is two', () => {
    const rows = [
      row('a', { subject: { namespace: 'shop', pod: 'p' } }),
      row('b', { subject: { pod: 'p', namespace: 'shop' } }),
      row('c', { subject: { pod: 'p', namespace: 'shop' }, cluster: 'c2' }),
    ];
    // One cluster's What changed: one series.
    expect(oncePerSeries(rows)).toHaveLength(1);
    // All clusters: the cluster is part of the series.
    expect(oncePerSeries(rows, (r) => r.cluster)).toHaveLength(2);
  });
});
