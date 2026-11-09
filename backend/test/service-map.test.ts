// SPDX-License-Identifier: AGPL-3.0-only
// Service map API (SPEC §4.5, Phase 4): flow series as the node agents write them.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { VictoriaQueryClient } from '../src/lib/victoria.js';
import {
  buildGraph,
  edgeMatchers,
  health,
  watchlogComponents,
} from '../src/modules/servicemap/graph.js';
import {
  TEST_VM_URL,
  closeTestContext,
  createTestContext,
  setupAdmin,
  type TestContext,
} from './helpers.js';
import { encode, type TestSeries } from './support/remote-write.js';

const RUN = `servicemap-${Date.now()}`;
const vm = new VictoriaQueryClient(TEST_VM_URL);
const SCRAPE = 15_000;
const NOW = Math.floor(Date.now() / SCRAPE) * SCRAPE;
let ctx: TestContext;
let cookie: string;
let clusterId: string;

const get = (url: string) =>
  ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, cookies: { wl_session: cookie } });

/** A counter growing `rate` per second over the last 20 minutes. */
function counter(name: string, labels: Record<string, string>, rate: number): TestSeries[] {
  const out: TestSeries[] = [];
  let v = 0;
  for (let t = NOW - 20 * 60_000; t <= NOW; t += SCRAPE) {
    out.push({
      labels: { __name__: name, run: RUN, node: 'w1', ...labels },
      value: v,
      timestampMs: t,
    });
    v += rate * (SCRAPE / 1000);
  }
  return out;
}

async function agent(ebpf: string, reason?: string, cause?: string) {
  await ctx.db
    .insertInto('agent_instances')
    .values({
      id: newId(),
      cluster_id: clusterId,
      node: 'w1',
      mode: 'node',
      agent_version: 'dev',
      capabilities: JSON.stringify({
        ebpf,
        cgroup: 'v2',
        ...(reason ? { ebpf_reason: reason } : {}),
        ...(cause ? { ebpf_cause: cause } : {}),
      }),
      last_seen_at: new Date(),
    })
    .execute();
}

beforeEach(async () => {
  ctx = await createTestContext();
  cookie = await setupAdmin(ctx.app);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/clusters',
    cookies: { wl_session: cookie },
    payload: { name: 'demo', kind: 'kubernetes' },
  });
  clusterId = res.json().cluster.id;
});
afterEach(() => closeTestContext(ctx));
afterAll(async () => {
  await fetch(
    `${TEST_VM_URL}/api/v1/admin/tsdb/delete_series?match[]=${encodeURIComponent(`{run="${RUN}"}`)}`,
    { method: 'POST' },
  );
});

const src = { namespace: 'shop', workload_kind: 'Deployment', workload: 'frontend' };
const pick = <T extends Record<string, string>>(o: T, ...keys: (keyof T)[]) =>
  Object.fromEntries(keys.map((k) => [k, o[k]]));
const cart = {
  ...src,
  dst_kind: 'workload',
  dst_namespace: 'shop',
  dst_workload_kind: 'Deployment',
  dst_workload: 'cart',
  dst_service: 'cart',
  dst_port: '8080',
};
const ext = { ...src, dst_kind: 'external', dst: '203.0.113.0/24', dst_port: '443' };

