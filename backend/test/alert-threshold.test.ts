// SPDX-License-Identifier: AGPL-3.0-only
// Custom threshold rules (Phase 3 slice 7, ADR-085): validation through the API,
// the 500-pod cap of label selectors, and evaluation against VictoriaMetrics.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { authorisedScope, VictoriaQueryClient } from '../src/lib/victoria.js';
import { lookupEvaluator } from '../src/modules/alerts/rules.js';
import {
  TEST_VM_URL,
  closeTestContext,
  createTestContext,
  setupAdmin,
  type TestContext,
} from './helpers.js';
import { testWorker } from './support/alerts.js';
import { encode, type TestSeries } from './support/remote-write.js';

const RUN = `threshold-${Date.now()}`;
const MIN = 60_000;
const A = Math.floor((Date.now() - 30 * MIN) / 15_000) * 15_000;
const vm = new VictoriaQueryClient(TEST_VM_URL);

let ctx: TestContext;
let cookie: string;
let clusterId: string;
let dockerId: string;

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
  dockerId = (await api('POST', '/clusters', { name: 'hosts', kind: 'docker' })).json().cluster.id;
});
afterEach(() => closeTestContext(ctx));
afterAll(async () => {
  await fetch(
    `${TEST_VM_URL}/api/v1/admin/tsdb/delete_series?match[]=${encodeURIComponent(`{run="${RUN}"}`)}`,
    {
      method: 'POST',
    },
  );
});

async function pods(
  n: number,
  labels: Record<string, string>,
  prefix = 'p',
  namespace = 'wl-test',
) {
  const rows = Array.from({ length: n }, (_, i) => ({
    id: newId(),
    cluster_id: clusterId,
    source: 'kubernetes',
    kind: 'Pod',
    namespace,
    name: `${prefix}-${i}`,
    uid: `${prefix}-${i}-${newId()}`,
    spec_summary: JSON.stringify({ labels, workload: { kind: 'Deployment', name: prefix } }),
    status_summary: JSON.stringify({ phase: 'Running' }),
  }));
  for (let i = 0; i < rows.length; i += 200) {
    await ctx.db
      .insertInto('objects')
      .values(rows.slice(i, i + 200))
      .execute();
  }
}

const rule = (over: object = {}) => ({
  name: 'Web memory',
  metric: 'pod.memory.working_set',
  clusterId: null,
  scope: { labels: { app: 'web' } },
  condition: { op: '>', value: 500 * 2 ** 20 },
  forSeconds: 0,
  severity: 'warning',
  channelIds: [],
  ...over,
});

describe('custom threshold rules: validation', () => {
  it('accepts catalog metrics with a fitting scope and rejects everything else', async () => {
    const ok = await api('POST', '/alert-rules', rule());
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({
      type: 'threshold',
      source: 'metric',
      unit: 'bytes',
      metric: 'pod.memory.working_set',
      appliesTo: ['kubernetes'],
      scope: { labels: { app: 'web' } },
    });
    const bad = async (body: object) =>
      (await api('POST', '/alert-rules', rule(body))).json().detail;
    expect(await bad({ metric: 'sum(rate(x[5m]))' })).toBe('Unknown metric "sum(rate(x[5m]))"');
    expect(await bad({ scope: { host: 'h1' } })).toBe(
      'Scope "host" does not apply to a Kubernetes metric',
    );
    expect(await bad({ metric: 'host.cpu.utilization', scope: { namespaces: ['a'] } })).toBe(
      'Scope "namespaces" does not apply to a Docker metric',
    );
    expect(await bad({ clusterId: dockerId })).toBe(
      'The cluster does not exist or does not have this metric',
    );
    expect(
      await bad({ metric: 'node.cpu.utilization', scope: {}, condition: { op: '>', value: 90 } }),
    ).toMatch(/between 0 and 1/);
    const docker = await api(
      'POST',
      '/alert-rules',
      rule({ metric: 'container.memory.working_set', scope: { host: 'h1' }, clusterId: dockerId }),
    );
    expect(docker.json()).toMatchObject({ appliesTo: ['docker'], clusterId: dockerId });
  });

  it('rejects a label selector that matches more than 500 pods (ADR-085)', async () => {
    await pods(501, { app: 'big' }, 'big');
    await pods(3, { app: 'small' }, 'small');
    const res = await api('POST', '/alert-rules', rule({ scope: { labels: { app: 'big' } } }));
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toBe(
      'The label selector matches 501 pods; at most 500 are allowed. Narrow it, or scope the rule to a workload or a namespace instead.',
    );
    const small = (
      await api('POST', '/alert-rules', rule({ scope: { labels: { app: 'small' } } }))
    ).json();
    const widen = await api('PATCH', `/alert-rules/${small.id}`, {
      scope: { labels: { app: 'big' } },
    });
    expect(widen.statusCode).toBe(400);
  });
});

describe('custom threshold rules: evaluation', () => {
  async function write(name: string, labels: Record<string, string>, value: number) {
    const series: TestSeries[] = [];
    for (let t = A; t <= A + 25 * MIN; t += 15_000) {
      series.push({ labels: { __name__: name, run: RUN, ...labels }, value, timestampMs: t });
    }
    await vm.write(authorisedScope(clusterId), encode(series));
    await fetch(`${TEST_VM_URL}/internal/force_flush`);
  }

  it('resolves the label selector to pods and reports a selector that grew too broad', async () => {
    await pods(2, { app: 'web' }, 'web');
    await pods(1, { app: 'db' }, 'db');
    const created = (await api('POST', '/alert-rules', rule())).json();
    const mem = 'watchlog_container_memory_working_set_bytes';
    await write(mem, { namespace: 'wl-test', pod: 'web-0', container: 'nginx' }, 900 * 2 ** 20);
    await write(mem, { namespace: 'wl-test', pod: 'web-1', container: 'nginx' }, 100 * 2 ** 20);
    await write(mem, { namespace: 'wl-test', pod: 'db-0', container: 'pg' }, 900 * 2 ** 20);

    const clock = { now: A + 10 * MIN };
    const worker = testWorker(ctx.db, clock, lookupEvaluator, { victoria: vm });
    await worker.runCycle();
    const states = await ctx.db
      .selectFrom('alert_states')
      .select(['state', 'fingerprint', 'labels', 'details'])
      .where('rule_id', '=', created.id)
      .execute();
    expect(states).toMatchObject([
      {
        state: 'firing',
        fingerprint: 'm:namespace=wl-test,pod=web-0',
        labels: { namespace: 'wl-test', pod: 'web-0' },
        details: { summary: '900 MiB' },
      },
    ]);

    // The selector grows past the cap: the rule reports why instead of a partial result.
    await pods(499, { app: 'web' }, 'web-more');
    clock.now += 30_000;
    const report = await worker.runCycle();
    expect(report.errors.join()).toMatch(/matches 501 pods/);
    const after = (await api('GET', '/alert-rules'))
      .json()
      .rules.find((r: { id: string }) => r.id === created.id);
    expect(after.evalError).toMatch(/^prod: The label selector matches 501 pods/);
    await worker.stop();
  });
});
