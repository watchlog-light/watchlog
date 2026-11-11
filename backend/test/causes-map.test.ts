// SPDX-License-Identifier: AGPL-3.0-only
// The rules across the map (v0.4 slice 3, ADR-150 #1, #8–#10, bad_change's dependency form,
// ADR-153): whole answers replayed from the reads GET /causes made on the kind and Docker e2e
// demos (deploy/test/causes-e2e.sh), so the walk runs on real edges, their last hour, the far
// end's evidence and the applications; then each rule's edges: what must not match.
import { describe, expect, it } from 'vitest';
import { checksOf } from '../src/modules/causes/checks.js';
import { explain } from '../src/modules/causes/engine.js';
import type { EdgeHistory, EvEdge, Evidence, Reader, Via } from '../src/modules/causes/evidence.js';
import { ApiReadError } from '../src/modules/mcp/reader.js';
import { alertFocus } from '../src/modules/causes/resolve.js';
import { runRules } from '../src/modules/causes/rules.js';
import { linksOf, topFinding } from '../src/modules/causes/rules/application-finding.js';
import { slowAfterChange } from '../src/modules/causes/rules/bad-change.js';
import { connectionRefused } from '../src/modules/causes/rules/connection-refused.js';
import { dependencyDown } from '../src/modules/causes/rules/dependency-down.js';
import { dnsNxdomain, nxdomainSince } from '../src/modules/causes/rules/dns-nxdomain.js';
import { tail } from '../src/modules/causes/rules/own.js';
import { parseSubject } from '../src/modules/causes/subject.js';
import { edgeHistory, runFrom, type EdgeSeries } from '../src/modules/causes/walk.js';
import {
  BEFORE_SLICE_4,
  beforeSlice4,
  evidence,
  recording,
  replay,
  step,
  type RecordingName,
} from './support/causes.js';

async function answer(name: RecordingName, patch?: Parameters<typeof replay>[1]) {
  const rec = recording(name);
  const reader = replay(rec, patch, beforeSlice4(rec) ? BEFORE_SLICE_4 : undefined);
  const a = await explain(reader, rec.cluster, parseSubject(rec.subject), { now: rec.now });
  return { a, rec, missed: reader.missed };
}

