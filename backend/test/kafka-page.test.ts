// SPDX-License-Identifier: AGPL-3.0-only
// The Kafka page (v0.5 slice 4, SPEC §4.12, ADR-166): its tabs from the collector's
// admin-API series (cluster-wide, topics and groups by name), brokers, members and the last
// members of an emptied group from its status (shapes as apache/kafka-native 4.1.1 gave
// them on the e2e VM: one KRaft broker, the `audit` group's only member killed), the
// reasons with the lost group linked to the member that ended, and the list's numbers.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { VictoriaQueryClient } from '../src/lib/victoria.js';
import type { Evidence } from '../src/modules/causes/evidence.js';
import { linksOf } from '../src/modules/causes/rules/application-finding.js';
import { connectCommand } from '../src/modules/integrations/credentials.js';
import { kindOfImage, kindOfPorts } from '../src/modules/integrations/discovery.js';
import { reasonSentence } from '../src/modules/mcp/tools/applications.js';
import {
  TEST_VM_URL,
  closeTestContext,
  createTestContext,
  setupAdmin,
  type TestContext,
} from './helpers.js';
import { encode, type TestSeries } from './support/remote-write.js';

const RUN = `kafka-page-${Date.now()}`;
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

async function cluster(name: string, kind: 'kubernetes' | 'docker') {
  const res = await api('POST', '/clusters', { name, kind });
  return { id: res.json().cluster.id as string, token: res.json().token.value as string };
}

/** 30 minutes of a series, every 15 s, from `value(i)` (i = 0…120). */
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

async function container(
  clusterId: string,
  host: string,
  name: string,
  ip: string,
  status: Record<string, unknown>,
) {
  await ctx.db
    .insertInto('objects')
    .values({
      id: newId(),
      cluster_id: clusterId,
      source: 'docker',
      kind: 'DockerContainer',
      namespace: 'kafka-e2e',
      name,
      uid: newId(),
      node: host,
      spec_summary: JSON.stringify({ ips: [ip], compose_service: name.split('-')[2] }),
      status_summary: JSON.stringify(status),
    })
    .execute();
}

type Panel = { id: string; state: string; [k: string]: unknown };

const TABS = ['overview', 'topics', 'consumer_groups', 'brokers'];
/** The consumer was killed at i = 100 (5 minutes before now). */
const KILLED = 100;

