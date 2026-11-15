// SPDX-License-Identifier: AGPL-3.0-only
// GET /api/v1/egress/policy (ADR-190, ADR-191; v0.7 slice 7): the suggested egress policy for
// one Kubernetes workload, in two flavours, as YAML text. In-cluster destinations come from
// flow series written to the real test VictoriaMetrics; external ones from inventory rows as
// the minute job writes them; Cilium from the cluster-agent's heartbeat capabilities. The
// clock is injected. Cloud's org scoping is the isolation suite's ("egress policy").
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { authorisedScope, VictoriaQueryClient } from '../src/lib/victoria.js';
import { classifyDestination } from '../src/modules/egress/inventory.js';
import {
  parseWorkload,
  renderCilium,
  renderKubernetes,
  sharedLabels,
  type PolicyInput,
} from '../src/modules/egress/policy.js';
import {
  closeTestContext,
  createTestContext,
  createUserSession,
  setupAdmin,
  TEST_VM_URL,
  type TestContext,
} from './helpers.js';
import { encode, type TestSeries } from './support/remote-write.js';

const MIN = 60_000;
const DAY = 86_400_000;
const SCRAPE = 15_000;
const RUN = `egress-policy-${Date.now()}`;
const NOW = Math.floor(Date.now() / SCRAPE) * SCRAPE;
const vm = new VictoriaQueryClient(TEST_VM_URL);

let ctx: TestContext;
let cookie: string;

afterAll(async () => {
  await fetch(
    `${TEST_VM_URL}/api/v1/admin/tsdb/delete_series?match[]=${encodeURIComponent(`{run="${RUN}"}`)}`,
    { method: 'POST' },
  );
});

async function open(overrides = {}) {
  ctx = await createTestContext(overrides, { now: () => NOW });
  cookie = await setupAdmin(ctx.app);
}
afterEach(() => closeTestContext(ctx));

const get = (query: Record<string, string>, as = cookie) =>
  ctx.app.inject({
    method: 'GET',
    url: '/api/v1/egress/policy',
    query,
    cookies: { wl_session: as },
  });

async function cluster(kind: 'kubernetes' | 'docker', name: string = kind) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/clusters',
    cookies: { wl_session: cookie },
    payload: { name, kind },
  });
  tokens.set(res.json().cluster.id, res.json().token.value);
  return res.json().cluster.id as string;
}
const tokens = new Map<string, string>();

async function object(
  clusterId: string,
  kind: string,
  namespace: string,
  name: string,
  spec: object = {},
  status: object = {},
) {
  await ctx.db
    .insertInto('objects')
    .values({
      id: newId(),
      cluster_id: clusterId,
      source: 'kubernetes',
      kind,
      namespace,
      name,
      uid: newId(),
      spec_summary: JSON.stringify(spec),
      status_summary: JSON.stringify(status),
    })
    .execute();
}

/** A running pod of a workload with its labels. */
const pod = (
  clusterId: string,
  ns: string,
  wkind: string,
  wname: string,
  name: string,
  labels: Record<string, string>,
  phase = 'Running',
) =>
  object(clusterId, 'Pod', ns, name, { workload: { kind: wkind, name: wname }, labels }, { phase });

async function inventory(
  clusterId: string,
  source: Record<string, string>,
  destination: string,
  port: number,
  lastAgoMs = 0,
) {
  const internet = destination === 'Internet';
  await ctx.db
    .insertInto('egress_destinations')
    .values({
      cluster_id: clusterId,
      source: JSON.stringify(source),
      destination,
      dst_kind: internet ? 'internet' : 'external',
      port,
      destination_class: classifyDestination(internet ? 'internet' : 'external', destination),
      first_seen: new Date(NOW - 40 * DAY),
      last_seen: new Date(NOW - lastAgoMs),
    })
    .execute();
}

async function expect_(
  clusterId: string,
  pattern: string,
  port: number | null,
  source: Record<string, string> | null,
) {
  await ctx.db
    .insertInto('egress_expected')
    .values({
      cluster_id: clusterId,
      pattern,
      port,
      source: source ? JSON.stringify(source) : null,
    })
    .execute();
}

async function agent(clusterId: string, capabilities: object) {
  await ctx.db
    .insertInto('agent_instances')
    .values({
      id: newId(),
      cluster_id: clusterId,
      agent_version: '0.7.0',
      mode: 'cluster',
      node: 'cluster-agent',
      last_seen_at: new Date(NOW),
      capabilities: JSON.stringify(capabilities),
    })
    .execute();
}

