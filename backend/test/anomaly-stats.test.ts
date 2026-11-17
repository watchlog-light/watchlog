// SPDX-License-Identifier: AGPL-3.0-only
// What changed's statistics and keys (ADR-196, v0.8 slice 2): the median and MAD, the floor
// per kind, the score, the usual range and the 10-minute rule; the scored keys and how a
// series and an alert name their subject, on Kubernetes and Docker. Pure: no clock waited.
import { describe, expect, it } from 'vitest';
import { alertTokens, seriesTokens } from '../src/modules/anomaly/exclusion.js';
import {
  allScoredKeys,
  INTEGRATION_KEYS,
  PLATFORM_KEYS,
  queriesFor,
  seriesHash,
  subjectOf,
} from '../src/modules/anomaly/keys.js';
import { loadAnomalySettings } from '../src/modules/anomaly/settings.js';
import {
  bucketOf,
  DEFAULT_RULE,
  median,
  medianAndMad,
  scoreOf,
  spreadOf,
  usualRange,
  verdict,
  type Minute,
} from '../src/modules/anomaly/stats.js';
import { buildQuery, METRIC_KEYS } from '../src/modules/query/catalog.js';

const T0 = Date.UTC(2026, 10, 17, 14, 0, 0); // a Tuesday, 14:00 UTC
const MIN = 60_000;

describe('median and MAD', () => {
  it('match a sorted reference, odd and even', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(Number.isNaN(median([]))).toBe(true);
    // |x - 3| = 2, 1, 0, 1, 97 → MAD 1: one incident value moves neither.
    expect(medianAndMad([1, 2, 3, 4, 100])).toEqual({ median: 3, mad: 1 });
  });

  it('buckets are UTC hours of the week, Sunday 00:00 first', () => {
    expect(bucketOf(Date.UTC(2026, 10, 15, 0, 0))).toBe(0); // Sunday
    expect(bucketOf(T0)).toBe(2 * 24 + 14);
    expect(bucketOf(T0 + 59 * MIN)).toBe(2 * 24 + 14);
    expect(bucketOf(Date.UTC(2026, 10, 21, 23, 59))).toBe(167); // Saturday
  });
});

describe('the floor and the score (ADR-196 as built)', () => {
  it('a flat series scores against the floor of its kind, not a zero spread', () => {
    expect(spreadOf(0.2, 0, 'cores')).toBe(0.05);
    expect(spreadOf(0, 0, 'bytes')).toBe(32 * 2 ** 20);
    expect(spreadOf(0.1, 0, 'ratio')).toBe(0.02);
    expect(spreadOf(0, 0, 'bytes_per_second')).toBe(100 * 1024);
    expect(spreadOf(0, 0, 'per_second')).toBe(0.5);
    expect(spreadOf(0.12, 0, 'seconds')).toBe(0.05);
    expect(spreadOf(0, 0, 'count')).toBe(2);
    // 0.2 cores away from 0.2 is exactly 4: not past it.
    expect(scoreOf(0.4, 0.2, 0, 'cores')).toBeCloseTo(4);
  });

  it('5 % of the median when that is larger; 1.4826 × MAD when that is', () => {
    expect(spreadOf(10, 0, 'cores')).toBeCloseTo(0.5);
    expect(spreadOf(1, 1, 'cores')).toBeCloseTo(1.4826);
    expect(scoreOf(2.4, 0.15, 0.01, 'seconds')).toBeCloseTo(45);
  });

  it('the usual range is median ± 2 spreads, clipped at 0', () => {
    const r = usualRange(0.15, 0.01, 'seconds');
    expect(r.low).toBeCloseTo(0.05);
    expect(r.high).toBeCloseTo(0.25);
    expect(usualRange(0.01, 0, 'cores').low).toBe(0);
  });
});

