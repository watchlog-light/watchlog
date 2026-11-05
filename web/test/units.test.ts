// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { rangeWindow, since } from '@/lib/time';
import { byteAxisStep, formatBytes, formatValue } from '@/lib/units';

describe('formatting', () => {
  it('formats bytes with binary units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(134217728)).toBe('128 MiB');
    expect(formatBytes(3424256)).toBe('3.3 MiB');
  });

  it('picks binary-round byte axis steps', () => {
    const MiB = 1024 ** 2;
    // 19.2 MiB peak: ECharts' decimal ticks gave 4.8 MiB steps.
    expect(formatBytes(byteAxisStep(19.2 * MiB))).toBe('5 MiB');
    expect(formatBytes(byteAxisStep(7 * MiB))).toBe('2 MiB');
    expect(formatBytes(byteAxisStep(600 * 1024))).toBe('200 KiB');
    expect(formatBytes(byteAxisStep(3 * 1024 ** 3))).toBe('1 GiB');
    expect(formatBytes(byteAxisStep(2.4 * 1024 ** 3))).toBe('1 GiB');
    expect(byteAxisStep(3)).toBe(1);
    expect(byteAxisStep(0)).toBe(1);
  });

  it('keeps small rate ticks distinct (connections per second)', () => {
    // The edge chart's axis read "0 0 0 0 0" for rates below one per second.
    expect([0, 0.01, 0.02, 0.03, 0.04].map((v) => formatValue(v, 'per_second'))).toEqual([
      '0/s',
      '0.01/s',
      '0.02/s',
      '0.03/s',
      '0.04/s',
    ]);
    expect(formatValue(0.025, 'per_second')).toBe('0.025/s');
    expect(formatValue(1.5, 'per_second')).toBe('1.5/s');
    expect(formatValue(12.34, 'per_second')).toBe('12.3/s');
    expect(formatValue(250, 'per_second')).toBe('250/s');
  });

  it('formats each catalog unit', () => {
    expect(formatValue(0.0912, 'ratio')).toBe('9.1%');
    expect(formatValue(0.75, 'ratio')).toBe('75%');
    expect(formatValue(0.0025, 'ratio')).toBe('0.25%'); // small CPU shares keep distinct ticks
    expect(formatValue(0, 'ratio')).toBe('0%');
    expect(formatValue(0.25, 'cores')).toBe('0.25'); // no bare "m": it reads like minutes
    expect(formatValue(1.5, 'cores')).toBe('1.50');
    expect(formatValue(2048, 'bytes_per_second')).toBe('2 KiB/s');
    expect(formatValue(null, 'bytes')).toBe('–');
    expect(formatValue(Number.NaN, 'load')).toBe('–');
  });

  it('computes relative windows and uptime', () => {
    expect(rangeWindow('1h', 3_600_000_000)).toEqual([3_596_400, 3_600_000]);
    const now = Date.parse('2026-10-31T12:00:00Z');
    expect(since('2026-10-31T11:18:00Z', now)).toBe('42m');
    expect(since('2026-10-31T06:48:00Z', now)).toBe('5h 12m');
    expect(since('2026-10-28T08:00:00Z', now)).toBe('3d 4h');
  });
});
