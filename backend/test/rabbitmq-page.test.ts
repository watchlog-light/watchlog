// SPDX-License-Identifier: AGPL-3.0-only
// The RabbitMQ page (v0.3 slice 11, SPEC §4.12): its tabs from the rabbitmq_prometheus
// series; a queue that lost its consumers linked to the client that was OOM-killed
// (a crash-looping pod on Kubernetes, an exited container on Docker); alarms, unacked
// messages; the plugin check with its command; the list; the default rule firing.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { VictoriaQueryClient } from '../src/lib/victoria.js';
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

const RUN = `rabbitmq-page-${Date.now()}`;
const MIN = 60_000;
const NOW = Math.floor(Date.now() / 15_000) * 15_000;
const vm = new VictoriaQueryClient(TEST_VM_URL);

let ctx: TestContext;
let cookie: string;

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
  await ctx.db.updateTable('orgs').set({ plan: 'pro' }).execute();
});
afterEach(() => closeTestContext(ctx));
afterAll(async () => {
  await fetch(
    `${TEST_VM_URL}/api/v1/admin/tsdb/delete_series?match[]=${encodeURIComponent(`{run="${RUN}"}`)}`,
    { method: 'POST' },
  );
});

async function cluster(name: string, kind: 'kubernetes' | 'docker') {
  const res = await api('POST', '/clusters', { name, kind });
  return { id: res.json().cluster.id as string, token: res.json().token.value as string };
}

/** 30 minutes of a series, every 15 s (i = 0…120), from `value(i)`. */
async function write(
  clusterId: string,
  name: string,
  labels: Record<string, string>,
  value: (i: number) => number,
) {
  const series: TestSeries[] = [];
  for (let i = 0, t = NOW - 30 * MIN; t <= NOW; i++, t += 15_000) {
    series.push({
      labels: { __name__: name, run: RUN, ...labels },
      value: value(i),
      timestampMs: t,
    });
  }
  await vm.write({ clusterId }, encode(series));
}

async function status(token: string, host: string, targets: object[]) {
  const r = await ctx.app.inject({
    method: 'POST',
    url: '/ingest/v1/integrations/status',
    headers: { authorization: `Bearer ${token}`, 'x-watchlog-agent': 'integrations' },
    payload: {
      host,
      mode: host ? 'docker' : 'kubernetes',
      version: 't',
      config_version: '',
      self: {},
      targets,
    },
  });
  expect(r.statusCode, r.body).toBe(204);
}

async function object(
  clusterId: string,
  kind: string,
  namespace: string,
  name: string,
  spec: object,
  st: object,
  node = 'w1',
) {
  await ctx.db
    .insertInto('objects')
    .values({
      id: newId(),
      cluster_id: clusterId,
      source: kind === 'DockerContainer' ? 'docker' : 'kubernetes',
      kind,
      namespace,
      name,
      uid: newId(),
      node,
      spec_summary: JSON.stringify(spec),
      status_summary: JSON.stringify(st),
    })
    .execute();
}

const tabOf = (id: string) => async (t: string) =>
  (await api('GET', `/applications/${id}/panels?tab=${t}`)).json().panels as {
    id: string;
    state: string;
    [k: string]: unknown;
  }[];
type Tile = {
  id: string;
  value: unknown;
  severity?: string;
  sub?: { key?: string; values?: object };
};

// The consumer stopped at i = 96 (6 minutes ago); publishing went on.
const LOST = 96;
const lostAt = new Date(NOW - (120 - LOST) * 15_000).toISOString();

