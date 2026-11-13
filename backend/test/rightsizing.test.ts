// SPDX-License-Identifier: AGPL-3.0-only
// Right-sizing hints (ADR-168) on numbers recorded on the e2e stack (kind 1.37 and Docker 29,
// 2026-11-13): the thresholds, the rounding, Kubernetes's request-from-limit default, the
// Docker rules, the order and the summary; and the use read from VictoriaMetrics' answers.
import { describe, expect, it } from 'vitest';
import {
  basedOn,
  dockerHints,
  enoughHistory,
  kubeHints,
  MIB,
  sortHints,
  suggestBytes,
  suggestCores,
  summarize,
  type HintObject,
  type Usage,
} from '../src/modules/rightsizing/hints.js';
import { usageByKey, usageExprs } from '../src/modules/rightsizing/queries.js';
import { oomAt } from '../src/modules/rightsizing/service.js';

const NOW = 1794540689;
const use = (u: Partial<Usage>): Usage => ({
  cpuP95: null,
  memoryPeak: null,
  memoryP95: null,
  throttledP95: null,
  samples: 240, // 20 hours
  from: NOW - 20 * 3600,
  oomKills: 0,
  ...u,
});
const kube = (name: string, ns = 'shop'): HintObject => ({
  kind: 'Deployment',
  namespace: ns,
  name,
});
const docker = (name: string): HintObject => ({
  kind: 'container',
  host: 'lima-watchlog-iso',
  name,
});
const k8s = (
  o: HintObject,
  c: string,
  s: Parameters<typeof kubeHints>[2],
  u: Usage,
  replicas = 1,
) => kubeHints(o, c, s, u, basedOn(u, 168, NOW), replicas);
const codes = (hs: { code: string }[]) => hs.map((h) => h.code);

describe('suggestions', () => {
  it('round CPU p95 × 1.25 up to 10m and memory peak × 1.25 up to 16 MiB', () => {
    expect(suggestCores(0.0986)).toBe(0.13); // causes-e2e/pg
    expect(suggestCores(0.0001)).toBe(0.01);
    expect(suggestCores(0.08)).toBe(0.1);
    expect(suggestBytes(111890432)).toBe(144 * MIB); // pg's 106.7 MiB peak
    expect(suggestBytes(917504)).toBe(16 * MIB);
    expect(suggestBytes(64 * MIB)).toBe(80 * MIB);
  });
});

describe('history', () => {
  it('needs 24 hours of 5-minute samples by default', () => {
    expect(enoughHistory(use({ samples: 287 }), 24)).toBe(false);
    expect(enoughHistory(use({ samples: 288 }), 24)).toBe(true);
    expect(basedOn(use({ samples: 3000 }), 168, NOW).hours).toBe(168);
    expect(basedOn(use({ samples: 247 }), 168, NOW)).toMatchObject({ hours: 20.6, samples: 247 });
  });
});