describe('GET /clusters/:id/service-map', () => {
  it('draws workloads, externals and edges with rates, failures, latency and health', async () => {
    await agent('enabled');
    await vm.write(
      { clusterId },
      encode([
        ...counter('watchlog_flow_connections_total', cart, 4),
        ...counter('watchlog_flow_connect_failed_total', cart, 1),
        ...counter('watchlog_flow_connect_latency_seconds_sum', cart, 3 * 0.002),
        ...counter('watchlog_flow_connect_latency_seconds_count', cart, 3),
        ...counter('watchlog_flow_connect_latency_seconds_bucket', { ...cart, le: '0.001' }, 0),
        ...counter('watchlog_flow_connect_latency_seconds_bucket', { ...cart, le: '0.0025' }, 3),
        ...counter('watchlog_flow_connect_latency_seconds_bucket', { ...cart, le: '+Inf' }, 3),
        ...counter('watchlog_flow_bytes_total', { ...cart, dir: 'sent' }, 1000),
        ...counter('watchlog_flow_bytes_total', { ...cart, dir: 'received' }, 4000),
        ...counter('watchlog_dns_requests_total', { ...src, rcode: 'NOERROR' }, 8),
        ...counter('watchlog_dns_requests_total', { ...src, rcode: 'NXDOMAIN' }, 1.5),
        ...counter('watchlog_dns_requests_total', { ...src, rcode: 'timeout' }, 0.5),
        ...counter('watchlog_dns_requests_total', { ...src, rcode: 'search_miss' }, 30),
        ...counter('watchlog_flow_connections_total', ext, 0.5),
        ...counter('watchlog_flow_connect_failed_total', ext, 0),
      ]),
    );
    await fetch(`${TEST_VM_URL}/internal/force_flush`);

    const res = await get(`/clusters/${clusterId}/service-map`);
    expect(res.statusCode, res.body).toBe(200);
    const map = res.json();
    expect(map.mode).toBe('flows');
    expect(map.nodes.map((n: { id: string; kind: string }) => [n.id, n.kind])).toEqual([
      ['w:shop/Deployment/cart', 'workload'],
      ['w:shop/Deployment/frontend', 'workload'],
      ['x:203.0.113.0/24:443', 'external'],
    ]);
    const toCart = map.edges.find((e: { target: string }) => e.target === 'w:shop/Deployment/cart');
    expect(toCart).toMatchObject({
      source: 'w:shop/Deployment/frontend',
      port: 8080,
      service: 'cart',
      health: 'critical',
    });
    expect(toCart.connectionsPerSecond).toBeCloseTo(4, 1);
    expect(toCart.failedRatio).toBeCloseTo(0.25, 2);
    expect(toCart.latencyMeanSeconds).toBeCloseTo(0.002, 4);
    expect(toCart.latencyP95Seconds).toBeGreaterThan(0.001);
    expect(toCart.latencyP95Seconds).toBeLessThanOrEqual(0.0025);
    expect(toCart.bytesReceivedPerSecond).toBeCloseTo(4000, -1);
    const toExt = map.edges.find((e: { target: string }) => e.target.startsWith('x:'));
    expect(toExt).toMatchObject({ health: 'ok', failedRatio: 0, bytesSentPerSecond: null });

    // DNS errors per workload (header rcodes and timeouts); search-path misses are
    // neither lookups nor errors (ADR-113).
    expect(map.dns).toHaveLength(1);
    expect(map.dns[0].node).toBe('w:shop/Deployment/frontend');
    expect(map.dns[0].requestsPerSecond).toBeCloseTo(10, 1);
    expect(map.dns[0].nxdomainPerSecond).toBeCloseTo(1.5, 1);
    expect(map.dns[0].timeoutPerSecond).toBeCloseTo(0.5, 1);
    expect(map.dns[0].searchMissPerSecond).toBeCloseTo(30, 0);
    expect(map.dns[0].errorRatio).toBeCloseTo(0.2, 2);

    // The edge's time series.
    const s = await get(
      `/clusters/${clusterId}/service-map/edge?source=${encodeURIComponent(toCart.source)}&target=${encodeURIComponent(toCart.target)}&port=8080&range=1800`,
    );
    expect(s.statusCode, s.body).toBe(200);
    const last = (pts: [number, number | null][]) => pts.filter(([, v]) => v !== null).at(-1)![1]!;
    expect(last(s.json().connections)).toBeCloseTo(4, 1);
    expect(last(s.json().failed)).toBeCloseTo(1, 1);
    expect(last(s.json().bytesSent)).toBeCloseTo(1000, -1);
  });

  it('shows an edge when its source or its destination is in the selected namespaces', async () => {
    await agent('enabled');
    const ops = { namespace: 'ops', workload_kind: 'Deployment', workload: 'probe' };
    const intoShop = {
      ...ops,
      ...pick(
        cart,
        'dst_kind',
        'dst_namespace',
        'dst_workload_kind',
        'dst_workload',
        'dst_service',
        'dst_port',
      ),
    };
    const named = { ...ops, dst_kind: 'external', dst: 'api.stripe.com', dst_port: '443' };
    await vm.write(
      { clusterId },
      encode([
        ...counter('watchlog_flow_connections_total', cart, 4),
        ...counter('watchlog_flow_connections_total', intoShop, 1),
        ...counter('watchlog_flow_connections_total', named, 1),
      ]),
    );
    await fetch(`${TEST_VM_URL}/internal/force_flush`);
    const edges = async (ns: string) =>
      (
        (await get(`/clusters/${clusterId}/service-map?namespaces=${ns}`)).json().edges as {
          source: string;
          target: string;
        }[]
      )
        .map((e) => `${e.source}>${e.target}`)
        .sort();
    expect(await edges('shop')).toEqual([
      'w:ops/Deployment/probe>w:shop/Deployment/cart',
      'w:shop/Deployment/frontend>w:shop/Deployment/cart',
    ]);
    expect(await edges('ops')).toEqual([
      'w:ops/Deployment/probe>w:shop/Deployment/cart',
      'w:ops/Deployment/probe>x:api.stripe.com:443',
    ]);
  });

  it('draws a keep-alive edge that only moved bytes in the range (ADR-108)', async () => {
    await agent('enabled');
    await vm.write(
      { clusterId },
      encode([
        ...counter('watchlog_flow_connections_total', cart, 0),
        ...counter('watchlog_flow_bytes_total', { ...cart, dir: 'sent' }, 900),
      ]),
    );
    await fetch(`${TEST_VM_URL}/internal/force_flush`);
    const map = (await get(`/clusters/${clusterId}/service-map`)).json();
    expect(map.edges).toMatchObject([
      { source: 'w:shop/Deployment/frontend', target: 'w:shop/Deployment/cart', health: 'ok' },
    ]);
    expect(map.edges[0].bytesSentPerSecond).toBeCloseTo(900, -1);
  });

  it('falls back to topology from Services when no agent has eBPF, with the reasons', async () => {
    await agent('unsupported', 'kernel has no BTF (/sys/kernel/btf/vmlinux missing)', 'kernel');
    await ctx.db
      .insertInto('objects')
      .values({
        id: newId(),
        cluster_id: clusterId,
        source: 'kubernetes',
        kind: 'Service',
        uid: 'svc-cart',
        namespace: 'shop',
        name: 'cart',
        spec_summary: JSON.stringify({ cluster_ips: ['10.96.0.9'] }),
        status_summary: JSON.stringify({
          workloads: [{ kind: 'Deployment', name: 'cart' }],
          ready_endpoints: 2,
        }),
      })
      .execute();
    const map = (await get(`/clusters/${clusterId}/service-map`)).json();
    expect(map.mode).toBe('topology');
    expect(map.dns).toEqual([]);
    expect(map.agents).toEqual([
      {
        node: 'w1',
        ebpf: 'unsupported',
        reason: 'kernel has no BTF (/sys/kernel/btf/vmlinux missing)',
        cause: 'kernel',
        fix: null,
      },
    ]);
    expect(map.edges).toMatchObject([
      {
        source: 's:shop/cart',
        target: 'w:shop/Deployment/cart',
        health: 'unknown',
        connectionsPerSecond: 0,
      },
    ]);
  });
});