describe('the Kafka page', () => {
  it('fills every tab, and links the group that lost its members to the member that ended (Docker)', async () => {
    const docker = await cluster('fleet', 'docker');
    const killedAt = new Date(NOW - 5 * MIN).toISOString();
    await container(docker.id, 'h1', 'kafka-e2e-audit-1', '172.24.0.4', {
      state: 'exited',
      oom_killed: true,
      exit_code: 137,
      finished_at: killedAt,
    });
    await container(docker.id, 'h1', 'kafka-e2e-producer-1', '172.24.0.3', { state: 'running' });
    const id = (
      await api('POST', '/applications', {
        clusterId: docker.id,
        type: 'kafka',
        target: {
          kind: 'compose',
          host: 'h1',
          compose_project: 'kafka-e2e',
          compose_service: 'kafka',
          port: 9092,
        },
        defaultAlerts: ['kafka_group_lost'],
      })
    ).json().application.id as string;
    const leftAt = Math.floor((NOW - 4 * MIN) / 1000);
    await status(docker.token, 'h1', [
      {
        id,
        state: 'ok',
        service_version: '4.1',
        members: [{ name: 'kafka-e2e-kafka-1', up: true }],
        extra: {
          brokers: [{ id: 1, host: 'kafka', port: 9092, rack: null, controller: true, up: true }],
          partitions: [],
          groups: [{ group: 'audit', state: 'Empty', members: 0, topics: 'orders', lag: 6000 }],
          members: [],
          last_members: [
            {
              group: 'audit',
              client_id: 'kmeasure-consume',
              client_host: '172.24.0.4',
              left_at: leftAt,
            },
          ],
          quorum: [{ leader: 1, voters: 1, observers: 0 }],
        },
      },
    ]);
    const svc = (extra: Record<string, string> = {}) => ({
      service: id,
      service_type: 'kafka',
      host: 'h1',
      ...extra,
    });
    const lag = (i: number) => (i > KILLED ? (i - KILLED) * 300 : 15);
    await Promise.all([
      write(docker.id, 'watchlog_kafka_brokers', svc(), () => 1),
      write(docker.id, 'watchlog_kafka_brokers_up', svc(), () => 1),
      write(docker.id, 'watchlog_kafka_partitions', svc(), () => 53),
      write(docker.id, 'watchlog_kafka_partitions_offline', svc(), () => 0),
      write(docker.id, 'watchlog_kafka_partitions_under_replicated', svc(), () => 0),
      write(docker.id, 'watchlog_kafka_topics', svc(), () => 1),
      write(docker.id, 'watchlog_kafka_groups', svc(), () => 1),
      write(docker.id, 'watchlog_kafka_broker_partitions', svc({ broker: '1' }), () => 53),
      write(docker.id, 'watchlog_kafka_broker_leaders', svc({ broker: '1' }), () => 53),
      write(docker.id, 'watchlog_kafka_broker_log_bytes', svc({ broker: '1' }), () => 2.4e6),
      write(docker.id, 'watchlog_kafka_topic_end_offset', svc({ topic: 'orders' }), (i) => i * 300),
      write(docker.id, 'watchlog_kafka_topic_partitions', svc({ topic: 'orders' }), () => 3),
      write(
        docker.id,
        'watchlog_kafka_topic_replication_factor',
        svc({ topic: 'orders' }),
        () => 1,
      ),
      write(
        docker.id,
        'watchlog_kafka_topic_offline_partitions',
        svc({ topic: 'orders' }),
        () => 0,
      ),
      write(
        docker.id,
        'watchlog_kafka_topic_under_replicated_partitions',
        svc({ topic: 'orders' }),
        () => 0,
      ),
      write(docker.id, 'watchlog_kafka_topic_size_bytes', svc({ topic: 'orders' }), () => 2.3e6),
      write(
        docker.id,
        'watchlog_kafka_topic_retention_seconds',
        svc({ topic: 'orders' }),
        () => 604800,
      ),
      write(docker.id, 'watchlog_kafka_group_members', svc({ group: 'audit' }), (i) =>
        i > KILLED + 3 ? 0 : 1,
      ),
      write(docker.id, 'watchlog_kafka_group_lag', svc({ group: 'audit', topic: 'orders' }), lag),
      write(
        docker.id,
        'watchlog_kafka_group_committed_offset',
        svc({ group: 'audit', topic: 'orders' }),
        (i) => i * 300 - lag(i),
      ),
    ]);
    await fetch(`${TEST_VM_URL}/internal/force_flush`);

    const d = (await api('GET', `/applications/${id}`)).json();
    expect(d.page.id).toBe('kafka');
    expect(d.page.tabs.map((t: { id: string }) => t.id)).toEqual([
      ...TABS,
      'internals',
      'connection',
    ]);
    const reasons = d.reasons as {
      code: string;
      facts: Record<string, unknown>;
      links?: { kind: string; id: string }[];
    }[];
    const lost = reasons.find((r) => r.code === 'group_no_members')!;
    expect(lost, JSON.stringify(reasons)).toBeDefined();
    expect(lost.facts).toMatchObject({
      group: 'audit',
      member: 'kafka-e2e-audit-1',
      how: 'OOMKilled',
    });
    expect(lost.facts.perMin).toBeGreaterThan(1000);
    expect(lost.facts.lag).toBeGreaterThan(5000);
    expect(lost.links).toEqual([
      { kind: 'container', id: 'kafka-e2e-audit-1', name: 'kafka-e2e-audit-1' },
    ]);
    // The lost group isn't also "lagging with members".
    expect(reasons.map((r) => r.code)).not.toContain('group_lag_growing');
    for (const r of reasons) expect(reasonSentence(r), r.code).not.toBe('See the facts.');

    const panels = async (tab: string) =>
      (await api('GET', `/applications/${id}/panels?tab=${tab}`)).json().panels as Panel[];
    for (const tab of TABS) {
      const ps = await panels(tab);
      // No member now: the members table is empty, the rest is filled.
      expect(
        ps.filter((p) => p.state !== 'ok' && p.id !== 'members'),
        tab,
      ).toEqual([]);
    }
    const tiles = (
      (await panels('overview')).find((p) => p.id === 'stats') as unknown as {
        tiles: { id: string; value: number | null; severity?: string }[];
      }
    ).tiles;
    expect(tiles.find((t) => t.id === 'brokers')).toMatchObject({ value: 1, severity: 'ok' });
    expect(tiles.find((t) => t.id === 'in')!.value).toBeCloseTo(20, 0);
    expect(tiles.find((t) => t.id === 'groups')).toMatchObject({ value: 1, severity: 'warning' });
    const groups = (await panels('overview')).find((p) => p.id === 'groups') as unknown as {
      rows: { cells: unknown[]; severity?: string }[];
    };
    expect(groups.rows[0]!.cells.slice(0, 5)).toEqual(['audit', 'Empty', 0, 'orders', 6000]);
    expect(groups.rows[0]!.severity).toBe('critical');
    expect(String(groups.rows[0]!.cells[5])).toMatch(/^~/);
    const topics = (await panels('topics')).find((p) => p.id === 'topics') as unknown as {
      rows: { cells: unknown[] }[];
    };
    expect(topics.rows[0]!.cells).toEqual(['orders', 3, 1, 0, 0, '7 d', '2 MB']);
    const brokers = (await panels('brokers')).find((p) => p.id === 'brokers') as unknown as {
      rows: { cells: unknown[] }[];
      note: { key: string };
    };
    expect(brokers.rows[0]!.cells).toEqual([1, 'kafka:9092', '–', '✓', '✓']);
    expect(brokers.note.key).toBe('integrations.kafka.panels.quorumNote');
    // Broker internals: no Prometheus endpoint, the panels say how to get one.
    const internals = await panels('internals');
    expect(internals.every((p) => p.state === 'empty')).toBe(true);

    const row = (await api('GET', '/applications/metrics')).json().metrics[id] as {
      keyMetrics: { id: string; value: number | null }[];
    };
    expect(row.keyMetrics.map((k) => k.id)).toEqual(['in', 'lag', 'offline']);
    expect(row.keyMetrics[1]!.value).toBeGreaterThan(5000);
  });

  it('a user without Describe on groups: the panels say so', async () => {
    const k8s = await cluster('prod', 'kubernetes');
    const id = (
      await api('POST', '/applications', {
        clusterId: k8s.id,
        type: 'kafka',
        target: {
          kind: 'workload',
          namespace: 'shop',
          workload_kind: 'StatefulSet',
          workload: 'kafka',
          port: 9092,
        },
      })
    ).json().application.id as string;
    await status(k8s.token, '', [
      {
        id,
        state: 'ok',
        service_version: '4.1',
        members: [{ name: 'kafka-0', up: true }],
        permissions: [{ tab: 'consumer_groups/lag', missing: 'Describe on every group' }],
        extra: { brokers: [] },
      },
    ]);
    const ps = (await api('GET', `/applications/${id}/panels?tab=consumer_groups`)).json()
      .panels as Panel[];
    const lag = ps.find((p) => p.id === 'lag')!;
    expect(lag.state).toBe('needs_permission');
    expect((lag as unknown as { missing: { key: string } }).missing.key).toBe(
      'integrations.kafka.missing.consumer_groups.lag',
    );
  });
});