describe('the 10-minute rule', () => {
  const window = (scores: (number | null)[]): Minute[] =>
    scores.map((s, i) => ({ t: T0 + i * MIN, value: s, score: s }));

  it('10 minutes past 4 open a period at the run’s first minute; 9 don’t', () => {
    expect(verdict(window([1, ...Array(10).fill(5)]), false)).toEqual({
      kind: 'open',
      startedAt: T0 + MIN,
    });
    expect(verdict(window([1, 1, ...Array(9).fill(5)]), false)).toEqual({ kind: 'none' });
    // Exactly 4 is not past it.
    expect(verdict(window([1, ...Array(10).fill(4)]), false)).toEqual({ kind: 'none' });
    // A missing minute breaks the run.
    expect(verdict(window([5, 5, null, ...Array(8).fill(5)]), false)).toEqual({ kind: 'none' });
  });

  it('an open period ends after 10 minutes at 4 or less (or missing), at the first of them', () => {
    expect(verdict(window([9, ...Array(10).fill(1)]), true)).toEqual({
      kind: 'end',
      endedAt: T0 + MIN,
    });
    expect(verdict(window([9, 9, ...Array(9).fill(1)]), true)).toEqual({ kind: 'none' });
    expect(verdict(window([9, ...Array(10).fill(null)]), true)).toEqual({
      kind: 'end',
      endedAt: T0 + MIN,
    });
  });

  it('the score and minutes come from the environment for tests and the demo', () => {
    const s = loadAnomalySettings({
      WATCHLOG_ANOMALY_SCORE: '3',
      WATCHLOG_ANOMALY_MINUTES: '5',
      WATCHLOG_ANOMALY_FLOORS: '{"cores":0.1}',
    });
    expect(s.rule.score).toBe(3);
    expect(s.rule.minutes).toBe(5);
    expect(s.rule.floors.cores).toBe(0.1);
    expect(s.rule.floors.bytes).toBe(DEFAULT_RULE.floors.bytes);
    expect(s.port).toBe(4082);
    expect(() => loadAnomalySettings({ WATCHLOG_ANOMALY_FLOORS: '{"pods":1}' })).toThrow(/pods/);
    expect(() => loadAnomalySettings({ WATCHLOG_ANOMALY_MINUTES: '0' })).toThrow();
  });
});

describe('the scored keys (ADR-196 as built)', () => {
  it("32 integration keys (PHP-FPM's 3 since 0.9), every scored key a catalog key or a map edge, no pod key", () => {
    expect(Object.values(INTEGRATION_KEYS).flat()).toHaveLength(32);
    for (const k of allScoredKeys()) {
      expect(k.startsWith('edge.') || (METRIC_KEYS as string[]).includes(k), k).toBe(true);
      expect(k.startsWith('pod.'), k).toBe(false);
    }
    expect(PLATFORM_KEYS.kubernetes).toContain('workload.http.latency.p95');
    expect(PLATFORM_KEYS.server).toContain('container.network.bytes');
  });

  it('a cluster is asked only for its platform’s keys, the edges and its integrations’ types', () => {
    const k = queriesFor('kubernetes', ['redis']).map((q) => q.key);
    expect(k).toContain('workload.cpu.usage');
    expect(k).toContain('redis.ops.rate');
    expect(k).toContain('edge.http.latency.p95');
    expect(k).not.toContain('postgres.connections');
    expect(k).not.toContain('container.cpu.usage');
    const d = queriesFor('server', []).map((q) => q.key);
    expect(d).toContain('container.memory.working_set');
    expect(d).not.toContain('node.cpu.utilization');
    expect(d).toHaveLength(PLATFORM_KEYS.server.length + 3);
    // Every query at a 60-second step: rates over 120 s; never cluster_id (VictoriaMetrics adds it).
    for (const q of queriesFor('kubernetes', Object.keys(INTEGRATION_KEYS))) {
      expect(q.expr, q.key).not.toContain('cluster_id');
    }
    expect(queriesFor('server', []).find((q) => q.key === 'container.cpu.usage')!.expr).toContain(
      '[120s]',
    );
  });

  it('the three new workload.http keys group by the server and scope by it', () => {
    const all = buildQuery('workload.http.requests.rate', {}, 60).expr;
    expect(all).toBe(
      'sum by (dst_kind, dst_namespace, dst_workload_kind, dst_workload, dst) (rate(watchlog_http_requests_total{dst_kind=~"workload|container"}[120s]))',
    );
    expect(
      buildQuery('workload.http.latency.p95', { namespace: 'shop', workload: 'checkout' }, 60).expr,
    ).toContain('{dst_kind="workload",dst_namespace="shop",dst_workload="checkout"}');
    expect(buildQuery('workload.http.errors.ratio', { container: 'a"b' }, 60).expr).toContain(
      '{class="5xx",dst_kind="container",dst="a\\"b"}',
    );
  });

  it('a series is its key and subject: label order and empty labels don’t change it', () => {
    const a = subjectOf({ workload: 'w', namespace: 'n', workload_kind: 'Deployment', dst: '' });
    const b = subjectOf({ namespace: 'n', workload_kind: 'Deployment', workload: 'w' });
    expect(a).toEqual(b);
    expect(Object.keys(a)).toEqual(['namespace', 'workload', 'workload_kind']);
    expect(seriesHash('workload.cpu.usage', a)).toEqual(seriesHash('workload.cpu.usage', b));
    expect(seriesHash('workload.cpu.usage', a)).not.toEqual(
      seriesHash('workload.memory.working_set', a),
    );
    // Docker: a re-created container keeps its name and so its series (ADR-029).
    expect(
      seriesHash('container.cpu.usage', subjectOf({ host: 'h', container: 'shop-api-1' })),
    ).toEqual(seriesHash('container.cpu.usage', subjectOf({ container: 'shop-api-1', host: 'h' })));
  });
});