function counter(name: string, labels: Record<string, string>, per: number): TestSeries[] {
  const out: TestSeries[] = [];
  for (let i = 0, t = NOW - 31 * MIN; t <= NOW - MIN; i++, t += SCRAPE) {
    out.push({ labels: { __name__: name, run: RUN, ...labels }, value: i * per, timestampMs: t });
  }
  return out;
}

async function write(clusterId: string, series: TestSeries[]) {
  await vm.write(authorisedScope(clusterId), encode(series));
  await fetch(`${TEST_VM_URL}/internal/force_flush`);
  const want = new Set(series.map((s) => JSON.stringify(s.labels))).size;
  for (let i = 0; i < 50; i++) {
    const found = await vm.query(
      authorisedScope(clusterId),
      `count({run="${RUN}"})`,
      (NOW - MIN) / 1000,
    );
    if ((found[0]?.points[0]?.[1] ?? 0) >= want) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('series not searchable');
}

const checkout = { namespace: 'shop', workload_kind: 'Deployment', workload: 'checkout' };
const src = { namespace: 'shop', workload_kind: 'Deployment', workload: 'checkout', node: 'n1' };
const flow = (dst: Record<string, string>) =>
  counter('watchlog_flow_connections_total', { ...src, ...dst }, 1);

/** Every non-comment line is a plain key, a quoted string or a list item: no raw data. */
function yamlShapeOk(yaml: string) {
  const scalar = String.raw`("([^"\\]|\\.)*"|-?\d+|[A-Za-z][A-Za-z0-9.\-/]*)`;
  const key = String.raw`("([^"\\]|\\.)*"|[A-Za-z][A-Za-z0-9]*)`;
  const line = new RegExp(String.raw`^ *(- )?(${key}:( ${scalar})?|${scalar})$`);
  return yaml
    .split('\n')
    .filter((l) => l.trim() && !l.trimStart().startsWith('#'))
    .filter((l) => !line.test(l));
}

/** The world of the main case: the workload, its peers, its externals and expectations. */
async function seedShop(id: string) {
  await object(id, 'Deployment', 'shop', 'checkout');
  // Two pods: pod-template-hash differs, version is shared but volatile labels go.
  await pod(id, 'shop', 'Deployment', 'checkout', 'checkout-a', {
    app: 'checkout',
    tier: 'web',
    'pod-template-hash': 'aaa',
  });
  await pod(id, 'shop', 'Deployment', 'checkout', 'checkout-b', {
    app: 'checkout',
    tier: 'web',
    'pod-template-hash': 'bbb',
  });
  await pod(id, 'shop', 'Deployment', 'checkout', 'checkout-old', { app: 'old' }, 'Succeeded');
  await pod(id, 'shop', 'StatefulSet', 'postgres', 'postgres-0', {
    app: 'postgres',
    'statefulset.kubernetes.io/pod-name': 'postgres-0',
  });
  await pod(id, 'cache', 'Deployment', 'redis', 'redis-1', { app: 'redis' });
  await object(id, 'Service', 'cache', 'redis', { selector: { app: 'redis', role: 'primary' } });
  await object(id, 'Service', 'kube-system', 'kube-dns', { selector: { 'k8s-app': 'kube-dns' } });
  // Externals: names, a public and a private network, a local name, Internet, an old one,
  // another workload's.
  await inventory(id, checkout, 'api.stripe.com', 443);
  await inventory(id, checkout, 'maps.googleapis.com', 443, 2 * DAY);
  await inventory(id, checkout, 'api.stripe.com', 8443);
  await inventory(id, checkout, '104.18.43.0/24', 443);
  await inventory(id, checkout, '10.0.3.0/24', 5432);
  await inventory(id, checkout, 'billing', 8080);
  await inventory(id, checkout, 'Internet', 0);
  await inventory(id, checkout, 'old.example.com', 443, 40 * DAY);
  await inventory(id, { ...checkout, workload: 'other' }, 'other.example.com', 443);
  // Expectations: every source, this workload, another workload.
  await expect_(id, '*.amazonaws.com', 443, null);
  await expect_(id, 'hooks.slack.com', null, checkout);
  await expect_(id, 'api.stripe.com', 443, checkout);
  await expect_(id, '203.0.113.0/24', 22, checkout);
  await expect_(id, 'never.example.com', 443, { ...checkout, workload: 'other' });
  await write(id, [
    ...flow({
      dst_kind: 'workload',
      dst_namespace: 'shop',
      dst_workload_kind: 'StatefulSet',
      dst_workload: 'postgres',
      dst_port: '5432',
    }),
    ...flow({
      dst_kind: 'workload',
      dst_namespace: 'cache',
      dst_workload_kind: 'Deployment',
      dst_workload: 'redis',
      dst_service: 'redis',
      dst_port: '6379',
    }),
    ...flow({
      dst_kind: 'service',
      dst_namespace: 'kube-system',
      dst_service: 'kube-dns',
      dst_port: '53',
    }),
    ...flow({ dst_kind: 'node', dst: 'kind-control-plane', dst_port: '6443' }),
    ...flow({
      dst_kind: 'workload',
      dst_namespace: 'shop',
      dst_workload_kind: 'Deployment',
      dst_workload: 'gone',
      dst_port: '9000',
    }),
    // An external edge: not in-cluster (externals come from the inventory).
    ...flow({ dst_kind: 'external', dst: 'api.stripe.com', dst_port: '443' }),
  ]);
}

describe('egress policy suggestion (ADR-190)', () => {
  it('both flavours for a workload: window, peers, names, networks, expectations, DNS; Cilium detected first', async () => {
    await open();
    const id = await cluster('kubernetes');
    await seedShop(id);
    await agent(id, { ebpf: 'disabled', cilium: true });
    const res = await get({ cluster: id, workload: 'shop/Deployment/checkout' });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.cluster).toEqual({ id, kind: 'kubernetes' });
    expect(body.workload).toEqual({ namespace: 'shop', kind: 'Deployment', name: 'checkout' });
    expect(body.cilium).toBe(true);
    expect(body.policies.map((p: { flavour: string }) => p.flavour)).toEqual([
      'cilium',
      'kubernetes',
    ]);
    // The window: in-cluster from the first retained flow sample, externals 30 days.
    expect(Date.parse(body.window.inCluster.from)).toBe(NOW - 31 * MIN);
    expect(Date.parse(body.window.external.from)).toBe(NOW - 30 * DAY);
    expect(Date.parse(body.window.to)).toBe(NOW);
    expect(body.counts).toEqual({
      inCluster: 2,
      names: 2,
      networks: 2,
      expected: 3,
      skipped: 0,
      unresolved: 1,
    });

    const cil = body.policies[0].yaml as string;
    const std = body.policies[1].yaml as string;
    for (const y of [cil, std]) {
      expect(yamlShapeOk(y)).toEqual([]);
      expect(y).toContain('# WatchLog never applies it: review it, and try it in staging first.');
      const d = (ms: number) => new Date(ms).toISOString().slice(0, 10);
      expect(y).toContain(
        `# Window: in-cluster destinations from the flow series, ${d(NOW - 31 * MIN)} to ${d(NOW)}`,
      );
      expect(y).toContain(`egress inventory, ${d(NOW - 30 * DAY)} to ${d(NOW)}`);
      expect(y).toContain('  name: "checkout-egress"\n  namespace: "shop"');
      // The selector: the labels both live pods share, without pod-template-hash.
      expect(y).toContain('    matchLabels:\n      "app": "checkout"\n      "tier": "web"\n');
      expect(y).not.toContain('pod-template-hash');
      expect(y).not.toContain('"old"');
      expect(y).toContain("past the agent's 50 per source");
      expect(y).toContain('1 in-cluster destination(s) left out');
      expect(y).not.toContain('old.example.com');
      expect(y).not.toContain('other.example.com');
      expect(y).not.toContain('never.example.com');
      expect(y).not.toContain('gone');
    }

    // Standard flavour.
    expect(std).toContain('apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy');
    expect(std).toContain('# Standard NetworkPolicy matches addresses, not DNS names');
    expect(std).toContain('#   port 443: api.stripe.com, maps.googleapis.com');
    expect(std).toContain('#   port 8443: api.stripe.com');
    expect(std).toContain(
      '# Local names are not allowed (no address WatchLog knows): billing:8080.',
    );
    expect(std).toContain(
      '              "kubernetes.io/metadata.name": "kube-system"\n          podSelector:\n            matchLabels:\n              "k8s-app": "kube-dns"\n      ports:\n        - port: 53\n          protocol: UDP\n        - port: 53\n          protocol: TCP',
    );
    // postgres directly (its pod port), redis through its Service (every port, the Service's selector).
    expect(std).toContain(
      '    # StatefulSet shop/postgres\n    - to:\n        - namespaceSelector:\n            matchLabels:\n              "kubernetes.io/metadata.name": "shop"\n          podSelector:\n            matchLabels:\n              "app": "postgres"\n      ports:\n        - port: 5432\n          protocol: TCP',
    );
    expect(std).toContain(
      '    # Service cache/redis (Deployment redis)\n    # reached through a Service on port 6379',
    );
    expect(std).toContain('"app": "redis"\n              "role": "primary"');
    expect(std).toContain(
      "# Node addresses were reached on port 6443: add an ipBlock with your nodes' addresses",
    );
    expect(std).toContain(
      '            cidr: "0.0.0.0/0"\n            except:\n              - "10.0.0.0/8"',
    );
    expect(std).toContain('            cidr: "::/0"');
    expect(std).toMatch(
      /any public address on their ports\n(.*\n){16} {6}ports:\n {8}- port: 443\n {10}protocol: TCP\n {8}- port: 8443\n/,
    );
    expect(std).toContain('# Expected for any port: any public address on any port');
    expect(std).toContain('#   hooks.slack.com');
    expect(std).toContain(
      '    # Private network seen\n    - to:\n        - ipBlock:\n            cidr: "10.0.3.0/24"\n      ports:\n        - port: 5432',
    );
    expect(std).toContain('cidr: "104.18.43.0/24"');
    expect(std).toContain(
      '    # Expected network\n    - to:\n        - ipBlock:\n            cidr: "203.0.113.0/24"\n      ports:\n        - port: 22',
    );
    expect(std).not.toContain('toFQDNs');

    // Cilium flavour.
    expect(cil).toContain('apiVersion: cilium.io/v2\nkind: CiliumNetworkPolicy');
    expect(cil).not.toContain('Cilium was not detected');
    expect(cil).toContain("# toFQDNs needs Cilium's DNS proxy");
    expect(cil).toContain(
      '            "k8s:io.kubernetes.pod.namespace": "kube-system"\n            "k8s:k8s-app": "kube-dns"\n      toPorts:\n        - ports:\n            - port: "53"\n              protocol: ANY\n          rules:\n            dns:\n              - matchPattern: "*"',
    );
    expect(cil).toContain(
      '    # Port 443\n    - toFQDNs:\n        - matchPattern: "*.amazonaws.com"\n        - matchName: "api.stripe.com"\n        - matchName: "maps.googleapis.com"\n      toPorts:\n        - ports:\n            - port: "443"\n              protocol: TCP',
    );
    expect(cil).toContain('    # Port 8080\n    - toFQDNs:\n        - matchName: "billing"');
    expect(cil).toContain('    # Port 8443\n    - toFQDNs:\n        - matchName: "api.stripe.com"');
    expect(cil).toContain(
      '    # Expected for any port\n    - toFQDNs:\n        - matchName: "hooks.slack.com"\n',
    );
    expect(cil).toContain('    - toEntities:\n        - host\n        - remote-node');
    expect(cil).toContain('    - toCIDR:\n        - "104.18.43.0/24"');
    expect(cil).toContain('"k8s:io.kubernetes.pod.namespace": "cache"\n            "app": "redis"');
    expect(cil).toContain('"**." for any depth');
    expect(body.policies[0].notes.join(' ')).toContain('DNS proxy');
    expect(body.policies[1].notes.join(' ')).toContain('not DNS names');
    expect(body.policies[1].notes.join(' ')).toContain("the Service's port, not the pod's");
  });

  it('Cilium not detected or unknown: the standard flavour first; one flavour on request', async () => {
    await open();
    const id = await cluster('kubernetes');
    await pod(id, 'shop', 'Deployment', 'checkout', 'checkout-a', { app: 'checkout' });
    await inventory(id, checkout, 'api.stripe.com', 443);
    // Unknown: no cluster-agent heartbeat (or an older one without the field).
    let res = await get({ cluster: id, workload: 'shop/Deployment/checkout' });
    expect(res.statusCode).toBe(200);
    expect(res.json().cilium).toBeNull();
    expect(res.json().policies.map((p: { flavour: string }) => p.flavour)).toEqual([
      'kubernetes',
      'cilium',
    ]);
    expect(res.json().policies[1].yaml).toContain(
      "# WatchLog doesn't know whether Cilium is installed on this cluster.",
    );
    // The cluster-agent's heartbeat carries cilium: false (ADR-191), stored with its capabilities.
    const hb = await ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/heartbeat',
      headers: { authorization: `Bearer ${tokens.get(id)}`, 'x-watchlog-agent': 'cluster-agent' },
      payload: {
        agent_version: '0.7.0',
        mode: 'cluster',
        node: 'cluster-agent',
        capabilities: { ebpf: 'disabled', cgroup: 'none', cilium: false },
        series: 10,
      },
    });
    expect(hb.statusCode, hb.body).toBe(204);
    res = await get({ cluster: id, workload: 'shop/Deployment/checkout' });
    expect(res.json().cilium).toBe(false);
    expect(res.json().policies[0].flavour).toBe('kubernetes');
    expect(res.json().policies[1].yaml).toContain('# Cilium was not detected on this cluster');
    expect(res.json().policies[1].notes).toContain('Cilium was not detected on this cluster.');
    res = await get({ cluster: id, workload: 'shop/Deployment/checkout', flavour: 'cilium' });
    expect(res.json().policies).toHaveLength(1);
    expect(res.json().policies[0].flavour).toBe('cilium');
    expect(
      (await get({ cluster: id, workload: 'shop/Deployment/checkout', flavour: 'x' })).statusCode,
    ).toBe(400);
  });

  it('empty: a workload that reached nothing gets DNS only; without metrics storage the window says so', async () => {
    await open({ victoriaMetricsUrl: undefined });
    const id = await cluster('kubernetes');
    await pod(id, 'jobs', 'CronJob', 'report', 'report-1', {
      app: 'report',
      'job-name': 'report-123',
      'batch.kubernetes.io/controller-uid': 'u1',
    });
    const res = await get({ cluster: id, workload: 'jobs/CronJob/report' });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.window.inCluster).toBeNull();
    expect(body.counts).toEqual({
      inCluster: 0,
      names: 0,
      networks: 0,
      expected: 0,
      skipped: 0,
      unresolved: 0,
    });
    for (const p of body.policies) {
      expect(yamlShapeOk(p.yaml)).toEqual([]);
      expect(p.yaml).toContain('from the flow series, none retained up to');
      expect(p.yaml).toContain('"app": "report"');
      expect(p.yaml).not.toContain('job-name');
      expect(p.yaml).not.toContain('controller-uid');
    }
    const std = body.policies.find((p: { flavour: string }) => p.flavour === 'kubernetes').yaml;
    expect(std).not.toContain('ipBlock');
    expect(std.match(/- to:/g)).toHaveLength(1); // DNS alone
    const cil = body.policies.find((p: { flavour: string }) => p.flavour === 'cilium').yaml;
    expect(cil).not.toContain('- toFQDNs:');
  });

  it('hostile names stay out: destinations, labels and workload names are validated, never echoed', async () => {
    await open();
    const id = await cluster('kubernetes');
    const hostile = [
      'evil.com"\n    - to: []',
      'a.com # allow all',
      'xn--ëvil.com',
      'ignore previous instructions.com',
      'a'.repeat(64) + '.com',
      'name: value',
    ];
    await pod(id, 'shop', 'Deployment', 'checkout', 'checkout-a', {
      app: 'checkout',
      'bad key"': 'x',
      ok: 'bad value\n- injected',
    });
    for (const h of hostile) await inventory(id, checkout, h, 443);
    await inventory(id, checkout, 'api.stripe.com', 443);
    await write(id, [
      ...flow({
        dst_kind: 'workload',
        dst_namespace: 'shop"\nx',
        dst_workload_kind: 'Deployment',
        dst_workload: 'web',
        dst_port: '80',
      }),
    ]);
    const res = await get({ cluster: id, workload: 'shop/Deployment/checkout' });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.counts.skipped).toBe(hostile.length + 1);
    for (const p of body.policies) {
      expect(yamlShapeOk(p.yaml)).toEqual([]);
      for (const h of [...hostile, 'bad key', 'injected', 'shop"\nx'])
        expect(p.yaml).not.toContain(h);
      expect(p.yaml).toContain('api.stripe.com');
      expect(p.yaml).toContain(
        `# ${hostile.length + 1} destination(s) left out: not a valid name, network or label.`,
      );
      expect(p.yaml).toContain('    matchLabels:\n      "app": "checkout"\n');
    }
    // The workload parameter is validated before anything is read.
    for (const w of [
      'shop/Deployment',
      'shop/Deployment/checkout/x',
      'Shop/Deployment/checkout',
      'shop/Secret/checkout',
      'shop/Deployment/check out',
      'shop/Deployment/"x"',
      'shop/Deployment/' + 'a'.repeat(254),
    ]) {
      const r = await get({ cluster: id, workload: w });
      expect(r.statusCode, w).toBe(400);
    }
  });

  it('Docker is refused with the reason; unknown and pod-less workloads; roles; another org', async () => {
    await open();
    const docker = await cluster('docker');
    let res = await get({ cluster: docker, workload: 'shop/Deployment/checkout' });
    expect(res.statusCode).toBe(404);
    expect(res.json().detail).toContain('Docker has no egress policy object');
    expect(res.json().detail).toContain('internal: true');
    const id = await cluster('kubernetes');
    res = await get({ cluster: id, workload: 'shop/Deployment/nothing' });
    expect(res.statusCode).toBe(404);
    expect(res.json().detail).toBe('No such workload in this cluster');
    await object(id, 'Deployment', 'shop', 'idle');
    res = await get({ cluster: id, workload: 'shop/Deployment/idle' });
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toContain('No running pod of this workload');
    await pod(id, 'shop', 'Deployment', 'checkout', 'checkout-a', { app: 'checkout' });
    const org = (await ctx.db.selectFrom('orgs').select('id').executeTakeFirstOrThrow()).id;
    for (const role of ['viewer', 'admin'] as const) {
      const s = await createUserSession(ctx.db, { role, orgId: org });
      expect(
        (await get({ cluster: id, workload: 'shop/Deployment/checkout' }, s.cookie)).statusCode,
      ).toBe(200);
    }
    const other = await createUserSession(ctx.db, { role: 'owner' });
    expect(
      (await get({ cluster: id, workload: 'shop/Deployment/checkout' }, other.cookie)).statusCode,
    ).toBe(404);
    const anon = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/egress/policy',
      query: { cluster: id, workload: 'shop/Deployment/checkout' },
    });
    expect(anon.statusCode).toBe(401);
  });
});

