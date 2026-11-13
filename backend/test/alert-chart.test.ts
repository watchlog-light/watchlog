// SPDX-License-Identifier: AGPL-3.0-only
// The chart of an alert (alert detail page) and what each rule charts (rule-charts.ts),
// against VictoriaMetrics with fixture series.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { authorisedScope, VictoriaQueryClient } from '../src/lib/victoria.js';
import { chartWindow } from '../src/modules/alerts/alert-chart.js';
import { RULE_CHARTS, bandRows, densify } from '../src/modules/alerts/rule-charts.js';
import { DEFAULT_RULES } from '../src/modules/alerts/rules.js';
import {
  TEST_VM_URL,
  closeTestContext,
  createTestContext,
  setupAdmin,
  type TestContext,
} from './helpers.js';
import { encode, type TestSeries } from './support/remote-write.js';

describe('the window around an alert', () => {
  const at = (h: number, m = 0) => Date.UTC(2026, 10, 1, h, m);
  const s = (ms: number) => ms / 1000;
  it('starts 2× the rule duration (at least 30 min) before the condition and ends when it resolved', () => {
    expect(chartWindow({ startedAt: at(10), resolvedAt: at(11) }, 0, at(12))).toEqual({
      from: s(at(9, 30)),
      to: s(at(11)),
    });
    expect(chartWindow({ startedAt: at(10), resolvedAt: null }, 3600, at(12))).toEqual({
      from: s(at(8)),
      to: s(at(12)),
    });
  });
  it('widens to a longer picked range, never narrows', () => {
    const open = { startedAt: at(10), resolvedAt: null };
    expect(chartWindow(open, 0, at(12), 86_400)).toEqual({
      from: s(at(12)) - 86_400,
      to: s(at(12)),
    });
    expect(chartWindow(open, 0, at(12), 600)).toEqual({ from: s(at(9, 30)), to: s(at(12)) });
  });
});

describe('state timelines and gaps', () => {
  it('takes the newest state at each step and merges runs into segments', () => {
    // Only the current state has a series; the old one lingers a step after a change.
    const rows = bandRows(
      [
        {
          labels: { condition: 'Ready', status: 'true' },
          points: [
            [0, 0],
            [60, 60],
            [120, 60],
          ],
        },
        {
          labels: { condition: 'Ready', status: 'false' },
          points: [
            [120, 120],
            [180, 180],
          ],
        },
      ],
      (l) => l.condition!,
      (l) => (l.status === 'true' ? 'True' : 'False'),
      (_r, st) => (st === 'True' ? 'ok' : 'critical'),
      60,
    );
    expect(rows).toEqual([
      {
        name: 'Ready',
        segments: [
          { from: 0, to: 120, state: 'True', tone: 'ok' },
          { from: 120, to: 240, state: 'False', tone: 'critical' },
        ],
      },
    ]);
  });
  it('keeps missing steps as gaps instead of joining the line across them', () => {
    expect(
      densify(
        [
          [60, 1],
          [240, 2],
        ],
        0,
        240,
        60,
      ),
    ).toEqual([
      [0, null],
      [60, 1],
      [120, null],
      [180, null],
      [240, 2],
    ]);
  });
  it('has a chart for every default rule', () => {
    for (const d of DEFAULT_RULES) {
      expect(!!RULE_CHARTS[d.key] || !!d.metrics, d.key).toBe(true);
    }
  });
});

// ---------------------------------------------------------------- API with fixtures

const RUN = `chart-${Date.now()}`;
const vm = new VictoriaQueryClient(TEST_VM_URL);
const NOW = Math.floor(Date.now() / 15_000) * 15_000;
const T = (min: number) => NOW + min * 60_000;
const sec = (min: number) => Math.floor(T(min) / 1000);
let ctx: TestContext;
let cookie: string;
let orgId: string;
let kube: string;
let docker: string;

const api = (url: string) =>
  ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, cookies: { wl_session: cookie } });