describe('the scenarios: the top cause on each platform, replayed', () => {
  it.each<[RecordingName, string, string]>([
    ['kube-dependency-down', 'dependency_down', 'dependency_down_scaled'],
    ['docker-dependency-down', 'dependency_down', 'dependency_down_stopped'],
    ['kube-refused', 'connection_refused', 'connection_refused'],
    ['docker-refused', 'connection_refused', 'connection_refused'],
    ['kube-dns-typo', 'dns_nxdomain', 'dns_nxdomain'],
    ['docker-dns-typo', 'dns_nxdomain', 'dns_nxdomain'],
    ['kube-slow-change', 'bad_change', 'bad_change_slow'],
    ['docker-slow-change', 'bad_change', 'bad_change_slow'],
    ['kube-pg-leak', 'application_finding', 'app_pg_held'],
    ['docker-pg-leak', 'application_finding', 'app_pg_held'],
    ['kube-rabbit-consumer-oom', 'application_finding', 'app_consumer_oom'],
    ['docker-rabbit-consumer-oom', 'application_finding', 'app_consumer_oom'],
    ['docker-rabbit-consumer-change', 'application_finding', 'app_consumer_change'],
  ])('%s: %s, likely (%s)', async (name, rule, headline) => {
    const { a, rec, missed } = await answer(name);
    expect(missed).toEqual([]);
    expect(a.state).toBe('likely');
    expect(a.causes[0]).toMatchObject({ rule, strength: 'likely' });
    expect(a.headline.code).toBe(headline);
    // As the live backend answered.
    expect({
      state: a.state,
      headline: a.headline.code,
      rule: a.causes[0]!.rule,
      chain: a.causes[0]!.chain.map((s) => s.code),
    }).toEqual(rec.expected);
    // ADR-147/148: at most one likely cause, three causes, three steps, each step linked.
    expect(a.causes.filter((c) => c.strength === 'likely')).toHaveLength(1);
    expect(a.causes.length).toBeLessThanOrEqual(3);
    for (const c of a.causes) {
      expect(c.chain.length).toBeLessThanOrEqual(3);
      expect(c.chain.at(-1)!.next).toBeNull();
      for (const s of c.chain) expect(s.object.ref).toBeTruthy();
    }
  });

  it('kind dependency down: web calls api → api has no pods → scaled from 1 to 0', async () => {
    const { a } = await answer('kube-dependency-down');
    const [edge, down, scaled] = a.causes[0]!.chain;
    expect(edge).toMatchObject({
      object: { kind: 'edge' },
      code: 'edge_failed',
      next: 'calls',
      source: 'service_map',
    });
    expect(edge!.since).not.toBeNull();
    expect(down).toMatchObject({
      object: { kind: 'workload', ref: 'causes-e2e/Deployment/api' },
      code: 'no_pods',
      next: 'because',
    });
    expect(scaled).toMatchObject({
      code: 'scaled',
      facts: { from: 1, to: 0 },
      source: 'change_marker',
    });
    expect(a.causes[0]!.since).toBe(scaled!.at);
    expect(a.checks.find((c) => c.topic === 'dependencies')).toMatchObject({
      code: 'dependencies_failing',
      result: 'explains',
    });
  });

  it('Docker dependency stopped: no failed connects, the lookups fail and the edge went quiet (gap 3)', async () => {
    const { a } = await answer('docker-dependency-down');
    const [edge, stopped] = a.causes[0]!.chain;
    expect(edge).toMatchObject({ code: 'edge_gone_dns', source: 'dns', next: 'calls' });
    expect(edge!.facts.perMinute).toBeGreaterThan(0);
    expect(stopped).toMatchObject({
      object: { kind: 'container', name: 'causes-e2e-api-1', host: 'docker-01' },
      code: 'container_stopped',
      facts: { exitCode: 0 },
    });
    // The dependency check (it called api, now nothing) and the DNS check are what it explains.
    const result = (topic: string) => a.checks.find((c) => c.topic === topic)?.result;
    // Minutes after the stop the 5-minute rate still shows calls; later none (dependencies_quiet).
    expect(['dependencies_ok', 'dependencies_quiet']).toContain(
      a.checks.find((c) => c.topic === 'dependencies')!.code,
    );
    expect(result('dependencies')).toBe('explains');
    expect(result('dns')).toBe('explains');
  });

  it.each<[RecordingName, string, string, string]>([
    ['kube-rabbit-consumer-oom', 'pod', 'oom_killed_restarts', 'rabbitmq-e2e/consumer'],
    ['docker-rabbit-consumer-oom', 'container', 'oom_killed_kills', 'rabbitmq-e2e-consumer-1'],
  ])(
    '%s: the lost consumer leads on to the consumer OOM-killed at its limit',
    async (name, kind, code, consumer) => {
      const { a } = await answer(name);
      const [queue, killed] = a.causes[0]!.chain;
      expect(queue).toMatchObject({
        object: { kind: 'application', type: 'rabbitmq' },
        code: 'queue_no_consumers',
        facts: { queue: 'orders' },
        next: 'consumed_by',
      });
      // When the queue last had a consumer (slice 0 gap 9 was the fixture's: now it consumes).
      expect(queue!.since).not.toBeNull();
      expect(killed).toMatchObject({ object: { kind }, code, facts: { limitBytes: 402653184 } });
      // Inside the window: Docker's aggregated OOMKilled event dates from hours before.
      // (the counted hour's points are on 15 s steps, so its first may be seconds before it).
      expect(Date.parse(a.causes[0]!.since!)).toBeGreaterThanOrEqual(
        Date.parse(a.window.from) - 60_000,
      );
      expect(a.headline).toMatchObject({
        code: 'app_consumer_oom',
        facts: { queue: 'orders', consumer, limitBytes: 402653184 },
      });
      // One cause for one failure: the finding alone (partial) is covered.
      expect(a.causes.filter((x) => x.rule === 'application_finding')).toHaveLength(1);
    },
  );

  it('a consumer re-created shortly before its OOM kills: its new version fails (bad_change)', async () => {
    const { a } = await answer('docker-rabbit-consumer-change');
    expect(a.causes[0]!.chain.map((s) => [s.object.kind, s.code])).toEqual([
      ['application', 'queue_no_consumers'],
      ['container', 'new_version_oom'],
      ['change', 'recreated'],
    ]);
  });

  it('a queue whose consumer is unknown or ended without a cause of its own', async () => {
    // The consumer's link removed: the finding alone, possible.
    const { a } = await answer('kube-rabbit-consumer-oom', (reads) => {
      for (const [k, r] of Object.entries(reads))
        if (/^GET \/applications\/[^ ]+ /.test(k))
          for (const f of (r.body as { reasons: { links?: unknown[] }[] }).reasons) f.links = [];
    });
    expect(a.state).toBe('possible');
    expect(a.causes[0]).toMatchObject({
      rule: 'application_finding',
      chain: [{ code: 'queue_no_consumers' }],
    });
  });

  it('PostgreSQL near max_connections: the top holder and when it started', async () => {
    for (const name of ['kube-pg-leak', 'docker-pg-leak'] as const) {
      const { a } = await answer(name);
      const [conn, held] = a.causes[0]!.chain;
      expect(conn).toMatchObject({ code: 'pg_connections', facts: { pct: 93, n: 37, max: 40 } });
      expect(held).toMatchObject({ code: 'holds_connections', facts: { n: 37 } });
      expect(held!.object.kind).toBe(name.startsWith('kube') ? 'workload' : 'container');
      expect(held!.since).not.toBeNull();
    }
  });

  it('a slow dependency after its rollout or re-create is bad_change, the edge in front', async () => {
    for (const name of ['kube-slow-change', 'docker-slow-change'] as const) {
      const { a } = await answer(name);
      const [edge, slow, change] = a.causes[0]!.chain;
      expect(edge).toMatchObject({ code: 'edge_slow' });
      expect(slow).toMatchObject({ code: 'new_version_slow', next: 'after' });
      expect(Number(slow!.facts.p95Ms)).toBeGreaterThan(1000);
      expect(change!.code).toBe(name.startsWith('kube') ? 'rolled_out' : 'recreated');
      expect(Date.parse(change!.at!)).toBeLessThanOrEqual(Date.parse(slow!.since!));
    }
  });

  it('without network flows the dependency rules cannot run (map unavailable)', async () => {
    const { a } = await answer('kube-dependency-down', (reads) => {
      for (const k of Object.keys(reads)) if (k.includes('/service-map ')) delete reads[k];
    });
    expect(a.state).toBe('none');
    expect(a.checks.find((c) => c.topic === 'dependencies')!.result).toBe('not_run');
  });
});

