// SPDX-License-Identifier: AGPL-3.0-only
// The catalog's server keys (ADR-208): systemd services (unit.*) and process groups
// (process.*), run against a real VictoriaMetrics with series shaped as the agent sends them.
import { describe, expect, it } from 'vitest';
import { metricKinds } from '../src/modules/alerts/conditions.js';
import { buildQuery, type MetricKey } from '../src/modules/query/catalog.js';
import { encode, type TestSeries } from './support/remote-write.js';
import { TEST_VM_URL } from './helpers.js';

const RUN = `server-catalog-${Date.now()}`;

/** Two scrapes a minute apart, as the agent sends them (counters grow between). */
function series(t0: number): TestSeries[] {
  const out: TestSeries[] = [];
  const add = (name: string, labels: Record<string, string>, v0: number, v1: number) => {
    const base = { __name__: name, host: 'web-01', run: RUN, ...labels };
    out.push({ labels: base, value: v0, timestampMs: t0 });
    out.push({ labels: base, value: v1, timestampMs: t0 + 60_000 });
  };
  const orders = { unit: 'orders.service' };
  add('watchlog_service_cpu_seconds_total', orders, 100, 130);
  add('watchlog_service_cpu_throttled_seconds_total', orders, 0, 6);
  add('watchlog_service_memory_working_set_bytes', orders, 150e6, 150e6);
  add('watchlog_service_memory_limit_bytes', orders, 200e6, 200e6);
  add('watchlog_service_restarts_total', orders, 2, 5);
  add('watchlog_service_exits_total', { ...orders, exit: 'error' }, 1, 3);
  add('watchlog_service_exits_total', { ...orders, exit: 'signal' }, 0, 1);
  add('watchlog_service_oom_kills_total', orders, 0, 1);
  add('watchlog_service_state', { ...orders, state: 'active', sub: 'running' }, 1, 1);
  add('watchlog_service_state', { unit: 'billing.service', state: 'failed', sub: 'failed' }, 1, 1);
  const api = { group: 'api', unit: 'pm2-app.service' };
  add('watchlog_process_group_cpu_seconds_total', api, 10, 22);
  add('watchlog_process_group_memory_rss_bytes', api, 60e6, 61e6);
  add('watchlog_process_group_instances', api, 1, 1);
  add('watchlog_process_group_exits_total', { ...api, exit: 'error' }, 4, 6);
  add('watchlog_process_group_starts_total', api, 4, 6);
  add('watchlog_process_group_releases_total', api, 0, 1);
  return out;
}

async function query(
  expr: string,
  at: number,
): Promise<{ metric: Record<string, string>; value: [number, string] }[]> {
  const url = `${TEST_VM_URL}/api/v1/query?query=${encodeURIComponent(expr)}&time=${at / 1000}`;
  const res = await fetch(url);
  const body = (await res.json()) as { status: string; error?: string; data: { result: never[] } };
  expect(body.status, `${expr}: ${body.error ?? ''}`).toBe('success');
  return body.data.result;
}

describe('server catalog keys (ADR-208)', () => {
  it('are server metrics only', () => {
    for (const k of [
      'unit.cpu.usage',
      'unit.failed',
      'process.instances',
      'process.exits.failed.increase',
    ])
      expect(metricKinds(k)).toEqual(['server']);
    expect(metricKinds('pod.cpu.usage')).toEqual(['kubernetes']);
  });

  it('scope by unit and group, and run on VictoriaMetrics', async () => {
    const t0 = Date.now() - 5 * 60_000;
    const write = await fetch(`${TEST_VM_URL}/api/v1/write`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf', 'content-encoding': 'snappy' },
      body: encode(series(t0)),
    });
    expect(write.status).toBeLessThan(300);
    await fetch(`${TEST_VM_URL}/internal/force_flush`);
    const at = t0 + 61_000;
    const run = `run="${RUN}"`;
    const value = async (key: MetricKey, scope: Record<string, string>) => {
      const q = buildQuery(key, scope, 60);
      expect(q.expr).toContain(Object.entries(scope).map(([k, v]) => `${k}="${v}"`)[0]!);
      const r = await query(q.expr.replace(/\{/, `{${run},`), at);
      return r.length ? Number(r[0]!.value[1]) : null;
    };
    const unit = { unit: 'orders.service' };
    expect(await value('unit.memory.utilization', unit)).toBeCloseTo(0.75, 2);
    expect(await value('unit.memory.limit', unit)).toBe(200e6);
    expect(await value('unit.restarts', unit)).toBe(5);
    expect(await value('unit.restarts.increase', unit)).toBeGreaterThanOrEqual(3);
    expect(await value('unit.exits.failed.increase', unit)).toBeGreaterThanOrEqual(3);
    expect(await value('unit.oom_kills.increase', unit)).toBeGreaterThanOrEqual(1);
    expect(await value('unit.failed', { unit: 'billing.service' })).toBe(1);
    expect(await value('unit.failed', unit)).toBeNull();
    const group = { group: 'api' };
    expect(await value('process.memory.rss', group)).toBe(61e6);
    expect(await value('process.instances', group)).toBe(1);
    expect(await value('process.exits.failed.increase', group)).toBeGreaterThanOrEqual(2);
    expect(await value('process.releases.increase', group)).toBeGreaterThanOrEqual(1);
  });
});