/** A series sampled every 15 s over [from, to] minutes; null skips a sample. */
function gen(
  name: string,
  labels: Record<string, string>,
  value: (min: number) => number | null,
  from = -70,
  to = 0,
): TestSeries[] {
  const out: TestSeries[] = [];
  for (let t = T(from); t <= T(to); t += 15_000) {
    const v = value((t - NOW) / 60_000);
    if (v !== null)
      out.push({ labels: { __name__: name, run: RUN, ...labels }, value: v, timestampMs: t });
  }
  return out;
}
async function write(clusterId: string, series: TestSeries[]) {
  await vm.write(authorisedScope(clusterId), encode(series));
  await fetch(`${TEST_VM_URL}/internal/force_flush`);
}

async function alertOf(
  ruleKey: string,
  clusterId: string,
  o: {
    labels: Record<string, string>;
    details?: Record<string, unknown>;
    started: number;
    fired?: number | null;
    resolved?: number | null;
    snapshot?: Record<string, unknown>;
    fingerprint?: string;
  },
): Promise<string> {
  const rule = await ctx.db
    .selectFrom('alert_rules')
    .select('id')
    .where('rule_key', '=', ruleKey)
    .executeTakeFirstOrThrow();
  const id = newId();
  const resolved = o.resolved ?? null;
  await ctx.db
    .insertInto('alert_states')
    .values({
      id,
      org_id: orgId,
      rule_id: rule.id,
      cluster_id: clusterId,
      fingerprint: o.fingerprint ?? `f-${id}`,
      state: resolved !== null ? 'resolved' : 'firing',
      severity: 'warning',
      labels: JSON.stringify(o.labels),
      details: JSON.stringify(o.details ?? {}),
      started_at: new Date(T(o.started)),
      fired_at: o.fired === null ? null : new Date(T(o.fired ?? o.started)),
      resolved_at: resolved !== null ? new Date(T(resolved)) : null,
      rule_snapshot: o.snapshot ? JSON.stringify(o.snapshot) : null,
    })
    .execute();
  return id;
}