describe('two hops', () => {
  // web → api → db, on the kind fixture's shapes: api's calls to db fail, db was scaled to 0.
  const CLUSTER = {
    id: '00000000-0000-4000-8000-00000000000a',
    name: 'kind',
    kind: 'kubernetes' as const,
  };
  const NOW = Date.parse('2026-11-10T17:10:00.000Z');
  function fake(): Reader {
    const healthy = evidence('kube-workload-healthy');
    const w = (name: string, ready: number, desired = ready) => ({
      ...healthy.workload!,
      name,
      ready,
      desired,
    });
    const e = (from: string, to: string) => ({
      ...healthy.map.outgoing[0]!,
      id: `w:causes-e2e/Deployment/${from}>w:causes-e2e/Deployment/${to}:9898`,
      source: `w:causes-e2e/Deployment/${from}`,
      target: `w:causes-e2e/Deployment/${to}`,
      failedRatio: 1,
      failedPerSecond: 1,
      failedLastMinute: 60,
      health: 'critical',
    });
    const node = (name: string) => ({
      ...healthy.map.nodes[0]!,
      id: `w:causes-e2e/Deployment/${name}`,
      name,
    });
    const routes: Record<string, unknown> = {
      [`/clusters/${CLUSTER.id}/workloads`]: {
        workloads: [w('web', 1), w('api', 1), w('db', 0, 0)],
      },
      [`/clusters/${CLUSTER.id}/events`]: { events: [] },
      [`/clusters/${CLUSTER.id}/change-markers`]: {
        markers: [
          {
            kind: 'scale',
            target: 'Deployment/causes-e2e/db',
            namespace: 'causes-e2e',
            details: { from: 2, to: 0 },
            ts: '2026-11-10T17:00:00.000Z',
          },
        ],
      },
      [`/clusters/${CLUSTER.id}/service-map`]: {
        mode: 'flows',
        agents: healthy.map.agents,
        nodes: [node('web'), node('api'), node('db')],
        // api answers web with 5xx (its connects succeed); api's connects to db fail.
        edges: [
          {
            ...e('web', 'api'),
            failedRatio: 0,
            failedPerSecond: 0,
            failedLastMinute: 0,
            http: {
              ...healthy.map.outgoing[0]!.http!,
              serverErrorsPerSecond: 0.5,
              serverErrorRatio: 0.5,
            },
          },
          e('api', 'db'),
        ],
        dns: [],
      },
      [`/clusters/${CLUSTER.id}/overview`]: { problems: { items: [] } },
      '/alerts': { alerts: [] },
    };
    return {
      async get<T>(path: string, query: Record<string, unknown> = {}) {
        if (path === `/clusters/${CLUSTER.id}/pods`)
          return {
            pods:
              query.workload === 'db'
                ? []
                : healthy.pods.map((p) => ({ ...p, workload: String(query.workload) })),
          } as T;
        if (path.startsWith(`/clusters/${CLUSTER.id}/nodes/`))
          return { node: healthy.nodes[0] } as T;
        if (path in routes) return routes[path] as T;
        throw new ApiReadError(404, `no fake for ${path}`);
      },
    };
  }

  it('web fails because api fails because db was scaled to 0: two hops, three steps', async () => {
    const a = await explain(fake(), CLUSTER, parseSubject('workload:causes-e2e/web'), { now: NOW });
    expect(a.state).toBe('likely');
    expect(a.causes[0]).toMatchObject({ rule: 'dependency_down', strength: 'likely' });
    expect(a.causes).toHaveLength(1);
    const chain = a.causes[0]!.chain;
    // The symptom (web's edge) first, where it starts last; the middle edge is left out.
    expect(chain.map((s) => s.code)).toEqual(['edge_errors', 'no_pods', 'scaled']);
    expect(chain[0]!.object.ref).toBe(
      'w:causes-e2e/Deployment/web>w:causes-e2e/Deployment/api:9898',
    );
    expect(chain[1]!.object.ref).toBe('causes-e2e/Deployment/db');
    expect(a.headline).toEqual({
      code: 'dependency_down_scaled',
      facts: { name: 'api', target: 'db' },
    });
  });
});

