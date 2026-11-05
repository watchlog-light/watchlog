// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  setupAdmin,
  TEST_VM_URL,
  type TestContext,
} from './helpers.js';
import { encode, type TestSeries } from './support/remote-write.js';
import { ensureDefaultRules, lookupEvaluator } from '../src/modules/alerts/rules.js';
import { testWorker } from './support/alerts.js';

// Objects and events of the kind test cluster as the cluster-agent sent them
// (captured after `helm install`, slice 6). Event times are shifted to "now" so the
// day partitions and retention accept them.
const objects = JSON.parse(
  readFileSync(new URL('./fixtures/kind-objects.json', import.meta.url), 'utf8'),
) as { kind: string; namespace: string; name: string; spec: Record<string, unknown> }[];
const rawEvents = JSON.parse(
  readFileSync(new URL('./fixtures/kind-events.json', import.meta.url), 'utf8'),
) as { type: string; first_ts: string; last_ts: string; involved: { name: string } }[];
const shift = Date.now() - Math.max(...rawEvents.map((e) => Date.parse(e.last_ts))) - 60_000;
const events = rawEvents.map((e) => ({
  ...e,
  first_ts: new Date(Date.parse(e.first_ts) + shift).toISOString(),
  last_ts: new Date(Date.parse(e.last_ts) + shift).toISOString(),
}));
const KINDS = [...new Set(objects.map((o) => o.kind))];
const RUN = `k8s-${Date.now()}`;

afterAll(async () => {
  await fetch(
    `${TEST_VM_URL}/api/v1/admin/tsdb/delete_series?match[]=${encodeURIComponent(`{run="${RUN}"}`)}`,
    { method: 'POST' },
  );
});