describe('eBPF fixes per agent (ADR-107)', () => {
  it('draws Compose networks and their containers for a Docker fleet without eBPF', async () => {
    await ctx.db.updateTable('orgs').set({ plan: 'pro' }).execute(); // a second cluster
    const fleet = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/clusters',
        cookies: { wl_session: cookie },
        payload: { name: 'fleet', kind: 'docker' },
      })
    ).json().cluster.id as string;
    const ctr = (name: string, project: string, networks: string[], state = 'running') => ({
      id: newId(),
      cluster_id: fleet,
      source: 'docker',
      kind: 'DockerContainer',
      uid: name.padEnd(12, '0'),
      node: 'host-1',
      name,
      namespace: project,
      spec_summary: JSON.stringify({ image: 'x:1', compose_service: name.split('-')[1], networks }),
      status_summary: JSON.stringify({ state }),
    });
    await ctx.db
      .insertInto('objects')
      .values([
        ctr('demo-web-1', 'demo', ['demo_default']),
        ctr('demo-db-1', 'demo', ['demo_default', 'demo_backend']),
        ctr('demo-old-1', 'demo', ['demo_default'], 'exited'),
        ctr('solo', '', []),
      ])
      .execute();
    const map = (await get(`/clusters/${fleet}/service-map`)).json();
    expect(map.mode).toBe('topology');
    const nodes = Object.fromEntries(
      map.nodes.map((n: { id: string; kind: string; namespace: string | null; name: string }) => [
        n.id,
        [n.kind, n.namespace, n.name],
      ]),
    );
    expect(nodes).toEqual({
      'c:demo-web-1': ['container', 'demo', 'web'],
      'c:demo-db-1': ['container', 'demo', 'db'],
      'c:solo': ['container', null, 'solo'],
      's:host-1/demo_default': ['service', 'demo', 'demo_default'],
      's:host-1/demo_backend': ['service', 'demo', 'demo_backend'],
    });
    expect(
      map.edges.map((e: { source: string; target: string }) => `${e.source}>${e.target}`).sort(),
    ).toEqual([
      's:host-1/demo_backend>c:demo-db-1',
      's:host-1/demo_default>c:demo-db-1',
      's:host-1/demo_default>c:demo-web-1',
    ]);
  });

  it('names the Docker agent container from the inventory and the release from the chart', async () => {
    const id = 'f'.repeat(64);
    await ctx.db
      .insertInto('agent_instances')
      .values([
        {
          id: newId(),
          cluster_id: clusterId,
          node: 'host-1',
          mode: 'docker',
          agent_version: 'dev',
          capabilities: JSON.stringify({ ebpf: 'disabled', cgroup: 'v2' }),
          last_seen_at: new Date(),
        },
        {
          id: newId(),
          cluster_id: clusterId,
          node: 'w2',
          mode: 'node',
          agent_version: 'dev',
          capabilities: JSON.stringify({
            ebpf: 'disabled',
            ebpf_cause: 'config',
            ebpf_reason: 'turned off by configuration (WATCHLOG_EBPF=false)',
            cgroup: 'v2',
            helm_release: 'watchlog-dev/kind-demo',
            helm_chart: 'watchlog-agent',
          }),
          last_seen_at: new Date(),
        },
      ])
      .execute();
    await ctx.db
      .insertInto('objects')
      .values({
        id: newId(),
        cluster_id: clusterId,
        source: 'docker',
        kind: 'DockerContainer',
        uid: id,
        node: 'host-1',
        name: 'watchlog-agent-dev',
        spec_summary: JSON.stringify({ image: 'watchlog-agent:dev' }),
      })
      .execute();
    const map = (await get(`/clusters/${clusterId}/service-map`)).json();
    const [host, w2] = map.agents;
    expect(host).toMatchObject({ node: 'host-1', cause: 'outdated' });
    expect(host.fix).toContain('docker rm -f watchlog-agent-dev && \\');
    expect(w2).toMatchObject({ node: 'w2', cause: 'config' });
    expect(w2.fix).toBe(
      [
        'helm upgrade kind-demo deploy/helm/watchlog-agent \\',
        '  --namespace watchlog-dev --reuse-values \\',
        '  --set agent.networkFlows.enabled=true',
      ].join('\n'),
    );
  });
});

