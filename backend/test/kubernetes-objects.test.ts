// SPDX-License-Identifier: AGPL-3.0-only
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTestContext, createTestContext, setupAdmin, type TestContext } from './helpers.js';

// Shaped like the cluster-agent's records for the kind test cluster (agent/internal/k8s).
const pod = (name: string, extra: object = {}) => ({
  kind: 'Pod',
  uid: `pod-${name}`,
  namespace: 'wl-test',
  name,
  node: 'watchlog-worker',
  spec: {
    workload: { kind: 'Deployment', name: 'web' },
    containers: [{ name: 'nginx', image: 'nginx:1.29-alpine' }],
  },
  status: { phase: 'Running', qos_class: 'Burstable', ready: true, containers: [] },
  ...extra,
});
const node = {
  kind: 'Node',
  uid: 'node-1',
  name: 'watchlog-worker',
  node: 'watchlog-worker',
  spec: {},
  status: {},
};
const deployment = {
  kind: 'Deployment',
  uid: 'dep-web',
  namespace: 'wl-test',
  name: 'web',
  spec: { replicas: 2 },
  status: {},
};
const KINDS = [
  'Namespace',
  'Node',
  'Pod',
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'Job',
  'CronJob',
  'HorizontalPodAutoscaler',
  'PersistentVolumeClaim',
];

describe('Kubernetes objects ingest', () => {
  let ctx: TestContext;
  let token: string;
  let clusterId: string;

  beforeEach(async () => {
    ctx = await createTestContext();
    const cookie = await setupAdmin(ctx.app);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/clusters',
      cookies: { wl_session: cookie },
      payload: { name: 'kind', kind: 'docker' },
    });
    token = res.json().token.value;
    clusterId = res.json().cluster.id;
    await ctx.db.updateTable('clusters').set({ kind: 'kubernetes' }).execute();
  });
  afterEach(() => closeTestContext(ctx));

  const post = (body: object) =>
    ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/objects',
      headers: {
        authorization: `Bearer ${token}`,
        'x-watchlog-agent': 'cluster-agent',
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      payload: gzipSync(JSON.stringify(body)),
    });
  const snapshot = (id: string, objects: object[], final = false) => ({
    source: 'kubernetes',
    kind: 'snapshot',
    snapshot_id: id,
    objects,
    ...(final ? { final: true, kinds: KINDS } : {}),
  });
  const live = async () =>
    (
      await ctx.db
        .selectFrom('objects')
        .select(['kind', 'name', 'node', 'source', 'spec_summary'])
        .where('cluster_id', '=', clusterId)
        .where('deleted_at', 'is', null)
        .orderBy('kind')
        .orderBy('name')
        .execute()
    ).map((o) => `${o.kind}:${o.name}`);

  it('stores chunked snapshots and sweeps objects the next snapshot no longer has', async () => {
    expect((await post(snapshot('s1', [node, pod('web-a'), pod('web-b')]))).statusCode).toBe(204);
    expect((await post(snapshot('s1', [deployment], true))).statusCode).toBe(204);
    expect(await live()).toEqual([
      'Deployment:web',
      'Node:watchlog-worker',
      'Pod:web-a',
      'Pod:web-b',
    ]);
    const row = await ctx.db
      .selectFrom('objects')
      .selectAll()
      .where('uid', '=', 'pod-web-a')
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      source: 'kubernetes',
      namespace: 'wl-test',
      node: 'watchlog-worker',
      snapshot_id: 's1',
    });
    expect(row.spec_summary).toMatchObject({ workload: { kind: 'Deployment', name: 'web' } });

    // Snapshot s2: web-b is gone; web-c arrives as a delta while s2 is being sent.
    await post(snapshot('s2', [node, pod('web-a')]));
    await post({ source: 'kubernetes', kind: 'delta', snapshot_id: 's2', objects: [pod('web-c')] });
    await post(snapshot('s2', [deployment], true));
    expect(await live()).toEqual([
      'Deployment:web',
      'Node:watchlog-worker',
      'Pod:web-a',
      'Pod:web-c',
    ]);
  });

  it('applies deltas: updates and deletes', async () => {
    await post(snapshot('s1', [node, pod('web-a')], true));
    await post({
      source: 'kubernetes',
      kind: 'delta',
      snapshot_id: 's1',
      objects: [
        pod('web-a', { status: { phase: 'Failed' } }),
        { ...pod('web-a'), deleted: true, spec: {}, status: {} },
      ],
    });
    // The same uid twice in one body: the last entry wins (here: deleted).
    expect(await live()).toEqual(['Node:watchlog-worker']);
    await post({
      source: 'kubernetes',
      kind: 'delta',
      snapshot_id: 's1',
      objects: [pod('web-a', { status: { phase: 'Failed' } })],
    });
    const row = await ctx.db
      .selectFrom('objects')
      .selectAll()
      .where('uid', '=', 'pod-web-a')
      .executeTakeFirstOrThrow();
    expect(row.deleted_at).toBeNull();
    expect(row.status_summary).toMatchObject({ phase: 'Failed' });
  });

  it('stores Services with the workloads behind them (service map topology)', async () => {
    const svc = {
      kind: 'Service',
      uid: 'svc-api',
      namespace: 'shop',
      name: 'api',
      spec: {
        type: 'ClusterIP',
        cluster_ips: ['10.96.1.1'],
        headless: false,
        ports: [{ port: 80 }],
      },
      status: { workloads: [{ kind: 'Deployment', name: 'api' }], ready_endpoints: 2 },
    };
    expect((await post(snapshot('s1', [node, svc], true))).statusCode).toBe(204);
    expect(await live()).toEqual(['Node:watchlog-worker', 'Service:api']);
  });

  it('rejects unknown kinds, oversized chunks and bodies without a snapshot id', async () => {
    expect((await post(snapshot('s1', [{ ...pod('x'), kind: 'Secret' }]))).statusCode).toBe(400);
    expect(
      (
        await post(
          snapshot(
            's1',
            Array.from({ length: 2501 }, (_, i) => pod(`p${i}`)),
          ),
        )
      ).statusCode,
    ).toBe(400);
    expect((await post({ source: 'kubernetes', kind: 'delta', objects: [] })).statusCode).toBe(400);
    expect(await live()).toEqual([]);
  });

  it('keeps the Docker inventory path unchanged', async () => {
    const res = await post({
      kind: 'snapshot',
      source: 'docker',
      node: 'host-1',
      inventory: {
        host: {
          docker_version: '29.9.2',
          api_version: '1.56',
          os: 'linux',
          arch: 'arm64',
          kernel_version: '6.8',
        },
        containers: [],
      },
    });
    expect(res.statusCode).toBe(204);
    expect(await live()).toEqual(['DockerHost:host-1']);
  });
});