describe('Kafka discovery', () => {
  it("finds Apache's, Bitnami's, Confluent's and Strimzi's brokers, not the tools around them", () => {
    for (const ref of [
      'apache/kafka:4.1.1',
      'apache/kafka-native:4.1.1',
      'bitnami/kafka:3.9',
      'confluentinc/cp-kafka:7.9.0',
      'quay.io/strimzi/kafka:0.48.0-kafka-4.1.0',
    ])
      expect(kindOfImage(ref)?.type, ref).toBe('kafka');
    for (const ref of ['provectuslabs/kafka-ui:latest', 'danielqsj/kafka-exporter:v1.9.0'])
      expect(kindOfImage(ref)?.type, ref).not.toBe('kafka');
    expect(kindOfPorts([9092])?.type).toBe('kafka');
  });
});

describe("Kafka's generated user", () => {
  it('a SCRAM user with Describe ACLs, run in the broker', () => {
    const cmd = connectCommand(
      'kafka',
      {
        kind: 'workload',
        namespace: 'shop',
        workload_kind: 'StatefulSet',
        workload: 'kafka',
        port: 9092,
      },
      'wl_mon_x',
    )!;
    expect(cmd).toMatch(/^kubectl exec -n shop statefulset\/kafka -- sh -c '/);
    expect(cmd).toContain('--add-config "SCRAM-SHA-512=[password=wl_mon_x]"');
    expect(cmd).toContain(
      '--allow-principal User:watchlog --operation Describe --cluster --topic "*" --group "*"',
    );
    expect(cmd).toContain('--operation DescribeConfigs --topic "*"');
  });
});

describe('probable cause follows group_no_members to the member', () => {
  const ev = (platform: string, links: { kind: string; id: string; name: string }[]) =>
    ({
      platform,
      application: {
        id: 'a',
        type: 'kafka',
        name: 'kafka-e2e/kafka',
        health: 'critical',
        reason: { code: 'connected', facts: {} },
        target: {},
        reasons: [
          { severity: 'critical', code: 'group_no_members', facts: { group: 'audit' }, links },
        ],
      },
    }) as unknown as Evidence;

  it('a workload on Kubernetes, a container on Docker, nothing without a link', () => {
    expect(
      linksOf(
        ev('kubernetes', [
          { kind: 'workload', id: 'kafka-e2e/Deployment/audit', name: 'kafka-e2e/audit' },
        ]),
      )[0],
    ).toMatchObject({
      name: 'kafka-e2e/audit',
      finding: 'group_no_members',
      target: {
        kind: 'workload',
        namespace: 'kafka-e2e',
        name: 'audit',
        workloadKind: 'Deployment',
      },
    });
    expect(
      linksOf(ev('docker', [{ kind: 'container', id: 'audit-1', name: 'audit-1' }]))[0],
    ).toMatchObject({ target: { kind: 'container', name: 'audit-1' } });
    expect(linksOf(ev('kubernetes', []))).toEqual([]);
  });
});