async function rabbitSeries(clusterId: string, id: string, member: string) {
  const svc = (extra: Record<string, string> = {}) => ({
    service: id,
    service_type: 'rabbitmq',
    member,
    ...extra,
  });
  const orders = { vhost: '/', queue: 'orders' };
  const ready = (i: number) => (i < LOST ? 5 : 5 + (i - LOST) * 150); // +10/s
  let delivered = 0;
  await Promise.all([
    write(clusterId, 'rabbitmq_queue_messages_ready', svc(), ready),
    write(clusterId, 'rabbitmq_queue_messages_unacked', svc(), (i) => (i < LOST ? 40 : 0)),
    write(clusterId, 'rabbitmq_global_messages_received_total', svc(), (i) => i * 150),
    write(clusterId, 'rabbitmq_global_messages_delivered_total', svc(), (i) =>
      i < LOST ? (delivered = i * 150) : delivered,
    ),
    write(
      clusterId,
      'rabbitmq_global_messages_acknowledged_total',
      svc(),
      (i) => Math.min(i, LOST) * 150,
    ),
    write(clusterId, 'rabbitmq_consumers', svc(), (i) => (i < LOST ? 1 : 0)),
    write(clusterId, 'rabbitmq_process_resident_memory_bytes', svc(), () => 900 * 2 ** 20),
    write(clusterId, 'rabbitmq_resident_memory_limit_bytes', svc(), () => 1024 * 2 ** 20),
    write(clusterId, 'rabbitmq_alarms_memory_used_watermark', svc(), () => 0),
    write(clusterId, 'rabbitmq_alarms_free_disk_space_watermark', svc(), () => 0),
    write(clusterId, 'rabbitmq_disk_space_available_bytes', svc(), () => 5e9),
    write(clusterId, 'rabbitmq_disk_space_available_limit_bytes', svc(), () => 5e7),
    write(clusterId, 'rabbitmq_detailed_queue_messages_ready', svc(orders), ready),
    write(clusterId, 'rabbitmq_detailed_queue_messages_unacked', svc(orders), (i) =>
      i < LOST ? 40 : 0,
    ),
    write(clusterId, 'rabbitmq_detailed_queue_consumers', svc(orders), (i) => (i < LOST ? 1 : 0)),
    write(
      clusterId,
      'rabbitmq_detailed_queue_exchange_messages_published_total',
      svc(orders),
      (i) => i * 150,
    ),
    write(
      clusterId,
      'rabbitmq_detailed_queue_messages_delivered_ack_total',
      svc(orders),
      (i) => Math.min(i, LOST) * 150,
    ),
    // A busy queue that keeps its consumer.
    write(
      clusterId,
      'rabbitmq_detailed_queue_messages_ready',
      svc({ vhost: '/', queue: 'emails' }),
      () => 3,
    ),
    write(
      clusterId,
      'rabbitmq_detailed_queue_consumers',
      svc({ vhost: '/', queue: 'emails' }),
      () => 2,
    ),
  ]);
}