// ---- Each rule's edges, on snapshots with the walk's `via` set as the engine sets it.

const edge = (over: Partial<EvEdge> = {}): EvEdge => ({
  id: 'w:causes-e2e/Deployment/web>w:causes-e2e/Deployment/api:9898',
  source: 'w:causes-e2e/Deployment/web',
  target: 'w:causes-e2e/Deployment/api',
  port: 9898,
  service: 'api',
  connectionsPerSecond: 1,
  failedPerSecond: 1,
  failedRatio: 1,
  latencyP95Seconds: null,
  failedLastMinute: 60,
  http: null,
  health: 'critical',
  ...over,
});
const history = (over: Partial<EdgeHistory> = {}): EdgeHistory => ({
  troubleSince: '2026-11-10T17:00:00.000Z',
  slowSince: null,
  p95Before: null,
  lastConnectedAt: '2026-11-10T17:01:00.000Z',
  end: '2026-11-10T17:01:30.000Z',
  ...over,
});
const via = (over: Partial<Via> = {}): Via => ({
  edge: edge(),
  history: history(),
  from: 'web',
  caller: { kind: 'workload', ref: 'causes-e2e/Deployment/web', name: 'causes-e2e/web' },
  dnsErrorsPerSecond: 0,
  ...over,
});

describe('dependency_down', () => {
  it('only at the far end of an edge: on its own, a workload with no ready pods is no cause', () => {
    const ev = evidence('kube-workload-healthy', (e) => {
      e.workload = { ...e.workload!, ready: 0, desired: 0 };
    });
    expect(dependencyDown.match(ev)).toBeNull();
    expect(dependencyDown.match({ ...ev, via: via() })).toMatchObject({
      code: 'dependency_down',
      complete: true,
      chain: [{ code: 'no_pods' }],
    });
  });

  it('a dependency with ready pods is not down (its failing connects are connection_refused)', () => {
    const ev = { ...evidence('kube-workload-healthy'), via: via() };
    expect(dependencyDown.match(ev)).toBeNull();
    expect(connectionRefused.match(ev)).toMatchObject({
      code: 'connection_refused',
      complete: true,
      headline: { code: 'connection_refused', facts: { name: 'web', target: 'web', port: 9898 } },
    });
  });

  it("every pod failing: the dependency's own cause ends the chain, and covers it", () => {
    const ev = evidence('kube-workload-oom', (e) => {
      e.workload = { ...e.workload!, ready: 0, desired: 1 };
      e.via = via();
    });
    const m = dependencyDown.match(ev)!;
    expect(m.chain.map((s) => s.code)).toEqual(['no_ready_pods', 'oom_killed_restarts']);
    expect(m.headline.code).toBe('dependency_down_oom');
    // One cause: oom_limit on the same dependency is a step of it.
    expect(runRules(ev).map((c) => c.rule)).toEqual(['dependency_down']);
  });

  it('Docker: a running container is not down; a stopped one is, with or without the DNS side', () => {
    const running = { ...evidence('docker-compose-healthy'), via: via() };
    expect(dependencyDown.match(running)).toBeNull();
    const stopped = evidence('docker-compose-healthy', (e) => {
      // Stopped by hand: no change, no crash before it.
      e.changes = [];
      e.events = [];
      for (const c of e.containers)
        Object.assign(c, { state: 'exited', exitCode: 0, finishedAt: '2026-11-10T17:00:00Z' });
      e.via = via({
        edge: edge({ failedPerSecond: 0, failedRatio: 0, failedLastMinute: 0 }),
        dnsErrorsPerSecond: 3,
      });
    });
    expect(dependencyDown.match(stopped)).toMatchObject({
      headline: { code: 'dependency_down_stopped', facts: { exitCode: 0 } },
      coversCaller: ['dns_nxdomain'],
    });
    // Neither failed connects, nor a quiet edge, nor failed lookups: no sign the caller suffers.
    const unseen = {
      ...stopped,
      via: via({
        edge: edge({ failedPerSecond: 0, failedRatio: 0 }),
        history: history({ lastConnectedAt: new Date(stopped.now).toISOString() }),
      }),
    };
    expect(dependencyDown.match(unseen)).toBeNull();
  });
});