describe("WatchLog's own components", () => {
  it('are found by image and their siblings of the same install, nothing else', () => {
    const w = (ns: string, name: string, image: string) => ({
      id: `w:${ns}/Deployment/${name}`,
      group: ns,
      name,
      images: [image],
    });
    const own = watchlogComponents([
      w('watchlog', 'watchlog-backend', 'ghcr.io/watchlog-light/backend:0.1.0'),
      w('watchlog', 'watchlog-postgresql', 'postgres:16-alpine'),
      w('watchlog', 'watchlog-victoriametrics', 'victoriametrics/victoria-metrics:v1.155.0'),
      w('watchlog', 'grafana', 'grafana/grafana:12'),
      w('watchlog-dev', 'wl-dev', 'ghcr.io/watchlog-light/agent:dev'),
      w('watchlog-dev', 'wl-dev-cluster-agent', 'ghcr.io/watchlog-light/cluster-agent:dev'),
      w('shop', 'watchlog-postgresql', 'postgres:16-alpine'), // another namespace
      // Docker: an agent container, and kind's node container on the same host.
      {
        id: 'c:watchlog-agent',
        group: 'host-1',
        name: 'watchlog-agent',
        images: ['watchlog-agent:dev'],
      },
      {
        id: 'c:watchlog-worker',
        group: 'host-1',
        name: 'watchlog-worker',
        images: ['kindest/node:v1.37.0'],
      },
      {
        id: 'c:watchlog-postgres-1',
        group: 'host-1',
        name: 'watchlog-postgres-1',
        images: ['postgres:16-alpine'],
      },
    ]);
    expect([...own].sort()).toEqual([
      'c:watchlog-agent',
      'c:watchlog-postgres-1',
      'w:watchlog-dev/Deployment/wl-dev',
      'w:watchlog-dev/Deployment/wl-dev-cluster-agent',
      'w:watchlog/Deployment/watchlog-backend',
      'w:watchlog/Deployment/watchlog-postgresql',
      'w:watchlog/Deployment/watchlog-victoriametrics',
    ]);
  });

  it('are flagged on the map, and an edge gets its target readiness and firing alert', async () => {
    await agent('enabled');
    const own = {
      namespace: 'watchlog',
      workload_kind: 'Deployment',
      workload: 'watchlog-backend',
      dst_kind: 'workload',
      dst_namespace: 'watchlog',
      dst_workload_kind: 'StatefulSet',
      dst_workload: 'watchlog-postgresql',
      dst_port: '5432',
    };
    await vm.write(
      { clusterId },
      encode([
        ...counter('watchlog_flow_connections_total', cart, 4),
        ...counter('watchlog_flow_connect_failed_total', cart, 2),
        ...counter('watchlog_flow_connections_total', own, 1),
      ]),
    );
    await fetch(`${TEST_VM_URL}/internal/force_flush`);
    const obj = (ns: string, kind: string, name: string, spec: object, status: object = {}) => ({
      id: newId(),
      cluster_id: clusterId,
      source: 'kubernetes',
      kind,
      uid: `${ns}-${name}`,
      namespace: ns,
      name,
      spec_summary: JSON.stringify(spec),
      status_summary: JSON.stringify(status),
    });
    await ctx.db
      .insertInto('objects')
      .values([
        obj('watchlog', 'Deployment', 'watchlog-backend', {
          containers: [{ image: 'ghcr.io/watchlog-light/backend:0.1.0' }],
        }),
        obj('watchlog', 'StatefulSet', 'watchlog-postgresql', {
          containers: [{ image: 'postgres:16-alpine' }],
        }),
        obj(
          'shop',
          'Deployment',
          'cart',
          { replicas: 2, containers: [{ image: 'cart:1' }] },
          { ready: 0 },
        ),
      ])
      .execute();
    const map = (await get(`/clusters/${clusterId}/service-map`)).json();
    const flag = Object.fromEntries(
      map.nodes.map((n: { id: string; watchlog: boolean }) => [n.id, n.watchlog]),
    );
    expect(flag).toMatchObject({
      'w:shop/Deployment/frontend': false,
      'w:shop/Deployment/cart': false,
      'w:watchlog/Deployment/watchlog-backend': true,
      'w:watchlog/StatefulSet/watchlog-postgresql': true,
    });

    await get('/alert-rules'); // creates the default rules
    const cluster = await ctx.db
      .selectFrom('clusters')
      .select('org_id')
      .where('id', '=', clusterId)
      .executeTakeFirstOrThrow();
    const rule = await ctx.db
      .selectFrom('alert_rules')
      .select('id')
      .where('rule_key', '=', 'network.connections.failed')
      .executeTakeFirstOrThrow();
    const labels = Object.fromEntries(Object.entries(cart).filter(([k]) => k !== 'dst_port'));
    const alertId = newId();
    await ctx.db
      .insertInto('alert_states')
      .values({
        id: alertId,
        org_id: cluster.org_id,
        rule_id: rule.id,
        cluster_id: clusterId,
        fingerprint: `f-${alertId}`,
        state: 'firing',
        severity: 'critical',
        labels: JSON.stringify(labels),
        started_at: new Date(Date.now() - 600_000),
        fired_at: new Date(Date.now() - 300_000),
      })
      .execute();
    const s = await get(
      `/clusters/${clusterId}/service-map/edge?source=${encodeURIComponent('w:shop/Deployment/frontend')}&target=${encodeURIComponent('w:shop/Deployment/cart')}&port=8080`,
    );
    expect(s.statusCode, s.body).toBe(200);
    expect(s.json().context).toMatchObject({
      target: { ready: 0, desired: 2 },
      alert: { id: alertId },
    });
  });
});