async function chart(id: string, range?: number) {
  const res = await api(`/alerts/${id}/chart${range ? `?range=${range}` : ''}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}
type Panel = {
  id: string;
  lines: { name: string; step?: boolean; points: [number, number | null][] }[];
  thresholds: unknown[];
  rows: { name: string; segments: { state: string; tone: string }[] }[];
  more: number;
  unit: string | null;
};
const panel = (c: { panels: Panel[] }, id: string) => c.panels.find((p) => p.id === id)!;
const states = (p: Panel, row: string) =>
  p.rows.find((r) => r.name === row)!.segments.map((s) => `${s.state}:${s.tone}`);

beforeEach(async () => {
  ctx = await createTestContext();
  cookie = await setupAdmin(ctx.app);
  await api('/alert-rules'); // creates the default rules
  orgId = (await ctx.db.selectFrom('orgs').select('id').executeTakeFirstOrThrow()).id;
  const create = (name: string, kind: string) =>
    ctx.app
      .inject({
        method: 'POST',
        url: '/api/v1/clusters',
        cookies: { wl_session: cookie },
        payload: { name, kind },
      })
      .then((r) => {
        if (r.statusCode !== 201) throw new Error(r.body);
        return r.json().cluster.id as string;
      });
  kube = await create('kind-demo', 'kubernetes');
  // The Docker fleet goes in directly, with a known id.
  docker = newId();
  await ctx.db
    .insertInto('clusters')
    .values({ id: docker, org_id: orgId, name: 'office-docker', kind: 'docker' })
    .execute();
});
afterEach(() => closeTestContext(ctx));
afterAll(async () => {
  await fetch(
    `${TEST_VM_URL}/api/v1/admin/tsdb/delete_series?match[]=${encodeURIComponent(`{run="${RUN}"}`)}`,
    { method: 'POST' },
  );
});

const POD = { namespace: 'wl', workload: 'api', workload_kind: 'Deployment', node: 'w1' };
const podLabels = (pod: string) => ({ ...POD, pod });

describe('GET /alerts/:id/chart', () => {
  it('crash loop: restarts as steps plus CPU and memory of the affected pods, with every marker', async () => {
    const pods = ['api-1', 'api-2', 'api-3'];
    await write(kube, [
      ...pods.flatMap((p, i) => [
        ...gen(
          'watchlog_kube_pod_container_restarts_total',
          { ...podLabels(p), container: 'main' },
          (m) => Math.max(0, Math.floor((m + 40) / 5)) + i,
        ),
        ...gen(
          'watchlog_container_cpu_seconds_total',
          { ...podLabels(p), container: 'main' },
          (m) => (m + 70) * 6,
        ),
        ...gen(
          'watchlog_container_memory_working_set_bytes',
          { ...podLabels(p), container: 'main' },
          () => 2 ** 24,
        ),
      ]),
    ]);
    const id = await alertOf('k8s.pod.crashloop', kube, {
      labels: podLabels('api-1'),
      details: { pods: ['api-1', 'api-2'] },
      started: -40,
      fired: -38,
    });
    const ch = newId();
    await ctx.db
      .insertInto('alert_channels')
      .values({ id: ch, org_id: orgId, name: 'ops slack', type: 'slack', config: '{}' })
      .execute();
    const note = newId();
    await ctx.db
      .insertInto('notifications')
      .values({
        id: note,
        org_id: orgId,
        channel_id: ch,
        kind: 'firing',
        status: 'failed',
        payload: '{}',
        dedupe_key: note,
        created_at: new Date(T(-38)),
        error: 'HTTP 404',
      })
      .execute();
    await ctx.db
      .insertInto('notification_alerts')
      .values({ notification_id: note, alert_state_id: id })
      .execute();
    await ctx.db
      .insertInto('silences')
      .values({
        id: newId(),
        org_id: orgId,
        matchers: JSON.stringify({ workload: 'api' }),
        starts_at: new Date(T(-20)),
        ends_at: new Date(T(60)),
        comment: '',
      })
      .execute();

    const c = await chart(id);
    expect(c.window).toEqual({ from: sec(-70), to: expect.any(Number) });
    expect(c.panels.map((p: Panel) => p.id)).toEqual(['restarts', 'cpu', 'memory']);
    const restarts = panel(c, 'restarts');
    // Only the alert's pods, never api-3; one line per pod, drawn as steps.
    expect(restarts.lines.map((l) => l.name).sort()).toEqual(['wl · api-1', 'wl · api-2']);
    expect(restarts.lines.every((l) => l.step)).toBe(true);
    expect(panel(c, 'memory').unit).toBe('bytes');
    expect(c.markers.map((m: { kind: string }) => m.kind)).toEqual([
      'started',
      'fired',
      'notification',
      'silenced',
    ]);
    expect(c.markers[2]).toMatchObject({
      ts: sec(-38),
      channel: 'ops slack',
      status: 'failed',
      messageKind: 'firing',
    });
    expect(c.markers[3].ts).toBe(sec(-20));
    expect(c.firing).toEqual({ from: sec(-38), to: c.window.to });
    expect(c.ruleChanged).toBeNull();
  });

  it('shows at most 10 objects and counts the rest', async () => {
    const pods = Array.from({ length: 12 }, (_, i) => `api-${i}`);
    await write(
      kube,
      pods.flatMap((p, i) =>
        gen(
          'watchlog_kube_pod_container_restarts_total',
          { ...podLabels(p), container: 'main' },
          () => i,
        ),
      ),
    );
    const id = await alertOf('k8s.pod.crashloop', kube, { labels: POD, started: -10 });
    const restarts = panel(await chart(id), 'restarts');
    expect(restarts.lines).toHaveLength(10);
    expect(restarts.more).toBe(2);
    // The busiest first.
    expect(restarts.lines[0]!.name).toBe('wl · api-11');
  });

  it('OOMKilled: memory with the limit as the threshold line, OOM kills as markers', async () => {
    const l = { ...podLabels('api-1'), container: 'main' };
    await write(kube, [
      ...gen('watchlog_container_memory_working_set_bytes', l, (m) => (30 + (m % 5)) * 2 ** 20),
      ...gen('watchlog_container_memory_limit_bytes', l, () => 32 * 2 ** 20),
      ...gen('watchlog_kube_pod_container_restarts_total', l, (m) => (m < -20 ? 0 : 1)),
      ...gen(
        'watchlog_kube_pod_container_last_termination_reason',
        { ...l, reason: 'OOMKilled' },
        () => 1,
      ),
    ]);
    const id = await alertOf('k8s.container.oomkilled', kube, {
      labels: podLabels('api-1'),
      details: { pods: ['api-1'], container: 'main' },
      started: -20,
    });
    const c = await chart(id);
    expect(c.panels.map((p: Panel) => p.id)).toEqual(['memory']);
    expect(panel(c, 'memory').thresholds).toEqual([{ kind: 'limit', value: 32 * 2 ** 20 }]);
    const ooms = c.markers.filter((m: { kind: string }) => m.kind === 'oom');
    expect(ooms).toHaveLength(1);
    expect(Math.abs(ooms[0].ts - sec(-20))).toBeLessThanOrEqual(60);
  });

  it('node NotReady and pressure: a condition timeline plus CPU and memory', async () => {
    const n = { node: 'w2' };
    await write(kube, [
      ...gen('watchlog_kube_node_condition', { ...n, condition: 'Ready', status: 'true' }, (m) =>
        m < -30 ? 1 : null,
      ),
      ...gen('watchlog_kube_node_condition', { ...n, condition: 'Ready', status: 'false' }, (m) =>
        m >= -30 ? 1 : null,
      ),
      ...gen(
        'watchlog_kube_node_condition',
        { ...n, condition: 'MemoryPressure', status: 'false' },
        () => 1,
      ),
      ...gen('watchlog_node_cpu_seconds_total', { ...n, mode: 'user' }, (m) => (m + 70) * 30),
      ...gen('watchlog_node_cpu_seconds_total', { ...n, mode: 'idle' }, (m) => (m + 70) * 30),
      ...gen('watchlog_node_memory_bytes', { ...n, state: 'total' }, () => 8 * 2 ** 30),
      ...gen('watchlog_node_memory_bytes', { ...n, state: 'available' }, () => 2 * 2 ** 30),
    ]);
    for (const key of ['k8s.node.notready', 'k8s.node.pressure']) {
      const id = await alertOf(key, kube, {
        labels: { node: 'w2', condition: 'Ready' },
        started: -30,
      });
      const c = await chart(id);
      expect(c.panels.map((p: Panel) => p.id)).toEqual(['conditions', 'cpu', 'memory']);
      const cond = panel(c, 'conditions');
      expect(cond.rows.map((r) => r.name)).toEqual(['Ready', 'MemoryPressure']);
      expect(states(cond, 'Ready')).toEqual(['True:ok', 'False:critical']);
      expect(states(cond, 'MemoryPressure')).toEqual(['False:ok']);
      expect(
        panel(c, 'cpu').lines[0]!.points.some(([, v]) => v !== null && Math.abs(v - 0.5) < 0.01),
      ).toBe(true);
    }
  });

  it('Pending and ImagePull: a phase timeline of the affected pods', async () => {
    await write(kube, [
      ...gen(
        'watchlog_kube_pod_status_phase',
        { ...podLabels('api-1'), phase: 'Pending' },
        () => 1,
        -70,
        0,
      ),
      ...gen(
        'watchlog_kube_pod_container_status_waiting_reason',
        { ...podLabels('api-1'), container: 'main', reason: 'ImagePullBackOff' },
        (m) => (m >= -20 ? 1 : null),
      ),
      ...gen(
        'watchlog_kube_pod_status_phase',
        { ...podLabels('api-2'), phase: 'Running' },
        () => 1,
      ),
    ]);
    for (const key of ['k8s.pod.pending', 'k8s.pod.imagepull']) {
      const id = await alertOf(key, kube, {
        labels: podLabels('api-1'),
        details: { pods: ['api-1'] },
        started: -20,
      });
      const c = await chart(id);
      expect(c.panels.map((p: Panel) => p.id)).toEqual(['phases']);
      const phases = panel(c, 'phases');
      expect(phases.rows.map((r) => r.name)).toEqual(['api-1']);
      expect(states(phases, 'api-1')).toEqual(['Pending:warning', 'ImagePullBackOff:critical']);
    }
  });

  it('Deployment unavailable: desired and ready replicas as two step lines', async () => {
    const d = { namespace: 'wl', workload: 'api' };
    await write(kube, [
      ...gen('watchlog_kube_deployment_replicas', { ...d, state: 'desired' }, () => 3),
      ...gen('watchlog_kube_deployment_replicas', { ...d, state: 'ready' }, (m) =>
        m < -15 ? 3 : 1,
      ),
      ...gen('watchlog_kube_deployment_replicas', { ...d, state: 'available' }, () => 9),
    ]);
    const id = await alertOf('k8s.deployment.unavailable', kube, {
      labels: { namespace: 'wl', workload: 'api', workload_kind: 'Deployment' },
      started: -15,
    });
    const p = panel(await chart(id), 'replicas');
    expect(p.lines.map((l) => [l.name, l.step])).toEqual([
      ['desired', true],
      ['ready', true],
    ]);
    const ready = p.lines[1]!.points.filter(([, v]) => v !== null).map(([, v]) => v);
    expect(new Set(ready)).toEqual(new Set([3, 1]));
  });

  it('Docker unhealthy: a ✓/✕ health strip plus CPU and memory of the container', async () => {
    const c0 = { host: 'db-01', container: 'postgres' };
    await write(docker, [
      ...gen('watchlog_container_health', { ...c0, status: 'healthy' }, (m) =>
        m < -10 ? 1 : null,
      ),
      ...gen('watchlog_container_health', { ...c0, status: 'unhealthy' }, (m) =>
        m >= -10 ? 1 : null,
      ),
      ...gen('watchlog_container_cpu_seconds_total', c0, (m) => (m + 70) * 15),
      ...gen('watchlog_container_memory_working_set_bytes', c0, () => 2 ** 28),
    ]);
    const id = await alertOf('docker.container.unhealthy', docker, {
      labels: { node: 'db-01', container: 'postgres' },
      started: -10,
    });
    const c = await chart(id);
    expect(c.panels.map((p: Panel) => p.id)).toEqual(['health', 'cpu', 'memory']);
    expect(states(panel(c, 'health'), 'postgres')).toEqual(['healthy:ok', 'unhealthy:critical']);
    expect(panel(c, 'cpu').lines.map((l) => l.name)).toEqual(['db-01 · postgres']);
  });

  it('Docker restarting: the restart count as steps with its threshold, plus CPU and memory', async () => {
    const c0 = { host: 'db-01', container: 'web' };
    await write(docker, [
      ...gen('watchlog_container_restarts_total', c0, (m) => Math.max(0, Math.floor(m + 10))),
      ...gen('watchlog_container_cpu_seconds_total', c0, (m) => m + 70),
      ...gen('watchlog_container_memory_working_set_bytes', c0, () => 2 ** 26),
    ]);
    const id = await alertOf('docker.container.restarts', docker, {
      labels: { node: 'db-01', container: 'web' },
      started: -5,
    });
    const c = await chart(id);
    expect(c.panels.map((p: Panel) => p.id)).toEqual(['metric', 'cpu', 'memory']);
    expect(panel(c, 'metric')).toMatchObject({
      unit: 'count',
      thresholds: [{ kind: 'warning', value: 3 }],
    });
    expect(panel(c, 'metric').lines[0]!.step).toBe(true);
  });

  it('agent not reporting: samples per minute with the silent gap and the last data', async () => {
    // 15-second scrapes of 500 series each until 25 minutes ago.
    await write(
      kube,
      gen('watchlog_agent_series', { node: 'w1' }, (m) => (m < -25 ? 500 : null)),
    );
    const lastSeen = new Date(T(-25)).toISOString();
    const id = await alertOf('agent.not_reporting', kube, {
      labels: { agent: 'node', node: 'w1' },
      details: { lastSeen },
      started: -22,
    });
    const c = await chart(id);
    const samples = panel(c, 'samples');
    expect(samples.lines.map((l) => l.name)).toEqual(['w1']);
    const values = samples.lines[0]!.points.map(([, v]) => v);
    expect(values.some((v) => v !== null && Math.abs(v - 2000) < 1)).toBe(true);
    expect(values.at(-1)).toBeNull(); // silent now: a gap, not a line to zero
    expect(c.silent).toEqual({ from: sec(-25), to: c.window.to });
    expect(c.markers.find((m: { kind: string }) => m.kind === 'lastData').ts).toBe(sec(-25));
  });

  it('a metric rule: its own metric for that node and mount, with the thresholds the alert had', async () => {
    const n = { node: 'w1' };
    await write(kube, [
      ...gen('watchlog_node_filesystem_bytes', { ...n, mount: '/var', state: 'avail' }, () => 10),
      ...gen('watchlog_node_filesystem_bytes', { ...n, mount: '/var', state: 'size' }, () => 100),
      ...gen('watchlog_node_filesystem_bytes', { ...n, mount: '/', state: 'avail' }, () => 50),
      ...gen('watchlog_node_filesystem_bytes', { ...n, mount: '/', state: 'size' }, () => 100),
    ]);
    // The rule was 85 % / 95 % when this alert fired; it is 90 % now.
    await ctx.db
      .updateTable('alert_rules')
      .set({ condition: JSON.stringify({ op: '>', value: 0.9 }) })
      .where('rule_key', '=', 'node.disk.usage')
      .execute();
    const labels = { node: 'w1', mount: '/var' };
    const fp = 'node:w1:/var';
    await alertOf('node.disk.usage', kube, {
      labels,
      started: -60,
      resolved: -50,
      fingerprint: fp,
    });
    const id = await alertOf('node.disk.usage', kube, {
      labels,
      started: -20,
      fingerprint: fp,
      snapshot: {
        name: 'Node disk usage',
        condition: { op: '>', value: 0.85, critical: 0.95 },
        forSeconds: 0,
        severity: 'warning',
        metric: null,
        scope: {},
      },
    });
    // Alerting was not running for 10 minutes while this alert was open.
    await ctx.db
      .insertInto('alerting_periods')
      .values([
        { id: newId(), started_at: new Date(T(-120)), ended_at: new Date(T(-18)) },
        { id: newId(), started_at: new Date(T(-8)), ended_at: new Date(T(0)) },
      ])
      .execute();

    const c = await chart(id, 3 * 3600);
    expect(c.window.to - c.window.from).toBe(3 * 3600);
    const p = panel(c, 'metric');
    expect(p).toMatchObject({ unit: 'ratio', metric: 'node.filesystem.utilization' });
    expect(p.lines.map((l) => l.name)).toEqual(['w1 · /var']);
    expect(p.thresholds).toEqual([
      { kind: 'warning', value: 0.85 },
      { kind: 'critical', value: 0.95 },
    ]);
    expect(c.ruleChanged).toEqual({
      condition: { op: '>', value: 0.9 },
      forSeconds: 0,
      unit: 'ratio',
    });
    expect(c.episodes).toEqual([{ from: sec(-60), to: sec(-50) }]);
    expect(c.gaps).toEqual([{ from: sec(-18), to: sec(-8) }]);

    // The detail page's timeline gets the same gap.
    const detail = (await api(`/alerts/${id}`)).json();
    expect(detail.gaps).toEqual([
      { from: new Date(T(-18)).toISOString(), to: new Date(T(-8)).toISOString() },
    ]);
  });

  it('answers 404 for an unknown alert', async () => {
    expect((await api(`/alerts/${newId()}/chart`)).statusCode).toBe(404);
  });
});

describe('the rule editor preview uses the same chart', () => {
  it("returns the chart of a state rule's latest alert", async () => {
    await write(
      kube,
      gen(
        'watchlog_kube_deployment_replicas',
        { namespace: 'wl', workload: 'api', state: 'desired' },
        () => 2,
      ),
    );
    await alertOf('k8s.deployment.unavailable', kube, {
      labels: { namespace: 'wl', workload: 'api', workload_kind: 'Deployment' },
      started: -15,
    });
    const rule = await ctx.db
      .selectFrom('alert_rules')
      .select('id')
      .where('rule_key', '=', 'k8s.deployment.unavailable')
      .executeTakeFirstOrThrow();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/alert-rules/preview',
      cookies: { wl_session: cookie },
      payload: { ruleId: rule.id },
    });
    expect(res.json()).toMatchObject({ kind: 'state', fired: 1 });
    expect(res.json().chart.panels[0].id).toBe('replicas');
  });
});