describe('a keep-alive edge that got slower (the demo kit: api → a throttled backend)', () => {
  // Recorded on kind and Docker: api's HTTP pool to backend opened its last new connection 20
  // minutes before (kind) or before the hour (Docker), while its requests and bytes flowed
  // every second; then backend's busy loop met its 30m CPU limit and the edge's p95 rose from
  // 2–3 ms to 200 ms. The walk read the edge as gone "since" that last connection, and the
  // dependency check as quiet: traffic is connections, bytes and requests, not connects.
  it.each<[RecordingName, string]>([
    ['kube-keepalive-throttle', 'possible'],
    ['docker-keepalive-throttle', 'likely'],
  ])('%s: "slowed from X to Y", never gone or quiet', async (name, state) => {
    const { a, rec, missed } = await answer(name);
    expect(missed).toEqual([]);
    expect(a.state).toBe(state);
    expect(a.causes[0]).toMatchObject({ rule: 'cpu_throttled', strength: state });
    const chain = a.causes[0]!.chain;
    expect(chain.map((s) => s.code)).toEqual(['edge_slower', 'cpu_throttled']);
    expect(chain[0]!.facts).toMatchObject({
      p95Ms: expect.any(Number),
      fromMs: expect.any(Number),
    });
    expect((chain[0]!.facts.p95Ms as number) / (chain[0]!.facts.fromMs as number)).toBeGreaterThan(
      20,
    );
    const steps = a.causes.flatMap((c) => c.chain.map((s) => s.code));
    expect(steps).not.toContain('edge_gone');
    const deps = a.checks.find((c) => c.topic === 'dependencies')!;
    expect(deps.code).toBe('dependencies_slower');
    // The edge's own series: connects long ago (or never), traffic up to the end.
    const key = Object.keys(rec.reads).find((k) => k.includes('/service-map/edge'))!;
    const s = rec.reads[key]!.body as EdgeSeries;
    const h = edgeHistory(s, Math.floor(rec.now / 1000) - 3600);
    const lastConnect = s.connections.filter((p) => (p[1] ?? 0) > 0).at(-1)?.[0] ?? null;
    expect(lastConnect === null || rec.now / 1000 - lastConnect > 15 * 60).toBe(true);
    expect(Date.parse(h.end!) - Date.parse(h.lastConnectedAt!)).toBeLessThan(60_000);
  });
});

