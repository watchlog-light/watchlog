// SPDX-License-Identifier: AGPL-3.0-only
// A service's or process group's last release (probable cause's "released at"): the query
// VictoriaMetrics runs must exist in MetricsQL and find a release older than the page's hour.
// Until 0.17.1 it named `tlast_change_timestamp`, which VictoriaMetrics refuses, and only
// releases inside the hour were seen.
import { describe, expect, it } from 'vitest';
import { lastReleaseQuery } from '../src/modules/servers/routes.js';
import { TEST_VM_URL } from './helpers.js';

const RUN = `release-${Date.now()}`;

describe('lastReleaseQuery', () => {
  it('finds a release three hours ago, as VictoriaMetrics answers it', async () => {
    const now = Math.floor(Date.now() / 1000);
    const release = now - 3 * 3600;
    // The counter: 0, then 1 from the release on, a sample every 5 minutes for 4 hours.
    const lines: string[] = [];
    for (let t = now - 4 * 3600; t <= now; t += 300)
      lines.push(
        JSON.stringify({
          metric: { __name__: 'watchlog_service_releases_total', run: RUN, unit: 'api.service' },
          values: [t >= release ? 1 : 0],
          timestamps: [t * 1000],
        }),
      );
    const imp = await fetch(`${TEST_VM_URL}/api/v1/import`, {
      method: 'POST',
      body: lines.join('\n'),
    });
    expect(imp.ok).toBe(true);
    await fetch(`${TEST_VM_URL}/internal/force_flush`);
    const expr = lastReleaseQuery(`watchlog_service_releases_total{run="${RUN}"}`);
    const res = await fetch(
      `${TEST_VM_URL}/api/v1/query?${new URLSearchParams({ query: expr, time: String(now) })}`,
    );
    const body = (await res.json()) as {
      status: string;
      error?: string;
      data?: { result: { value: [number, string] }[] };
    };
    expect(body.status, body.error).toBe('success');
    const at = Number(body.data!.result[0]!.value[1]);
    // The first sample at or after the release (5-minute samples).
    expect(Math.abs(at - release)).toBeLessThanOrEqual(300);
  });
});