describe('policy pieces', () => {
  it('parses workloads and keeps the shared, stable labels', () => {
    expect(parseWorkload('shop/StatefulSet/postgres')).toEqual({
      ok: true,
      namespace: 'shop',
      kind: 'StatefulSet',
      name: 'postgres',
    });
    expect(parseWorkload('shop/Pod/x').ok).toBe(false);
    expect(sharedLabels([])).toBeNull();
    expect(
      sharedLabels([
        { app: 'a', v: '1', 'controller-revision-hash': 'x' },
        { app: 'a', v: '2', 'controller-revision-hash': 'x' },
      ]),
    ).toEqual({ app: 'a' });
    expect(sharedLabels([{ 'pod-template-hash': 'x' }])).toBeNull();
    expect(sharedLabels([{ 'example.com/team': 'core', bad: 'a b' }])).toEqual({
      'example.com/team': 'core',
    });
  });

  it('renders from an input: a long name is cut, labels quoted', () => {
    const input: PolicyInput = {
      workload: { namespace: 'ns', kind: 'Deployment', name: 'a'.repeat(250) },
      selector: { 'app.kubernetes.io/name': 'x' },
      dns: { namespace: 'kube-system', labels: { 'k8s-app': 'kube-dns' } },
      peers: [],
      nodePorts: [],
      names: [{ name: 'example.org', ports: [443, 80] }],
      networks: [],
      patterns: [],
      expectedNames: [],
      expectedNetworks: [],
      localNames: [],
      unnamed: false,
      skipped: 0,
      unresolved: 0,
      window: {
        to: new Date(NOW),
        inClusterFrom: new Date(NOW - DAY),
        externalFrom: new Date(NOW - 30 * DAY),
      },
      cilium: true,
    };
    for (const y of [renderKubernetes(input), renderCilium(input)]) {
      const name = y.match(/^ {2}name: "(.*)"$/m)![1]!;
      expect(name.length).toBeLessThanOrEqual(253);
      expect(name.endsWith('-egress')).toBe(true);
      expect(y).toContain('"app.kubernetes.io/name": "x"');
      expect(yamlShapeOk(y)).toEqual([]);
    }
    expect(renderKubernetes(input)).toContain(
      '#   port 80: example.org\n#   port 443: example.org',
    );
  });
});