describe('the dependency check', () => {
  it('calls in the last hour, none now: quiet (a stopped Docker dependency), something to look at', () => {
    const ev = evidence('docker-compose-healthy', (e) => {
      for (const x of e.map.outgoing)
        Object.assign(x, {
          connectionsPerSecond: 0,
          failedPerSecond: 0,
          http: null,
          health: 'idle',
        });
    });
    expect(checksOf(ev).checks.find((c) => c.topic === 'dependencies')).toMatchObject({
      code: 'dependencies_quiet',
      result: 'possible',
    });
  });

  it('a keep-alive pool opens no new connection, yet its traffic flows: in use, not quiet', () => {
    // The demo kit's api → backend (podinfo's HTTP client): no connects for minutes, bytes and
    // requests every second (the map's health is ok, not idle).
    const ev = evidence('docker-compose-healthy', (e) => {
      for (const x of e.map.outgoing)
        Object.assign(x, { connectionsPerSecond: 0, failedPerSecond: 0, health: 'ok' });
    });
    expect(checksOf(ev).checks.find((c) => c.topic === 'dependencies')).toMatchObject({
      code: 'dependencies_ok',
      result: 'ok',
    });
  });
});

describe('connection_refused', () => {
  it('partial while some connects get through; nothing without failures', () => {
    const ev = evidence('kube-workload-healthy');
    expect(
      connectionRefused.match({ ...ev, via: via({ edge: edge({ failedRatio: 0.2 }) }) }),
    ).toMatchObject({ complete: false });
    expect(
      connectionRefused.match({
        ...ev,
        via: via({ edge: edge({ failedRatio: 0, failedPerSecond: 0 }) }),
      }),
    ).toBeNull();
    expect(connectionRefused.match(ev)).toBeNull();
  });
});

