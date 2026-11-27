// SPDX-License-Identifier: AGPL-3.0-only
// The RabbitMQ page (v0.3 slice 11, SPEC §4.12): its tabs from the rabbitmq_prometheus
// series; a queue that lost its consumers linked to the client that was OOM-killed
// (a crash-looping pod on Kubernetes, an exited container on Docker); alarms, unacked
// messages; the plugin check with its command; the list; the default rule firing; the
// application's likely cause on both platforms (ADR-148).
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
import { mcpClient } from './support/mcp.js';
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
});
afterEach(() => closeTestContext(ctx));
afterAll(async () => {
  await fetch(
    `${TEST_VM_URL}/api/v1/admin/tsdb/delete_series?match[]=${encodeURIComponent(`{run="${RUN}"}`)}`,
    { method: 'POST' },
  );
});

async function cluster(name: string, kind: 'kubernetes' | 'server') {
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
  await vm.write(authorisedScope(clusterId), encode(series));
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
      // Bytes each way (1.1.0): the api sends far more than it receives (it publishes); the
      // worker received far more until it was killed (it consumed).
      write(
        k8s.id,
        'watchlog_flow_bytes_total',
        { namespace: 'shop', workload_kind: 'Deployment', workload: 'api', dir: 'sent', ...amqp },
        (i) => i * 200_000,
      ),
      write(
        k8s.id,
        'watchlog_flow_bytes_total',
        {
          namespace: 'shop',
          workload_kind: 'Deployment',
          workload: 'api',
          dir: 'received',
          ...amqp,
        },
        (i) => i * 2_000,
      ),
      write(
        k8s.id,
        'watchlog_flow_bytes_total',
        {
          namespace: 'shop',
          workload_kind: 'Deployment',
          workload: 'worker',
          dir: 'received',
          ...amqp,
        },
        (i) => Math.min(i, LOST) * 150_000,
      ),
      write(
        k8s.id,
        'watchlog_flow_bytes_total',
        {
          namespace: 'shop',
          workload_kind: 'Deployment',
          workload: 'worker',
          dir: 'sent',
          ...amqp,
        },
        (i) => Math.min(i, LOST) * 1_000,
      ),
      // The queue's type and its consumers' utilisation (1.1.0).
      write(
        k8s.id,
        'rabbitmq_detailed_queue_info',
        {
          service: id,
          service_type: 'rabbitmq',
          member: 'rabbitmq-0',
          vhost: '/',
          queue: 'orders',
          type: 'quorum',
          membership: 'leader',
        },
        () => 1,
      ),
      write(
        k8s.id,
        'rabbitmq_detailed_queue_consumer_utilisation',
        {
          service: id,
          service_type: 'rabbitmq',
          member: 'rabbitmq-0',
          vhost: '/',
          queue: 'orders',
        },
        (i) => (i < LOST ? 0.4 - (0.39 * i) / LOST : 0),
      ),
      write(
        k8s.id,
        'watchlog_rabbitmq_node_info',
        {
          service: id,
          service_type: 'rabbitmq',
          member: 'rabbitmq-0',
          version: '4.1.8',
          rabbitmq_node: 'rabbit@rabbitmq-0',
        },
        () => 1,
      ),
    ]);
    await fetch(`${TEST_VM_URL}/internal/force_flush`);

    const d = (await api('GET', `/applications/${id}`)).json();
    expect(d.page.id).toBe('rabbitmq');
    // 1.1.0: Overview, Queues, Clients, Nodes, Alerts (the queue's page has its own address).
    expect(d.page.tabs.map((t: { id: string }) => t.id)).toEqual([
      'overview',
      'queues',
      'clients',
      'nodes',
      'alerts',
      'connection',
    ]);
    expect(d.page.tabs.find((t: { id: string }) => t.id === 'queues').count).toBe(2);
    expect(d.page.tabs.find((t: { id: string }) => t.id === 'alerts').view).toBe('alerts');
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
    // When the consumers left, for the page to write in the reader's time.
    expect(r.facts.sinceAt).toBeCloseTo((NOW - (120 - LOST) * 15_000) / 1000 - 15, -2);

    // The badge follows the worst finding: critical on the page, in the list and over MCP,
    // with that finding as the reason it is.
    expect(d.application).toMatchObject({
      health: 'critical',
      finding: { code: 'queue_no_consumers' },
    });
    const listed = (await api('GET', '/applications'))
      .json()
      .applications.find((a: { id: string }) => a.id === id);
    expect(listed).toMatchObject({
      health: 'critical',
      finding: { code: 'queue_no_consumers', severity: 'critical' },
    });
    // Its likely cause (ADR-148): the lost consumer, followed to how it ended; the same in the list.
    const cause = {
      rule: 'application_finding',
      facts: { finding: 'queue_no_consumers', consumer: 'shop/worker' },
      headline: { code: 'app_consumer_ended', facts: { queue: 'orders', consumer: 'shop/worker' } },
      subject: `application:${id}`,
    };
    expect(d.application.likelyCause).toMatchObject(cause);
    expect(listed.likelyCause).toMatchObject(cause);
    const mcp = await mcpClient(ctx, cookie);
    try {
      const all = await mcp.call('list_applications', {});
      expect(all.data.applications[0]).toMatchObject({
        name: 'shop/rabbitmq',
        health: 'critical',
        finding: { code: 'queue_no_consumers', sentence: expect.stringContaining('no consumers') },
      });
      const one = await mcp.call('get_application', { name: 'shop/rabbitmq' });
      expect(one.data.application.health).toBe('critical');
    } finally {
      await mcp.close();
    }

    const tab = tabOf(id);
    const panel = (ps: Awaited<ReturnType<typeof tab>>, pid: string) =>
      ps.find((p) => p.id === pid)!;
    const ov = await tab('overview');
    const tiles = panel(ov, 'summary').tiles as Tile[];
    // 1.1.1: the per-queue consumers, the rows' and the checks' source: emails' 2 (orders has
    // none, its finding says so). Consumers present: the tile isn't red. The series are 30
    // minutes old, so there is no "an hour ago" yet.
    const consumersTile = tiles.find((t) => t.id === 'consumers')!;
    expect(consumersTile).toMatchObject({
      value: 2,
      sub: { key: 'integrations.rabbitmq.panels.steady' },
    });
    expect(consumersTile.severity).toBeUndefined();
    expect(tiles.find((t) => t.id === 'deliver')).toMatchObject({
      sub: { key: 'integrations.rabbitmq.panels.wasRate' },
    });
    expect(tiles.find((t) => t.id === 'ready')).toMatchObject({
      sub: { key: 'integrations.rabbitmq.panels.growing' },
    });
    expect(tiles.find((t) => t.id === 'memory')!.value as number).toBeCloseTo(0.88, 2);
    // The message flow: the queue that nobody consumes, and the consumer that is gone.
    const flowCols = panel(ov, 'flow').columns as {
      id: string;
      rows: { name: string; link?: { kind: string }; text?: { key: string } }[];
      severity?: string;
    }[];
    expect(flowCols.map((c) => c.id)).toEqual(['publishers', 'exchanges', 'queues', 'consumers']);
    expect(flowCols[2]).toMatchObject({ severity: 'critical' });
    expect(flowCols[2]!.rows[0]).toMatchObject({ name: 'orders', link: { kind: 'queue' } });
    expect(flowCols[0]!.rows.map((r) => r.name)).toEqual(['shop/api']);
    expect(flowCols[3]!.rows[0]).toMatchObject({
      name: 'shop/worker',
      text: { key: 'integrations.rabbitmq.panels.flow.gone' },
    });
    // The publish chart marks when the worker ended.
    expect(
      (panel(ov, 'rates').markers as { text: { values: object } }[])[0]!.text.values,
    ).toMatchObject({
      name: 'shop/worker',
    });
    // The health checks: a queue without consumers fails, and links to the filtered list.
    const checks = panel(ov, 'checks').items as { id: string; state: string; link?: object }[];
    expect(checks.find((c) => c.id === 'consumers')).toMatchObject({
      state: 'fail',
      link: { kind: 'tab', tab: 'queues', filter: 'no_consumers' },
    });
    expect(checks.find((c) => c.id === 'memory')).toMatchObject({ state: 'pass' });
    expect(checks.find((c) => c.id === 'version')).toMatchObject({ state: 'pass' });
    expect(checks.find((c) => c.id === 'leaders')).toMatchObject({ state: 'pass' });
    expect(checks.map((c) => c.id)).not.toContain('partitions');
    // The queues that need a look: orders first, never drains (nothing takes from it).
    const need = panel(ov, 'needLook') as unknown as {
      full: boolean;
      total: number;
      rows: {
        name: string;
        type: string | null;
        consumers: number;
        severity?: string;
        drain: { state: string };
        in: number;
      }[];
    };
    expect(need.full).toBe(false);
    expect(need.total).toBe(2);
    expect(need.rows[0]).toMatchObject({
      name: 'orders',
      type: 'quorum',
      consumers: 0,
      severity: 'critical',
      drain: { state: 'never' },
    });
    expect(need.rows[0]!.in).toBeCloseTo(10, 0);
    expect(need.rows.map((x) => x.name)).toEqual(['orders', 'emails']);
    const qs = await tab('queues');
    expect(panel(qs, 'queues')).toMatchObject({ kind: 'queues', full: true, total: 2 });
    // Clients: the worker ended (OOM-killed, crash-looping) and mostly consumed; the api
    // mostly publishes and runs.
    const clients = panel(await tab('clients'), 'clients').rows as {
      name: string;
      mostly: string | null;
      state: { key: string; values?: { how?: string } };
      severity?: string;
      link?: { kind: string; id: string };
    }[];
    expect(clients[0]).toMatchObject({
      name: 'shop/worker',
      mostly: 'consumes',
      state: { key: 'ended', values: { how: 'OOMKilled, CrashLoopBackOff' } },
      severity: 'critical',
      link: { kind: 'workload', id: 'shop/Deployment/worker' },
    });
    expect(clients.find((c) => c.name === 'shop/api')).toMatchObject({
      mostly: 'publishes',
      state: { key: 'running' },
    });
    // Nodes: each against its limits, with its version and (4.x) its queue leaders.
    const nodes = panel(await tab('nodes'), 'nodes').items as {
      name: string;
      version: string;
      leaders: number | null;
      limits: { labelKey: string }[];
    }[];
    expect(nodes[0]).toMatchObject({ name: 'rabbitmq-0', version: '4.1.8', leaders: 1 });
    expect(nodes[0]!.limits.map((l) => l.labelKey)).toEqual([
      'integrations.rabbitmq.panels.limit.memory',
      'integrations.rabbitmq.panels.limit.disk',
    ]);
    expect((await tab('alerts')).length).toBe(0);

    // The queue's page: tiles, what happened, the probable cause, its facts and alerts.
    const qp = (await api('GET', `/applications/${id}/panels?tab=queue&queue=orders`)).json()
      .panels as { id: string; [k: string]: unknown }[];
    const qtiles = qp.find((p) => p.id === 'summary')!.tiles as Tile[];
    expect(qtiles.find((t) => t.id === 'consumers')).toMatchObject({
      value: 0,
      severity: 'critical',
      sub: { key: 'integrations.rabbitmq.panels.wasUntil', values: { n: 1 } },
    });
    const events = qp.find((p) => p.id === 'timeline')!.events as {
      text: { key: string; values?: Record<string, unknown> };
    }[];
    expect(events.map((e) => e.text.key)).toEqual(
      expect.arrayContaining([
        'integrations.rabbitmq.panels.event.consumers',
        'integrations.rabbitmq.panels.event.ended',
        'integrations.rabbitmq.panels.event.busy',
      ]),
    );
    expect(events.find((e) => e.text.key.endsWith('consumers'))!.text.values).toEqual({
      from: 1,
      to: 0,
    });
    expect(qp.find((p) => p.id === 'cause')).toMatchObject({
      text: { key: 'integrations.rabbitmq.panels.causeEnded', values: { name: 'shop/worker' } },
      links: [{ kind: 'workload', id: 'shop/Deployment/worker' }],
    });
    expect(qp.find((p) => p.id === 'consumers')).toMatchObject({
      note: { key: 'integrations.rabbitmq.panels.busyBeforeDrop' },
    });
    const facts = qp.find((p) => p.id === 'facts')!.rows as { labelKey: string; value: unknown }[];
    expect(facts.find((f) => f.labelKey.endsWith('fact.type'))?.value).toBe('quorum');
    expect(facts.find((f) => f.labelKey.endsWith('fact.leader'))?.value).toBe('rabbitmq-0');
    const qa = qp.find((p) => p.id === 'alerts') as unknown as {
      rules: unknown[];
      presets: { key: string; metric: string }[];
    };
    expect(qa.rules).toEqual([]);
    expect(qa.presets.map((x) => x.key)).toEqual(['unconsumed', 'depth', 'dead_letters']);
    // A queue that isn't read says so.
    const none = (await api('GET', `/applications/${id}/panels?tab=queue&queue=nope`)).json();
    expect(none.panels[0]).toMatchObject({ id: 'missing', state: 'empty' });

    // A queue's own alert, made from its page: scoped to the service and the queue.
    const qRule = await api('POST', '/alert-rules', {
      name: 'orders: ready above 100',
      metric: 'rabbitmq.queue.ready',
      clusterId: k8s.id,
      scope: { service: id, queue: { vhost: '/', name: 'orders' } },
      condition: { op: '>', value: 100 },
      forSeconds: 0,
      severity: 'warning',
      channelIds: [],
    });
    expect(qRule.statusCode, qRule.body).toBe(201);
    const badQueue = await api('POST', '/alert-rules', {
      name: 'x',
      metric: 'rabbitmq.messages.ready',
      clusterId: k8s.id,
      scope: { service: id, queue: { name: 'orders' } },
      condition: { op: '>', value: 1 },
      forSeconds: 0,
      severity: 'warning',
      channelIds: [],
    });
    expect(badQueue.json().detail).toMatch(/has no queues/);
    const qa2 = (await api('GET', `/applications/${id}/panels?tab=queue&queue=orders`))
      .json()
      .panels.find((p: { id: string }) => p.id === 'alerts');
    expect(qa2.rules).toEqual([
      { id: qRule.json().id, name: 'orders: ready above 100', state: 'quiet' },
    ]);

    // It fires for that queue only.
    const qClock = { now: NOW - 2 * MIN };
    const qWorker = testWorker(ctx.db, qClock, lookupEvaluator, { victoria: vm });
    for (let i = 0; i < 3; i++) {
      await qWorker.runCycle();
      qClock.now += 30_000;
    }
    await qWorker.stop();
    const qStates = await ctx.db
      .selectFrom('alert_states')
      .select(['labels', 'state'])
      .where('rule_id', '=', qRule.json().id)
      .execute();
    expect(qStates).toEqual([
      expect.objectContaining({
        state: 'firing',
        labels: expect.objectContaining({ queue: 'orders' }),
      }),
    ]);

    // The API: the queues, one queue, the clients.
    const apiQueues = (await api('GET', `/applications/${id}/rabbitmq/queues`)).json();
    expect(apiQueues.total).toBe(2);
    expect(apiQueues.queues[0]).toMatchObject({ name: 'orders', drain: { state: 'never' } });
    const apiQueue = (await api('GET', `/applications/${id}/rabbitmq/queues/orders`)).json();
    expect(apiQueue.probableCause).toMatchObject({ values: { name: 'shop/worker' } });
    expect((await api('GET', `/applications/${id}/rabbitmq/queues/nope`)).statusCode).toBe(404);
    const apiClients = (await api('GET', `/applications/${id}/rabbitmq/clients`)).json();
    expect(apiClients.clients[0]).toMatchObject({
      name: 'shop/worker',
      state: 'ended',
      mostly: 'consumes',
    });
    const mcp2 = await mcpClient(ctx, cookie);
    try {
      const one = await mcp2.call('get_application', { name: 'shop/rabbitmq', queue: 'orders' });
      expect(one.data.rabbitmq.queues.needALook[0]).toMatchObject({
        name: 'orders',
        drainsIn: 'never',
      });
      expect(one.data.rabbitmq.queue.queue).toMatchObject({ name: 'orders' });
      expect(one.data.rabbitmq.clients[0]).toMatchObject({ name: 'shop/worker' });
    } finally {
      await mcp2.close();
    }

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
    const docker = await cluster('fleet', 'server');
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
    // The application's likely cause (ADR-148): its consumer container, OOM-killed.
    expect(d.application.likelyCause).toMatchObject({
      rule: 'application_finding',
      headline: {
        code: 'app_consumer_ended',
        facts: { consumer: 'shop-consumer-1', how: 'OOMKilled' },
      },
      subject: `application:${id}`,
    });
    const listed = (await api('GET', '/applications')).json().applications[0];
    expect(listed.likelyCause).toMatchObject({ rule: 'application_finding' });

    // 1.1.0 on a server: the checks fail for the plugin and the disk alarm, the clients
    // tab has the exited container, the queue's page names it, both nodes are listed.
    const ov = await tabOf(id)('overview');
    const checks = ov.find((p) => p.id === 'checks')!.items as { id: string; state: string }[];
    expect(checks.find((c) => c.id === 'plugin')).toMatchObject({ state: 'fail' });
    expect(checks.find((c) => c.id === 'disk')).toMatchObject({ state: 'fail' });
    expect(checks.find((c) => c.id === 'consumers')).toMatchObject({ state: 'fail' });
    // 3.13-like here (no membership label): no leader check.
    expect(checks.map((c) => c.id)).not.toContain('leaders');
    const clients = (await tabOf(id)('clients')).find((p) => p.id === 'clients')!.rows as {
      name: string;
      state: { key: string; values?: { how?: string } };
      link?: { kind: string };
    }[];
    expect(clients[0]).toMatchObject({
      name: 'shop-consumer-1',
      state: { key: 'ended', values: { how: 'OOMKilled' } },
      link: { kind: 'container' },
    });
    const nodes = (await tabOf(id)('nodes')).find((p) => p.id === 'nodes')!.items as {
      name: string;
      leaders: number | null;
      severity?: string;
    }[];
    expect(nodes.map((n) => n.name)).toEqual(['shop-rabbitmq-1', 'shop-rabbitmq-2']);
    expect(nodes[1]).toMatchObject({ leaders: null, severity: 'critical' });
    const qp = (await api('GET', `/applications/${id}/panels?tab=queue&queue=orders`)).json()
      .panels as { id: string; [k: string]: unknown }[];
    expect(qp.find((p) => p.id === 'cause')).toMatchObject({
      text: { values: { name: 'shop-consumer-1', how: 'OOMKilled' } },
      links: [{ kind: 'container', id: 'shop-consumer-1' }],
    });
  });

  // 1.1.1: the demo's healthy moment. The consumer was OOM-killed 20 minutes ago and its
  // restarted pod (Kubernetes) or container (server) is connected again; the backlog drained.
  for (const kind of ['kubernetes', 'server'] as const) {
    it(`a restarted consumer that is connected again is no problem anywhere (${kind})`, async () => {
      const c = await cluster(`healthy-${kind}`, kind);
      const k8s = kind === 'kubernetes';
      const oomAt = new Date(NOW - 20 * MIN).toISOString();
      if (k8s) {
        await object(
          c.id,
          'Pod',
          'shop',
          'consumer-7d9-x1',
          { workload: { kind: 'Deployment', name: 'consumer' } },
          {
            phase: 'Running',
            containers: [
              {
                name: 'consumer',
                state: 'running',
                restart_count: 1,
                last_termination: { reason: 'OOMKilled', exit_code: 137, finished_at: oomAt },
              },
            ],
          },
        );
      } else {
        await object(
          c.id,
          'DockerContainer',
          'shop',
          'shop-consumer-1',
          { compose_service: 'consumer' },
          {
            state: 'running',
            oom_killed: true,
            restart_count: 1,
            finished_at: oomAt,
          },
          'h1',
        );
        await object(
          c.id,
          'DockerContainer',
          'shop',
          'shop-rabbitmq-1',
          { compose_service: 'rabbitmq' },
          { state: 'running' },
          'h1',
        );
      }
      const target = k8s
        ? {
            kind: 'workload',
            namespace: 'shop',
            workload_kind: 'StatefulSet',
            workload: 'rabbitmq',
            port: 5672,
          }
        : {
            kind: 'compose',
            host: 'h1',
            compose_project: 'shop',
            compose_service: 'rabbitmq',
            port: 5672,
          };
      const id = (
        await api('POST', '/applications', { clusterId: c.id, type: 'rabbitmq', target })
      ).json().application.id as string;
      await status(c.token, k8s ? '' : 'h1', [
        {
          id,
          state: 'ok',
          service_version: '4.1.8',
          members: [{ name: 'rabbitmq-0', up: true }],
          extra: {
            rabbitmq: [{ member: 'rabbitmq-0', node: 'rabbit@0', cluster: 'c', plugin: true }],
          },
        },
      ]);
      const svc = (extra: Record<string, string> = {}) => ({
        service: id,
        service_type: 'rabbitmq',
        member: 'rabbitmq-0',
        ...extra,
      });
      const orders = { vhost: '/', queue: 'orders' };
      // Publish 3/s all along; deliver 3/s, with a 12/s burst draining the backlog 15 minutes ago.
      let delivered = 0;
      const dst: Record<string, string> = k8s
        ? {
            dst_kind: 'workload',
            dst_namespace: 'shop',
            dst_workload_kind: 'StatefulSet',
            dst_workload: 'rabbitmq',
            dst_port: '5672',
          }
        : { dst_kind: 'container', dst: 'shop-rabbitmq-1', dst_port: '5672' };
      const src = (w: string): Record<string, string> =>
        k8s
          ? {
              namespace: 'shop',
              workload_kind: w === 'rabbitmq' ? 'StatefulSet' : 'Deployment',
              workload: w,
            }
          : { host: 'h1', container: `shop-${w}-1`, compose_project: 'shop', compose_service: w };
      await Promise.all([
        write(c.id, 'rabbitmq_queue_messages_ready', svc(), () => 0),
        write(c.id, 'rabbitmq_queue_messages_unacked', svc(), () => 0),
        write(c.id, 'rabbitmq_global_messages_received_total', svc(), (i) => i * 45),
        write(
          c.id,
          'rabbitmq_global_messages_delivered_total',
          svc(),
          (i) => (delivered += i >= 56 && i < 60 ? 180 : 45),
        ),
        write(c.id, 'rabbitmq_consumers', svc(), () => 1),
        write(c.id, 'rabbitmq_process_resident_memory_bytes', svc(), () => 0.0031 * 2 ** 30),
        write(c.id, 'rabbitmq_resident_memory_limit_bytes', svc(), () => 2 ** 30),
        write(c.id, 'rabbitmq_alarms_memory_used_watermark', svc(), () => 0),
        write(c.id, 'rabbitmq_detailed_queue_messages_ready', svc(orders), () => 0),
        write(c.id, 'rabbitmq_detailed_queue_messages_unacked', svc(orders), () => 0),
        write(c.id, 'rabbitmq_detailed_queue_consumers', svc(orders), () => 1),
        write(c.id, 'rabbitmq_detailed_queue_consumer_utilisation', svc(orders), () => 1),
        write(
          c.id,
          'rabbitmq_detailed_queue_exchange_messages_published_total',
          svc(orders),
          (i) => i * 45,
        ),
        write(
          c.id,
          'rabbitmq_detailed_queue_messages_delivered_ack_total',
          svc(orders),
          (i) => i * 45,
        ),
        // The consumer receives, the publisher sends (long-lived: no new connection), and the
        // broker's own pods talk to its port (never a client).
        write(
          c.id,
          'watchlog_flow_bytes_total',
          { ...src('consumer'), ...dst, dir: 'received' },
          (i) => i * 6000,
        ),
        write(
          c.id,
          'watchlog_flow_bytes_total',
          { ...src('consumer'), ...dst, dir: 'sent' },
          (i) => i * 900,
        ),
        write(c.id, 'watchlog_flow_connections_total', { ...src('consumer'), ...dst }, (i) =>
          i < 40 ? 1 : 2,
        ),
        write(
          c.id,
          'watchlog_flow_bytes_total',
          { ...src('publisher'), ...dst, dir: 'sent' },
          (i) => i * 4600,
        ),
        write(
          c.id,
          'watchlog_flow_bytes_total',
          { ...src('publisher'), ...dst, dir: 'received' },
          (i) => i * 15,
        ),
        write(c.id, 'watchlog_flow_connections_total', { ...src('publisher'), ...dst }, () => 1),
        write(
          c.id,
          'watchlog_flow_connections_total',
          { ...src('rabbitmq'), ...dst },
          (i) => i * 6,
        ),
      ]);
      await fetch(`${TEST_VM_URL}/internal/force_flush`);
      const d = (await api('GET', `/applications/${id}`)).json();
      expect(d.application.health).toBe('ok');
      // A4: the connected list leaves out the broker itself and has the long-lived publisher.
      const connected = (d.connected.items as { name: string }[]).map((x) => x.name);
      expect(connected).not.toContain(k8s ? 'rabbitmq' : 'shop-rabbitmq-1');
      expect(connected).toContain(k8s ? 'publisher' : 'shop-publisher-1');
      const ov = await tabOf(id)('overview');
      const tiles = ov.find((p) => p.id === 'summary')!.tiles as Tile[];
      // A1: one count of consumers; nothing red, nothing gone.
      expect(tiles.find((t) => t.id === 'consumers')).toMatchObject({ value: 1 });
      expect(tiles.find((t) => t.id === 'consumers')!.severity).toBeUndefined();
      const cols = ov.find((p) => p.id === 'flow')!.columns as {
        id: string;
        rows: { name: string; text?: { key: string }; severity?: string }[];
      }[];
      const consumerRows = cols.find((x) => x.id === 'consumers')!.rows;
      expect(consumerRows.map((r) => r.name)).toEqual([k8s ? 'shop/consumer' : 'shop-consumer-1']);
      expect(consumerRows[0]!.text).toBeUndefined();
      expect(consumerRows[0]!.severity).toBeUndefined();
      const checks = ov.find((p) => p.id === 'checks')!.items as { state: string }[];
      expect(checks.every((x) => x.state === 'pass')).toBe(true);
      // A2: deliver equals publish and nothing waits: no warning for the earlier burst.
      const deliverTile = tiles.find((t) => t.id === 'deliver')!;
      expect(deliverTile.severity).toBeUndefined();
      expect(deliverTile.sub?.key).not.toBe('integrations.rabbitmq.panels.wasRate');
      // A3: the check writes the memory as the tile does.
      expect(
        (
          ov.find((p) => p.id === 'checks')!.items as {
            id: string;
            value: { values: { pct: string } };
          }[]
        ).find((x) => x.id === 'memory')!.value.values.pct,
      ).toBe('0.31%');
      // A5: no queue needs a look.
      expect(ov.find((p) => p.id === 'needLook')).toMatchObject({ rows: [], total: 1 });
      // The row: idle consumers are 0% busy, not 100%.
      expect(
        (await api('GET', `/applications/${id}/rabbitmq/queues`)).json().queues[0],
      ).toMatchObject({ consumers: 1, busy: 0 });
      // The Clients tab: the restart said, not in red; the broker not a client of itself.
      const clients = (await tabOf(id)('clients')).find((p) => p.id === 'clients')!.rows as {
        name: string;
        state: { key: string };
        severity?: string;
      }[];
      expect(clients.map((x) => x.name).sort()).toEqual(
        k8s ? ['shop/consumer', 'shop/publisher'] : ['shop-consumer-1', 'shop-publisher-1'],
      );
      const consumer = clients.find((x) => x.name.includes('consumer'))!;
      expect(consumer.state.key).toBe('restarted');
      expect(consumer.severity).toBeUndefined();
    });
  }

  it('warns before a growing queue takes a node to its memory watermark', async () => {
    const k8s = await cluster('mem', 'kubernetes');
    const id = (
      await api('POST', '/applications', {
        clusterId: k8s.id,
        type: 'rabbitmq',
        target: {
          kind: 'workload',
          namespace: 'mq',
          workload_kind: 'StatefulSet',
          workload: 'rabbitmq',
          port: 5672,
        },
        defaultAlerts: ['rabbitmq_watermark_soon'],
      })
    ).json().application.id as string;
    const svc = { service: id, service_type: 'rabbitmq', member: 'rabbitmq-0' };
    const MB = 2 ** 20;
    // 600 MiB growing 2 MiB every 15 s, against a 1 GiB watermark: about 23 minutes left.
    await Promise.all([
      write(k8s.id, 'rabbitmq_process_resident_memory_bytes', svc, (i) => 600 * MB + i * 2 * MB),
      write(k8s.id, 'rabbitmq_resident_memory_limit_bytes', svc, () => 1024 * MB),
      write(
        k8s.id,
        'rabbitmq_detailed_queue_messages_ready',
        { ...svc, vhost: '/', queue: 'invoices' },
        (i) => i * 100,
      ),
      write(
        k8s.id,
        'rabbitmq_detailed_queue_consumers',
        { ...svc, vhost: '/', queue: 'invoices' },
        () => 1,
      ),
      write(
        k8s.id,
        'rabbitmq_detailed_queue_messages_ready',
        { ...svc, vhost: '/', queue: 'steady' },
        () => 5,
      ),
    ]);
    await fetch(`${TEST_VM_URL}/internal/force_flush`);
    const rule = (await api('GET', '/alert-rules'))
      .json()
      .rules.find((x: { defaultKey: string }) => x.defaultKey === 'rabbitmq_watermark_soon');
    expect(rule).toMatchObject({ metric: 'rabbitmq.queue.watermark_eta', severity: 'warning' });
    const clock = { now: NOW - 6 * MIN };
    const worker = testWorker(ctx.db, clock, lookupEvaluator, { victoria: vm });
    for (let i = 0; i < 14; i++) {
      await worker.runCycle();
      clock.now += 30_000;
    }
    await worker.stop();
    const states = await ctx.db
      .selectFrom('alert_states')
      .select(['labels', 'state'])
      .where('rule_id', '=', rule.id)
      .execute();
    expect(states).toEqual([
      expect.objectContaining({
        state: 'firing',
        labels: expect.objectContaining({ queue: 'invoices' }),
      }),
    ]);
    // The queue's page says when memory runs out at this rate.
    const qp = (await api('GET', `/applications/${id}/panels?tab=queue&queue=invoices`)).json()
      .panels as { id: string; tiles?: Tile[] }[];
    const fill = qp.find((p) => p.id === 'summary')!.tiles!.find((t) => t.id === 'drain')!;
    expect(fill).toMatchObject({
      severity: 'warning',
      sub: { key: 'integrations.rabbitmq.panels.atThisRate' },
    });
    expect(fill.value as number).toBeGreaterThan(600);
    expect(fill.value as number).toBeLessThan(3600);
  });

  it('says what is missing: no queues yet, no client seen, a node down', async () => {
    const k8s = await cluster('empty', 'kubernetes');
    const id = (
      await api('POST', '/applications', {
        clusterId: k8s.id,
        type: 'rabbitmq',
        target: {
          kind: 'workload',
          namespace: 'mq',
          workload_kind: 'StatefulSet',
          workload: 'rabbitmq',
          port: 5672,
        },
      })
    ).json().application.id as string;
    await status(k8s.token, '', [
      {
        id,
        state: 'ok',
        members: [
          { name: 'rabbitmq-0', up: true },
          { name: 'rabbitmq-1', up: false, error: 'connection refused' },
        ],
        extra: {
          rabbitmq: [{ member: 'rabbitmq-0', node: 'rabbit@0', cluster: 'c', plugin: true }],
        },
      },
    ]);
    // Node totals only: no queue yet.
    await write(
      k8s.id,
      'rabbitmq_queue_messages_ready',
      { service: id, service_type: 'rabbitmq', member: 'rabbitmq-0' },
      () => 0,
    );
    await fetch(`${TEST_VM_URL}/internal/force_flush`);
    const tab = tabOf(id);
    expect((await tab('queues'))[0]).toMatchObject({ kind: 'queues', state: 'empty', total: 0 });
    expect((await tab('clients'))[0]).toMatchObject({
      kind: 'clients',
      state: 'empty',
      note: { key: 'integrations.rabbitmq.panels.clientsNote' },
    });
    const checks = (await tab('overview')).find((p) => p.id === 'checks')!.items as {
      id: string;
      state: string;
      value: { values?: object };
    }[];
    expect(checks.find((c) => c.id === 'nodes')).toMatchObject({
      state: 'fail',
      value: { values: { n: 1, m: 2 } },
    });
    expect(checks.find((c) => c.id === 'consumers')).toMatchObject({ state: 'pass' });
    const nodes = (await tab('nodes')).find((p) => p.id === 'nodes')!.items as { name: string }[];
    expect(nodes.map((n) => n.name)).toEqual(['rabbitmq-0', 'rabbitmq-1']);
  });
});
