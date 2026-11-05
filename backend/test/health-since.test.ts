// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { healthSince } from '../src/modules/ingest/health.js';

const now = new Date('2026-10-31T10:00:00Z');
const probes = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    start: `2026-10-31T09:5${i}:00Z`,
    end: `2026-10-31T09:5${i}:01Z`,
    exit_code: 1,
  }));

describe('healthSince', () => {
  it('estimates "unhealthy since" from the probe log on first sight', () => {
    // Streak of 4 in a log of 5 with retries 3: the third failure (index 3) tipped it.
    expect(
      healthSince(
        undefined,
        'unhealthy',
        { failing_streak: 4, probes: probes(5), check: { retries: 3 } },
        now,
      ),
    ).toEqual({ since: '2026-10-31T09:53:01.000Z', estimated: false });
    // Streak longer than the log: the oldest probe is only a lower bound.
    expect(
      healthSince(undefined, 'unhealthy', { failing_streak: 300, probes: probes(5) }, now),
    ).toEqual({ since: '2026-10-31T09:50:00.000Z', estimated: true });
  });

  it('keeps the stored time while unchanged and uses now for an observed change', () => {
    const prev = {
      health: 'unhealthy',
      health_since: '2026-10-31T09:00:00Z',
      health_since_estimated: true,
    };
    expect(healthSince(prev, 'unhealthy', undefined, now)).toEqual({
      since: '2026-10-31T09:00:00Z',
      estimated: true,
    });
    expect(healthSince(prev, 'healthy', undefined, now)).toEqual({
      since: now.toISOString(),
      estimated: false,
    });
    expect(healthSince(undefined, 'healthy', undefined, now)).toEqual({
      since: now.toISOString(),
      estimated: true,
    });
    expect(healthSince(prev, undefined, undefined, now)).toBeUndefined();
  });
});