describe('dns_nxdomain', () => {
  const withDns = (rows: Partial<Evidence['map']['dns'][number]>) =>
    evidence('kube-workload-healthy', (e) => {
      e.map.dns = [
        {
          node: e.map.ids[0]!,
          requestsPerSecond: 0.6,
          nxdomainPerSecond: 0,
          servfailPerSecond: 0,
          timeoutPerSecond: 0,
          searchMissPerSecond: 1.4,
          errorRatio: 0,
          ...rows,
        },
      ];
    });
  it('NXDOMAIN answers, search misses left out, SERVFAIL not counted', () => {
    expect(dnsNxdomain.match(withDns({ nxdomainPerSecond: 0.4 }))).toMatchObject({
      code: 'dns_nxdomain',
      facts: { perMinute: 24 },
      chain: [{ code: 'nxdomain', source: 'dns' }],
    });
    expect(dnsNxdomain.match(withDns({ servfailPerSecond: 3.4 }))).toBeNull();
    // One a minute is no pattern; nor a share under 5 % of the lookups.
    expect(dnsNxdomain.match(withDns({ nxdomainPerSecond: 0.01 }))).toBeNull();
    expect(
      dnsNxdomain.match(withDns({ requestsPerSecond: 100, nxdomainPerSecond: 0.5 })),
    ).toBeNull();
  });

  it('since: the run of NXDOMAIN points to the newest, its first point when the client is new', () => {
    const ev = withDns({ nxdomainPerSecond: 0.4 });
    const from = Date.parse('2026-11-10T16:00:00Z') / 1000;
    ev.metrics = {
      from: new Date(from * 1000).toISOString(),
      to: '',
      step: 15,
      restarts: {},
      oomKills: {},
      memory: {},
      nxdomain: [
        [from, 0],
        [from + 15, 0.4],
        [from + 30, 0.4],
        [from + 45, 0],
      ],
    };
    expect(nxdomainSince(ev)).toBe(new Date((from + 15) * 1000).toISOString());
    ev.metrics.nxdomain = [
      [from + 600, 0.4],
      [from + 615, 0.4],
    ];
    expect(nxdomainSince(ev)).toBe(new Date((from + 600) * 1000).toISOString());
    ev.metrics.nxdomain = [
      [from, 0.4],
      [from + 15, 0.4],
    ];
    expect(nxdomainSince(ev)).toBeNull();
  });
});

describe("bad_change's dependency form", () => {
  const slowEdge = edge({
    failedPerSecond: 0,
    failedRatio: 0,
    http: {
      requestsPerSecond: 1,
      serverErrorsPerSecond: 0,
      serverErrorRatio: 0,
      p50Seconds: 1,
      p95Seconds: 2.4,
      p99Seconds: 3,
    },
  });
  const rollout = (ts: string) => ({
    kind: 'rollout',
    target: 'Deployment/causes-e2e/web',
    namespace: 'causes-e2e',
    details: { from: '3', to: '4' },
    ts,
  });
  it('a change shortly before the slowdown began; none for a change after it, or none at all', () => {
    const at = (ts: string, slowSince: string | null) =>
      slowAfterChange(
        evidence('kube-workload-healthy', (e) => {
          e.changes = [rollout(ts)];
          e.via = via({ edge: slowEdge, history: history({ slowSince, p95Before: 0.002 }) });
        }),
      );
    expect(at('2026-11-10T17:00:00Z', '2026-11-10T17:00:15Z')).toMatchObject({
      complete: true,
      chain: [
        { code: 'new_version_slow', facts: { fromMs: 2, p95Ms: 2400 } },
        { code: 'rolled_out' },
      ],
      headline: { code: 'bad_change_slow' },
    });
    expect(at('2026-11-10T17:05:00Z', '2026-11-10T17:00:15Z')).toBeNull();
    // Slow the whole hour: no change in it explains it.
    expect(at('2026-11-10T17:00:00Z', null)).toBeNull();
  });
});

describe('application_finding', () => {
  it('the finding alone is partial; its links name the consumer or the holder', () => {
    const ev = evidence('kube-workload-healthy', (e) => {
      e.focus = { kind: 'application', id: 'a1' };
      e.application = {
        id: 'a1',
        type: 'postgres',
        name: 'causes-e2e/pg',
        health: 'warning',
        reason: { code: 'connected', facts: {} },
        target: {},
        reasons: [
          { severity: 'info', code: 'statements_unavailable', facts: {} },
          {
            severity: 'warning',
            code: 'connections_near_max',
            facts: { n: 37, max: 40, pct: 93, top: 'causes-e2e/leak (37)' },
          },
        ],
      };
    });
    expect(topFinding(ev.application)!.code).toBe('connections_near_max');
    expect(runRules(ev)).toMatchObject([{ rule: 'application_finding', complete: false }]);
    expect(linksOf(ev)).toMatchObject([
      {
        target: { kind: 'workload', namespace: 'causes-e2e', name: 'leak', workloadKind: null },
        n: 37,
      },
    ]);
    // An address it couldn't name is no link (slice 0, gap 10).
    ev.application!.reasons[1]!.facts.top = '10.244.1.7 (37)';
    expect(linksOf(ev)).toEqual([]);
    // A collector that can't connect has no findings to trust.
    ev.application!.reason.code = 'unreachable';
    expect(topFinding(ev.application)).toBeNull();
  });
});