describe('Kubernetes', () => {
  const none = { cpuRequest: null, cpuLimit: null, memoryRequest: null, memoryLimit: null };

  it('an idle Deployment that asks for 500m and 256 MiB gives them back, times its replicas', () => {
    const hs = k8s(
      kube('idle', 'rs-e2e'),
      'idle',
      { cpuRequest: 0.5, cpuLimit: null, memoryRequest: 256 * MIB, memoryLimit: 512 * MIB },
      use({ cpuP95: 0.0001, memoryPeak: 0.4 * MIB, memoryP95: 0.4 * MIB }),
      2,
    );
    expect(codes(hs)).toEqual(['cpu_request_high', 'memory_request_high']);
    expect(hs[0]).toMatchObject({ suggestion: 0.01, giveBack: 0.98, resource: 'cpu' });
    expect(hs[0]!.facts).toMatchObject({ name: 'idle', requestCores: 0.5, replicas: 2, hours: 20 });
    expect(hs[1]).toMatchObject({ suggestion: 16 * MIB, giveBack: 2 * 240 * MIB });
  });

  it('a request under 2× the use, or with less than 100m / 128 MiB spare, is left alone', () => {
    // watchlog-agent-cluster-agent: 128 MiB request, 58 MiB peak (70 MiB spare).
    const hs = k8s(
      kube('cluster-agent', 'watchlog'),
      'cluster-agent',
      { cpuRequest: 0.05, cpuLimit: null, memoryRequest: 128 * MIB, memoryLimit: 512 * MIB },
      use({ cpuP95: 0.0174, memoryPeak: 58 * MIB, memoryP95: 57 * MIB }),
    );
    expect(hs).toEqual([]);
  });

  it('use above the request: causes-e2e/pg (10m, 64 MiB) used 99m and 100 MiB (p95)', () => {
    const hs = k8s(
      kube('pg', 'causes-e2e'),
      'pg',
      { cpuRequest: 0.01, cpuLimit: 0.5, memoryRequest: 64 * MIB, memoryLimit: 256 * MIB },
      use({ cpuP95: 0.09863, memoryPeak: 111890432, memoryP95: 104760729.6 }),
    );
    expect(codes(hs)).toEqual(['cpu_request_low', 'memory_request_low']);
    expect(hs[0]!.suggestion).toBe(0.13);
    expect(hs[1]!.suggestion).toBe(144 * MIB);
  });

  it('throttled at its limit: causes-e2e/hot, 20m, 88 % of the time', () => {
    const hs = k8s(
      kube('hot', 'causes-e2e'),
      'hot',
      { cpuRequest: 0.005, cpuLimit: 0.02, memoryRequest: 8 * MIB, memoryLimit: 16 * MIB },
      use({ cpuP95: 0.02, throttledP95: 0.877, memoryPeak: 4 * MIB, memoryP95: 4 * MIB }),
    );
    expect(codes(hs)).toEqual(['cpu_limit_throttled', 'cpu_request_low']);
    expect(hs[0]).toMatchObject({ suggestion: null, facts: { throttledShare: 0.88 } });
    // Under 10 % is not a hint.
    expect(
      codes(
        k8s(
          kube('w'),
          'w',
          { ...none, cpuRequest: 0.05, cpuLimit: 0.1 },
          use({ cpuP95: 0.02, throttledP95: 0.09 }),
        ),
      ),
    ).toEqual([]);
  });

  it('memory limit: an OOM kill in the window, or a peak within 10 %', () => {
    const lim = {
      cpuRequest: 0.01,
      cpuLimit: null,
      memoryRequest: 32 * MIB,
      memoryLimit: 32 * MIB,
    };
    const tight = k8s(
      kube('tight'),
      'tight',
      lim,
      use({ cpuP95: 0.001, memoryPeak: 29 * MIB, memoryP95: 29 * MIB }),
    );
    expect(codes(tight)).toEqual(['memory_limit_tight']);
    expect(tight[0]!.suggestion).toBe(48 * MIB);
    expect(
      codes(
        k8s(
          kube('ok'),
          'ok',
          lim,
          use({ cpuP95: 0.001, memoryPeak: 28 * MIB, memoryP95: 20 * MIB }),
        ),
      ),
    ).toEqual([]);
    // rabbitmq-e2e/consumer: OOM-killed at 384 MiB, its highest sample 250 MiB.
    const oom = k8s(
      kube('consumer', 'rabbitmq-e2e'),
      'consumer',
      { ...none, memoryLimit: 384 * MIB },
      use({
        cpuP95: 0.099,
        memoryPeak: 262533120,
        memoryP95: 200 * MIB,
        oomKills: 1,
        lastOomAt: '2026-11-13T03:27:36Z',
      }),
    );
    expect(codes(oom)).toEqual(['memory_limit_oom', 'cpu_no_request']);
    expect(oom[0]).toMatchObject({
      suggestion: 480 * MIB,
      facts: { oomKills: 1, lastOomAt: '2026-11-13T03:27:36Z' },
    });
  });

  it('a request left out is the limit (Kubernetes) ; nothing set gives what it used', () => {
    const fromLimit = k8s(
      kube('w'),
      'w',
      { ...none, cpuLimit: 0.1, memoryLimit: 64 * MIB },
      use({ cpuP95: 0.02, memoryPeak: 20 * MIB, memoryP95: 20 * MIB }),
    );
    expect(codes(fromLimit)).toEqual([]);
    // shop/cart: no requests, no limits; 7.8m and 44 MiB.
    const cart = k8s(
      kube('cart'),
      'podinfo',
      none,
      use({ cpuP95: 0.0078, memoryPeak: 46071808, memoryP95: 44 * MIB }),
    );
    expect(codes(cart)).toEqual(['cpu_no_request', 'memory_no_request', 'memory_no_limit']);
    expect(cart.map((h) => h.suggestion)).toEqual([0.01, 64 * MIB, 64 * MIB]);
  });
});