describe('the RabbitMQ page', () => {
  it('links a queue without consumers to the pod that was OOM-killed (Kubernetes)', async () => {
    const k8s = await cluster('prod', 'kubernetes');
    await object(
      k8s.id,
      'Pod',
      'shop',
      'worker-6d8f-x2',
      { workload: { kind: 'Deployment', name: 'worker' } },
      {
        phase: 'Running',
        containers: [
          {
            name: 'worker',
            state: 'waiting',
            reason: 'CrashLoopBackOff',
            restart_count: 3,
            last_termination: { reason: 'OOMKilled', exit_code: 137, finished_at: lostAt },
          },
        ],
      },
    );
    // A client that is fine: the publisher.
    await object(
      k8s.id,
      'Pod',
      'shop',
      'api-1',
      { workload: { kind: 'Deployment', name: 'api' } },
      {
        phase: 'Running',
        containers: [{ name: 'api', state: 'running', restart_count: 0 }],
      },
    );
    const id = (
      await api('POST', '/applications', {
        clusterId: k8s.id,
        type: 'rabbitmq',
        target: {
          kind: 'workload',
          namespace: 'shop',
          workload_kind: 'StatefulSet',
          workload: 'rabbitmq',
          port: 5672,
        },
        defaultAlerts: ['rabbitmq_queue_unconsumed'],
      })
    ).json().application.id as string;
    await status(k8s.token, '', [
      {
        id,
        state: 'ok',
        service_version: '4.1.8',
        members: [{ name: 'rabbitmq-0', up: true }],
        extra: {
          rabbitmq: [
            {
              member: 'rabbitmq-0',
              node: 'rabbit@rabbitmq-0',
              cluster: 'rabbit@rabbitmq-0',
              plugin: true,
            },
          ],
        },
      },
    ]);
    await rabbitSeries(k8s.id, id, 'rabbitmq-0');
    const amqp = {
      dst_kind: 'workload',
      dst_namespace: 'shop',
      dst_workload_kind: 'StatefulSet',
      dst_workload: 'rabbitmq',
      dst_port: '5672',
    };
    await Promise.all([
      write(
        k8s.id,
        'watchlog_flow_connections_total',
        { namespace: 'shop', workload_kind: 'Deployment', workload: 'worker', ...amqp },
        (i) => (i < LOST ? 1 : 1 + (i - LOST)),
      ),
      write(
        k8s.id,
        'watchlog_flow_connections_total',
        { namespace: 'shop', workload_kind: 'Deployment', workload: 'api', ...amqp },
        () => 1,
      ),
    ]);
    await fetch(`${TEST_VM_URL}/internal/force_flush`);

    const d = (await api('GET', `/applications/${id}`)).json();
    expect(d.page.id).toBe('rabbitmq');
    expect(d.page.tabs.map((t: { id: string }) => t.id)).toEqual([
      'overview',
      'queues',
      'rates',
      'resources',
      'connection',
    ]);
    const r = d.reasons.find((x: { code: string }) => x.code === 'queue_no_consumers');
    expect(r).toMatchObject({
      severity: 'critical',
      facts: {
        queue: 'orders',
        consumer: 'shop/worker',
        how: 'OOMKilled, CrashLoopBackOff',
        perMin: 600,
      },
      links: [{ kind: 'workload', id: 'shop/Deployment/worker', name: 'shop/worker' }],
    });
    expect(r.facts.since).toMatch(/min ago/);

    const tab = tabOf(id);
    const panel = (ps: Awaited<ReturnType<typeof tab>>, pid: string) =>
      ps.find((p) => p.id === pid)!;
    const ov = await tab('overview');
    const tiles = panel(ov, 'summary').tiles as Tile[];
    expect(tiles.find((t) => t.id === 'consumers')).toMatchObject({
      value: 0,
      sub: { values: { n: 1 } },
      severity: 'warning',
    });
    expect(tiles.find((t) => t.id === 'deliver')).toMatchObject({
      sub: { key: 'integrations.rabbitmq.panels.wasRate' },
    });
    expect(tiles.find((t) => t.id === 'ready')).toMatchObject({
      sub: { key: 'integrations.rabbitmq.panels.growing' },
    });
    expect(tiles.find((t) => t.id === 'memory')!.value as number).toBeCloseTo(0.88, 2);
    const rows = panel(ov, 'queues').rows as { cells: unknown[]; severity?: string }[];
    expect(rows[0]).toMatchObject({
      cells: ['orders', expect.any(Number), 0, 0, '10/s', '0/s'],
      severity: 'critical',
    });
    expect(rows.map((x) => x.cells[0])).toEqual(['orders', 'emails']);
    const qs = await tab('queues');
    expect((panel(qs, 'depth').items as { label: string; severity?: string }[])[0]).toMatchObject({
      label: 'orders',
      severity: 'critical',
    });
    expect(panel(await tab('rates'), 'flow').state).toBe('ok');
    const res = await tab('resources');
    expect((panel(res, 'limits').items as { label: string }[]).map((x) => x.label)).toEqual([
      'rabbitmq-0 · memory',
    ]);

    const list = (await api('GET', '/applications/metrics')).json().metrics[id];
    expect(list.keyMetrics.map((m: { id: string }) => m.id)).toEqual([
      'ready',
      'publish',
      'consumers',
    ]);
    expect(list.keyMetrics[2].value).toBe(0);

    // The default rule fires for that queue.
    const rule = (await api('GET', '/alert-rules'))
      .json()
      .rules.find((x: { defaultKey: string }) => x.defaultKey === 'rabbitmq_queue_unconsumed');
    const clock = { now: NOW - 12 * MIN };
    const worker = testWorker(ctx.db, clock, lookupEvaluator, { victoria: vm });
    for (let i = 0; i < 24; i++) {
      await worker.runCycle();
      clock.now += 30_000;
    }
    await worker.stop();
    expect(
      await ctx.db
        .selectFrom('alert_states')
        .select(['labels', 'state'])
        .where('rule_id', '=', rule.id)
        .execute(),
    ).toEqual([
      expect.objectContaining({
        state: 'firing',
        labels: expect.objectContaining({ queue: 'orders', service_name: 'shop/rabbitmq' }),
      }),
    ]);
  });

  it('links the exited container on Docker, and says how to enable the plugin', async () => {
    const docker = await cluster('fleet', 'docker');
    await object(
      docker.id,
      'DockerContainer',
      'shop',
      'shop-rabbitmq-1',
      { compose_service: 'rabbitmq', image: 'rabbitmq:4.1' },
      { state: 'running' },
      'h1',
    );
    await object(
      docker.id,
      'DockerContainer',
      'shop',
      'shop-rabbitmq-2',
      { compose_service: 'rabbitmq', image: 'rabbitmq:4.1' },
      { state: 'running' },
      'h1',
    );
    await object(
      docker.id,
      'DockerContainer',
      'shop',
      'shop-consumer-1',
      { compose_service: 'consumer', image: 'shop/consumer' },
      {
        state: 'exited',
        oom_killed: true,
        exit_code: 137,
        finished_at: lostAt,
        restart_count: 0,
      },
      'h1',
    );
    const id = (
      await api('POST', '/applications', {
        clusterId: docker.id,
        type: 'rabbitmq',
        target: {
          kind: 'compose',
          host: 'h1',
          compose_project: 'shop',
          compose_service: 'rabbitmq',
          port: 5672,
        },
      })
    ).json().application.id as string;
    await status(docker.token, 'h1', [
      {
        id,
        state: 'ok',
        members: [
          { name: 'shop-rabbitmq-1', up: true },
          { name: 'shop-rabbitmq-2', up: true },
        ],
        extra: {
          rabbitmq: [
            { member: 'shop-rabbitmq-1', node: 'rabbit@a', cluster: 'rabbit@a', plugin: true },
            { member: 'shop-rabbitmq-2', node: '', cluster: '', plugin: false },
          ],
        },
      },
    ]);
    await rabbitSeries(docker.id, id, 'shop-rabbitmq-1');
    await Promise.all([
      write(
        docker.id,
        'watchlog_flow_connections_total',
        {
          host: 'h1',
          container: 'shop-consumer-1',
          compose_project: 'shop',
          compose_service: 'consumer',
          dst_kind: 'container',
          dst: 'shop-rabbitmq-1',
          dst_port: '5672',
        },
        () => 1,
      ),
      write(
        docker.id,
        'rabbitmq_queue_messages_unacked',
        { service: id, service_type: 'rabbitmq', member: 'shop-rabbitmq-2' },
        () => 20_000,
      ),
      write(
        docker.id,
        'rabbitmq_alarms_free_disk_space_watermark',
        { service: id, service_type: 'rabbitmq', member: 'shop-rabbitmq-2' },
        () => 1,
      ),
    ]);
    await fetch(`${TEST_VM_URL}/internal/force_flush`);

    const d = (await api('GET', `/applications/${id}`)).json();
    const by = (code: string) => d.reasons.find((x: { code: string }) => x.code === code);
    expect(by('queue_no_consumers')).toMatchObject({
      facts: { consumer: 'shop-consumer-1', how: 'OOMKilled' },
      links: [{ kind: 'container', id: 'shop-consumer-1' }],
    });
    expect(by('prometheus_plugin_off').facts).toEqual({
      n: 1,
      command: 'docker exec shop-rabbitmq-2 rabbitmq-plugins enable rabbitmq_prometheus',
    });
    expect(by('disk_alarm')).toMatchObject({
      severity: 'critical',
      facts: { member: 'shop-rabbitmq-2' },
    });
    expect(by('unacked_high')).toMatchObject({ facts: { n: 20_000 } });
  });
});