describe('alerts on an application', () => {
  it('an alert of a monitored application is about the application', async () => {
    const reader: Reader = { get: () => Promise.reject(new ApiReadError(404, 'none')) };
    for (const kind of ['kubernetes', 'docker'] as const)
      expect(
        await alertFocus(
          reader,
          { id: 'c', name: 'c', kind },
          { service: 'a1', service_type: 'postgres' },
        ),
      ).toEqual({ focus: { kind: 'application', id: 'a1' }, edge: null });
  });
});

describe('walk helpers', () => {
  it('edgeHistory: when the trouble and the slowness began, the last connection', () => {
    const from = 1000;
    const t = (i: number) => from + 15 * (i + 1);
    const series = (f: (i: number) => number | null) =>
      Array.from({ length: 10 }, (_, i) => [t(i), f(i)] as [number, number | null]);
    const h = edgeHistory(
      {
        step: 15,
        connections: series((i) => (i < 8 ? 1 : 0)),
        failed: series((i) => (i >= 5 && i < 8 ? 1 : 0)),
        httpP95: series((i) => (i >= 3 ? 2 : 0.002)),
      },
      from - 3600,
    );
    expect(h.troubleSince).toBeNull(); // not failing at the newest point
    expect(h.slowSince).toBe(new Date(t(3) * 1000).toISOString());
    expect(h.p95Before).toBe(0.002);
    expect(h.lastConnectedAt).toBe(new Date(t(7) * 1000).toISOString());
    // A run back to the start of the range began before it; a series that begins later, with it.
    expect(runFrom([10, 25, 40], () => true, 0, 15)).toBeNull();
    expect(runFrom([100, 115, 130], () => true, 0, 15)).toBe(100);
    expect(runFrom([100, 115, 130], (t) => t > 100, 0, 15)).toBe(115);
  });

  it("edgeHistory with a resolved alert's end: the run before the end, not a later one", () => {
    // Failing from point 2, recovered at 6 (the alert resolved at 7), failing again from 9.
    const from = 1000;
    const t = (i: number) => from + 15 * (i + 1);
    const series = (f: (i: number) => number | null) =>
      Array.from({ length: 12 }, (_, i) => [t(i), f(i)] as [number, number | null]);
    const s = {
      step: 15,
      connections: series(() => 1),
      failed: series((i) => ((i >= 2 && i < 6) || i >= 9 ? 1 : 0)),
    };
    // Today's answer: the run lasting to now, which began at point 9.
    expect(edgeHistory(s, from - 3600).troubleSince).toBe(new Date(t(9) * 1000).toISOString());
    // The resolved alert's: the run it had, from point 2, though it ended before the alert.
    expect(edgeHistory(s, from - 3600, t(7)).troubleSince).toBe(
      new Date(t(2) * 1000).toISOString(),
    );
  });

  it('tail: the counts go first, then the details; the last step kept ends the chain', () => {
    const chain = [
      step({ code: 'restarts_backoff', next: 'because' }),
      step({ code: 'exit_code_every', next: 'after' }),
      step({ code: 'last_event' }),
    ];
    expect(tail(chain, 3).map((s) => s.code)).toEqual([
      'restarts_backoff',
      'exit_code_every',
      'last_event',
    ]);
    expect(tail(chain, 2).map((s) => s.code)).toEqual(['exit_code_every', 'last_event']);
    expect(tail(chain, 1)).toMatchObject([{ code: 'exit_code_every', next: null }]);
  });
});
