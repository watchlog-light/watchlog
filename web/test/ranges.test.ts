// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/client';
import { chartFailure } from '@/lib/chart-error';
import { offeredRanges, withinLimit } from '@/lib/ranges';

const R = [
  { key: '1h', seconds: 3600 },
  { key: '24h', seconds: 86_400 },
  { key: '7d', seconds: 604_800 },
];

describe('ranges in the demo', () => {
  it('offers every range outside the demo, and only those within its limit in it', () => {
    expect(offeredRanges(R, null).map((r) => r.key)).toEqual(['1h', '24h', '7d']);
    expect(offeredRanges(R, 86_400).map((r) => r.key)).toEqual(['1h', '24h']);
    expect(withinLimit(604_800, 86_400)).toBe(86_400);
    expect(withinLimit(3600, 86_400)).toBe(3600);
    expect(withinLimit(604_800, null)).toBe(604_800);
  });
});

describe('a chart that failed', () => {
  it("shows a refusal's own words without Retry, and keeps Retry for errors worth retrying", () => {
    const demo = new ApiError(400, {
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'The demo shows at most the last 24 hours.',
    } as never);
    expect(chartFailure(demo)).toEqual({
      text: 'The demo shows at most the last 24 hours.',
      retry: false,
    });
    expect(chartFailure(new ApiError(503))).toEqual({ text: null, retry: true });
    expect(chartFailure(new ApiError(0))).toEqual({ text: null, retry: true });
    expect(chartFailure(new ApiError(429, { detail: 'slow down' } as never))).toEqual({
      text: null,
      retry: true,
    });
    expect(chartFailure(new ApiError(404))).toEqual({ text: null, retry: true });
    expect(chartFailure(new Error('boom'))).toEqual({ text: null, retry: true });
  });
});