describe('edges', () => {
  it('rates health: critical at the failed-connections rule threshold, warning at 1 % or slow connects', () => {
    expect(health({ connectionsPerSecond: 1, failedRatio: 0.05, latencyP95Seconds: 0.01 })).toBe(
      'critical',
    );
    expect(health({ connectionsPerSecond: 1, failedRatio: 0.02, latencyP95Seconds: 0.01 })).toBe(
      'warning',
    );
    expect(health({ connectionsPerSecond: 1, failedRatio: 0, latencyP95Seconds: 1.5 })).toBe(
      'warning',
    );
    expect(health({ connectionsPerSecond: 1, failedRatio: 0, latencyP95Seconds: 0.01 })).toBe('ok');
    expect(health({ connectionsPerSecond: 0, failedRatio: null, latencyP95Seconds: null })).toBe(
      'idle',
    );
    // A keep-alive pool: no new connections, bytes flowing (podinfo on kind).
    expect(
      health({
        connectionsPerSecond: 0,
        failedRatio: null,
        latencyP95Seconds: null,
        bytesSentPerSecond: 900,
      }),
    ).toBe('ok');
  });

  it('reads HTTP per edge, and 5xx turn it warning at 1 % and critical at 5 % (ADR-139)', () => {
    const l = {
      namespace: 'shop',
      workload_kind: 'Deployment',
      workload: 'frontend',
      dst_kind: 'workload',
      dst_namespace: 'shop',
      dst_workload_kind: 'Deployment',
      dst_workload: 'cart',
      dst_port: '8080',
    };
    const at = (v: number, extra: Record<string, string> = {}) => ({
      labels: { ...l, ...extra },
      points: [[1793440000, v]] as [number, number | null][],
    });
    const graph = (fiveXX: number) =>
      buildGraph({
        seen: [at(1)],
        connections: [at(0.2)],
        failed: [at(0)],
        latencySum: [],
        latencyCount: [],
        latencyP95: [at(0.002)],
        bytes: [],
        retransmits: [],
        http: {
          byClass: [
            at(97 - fiveXX, { class: '2xx' }),
            at(3, { class: '4xx' }),
            at(fiveXX, { class: '5xx' }),
          ],
          p50: [at(0.01)],
          p95: [at(0.2)],
          p99: [at(0.8)],
        },
      }).edges[0]!;
    const e = graph(0.5);
    expect(e.http).toEqual({
      requestsPerSecond: 100,
      clientErrorsPerSecond: 3,
      serverErrorsPerSecond: 0.5,
      serverErrorRatio: 0.005,
      p50Seconds: 0.01,
      p95Seconds: 0.2,
      p99Seconds: 0.8,
    });
    expect(e.health).toBe('ok');
    expect(graph(2).health).toBe('warning');
    expect(graph(6).health).toBe('critical');
    // An edge with no HTTP seen has none.
    expect(
      buildGraph({
        seen: [at(1)],
        connections: [at(1)],
        failed: [],
        latencySum: [],
        latencyCount: [],
        latencyP95: [],
        bytes: [],
        retransmits: [],
      }).edges[0]!.http,
    ).toBeNull();
  });

  it('counts failures only while there are some in the last minute (ADR-116)', () => {
    // A keep-alive client after a startup blip: every new connect in 5 min failed, but
    // none in the last minute, and bytes flow. Recovered, not red.
    const blip = {
      connectionsPerSecond: 0.16,
      failedRatio: 1,
      latencyP95Seconds: 0.01,
      bytesSentPerSecond: 1800,
    };
    expect(health({ ...blip, failedLastMinute: 0 })).toBe('ok');
    expect(health({ ...blip, failedLastMinute: 3 })).toBe('critical');
    expect(health({ ...blip, failedRatio: 0.02, failedLastMinute: 1 })).toBe('warning');
    // Slow stays slow, failures or not.
    expect(
      health({
        connectionsPerSecond: 1,
        failedRatio: 0.5,
        latencyP95Seconds: 2,
        failedLastMinute: 0,
      }),
    ).toBe('warning');
    // Without the last-minute series (older callers), the 5-minute share decides, as before.
    expect(health(blip)).toBe('critical');
  });

  it('turns node ids back into label matchers, IPv6 externals included', () => {
    expect(edgeMatchers('w:shop/Deployment/frontend', 'x:2001:db8:aa::/48:443', 443)).toEqual({
      namespace: 'shop',
      workload_kind: 'Deployment',
      workload: 'frontend',
      dst_kind: 'external',
      dst: '2001:db8:aa::/48',
      dst_port: '443',
    });
    // Named by the source's DNS lookup (ADR-104).
    expect(edgeMatchers('w:ops/Deployment/probe', 'x:api.stripe.com:443', 443)).toMatchObject({
      dst_kind: 'external',
      dst: 'api.stripe.com',
      dst_port: '443',
    });
    expect(edgeMatchers('c:demo-web-1', 'internet', null)).toEqual({
      container: 'demo-web-1',
      dst_kind: 'internet',
    });
    expect(edgeMatchers('s:shop/cart', 'internet', null)).toBeNull();
  });
});
