// SPDX-License-Identifier: AGPL-3.0-only
// Rule preview (alerts redesign item 9, ADR-096): the backtest and its API.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { VictoriaQueryClient } from '../src/lib/victoria.js';
import { backtest } from '../src/modules/alerts/preview.js';
import {
  TEST_VM_URL,
  closeTestContext,
  createTestContext,
  setupAdmin,
  type TestContext,
} from './helpers.js';
import { encode, type TestSeries } from './support/remote-write.js';

const S = 60;
const series = (values: (number | null)[]): [number, number | null][] =>
  values.map((v, i) => [i * S, v]);

describe('backtest (same rules as the worker)', () => {
  const cond = { op: '>' as const, value: 85, critical: 95 };
  it('fires only after the duration and resolves after two clean checks', () => {
    // 3 minutes above, a dip of one sample (not resolved), 2 more above, 2 below.
    expect(backtest(series([90, 90, 90, 80, 90, 90, 80, 80]), cond, 120)).toEqual({
      fired: 1,
      critical: 0,
    });
    // Too short for a 5-minute duration.
    expect(backtest(series([90, 90, 90, 80, 80]), cond, 300)).toEqual({ fired: 0, critical: 0 });
  });
  it('counts separate episodes and the ones that reached critical', () => {
    expect(backtest(series([90, 80, 80, 96, 96, 80, 80, 90]), cond, 0)).toEqual({
      fired: 3,
      critical: 1,
    });
  });
  it('treats missing samples as no data and supports "below"', () => {
    expect(backtest(series([90, null, null, 90]), cond, 120)).toEqual({ fired: 1, critical: 0 });
    expect(backtest(series([5, 5, 50]), { op: '<', value: 10 }, 0)).toEqual({
      fired: 1,
      critical: 0,
    });
  });
});

const RUN = `preview-${Date.now()}`;
const vm = new VictoriaQueryClient(TEST_VM_URL);
let ctx: TestContext;
let cookie: string;
let clusterId: string;
const api = (method: string, url: string, payload?: object) =>
  ctx.app.inject({
    method: method as 'GET',
    url: `/api/v1${url}`,
    cookies: { wl_session: cookie },
    ...(payload ? { payload } : {}),
  });

beforeEach(async () => {
  ctx = await createTestContext();
  cookie = await setupAdmin(ctx.app);
  clusterId = (await api('POST', '/clusters', { name: 'prod', kind: 'kubernetes' })).json().cluster
    .id;
});
afterEach(() => closeTestContext(ctx));
afterAll(async () => {
  await fetch(
    `${TEST_VM_URL}/api/v1/admin/tsdb/delete_series?match[]=${encodeURIComponent(`{run="${RUN}"}`)}`,
    { method: 'POST' },
  );
});