describe('how alerts and series name their subject (slice 1)', () => {
  const crashLoop = {
    namespace: 'shop',
    workload_kind: 'Deployment',
    workload: 'checkout',
    pod: 'checkout-7d9-x',
    node: 'kind-worker',
  };
  const shares = (a: Set<string>, b: Set<string>) => [...a].some((t) => b.has(t));

  it('Kubernetes: a pod’s alert covers its workload’s series and edges, not its node', () => {
    const alert = alertTokens('kubernetes', crashLoop);
    const wl = { namespace: 'shop', workload_kind: 'Deployment', workload: 'checkout' };
    expect(shares(alert, seriesTokens('kubernetes', wl))).toBe(true);
    expect(
      shares(
        alert,
        seriesTokens('kubernetes', {
          dst_kind: 'workload',
          dst_namespace: 'shop',
          dst_workload_kind: 'Deployment',
          dst_workload: 'checkout',
        }),
      ),
    ).toBe(true);
    expect(shares(alert, seriesTokens('kubernetes', { node: 'kind-worker' }))).toBe(false);
    expect(shares(alert, seriesTokens('kubernetes', { ...wl, workload: 'cart' }))).toBe(false);
    // A node alert covers the node's series.
    expect(
      shares(
        alertTokens('kubernetes', { node: 'kind-worker' }),
        seriesTokens('kubernetes', { node: 'kind-worker', dir: 'rx' }),
      ),
    ).toBe(true);
  });

  it('Docker: `node` in alerts is `host` in series; a Compose alert covers its containers', () => {
    const compose = new Map([['shop-api-1', { project: 'shop', service: 'api' }]]);
    const container = { host: 'docker-1', container: 'shop-api-1' };
    expect(
      shares(
        alertTokens('server', { container: 'shop-api-1', node: 'docker-1' }),
        seriesTokens('server', container),
      ),
    ).toBe(true);
    expect(
      shares(
        alertTokens('server', { mount: '/', node: 'docker-1' }),
        seriesTokens('server', { host: 'docker-1' }),
      ),
    ).toBe(true);
    // A container alert does not cover its host.
    expect(
      shares(
        alertTokens('server', { container: 'shop-api-1', node: 'docker-1' }),
        seriesTokens('server', { host: 'docker-1' }),
      ),
    ).toBe(false);
    const egress = alertTokens(
      'server',
      { compose_project: 'shop', compose_service: 'api' },
      compose,
    );
    expect(shares(egress, seriesTokens('server', container, compose))).toBe(true);
    expect(
      shares(egress, seriesTokens('server', { host: 'docker-1', container: 'shop-db-1' }, compose)),
    ).toBe(false);
    // An integration's alert covers its series.
    expect(
      shares(
        alertTokens('server', { service: 'svc-1' }),
        seriesTokens('server', { service: 'svc-1', service_type: 'redis' }),
      ),
    ).toBe(true);
  });
});