describe('Docker', () => {
  const host = 6198562816;
  it('a reservation far above use gives it back; under use it is too low', () => {
    const high = dockerHints(
      docker('rs-e2e-idle-1'),
      { cpuLimit: null, memoryLimit: null, memoryReservation: 256 * MIB, hostMemory: host },
      use({ memoryPeak: 0.4 * MIB, memoryP95: 0.4 * MIB, cpuP95: 0 }),
      basedOn(use({}), 168, NOW),
    );
    expect(codes(high)).toEqual(['memory_reservation_high']);
    expect(high[0]).toMatchObject({ suggestion: 16 * MIB, giveBack: 240 * MIB, container: null });
    const low = dockerHints(
      docker('db'),
      { cpuLimit: null, memoryLimit: null, memoryReservation: 32 * MIB, hostMemory: host },
      use({ memoryPeak: 60 * MIB, memoryP95: 50 * MIB }),
      basedOn(use({}), 168, NOW),
    );
    expect(codes(low)).toEqual(['memory_reservation_low']);
  });

  it('limits reserve nothing: no "too high", only OOM risk and throttling', () => {
    // causes-e2e-hog-1: 48 MiB limit reached, 356 OOM kills, throttled 11 % at a 50m limit.
    const hog = dockerHints(
      docker('causes-e2e-hog-1'),
      { cpuLimit: 0.05, memoryLimit: 48 * MIB, memoryReservation: null, hostMemory: host },
      use({
        memoryPeak: 48 * MIB,
        memoryP95: 40 * MIB,
        cpuP95: 0.0087,
        throttledP95: 0.11,
        oomKills: 356,
      }),
      basedOn(use({}), 168, NOW),
    );
    expect(codes(hog)).toEqual(['memory_limit_oom', 'cpu_limit_throttled']);
    const idle = dockerHints(
      docker('web'),
      { cpuLimit: 4, memoryLimit: 2048 * MIB, memoryReservation: null, hostMemory: host },
      use({ memoryPeak: 10 * MIB, memoryP95: 10 * MIB, cpuP95: 0.001 }),
      basedOn(use({}), 168, NOW),
    );
    expect(idle).toEqual([]);
  });

  it('no memory limit matters past a quarter of the host: the kind node demo-worker', () => {
    const s = { cpuLimit: null, memoryLimit: null, memoryReservation: null, hostMemory: host };
    const big = dockerHints(
      docker('demo-worker'),
      s,
      use({ memoryPeak: 1597366272, memoryP95: 1.4e9 }),
      basedOn(use({}), 168, NOW),
    );
    expect(codes(big)).toEqual(['memory_no_limit']);
    expect(big[0]!.facts).toMatchObject({ hostMemoryBytes: host, host: 'lima-watchlog-iso' });
    expect(
      dockerHints(
        docker('small'),
        s,
        use({ memoryPeak: 1e9, memoryP95: 1e9 }),
        basedOn(use({}), 168, NOW),
      ),
    ).toEqual([]);
  });
});

describe('order and summary', () => {
  it('OOM risk first, then what holds back, then the most to give back; counts objects', () => {
    const b = basedOn(use({}), 168, NOW);
    const hs = sortHints([
      ...kubeHints(
        kube('idle'),
        'idle',
        { cpuRequest: 0.5, cpuLimit: null, memoryRequest: 256 * MIB, memoryLimit: 512 * MIB },
        use({ cpuP95: 0.0001, memoryPeak: MIB, memoryP95: MIB }),
        b,
        2,
      ),
      ...kubeHints(
        kube('big'),
        'big',
        { cpuRequest: 2, cpuLimit: null, memoryRequest: 64 * MIB, memoryLimit: 64 * MIB },
        use({ cpuP95: 0.1, memoryPeak: 63 * MIB, memoryP95: 50 * MIB }),
        b,
        1,
      ),
    ]);
    expect(hs.map((h) => `${h.object.name}:${h.code}`)).toEqual([
      'big:memory_limit_tight',
      'big:cpu_request_high',
      'idle:cpu_request_high',
      'idle:memory_request_high',
    ]);
    expect(summarize(hs)).toEqual({
      objects: 2,
      giveBackObjects: 2,
      giveBack: { cores: 2.85, bytes: 2 * 240 * MIB },
      oomRisk: 1,
    });
  });
});

describe('reading the use', () => {
  it('7-day subqueries at 5 minutes, per workload container or Docker container', () => {
    const k = usageExprs('kubernetes', '168h');
    expect(k.cpuP95).toBe(
      'max by (namespace, workload_kind, workload, container) (quantile_over_time(0.95, rate(watchlog_container_cpu_seconds_total{pod!="",container!="",workload_kind=~"Deployment|StatefulSet|DaemonSet"}[5m])[168h:5m]))',
    );
    expect(Object.keys(k)).not.toContain('oomKills');
    const d = usageExprs('docker', '168h');
    expect(d.oomKills).toContain(
      'increase(watchlog_container_oom_events_total{container!="",pod=""}[168h])',
    );
    expect(d.memoryReservation).toContain('watchlog_container_memory_reservation_bytes');
  });

  it('keys the answers by object and container', () => {
    const l = { host: 'h', container: 'c' };
    const one = (v: number) => [{ labels: l, points: [[NOW, v] as [number, number]] }];
    const u = usageByKey('docker', {
      cpuP95: one(0.02),
      memoryPeak: one(50 * MIB),
      memoryP95: one(40 * MIB),
      throttledP95: [],
      samples: one(240),
      from: one(NOW - 72000),
      oomKills: one(2.9999),
    });
    expect(u.get('h/c')).toEqual({
      cpuP95: 0.02,
      memoryPeak: 50 * MIB,
      memoryP95: 40 * MIB,
      throttledP95: null,
      samples: 240,
      from: NOW - 72000,
      oomKills: 3,
    });
  });

  it("finds a pod container's last OOM kill", () => {
    expect(
      oomAt({
        name: 'c',
        ready: true,
        restart_count: 1,
        state: 'running',
        last_termination: {
          reason: 'OOMKilled',
          exit_code: 137,
          finished_at: '2026-11-13T03:27:36Z',
        },
      }),
    ).toBe('2026-11-13T03:27:36Z');
    expect(
      oomAt({
        name: 'c',
        ready: true,
        restart_count: 1,
        state: 'running',
        last_termination: { reason: 'Error', exit_code: 1, finished_at: '2026-11-13T03:27:36Z' },
      }),
    ).toBeNull();
  });
});