describe('POST /alert-rules/preview', () => {
  it('replays a metric rule over the last 24 h and returns the busiest series', async () => {
    // Node CPU: busy (95 %) for 20 minutes twice in the last 3 hours, idle otherwise.
    const now = Date.now();
    const start = Math.floor((now - 3 * 3600_000) / 15_000) * 15_000;
    const busy = (t: number) =>
      (t > now - 160 * 60_000 && t < now - 140 * 60_000) ||
      (t > now - 60 * 60_000 && t < now - 40 * 60_000)
        ? 0.95
        : 0.1;
    const mk = (mode: string, rate: (t: number) => number): TestSeries[] => {
      const out: TestSeries[] = [];
      let v = 0;
      for (let t = start; t <= now - 60_000; t += 15_000) {
        v += rate(t) * 15;
        out.push({
          labels: { __name__: 'watchlog_node_cpu_seconds_total', run: RUN, node: 'worker-7', mode },
          value: v,
          timestampMs: t,
        });
      }
      return out;
    };
    await vm.write({ clusterId }, encode([...mk('user', busy), ...mk('idle', (t) => 1 - busy(t))]));
    await fetch(`${TEST_VM_URL}/internal/force_flush`);

    const { rules } = (await api('GET', '/alert-rules')).json();
    const cpu = rules.find((r: { ruleKey: string }) => r.ruleKey === 'node.cpu.high');
    const ten = (await api('POST', '/alert-rules/preview', { ruleId: cpu.id })).json();
    expect(ten).toMatchObject({ kind: 'metric', fired: 2, critical: 0, hours: 24, unit: 'ratio' });
    expect(ten.series.name).toBe('worker-7');
    // Settings being edited: a 30-minute duration would not have fired.
    expect(
      (await api('POST', '/alert-rules/preview', { ruleId: cpu.id, forSeconds: 1800 })).json()
        .fired,
    ).toBe(0);
    // A custom rule that was never saved.
    const custom = await api('POST', '/alert-rules/preview', {
      metric: 'node.cpu.utilization',
      clusterId,
      scope: { node: 'worker-7' },
      condition: { op: '>', value: 0.5, critical: 0.9 },
      forSeconds: 300,
    });
    expect(custom.json()).toMatchObject({ fired: 2, critical: 2 });
  });

  it('names the busiest series where it is first: node, then mount', async () => {
    const now = Date.now();
    const disk: TestSeries[] = [];
    for (let t = now - 3600_000; t <= now - 60_000; t += 15_000) {
      for (const [state, value] of [
        ['avail', 30],
        ['size', 100],
      ] as const) {
        disk.push({
          labels: {
            __name__: 'watchlog_node_filesystem_bytes',
            run: RUN,
            node: 'worker-7',
            mount: '/var',
            state,
          },
          value,
          timestampMs: t,
        });
      }
    }
    await vm.write({ clusterId }, encode(disk));
    await fetch(`${TEST_VM_URL}/internal/force_flush`);
    const res = await api('POST', '/alert-rules/preview', {
      metric: 'node.filesystem.utilization',
      clusterId,
      scope: { node: 'worker-7' },
      condition: { op: '>', value: 0.5 },
      forSeconds: 0,
    });
    expect(res.json().series.name).toBe('worker-7 · /var');
  });

  it('counts the last 7 days of a state rule from its history', async () => {
    const { rules } = (await api('GET', '/alert-rules')).json();
    const crash = rules.find((r: { ruleKey: string }) => r.ruleKey === 'k8s.pod.crashloop');
    const orgId = (await ctx.db.selectFrom('orgs').select('id').executeTakeFirstOrThrow()).id;
    for (const daysAgo of [1, 3, 9]) {
      const at = new Date(Date.now() - daysAgo * 86_400_000);
      await ctx.db
        .insertInto('alert_states')
        .values({
          id: newId(),
          org_id: orgId,
          rule_id: crash.id,
          cluster_id: clusterId,
          fingerprint: `f${daysAgo}`,
          state: 'resolved',
          severity: 'critical',
          started_at: at,
          fired_at: at,
          resolved_at: at,
        })
        .execute();
    }
    const res = (await api('POST', '/alert-rules/preview', { ruleId: crash.id })).json();
    expect(res).toMatchObject({
      kind: 'state',
      fired: 2,
      critical: 2,
      hours: 168,
      unit: null,
      series: null,
    });
    // With the chart of the latest of them (a day ago), as on its alert page.
    const dayAgo = (Date.now() - 86_400_000) / 1000;
    expect(res.chart.markers[0].kind).toBe('started');
    expect(Math.abs(res.chart.markers[0].ts - dayAgo)).toBeLessThan(60);
    expect(res.chart.panels.map((p: { id: string }) => p.id)).toEqual([
      'restarts',
      'cpu',
      'memory',
    ]);
  });
});

describe('default rules: shared channels and reset', () => {
  it('sends every default rule to the chosen channels and resets one rule', async () => {
    const ch = (
      await api('POST', '/alert-channels', {
        type: 'email',
        name: 'Ops',
        settings: { recipients: ['ops@acme.dev'] },
        useForAllRules: false,
      })
    ).json().channel;
    const set = await api('PUT', '/alert-rules/defaults/channels', { channelIds: [ch.id] });
    const defaults = set.json().rules.filter((r: { type: string }) => r.type === 'default');
    expect(defaults.every((r: { channelIds: string[] }) => r.channelIds.join() === ch.id)).toBe(
      true,
    );

    const disk = defaults.find((r: { ruleKey: string }) => r.ruleKey === 'node.disk.usage');
    await api('PATCH', `/alert-rules/${disk.id}`, {
      condition: { op: '>', value: 0.7 },
      forSeconds: 900,
      enabled: false,
    });
    const reset = (await api('POST', `/alert-rules/${disk.id}/reset`)).json();
    expect(reset).toMatchObject({
      condition: { op: '>', value: 0.85, critical: 0.95 },
      forSeconds: 0,
      enabled: true,
      channelIds: [ch.id],
    });
  });
});