describe('Kubernetes read API', () => {
  let ctx: TestContext;
  let cookie: string;
  let clusterId: string;
  let token: string;

  const heartbeat = (payload: object, agent: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/heartbeat',
      headers: { authorization: `Bearer ${token}`, 'x-watchlog-agent': agent },
      payload,
    });
  const ingest = (path: string, body: object, agent = 'cluster-agent') =>
    ctx.app.inject({
      method: 'POST',
      url: `/ingest/v1/${path}`,
      headers: {
        authorization: `Bearer ${token}`,
        'x-watchlog-agent': agent,
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      payload: gzipSync(JSON.stringify(body)),
    });
  const api = (url: string) =>
    ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, cookies: { wl_session: cookie } });
  const get = async (url: string) => {
    const res = await api(url);
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };

  beforeEach(async () => {
    ctx = await createTestContext();
    await ctx.app.ready();
    cookie = await setupAdmin(ctx.app);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/clusters',
      cookies: { wl_session: cookie },
      payload: { name: 'kind', kind: 'kubernetes' },
    });
    clusterId = res.json().cluster.id;
    token = res.json().token.value;
    const snap = await ingest('objects', {
      source: 'kubernetes',
      kind: 'snapshot',
      snapshot_id: 's1',
      objects,
      final: true,
      kinds: KINDS,
    });
    expect(snap.statusCode, snap.body).toBe(204);
    expect((await ingest('events', { events })).statusCode).toBe(204);
  });
  afterEach(() => closeTestContext(ctx));

  // Samples are written 60–90 s in the past: CI's VictoriaMetrics runs with the default
  // 30 s latency offset (the dev compose uses 5 s, ADR-045).
  const writeMetrics = async (series: TestSeries[], agent: string) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/write',
      headers: {
        authorization: `Bearer ${token}`,
        'x-watchlog-agent': agent,
        'content-type': 'application/x-protobuf',
        'content-encoding': 'snappy',
      },
      payload: encode(series),
    });
    expect(res.statusCode).toBe(204);
    await fetch(`${TEST_VM_URL}/internal/force_flush`);
  };

  it('answers the overview: facts, KPIs, one problem list for strip and list, events, nodes', async () => {
    const o = await get(`/clusters/${clusterId}/overview`);
    expect(o.kind).toBe('kubernetes');
    expect(o.kpis.nodes).toMatchObject({ ready: 3, total: 3 });
    expect(o.kpis.pods.total).toBe(objects.filter((x) => x.kind === 'Pod').length);
    expect(o.kpis.cpu.allocatable).toBe(12);
    expect(o.kpis.cpu.requests).toBeGreaterThan(0);
    expect(o.facts).toMatchObject({
      nodes: 3,
      agents: { reporting: 0, expected: 3 },
      clusterAgent: 'missing',
      alertingRunning: false,
      ebpf: 'off',
    });
    expect(o.facts.kubernetesVersion).toMatch(/^v1\./);
    expect(o.kpis.traffic).toBeNull();
    expect(o.nodes).toHaveLength(3);

    // Without alerting the crashing pods are still problems, found from their objects.
    const consistent = (ov: typeof o) => {
      expect(ov.problems.critical + ov.problems.warning).toBe(ov.problems.items.length);
      expect(ov.problems.types.reduce((s: number, t: { count: number }) => s + t.count, 0)).toBe(
        ov.problems.items.length,
      );
    };
    consistent(o);
    expect(
      o.problems.items.map((p: { source: string; title: string }) => [p.source, p.title]).sort(),
    ).toEqual([
      ['object', 'crashloop is crash-looping'],
      ['object', 'oom was killed for using too much memory'],
    ]);
    expect(o.health).toBe('critical');
    // The heatmap marks them failing, with why.
    const failing = Object.fromEntries(
      o.pods
        .filter((p: { failing: string | null }) => p.failing)
        .map((p: { name: string; failing: string }) => [p.name.split('-')[0], p.failing]),
    );
    expect(failing).toMatchObject({ crashloop: 'CrashLoopBackOff', oom: 'OOMKilled' });
    // Top workloads say which are in system namespaces.
    for (const t of [...o.top.cpu, ...o.top.memory])
      expect(t.system).toBe(['kube-system', 'local-path-storage'].includes(t.namespace));
    // Their BackOff events are flagged as covered, for the page to hide.
    const backoff = o.events.filter((e: { reason: string }) => e.reason === 'BackOff');
    expect(backoff.length).toBeGreaterThan(0);
    expect(backoff.every((e: { covered: boolean }) => e.covered)).toBe(true);
    expect(
      o.events.every((e: { message: string }) => !/[0-9a-f]{8}-[0-9a-f]{4}-/.test(e.message)),
    ).toBe(true);

    const kube = await get(`/clusters/${clusterId}/overview?namespaces=kube-system`);
    expect(kube.problems.items).toEqual([]);

    // The worker fires alerts for the crashing pods: each pod is one problem, from its
    // alert, not twice (ADR-078).
    const clock = { now: Date.now() };
    const worker = testWorker(ctx.db, clock, lookupEvaluator, {
      prepareOrg: (org) => ensureDefaultRules(ctx.db, org),
    });
    for (let i = 0; i < 6; i++) {
      await worker.runCycle();
      clock.now += 30_000;
    }
    const after = await get(`/clusters/${clusterId}/overview`);
    await worker.stop();
    expect(after).toMatchObject({ health: 'critical', facts: { alertingRunning: true } });
    consistent(after);
    const items = after.problems.items as { source: string; title: string; why: string }[];
    expect(items.every((p) => p.source === 'alert')).toBe(true);
    const crash = items.filter((p) => /crashloop/.test(p.title));
    const oom = items.filter((p) => /^oom /.test(p.title));
    expect(crash).toHaveLength(1);
    expect(oom).toHaveLength(1);
    expect(after.problems.silenced).toBe(0);
  });

  it('lists nodes with allocatable, requests, pods and agent state', async () => {
    const hb = await heartbeat(
      {
        agent_version: '2.0.0',
        mode: 'node',
        node: 'watchlog-worker',
        capabilities: { ebpf: 'disabled', cgroup: 'v2', kubelet_tls: 'unverified' },
        series: 120,
      },
      'watchlog-worker',
    );
    expect(hb.statusCode).toBe(204);
    await heartbeat(
      {
        agent_version: '2.0.0',
        mode: 'cluster',
        node: 'cluster-agent',
        capabilities: {},
        series: 300,
      },
      'cluster-agent',
    );
    const now = Date.now();
    const node = { node: 'watchlog-worker', run: RUN };
    await writeMetrics(
      [
        {
          labels: { __name__: 'watchlog_node_cpu_seconds_total', ...node, mode: 'user' },
          value: 100,
          timestampMs: now - 90_000,
        },
        {
          labels: { __name__: 'watchlog_node_cpu_seconds_total', ...node, mode: 'user' },
          value: 130,
          timestampMs: now - 60_000,
        },
        {
          labels: { __name__: 'watchlog_node_memory_bytes', ...node, state: 'total' },
          value: 6e9,
          timestampMs: now - 60_000,
        },
        {
          labels: { __name__: 'watchlog_node_memory_bytes', ...node, state: 'available' },
          value: 4e9,
          timestampMs: now - 60_000,
        },
        {
          labels: {
            __name__: 'watchlog_node_filesystem_bytes',
            ...node,
            mount: '/var',
            state: 'size',
          },
          value: 100,
          timestampMs: now - 60_000,
        },
        {
          labels: {
            __name__: 'watchlog_node_filesystem_bytes',
            ...node,
            mount: '/var',
            state: 'avail',
          },
          value: 75,
          timestampMs: now - 60_000,
        },
      ],
      'watchlog-worker',
    );

    const { nodes } = await get(`/clusters/${clusterId}/nodes`);
    expect(nodes.map((n: { name: string }) => n.name)).toEqual([
      'watchlog-control-plane',
      'watchlog-worker',
      'watchlog-worker2',
    ]);
    const worker = nodes[1];
    expect(worker).toMatchObject({
      status: 'Ready',
      kubeletVersion: 'v1.37.0',
      cpu: { allocatableCores: 4 },
      agent: { status: 'active', kubeletTls: 'unverified', version: '2.0.0' },
    });
    expect(worker.cpu.usageCores).toBeCloseTo(1, 1);
    expect(worker.memory.usageBytes).toBe(2e9);
    expect(worker.diskUtilization).toBeCloseTo(0.25); // /var when there is no / (kind)
    expect(worker.pods.count).toBeGreaterThan(0);
    expect(worker.pods.capacity).toBe(110);
    expect(worker.createdAt).toMatch(/^2026-/);
    expect(nodes[0].roles).toEqual(['control-plane']);
    expect(nodes[2].agent.status).toBe('missing');

    // The Nodes page's additions: every mount with its size, Ready since, trends, and
    // with ?heat=1 each node's pods for the heatmap.
    expect(worker.disks).toEqual([{ mount: '/var', utilization: 0.25, sizeBytes: 100 }]);
    expect(worker.readySince).toMatch(/^2026-/);
    expect(worker.cpuSeries.length).toBeGreaterThan(0);
    expect(worker.heat).toBeUndefined();
    const withHeat = await get(`/clusters/${clusterId}/nodes?heat=1&range=900`);
    expect(withHeat).toMatchObject({ range: 900, step: 15, diskAlerts: [] });
    const heat = withHeat.nodes[1].heat;
    expect(heat).toHaveLength(worker.pods.count);
    expect(heat[0]).toEqual({
      namespace: expect.any(String),
      name: expect.any(String),
      cpu: null,
      cpuRequest: expect.toBeOneOf([null, expect.any(Number)]),
      cpuRatio: null,
      failing: expect.toBeOneOf([null, expect.any(String)]),
    });
    expect(
      withHeat.nodes
        .flatMap((n: { heat: { failing: string | null; name: string }[] }) =>
          n.heat.filter((p) => p.failing).map((p) => p.name),
        )
        .sort(),
    ).toEqual(['crashloop', 'oom']);

    // The cluster-agent is not a node (Settings showed 4 for 3 nodes).
    const cluster = await get(`/clusters/${clusterId}`);
    expect(cluster.cluster.nodeCount).toBe(1);

    const detail = await get(`/clusters/${clusterId}/nodes/watchlog-worker`);
    expect(detail.pods.length).toBe(
      worker.pods.count +
        detail.pods.filter((p: { phase: string }) => p.phase === 'Succeeded').length,
    );
    expect(detail.labels['kubernetes.io/hostname']).toBe('watchlog-worker');
    expect((await api(`/clusters/${clusterId}/nodes/nope`)).statusCode).toBe(404);
  });

  it('lists pods and a pod with containers, termination and events', async () => {
    const now = Date.now();
    const web = {
      namespace: 'wl-test',
      pod: 'web-674987bb67-b24ww',
      node: 'watchlog-worker',
      workload_kind: 'Deployment',
      workload: 'web',
      run: RUN,
    };
    await writeMetrics(
      [
        {
          labels: { __name__: 'watchlog_container_cpu_seconds_total', ...web, container: 'nginx' },
          value: 10,
          timestampMs: now - 90_000,
        },
        {
          labels: { __name__: 'watchlog_container_cpu_seconds_total', ...web, container: 'nginx' },
          value: 10.6,
          timestampMs: now - 60_000,
        },
        {
          labels: {
            __name__: 'watchlog_container_memory_working_set_bytes',
            ...web,
            container: 'nginx',
          },
          value: 8e6,
          timestampMs: now - 60_000,
        },
        {
          labels: {
            __name__: 'watchlog_container_memory_working_set_bytes',
            ...web,
            container: 'sidecar',
          },
          value: 2e6,
          timestampMs: now - 60_000,
        },
      ],
      'watchlog-worker',
    );

    const { pods } = await get(`/clusters/${clusterId}/pods?namespaces=wl-test`);
    expect(pods.every((p: { namespace: string }) => p.namespace === 'wl-test')).toBe(true);
    const webPod = pods.find((p: { name: string }) => p.name === web.pod);
    expect(webPod).toMatchObject({ status: 'Running', workload: 'web', memoryBytes: 10e6 });
    expect(webPod.cpuCores).toBeCloseTo(0.02, 2);

    const byWorkload = await get(
      `/clusters/${clusterId}/pods?namespaces=wl-test&workloadKind=Deployment&workload=web`,
    );
    expect(byWorkload.pods).toHaveLength(2);
    const onNode = await get(`/clusters/${clusterId}/pods?node=watchlog-worker2`);
    expect(onNode.pods.every((p: { node: string }) => p.node === 'watchlog-worker2')).toBe(true);

    const oom = await get(`/clusters/${clusterId}/pods/wl-test/oom`);
    expect(oom.pod).toMatchObject({
      status: 'CrashLoopBackOff',
      lastTermination: { container: 'main', reason: 'OOMKilled', exitCode: 137 },
    });
    expect(oom.containers[0]).toMatchObject({ name: 'main', init: false, state: 'waiting' });
    expect(oom.containers[0].memoryLimitBytes).toBeGreaterThan(0);
    expect(oom.events.some((e: { reason: string }) => e.reason === 'BackOff')).toBe(true);

    const webDetail = await get(`/clusters/${clusterId}/pods/wl-test/${web.pod}`);
    expect(
      webDetail.containers.map(
        (c: { name: string; init: boolean }) => `${c.init ? 'init:' : ''}${c.name}`,
      ),
    ).toEqual(expect.arrayContaining(['nginx', 'sidecar']));
    expect(webDetail.containers.find((c: { name: string }) => c.name === 'nginx').memoryBytes).toBe(
      8e6,
    );
    expect((await api(`/clusters/${clusterId}/pods/wl-test/nope`)).statusCode).toBe(404);
  });

  it('lists workloads with replicas, pods and the last rollout', async () => {
    const web = objects.find((o) => o.kind === 'Deployment' && o.name === 'web')!;
    const delta = await ingest('objects', {
      source: 'kubernetes',
      kind: 'delta',
      snapshot_id: 's1',
      objects: [{ ...web, spec: { ...web.spec, revision: '2' } }],
    });
    expect(delta.statusCode).toBe(204);

    const { workloads } = await get(`/clusters/${clusterId}/workloads?namespaces=wl-test`);
    const by = (kind: string, name: string) =>
      workloads.find((w: { kind: string; name: string }) => w.kind === kind && w.name === name);
    expect(by('Deployment', 'web')).toMatchObject({
      desired: 2,
      ready: 2,
      pods: 2,
      health: 'healthy',
    });
    expect(by('Deployment', 'web').lastRolloutAt).not.toBeNull();
    expect(by('DaemonSet', 'per-node')).toMatchObject({ desired: 3, ready: 3, pods: 3 });
    expect(by('StatefulSet', 'db')).toMatchObject({ desired: 1, pods: 1 });
    expect(by('CronJob', 'every-minute').schedule).toBe('* * * * *');
    expect(by('Job', 'once')).toMatchObject({ health: 'healthy' });

    // The Workloads page's rows: a problem line worded as the alert texts, one square
    // per pod, the CronJob's last finished run (its Jobs are not rows of their own).
    // (crashloop and oom are bare pods here: their failing reason is on the pod rows.)
    const pods = (await get(`/clusters/${clusterId}/pods?namespaces=wl-test`)).pods;
    const failing = (n: string) => pods.find((p: { name: string }) => p.name === n).failing;
    expect([failing('crashloop'), failing('oom'), failing('guaranteed')]).toEqual([
      'CrashLoopBackOff',
      'OOMKilled',
      null,
    ]);
    expect(by('Deployment', 'web')).toMatchObject({
      podStates: ['ready', 'ready'],
      problem: {
        severity: 'warning',
        reason: "HPA web can't read its metrics",
      },
    });
    expect(by('DaemonSet', 'per-node').problem).toBeNull();
    expect(by('CronJob', 'every-minute').lastRun).toEqual({
      result: 'succeeded',
      at: '2026-10-31T11:52:03Z',
    });
    expect(workloads.some((w: { name: string }) => w.name.startsWith('every-minute-'))).toBe(false);
    expect(workloads.every((w: { system: boolean }) => !w.system)).toBe(true);
    const all = await get(`/clusters/${clusterId}/workloads?range=3600`);
    expect(all).toMatchObject({ range: 3600, step: 60 });
    expect(all.systemNamespaces).toEqual(
      expect.arrayContaining(['kube-system', 'local-path-storage', 'watchlog']),
    );
    const sys = all.workloads.filter((w: { system: boolean }) => w.system);
    expect(new Set(sys.map((w: { namespace: string }) => w.namespace))).toEqual(
      new Set(['kube-system', 'local-path-storage', 'watchlog']),
    );

    const only = await get(`/clusters/${clusterId}/workloads?kind=DaemonSet`);
    expect(only.workloads.every((w: { kind: string }) => w.kind === 'DaemonSet')).toBe(true);

    const now = Math.floor(Date.now() / 1000);
    const { markers } = await get(
      `/clusters/${clusterId}/change-markers?from=${now - 600}&to=${now + 60}&namespaces=wl-test`,
    );
    expect(markers).toEqual([
      expect.objectContaining({
        kind: 'rollout',
        target: 'Deployment/wl-test/web',
        details: { from: '1', to: '2' },
      }),
    ]);
    const none = await get(
      `/clusters/${clusterId}/change-markers?from=${now - 600}&to=${now + 60}&namespaces=kube-system`,
    );
    expect(none.markers).toEqual([]);
    expect((await api(`/clusters/${clusterId}/change-markers?from=10&to=5`)).statusCode).toBe(400);
  });

  it('pages events newest first and filters them', async () => {
    const first = await get(`/clusters/${clusterId}/events?limit=30`);
    expect(first.events).toHaveLength(30);
    expect(first.nextCursor).toBeTruthy();
    const seen = new Set(first.events.map((e: object) => JSON.stringify(e)));
    let cursor = first.nextCursor;
    let total = first.events.length;
    while (cursor) {
      const page = await get(`/clusters/${clusterId}/events?limit=30&cursor=${cursor}`);
      for (const e of page.events) {
        expect(seen.has(JSON.stringify(e))).toBe(false);
        seen.add(JSON.stringify(e));
      }
      total += page.events.length;
      cursor = page.nextCursor;
    }
    const stored = await ctx.db
      .selectFrom('k8s_events')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    expect(total).toBe(Number(stored.n));
    const times = first.events.map((e: { lastSeen: string }) => Date.parse(e.lastSeen));
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    const warnings = await get(`/clusters/${clusterId}/events?type=Warning`);
    expect(warnings.events.length).toBe(events.filter((e) => e.type === 'Warning').length);
    const oom = await get(`/clusters/${clusterId}/events?namespaces=wl-test&kind=Pod&name=oom`);
    expect(oom.events.every((e: { involvedName: string }) => e.involvedName === 'oom')).toBe(true);
    expect((await api(`/clusters/${clusterId}/events?cursor=bm9wZQ`)).statusCode).toBe(400);
  });

  it('filters events by several kinds, types, reasons, cluster-wide and words; sums them up', async () => {
    // Three nodes rebooted (stored in "default", as Kubernetes records node events).
    const t = new Date(Date.now() - 30 * 60_000).toISOString();
    const rebooted = ['n1', 'n2', 'n3'].map((n, i) => ({
      uid: `reboot-${n}`,
      namespace: 'default',
      involved: { kind: 'Node', namespace: '', name: n, uid: n },
      type: 'Warning',
      reason: 'Rebooted',
      message: `Node ${n} has been rebooted, boot id: 963e6014-1c5a-4b7e-9d1f-0c4c1c7a${i}abc`,
      count: 1,
      first_ts: t,
      last_ts: t,
      reporting_controller: 'kubelet',
    }));
    expect((await ingest('events', { events: rebooted })).statusCode).toBe(204);

    const wide = await get(`/clusters/${clusterId}/events?ns=-`);
    expect(wide.events).toHaveLength(3);
    expect(wide.events.every((e: { namespace: string | null }) => e.namespace === null)).toBe(true);
    const some = await get(`/clusters/${clusterId}/events?ns=wl-test,-&types=Warning&limit=500`);
    expect(new Set(some.events.map((e: { involvedKind: string }) => e.involvedKind))).toEqual(
      new Set(['Node', 'Pod', 'HorizontalPodAutoscaler']),
    );
    const kinds = await get(`/clusters/${clusterId}/events?kinds=Job,CronJob&limit=500`);
    expect(kinds.events.length).toBe(21);
    const words = await get(`/clusters/${clusterId}/events?q=back-off%20restarting`);
    expect(words.events.length).toBeGreaterThan(0);
    expect(
      words.events.every((e: { message: string }) => /back-off restarting/i.test(e.message)),
    ).toBe(true);
    // The top bar's namespaces never include cluster-scoped objects.
    const inDefault = await get(`/clusters/${clusterId}/events?namespaces=default`);
    expect(inDefault.events).toEqual([]);

    const now = Math.floor(Date.now() / 1000);
    const sum = await get(`/clusters/${clusterId}/events/summary?from=${now - 86400}&to=${now}`);
    expect(sum.bucket).toBe(1800);
    // Whole buckets: 48, or 49 when the range does not start on a bucket.
    expect(sum.histogram.length).toBe(
      Math.ceil((now - Math.floor((now - 86400) / 1800) * 1800) / 1800),
    );
    const all = await get(`/clusters/${clusterId}/events?from=${now - 86400}&limit=500`);
    const occurrences = all.events.reduce((s: number, e: { count: number }) => s + e.count, 0);
    expect(sum.total).toBe(occurrences);
    const drawn = sum.histogram.reduce(
      (s: number, h: { warning: number; normal: number }) => s + h.warning + h.normal,
      0,
    );
    expect(Math.abs(drawn - occurrences)).toBeLessThanOrEqual(sum.histogram.length);
    expect(sum.facets.namespaces).toContainEqual({ value: '-', count: 3 });
    expect(sum.facets.kinds).toContainEqual({ value: 'Node', count: 3 });
    expect(sum.markers).toEqual([
      expect.objectContaining({ reason: 'Rebooted', kind: 'Node', objects: 3 }),
    ]);
    // A facet leaves out its own filter, so its other values keep their counts.
    const pods = await get(
      `/clusters/${clusterId}/events/summary?from=${now - 86400}&to=${now}&kinds=Pod`,
    );
    expect(pods.facets.kinds).toEqual(sum.facets.kinds);
    expect(pods.total).toBe(
      sum.facets.kinds.find((k: { value: string }) => k.value === 'Pod').count,
    );
    expect(
      (await api(`/clusters/${clusterId}/events/summary?from=${now}&to=${now - 10}`)).statusCode,
    ).toBe(400);
  });

  it('lists namespaces with pod counts and rejects bad filters', async () => {
    const { namespaces } = await get(`/clusters/${clusterId}/namespaces`);
    const wl = namespaces.find((n: { name: string }) => n.name === 'wl-test');
    expect(wl).toEqual({
      name: 'wl-test',
      phase: 'Active',
      pods: objects.filter((o) => o.kind === 'Pod' && o.namespace === 'wl-test').length,
    });
    expect((await api(`/clusters/${clusterId}/pods?namespaces=Bad_NS`)).statusCode).toBe(400);
    expect((await api(`/clusters/00000000-0000-7000-8000-000000000000/nodes`)).statusCode).toBe(
      404,
    );
  });
});
