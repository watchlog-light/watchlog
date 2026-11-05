// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { conditionBad, conditionSegments, podTone, share } from '@/lib/kube';

describe('Kubernetes view helpers', () => {
  it('divides only known values by a positive total', () => {
    expect(share(1, 4)).toBe(0.25);
    expect(share(null, 4)).toBeNull();
    expect(share(1, 0)).toBeNull();
  });

  it('gives pod statuses a tone', () => {
    expect(podTone('CrashLoopBackOff')).toBe('critical');
    expect(podTone('Init:Error')).toBe('critical');
    expect(podTone('Running')).toBe('ok');
    expect(podTone('Pending')).toBe('warning');
    expect(podTone('Completed')).toBe('neutral');
  });

  it('reads Ready the other way round from the pressure conditions', () => {
    expect(conditionBad('Ready', 1)).toBe(false);
    expect(conditionBad('Ready', 0)).toBe(true);
    expect(conditionBad('DiskPressure', 1)).toBe(true);
    expect(conditionBad('DiskPressure', 0)).toBe(false);
  });

  it('collapses condition points into good, bad and missing runs', () => {
    const pts = [0, 15, 30, 45, 60, 75].map((t) => [1000 + t, t >= 45 ? 1 : 0]);
    // A gap of 5 minutes, then data again.
    pts.push([1400, 0], [1415, 0]);
    expect(conditionSegments('MemoryPressure', pts, 1000, 1500, 15)).toEqual([
      { from: 1000, to: 1045, bad: false },
      { from: 1045, to: 1090, bad: true },
      { from: 1090, to: 1385, bad: null },
      { from: 1385, to: 1430, bad: false },
      { from: 1430, to: 1500, bad: null },
    ]);
  });
});
