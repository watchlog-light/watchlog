// SPDX-License-Identifier: AGPL-3.0-only
// The rules under the object (v0.4 slice 4, ADR-150 #7 and #11, ADR-154): node_or_host and
// cpu_throttled, from answers recorded on the kind and Docker e2e demos (deploy/test/
// causes-e2e.sh: the node drain, the silent Docker host, the CPU-limited hot behind caller)
// and evidence captured there; then each form's edges: what must not match.
import { describe, expect, it } from 'vitest';
import { checksOf } from '../src/modules/causes/checks.js';
import { explain } from '../src/modules/causes/engine.js';
import type { EdgeHistory, EvEdge, Evidence, Via } from '../src/modules/causes/evidence.js';
import { runRules } from '../src/modules/causes/rules.js';
import { cpuThrottled, THROTTLING_ALERT } from '../src/modules/causes/rules/cpu-throttled.js';
import { cordonedAt, evictedFor, nodeOrHost } from '../src/modules/causes/rules/node-or-host.js';
import { unschedulable } from '../src/modules/causes/rules/unschedulable.js';
import { parseSubject } from '../src/modules/causes/subject.js';
import { runFromTolerant } from '../src/modules/causes/counts.js';
import { THROTTLED_SHARE, throttled, throttlings } from '../src/modules/causes/throttle.js';
import { dependenciesOf, edgeHistory, RISEN_MIN_P95_S } from '../src/modules/causes/walk.js';
import { evidence, recording, replay, type RecordingName } from './support/causes.js';

async function answer(name: RecordingName) {
  const rec = recording(name);
  const reader = replay(rec);
  const a = await explain(reader, rec.cluster, parseSubject(rec.subject), { now: rec.now });
  return { a, rec, missed: reader.missed };
}

describe('the scenarios: the top cause on each platform, replayed', () => {
  it.each<[RecordingName, string, string, string[]]>([
    [
      'kube-node-drain',
      'node_or_host',
      'node_or_host_held_cordoned',
      ['pending_unscheduled', 'node_cordoned'],
    ],
    ['docker-host-silent', 'node_or_host', 'node_or_host_silent', ['last_report', 'host_silent']],
    [
      'kube-cpu-throttle',
      'cpu_throttled',
      'cpu_throttled_dependency',
      ['edge_slower', 'cpu_throttled'],
    ],
    [
      'docker-cpu-throttle',
      'cpu_throttled',
      'cpu_throttled_dependency',
      ['edge_slower', 'cpu_throttled'],
    ],
  ])('%s: %s, likely (%s)', async (name, rule, headline, chain) => {
    const { a, rec, missed } = await answer(name);
    expect(missed).toEqual([]);
    expect(a.state).toBe('likely');
    expect(a.causes[0]).toMatchObject({ rule, strength: 'likely' });
    expect(a.headline.code).toBe(headline);
    expect(a.causes[0]!.chain.map((s) => s.code)).toEqual(chain);
    expect({
      state: a.state,
      headline: a.headline.code,
      rule: a.causes[0]!.rule,
      chain: a.causes[0]!.chain.map((s) => s.code),
    }).toEqual(rec.expected);
    expect(a.causes.filter((c) => c.strength === 'likely')).toHaveLength(1);
    for (const c of a.causes) {
      expect(c.chain.at(-1)!.next).toBeNull();
      for (const s of c.chain) expect(s.object.ref).toBeTruthy();
    }
  });

  it('kind node drain: pinned is Pending because demo-worker2, where it may run, is cordoned', async () => {
    const { a } = await answer('kube-node-drain');
    const [pending, node] = a.causes[0]!.chain;
    expect(pending).toMatchObject({ object: { kind: 'pod' }, next: 'because' });
    expect(node).toMatchObject({
      object: { kind: 'node', ref: 'demo-worker2' },
      facts: { node: 'demo-worker2' },
    });
    // No change marker for a cordon (gap 4): NodeNotSchedulable says when.
    expect(node!.at).toBeTruthy();
    // node_or_host covers unschedulable's partial chain: one cause for one failure.
    expect(a.causes.map((c) => c.rule)).not.toContain('unschedulable');
    expect(a.checks.find((c) => c.topic === 'node')).toMatchObject({
      code: 'node_unschedulable',
      result: 'explains',
      object: { ref: 'demo-worker2' },
    });
  });

  it('Docker host silent: the containers keep their last state; the host explains it', async () => {
    const { a } = await answer('docker-host-silent');
    const [last, host] = a.causes[0]!.chain;
    expect(last).toMatchObject({ code: 'last_report', facts: { state: 'running' } });
    expect(host).toMatchObject({ object: { kind: 'host', ref: 'docker-01' }, code: 'host_silent' });
    expect(a.causes[0]!.since).toBe(host!.since);
    expect(a.checks.find((c) => c.topic === 'host')).toMatchObject({
      code: 'host_silent',
      result: 'explains',
    });
  });

  it('a CPU-limited dependency: the walk follows an edge whose p95 rose under the 1 s bar', async () => {
    for (const name of ['kube-cpu-throttle', 'docker-cpu-throttle'] as const) {
      const { a } = await answer(name);
      const [edge, cpu] = a.causes[0]!.chain;
      expect(edge!.object.kind).toBe('edge');
      expect(Number(edge!.facts.p95Ms)).toBeGreaterThan(RISEN_MIN_P95_S * 1000);
      expect(Number(edge!.facts.p95Ms)).toBeLessThan(1000);
      expect(Number(edge!.facts.fromMs)).toBeLessThan(5);
      expect(cpu).toMatchObject({ source: 'metrics', facts: { limitCores: 0.02 } });
      expect(Number(cpu!.facts.pct)).toBeGreaterThanOrEqual(THROTTLED_SHARE * 100);
      expect(a.causes[0]!.facts).toMatchObject({ name: 'caller' });
      // The caller's dependency check says why it was followed.
      expect(a.checks.find((c) => c.topic === 'dependencies')).toMatchObject({
        code: 'dependencies_slower',
        result: 'explains',
      });
    }
  });
});

describe('node_or_host on Kubernetes', () => {
  it('held off a cordoned node: complete, at the NodeNotSchedulable event, covering unschedulable', () => {
    const ev = evidence('kube-workload-cordoned');
    const m = nodeOrHost.match(ev)!;
    expect(m).toMatchObject({ complete: true, covers: ['unschedulable'] });
    expect(m.chain[1]!.at).toBe(cordonedAt(ev.nodes[0]!));
    expect(unschedulable.match(ev)).toMatchObject({ complete: false });
    expect(runRules(ev).map((c) => c.rule)).toEqual(['node_or_host']);
  });

  it('uncordoned since: no cordon time; no cordoned node: no cause of its own', () => {
    const ev = evidence('kube-workload-cordoned', (e) => {
      const off = e.nodes[0]!.events!.find((x) => x.reason === 'NodeNotSchedulable')!;
      e.nodes[0]!.events!.unshift({
        ...off,
        reason: 'NodeSchedulable',
        lastSeen: new Date(Date.parse(off.lastSeen) + 60_000).toISOString(),
      });
    });
    expect(cordonedAt(ev.nodes[0]!)).toBeNull();
    const fine = evidence('kube-workload-cordoned', (e) => {
      e.nodes[0]!.unschedulable = false;
      e.nodes[0]!.taints = [];
    });
    expect(nodeOrHost.match(fine)).toBeNull();
    expect(runRules(fine).map((c) => [c.rule, c.complete])).toEqual([['unschedulable', false]]);
  });

  it('short of CPU on the other nodes too: partial (the held node may be as well)', () => {
    const ev = evidence('kube-workload-cordoned', (e) => {
      for (const x of e.events.filter((y) => y.reason === 'FailedScheduling'))
        x.message =
          '0/3 nodes are available: 1 node(s) had untolerated taint(s), 1 node(s) were unschedulable, 1 Insufficient cpu. preemption: 0/3 nodes are available.';
    });
    const m = nodeOrHost.match(ev)!;
    expect(m.complete).toBe(false);
    expect(m.covers).toBeUndefined();
    // The request is the likelier reason then: unschedulable is complete.
    expect(unschedulable.match(ev)).toMatchObject({ complete: true });
  });

  it('on a node that is not Ready: its pods state is the node’s', () => {
    const ev = evidence('kube-workload-healthy', (e) => {
      e.nodes[0]!.status = 'NotReady';
      const ready = e.nodes[0]!.conditions.find((c) => c.type === 'Ready')!;
      Object.assign(ready, { status: 'Unknown', reason: 'NodeStatusUnknown', bad: true });
    });
    const m = nodeOrHost.match(ev)!;
    expect(m).toMatchObject({ complete: true, headline: { code: 'node_or_host_not_ready' } });
    expect(m.chain.map((s) => s.code)).toEqual(['on_node', 'node_not_ready']);
    expect(nodeOrHost.match(evidence('kube-workload-healthy'))).toBeNull();
  });

  it('evicted for the node’s sake, not for its own ephemeral-storage limit', () => {
    const evict = (message: string) =>
      evidence('kube-workload-healthy', (e) => {
        Object.assign(e.pods[0]!, { phase: 'Failed', status: 'Evicted', ready: false, message });
      });
    const m = nodeOrHost.match(
      evict('The node was low on resource: memory. Threshold quantity: 100Mi, available: 80Mi.'),
    )!;
    expect(m).toMatchObject({ complete: true, facts: { how: 'evicted', resource: 'memory' } });
    expect(m.chain.map((s) => s.code)).toEqual(['evicted', 'node_was_low']);
    expect(
      nodeOrHost.match(
        evict('Pod ephemeral local storage usage exceeds the total limit of containers 1Mi.'),
      ),
    ).toBeNull();
    expect(evictedFor('The node was low on resource: [DiskPressure].')).toBe('DiskPressure');
  });

  it('OOM-killed without a memory limit: the node ran out; it covers nothing else then', () => {
    const ev = evidence('kube-workload-oom', (e) => {
      for (const p of e.pods) {
        p.memoryLimitBytes = null;
        for (const c of p.containers ?? []) c.memoryLimitBytes = null;
      }
    });
    const m = nodeOrHost.match(ev)!;
    expect(m).toMatchObject({ complete: true, headline: { code: 'node_or_host_oom_no_limit' } });
    expect(m.chain[0]!.code).toBe('oom_killed_no_limit');
    expect(runRules(ev).map((c) => c.rule)).toEqual(['node_or_host']);
    // At its limit and no pressure: oom_limit's, not this.
    expect(nodeOrHost.match(evidence('kube-workload-oom'))).toBeNull();
  });

  it('under MemoryPressure: complete below half the limit, partial near it (oom_limit too)', () => {
    const pressured = (peak: number) =>
      evidence('kube-workload-oom', (e) => {
        e.nodes[0]!.conditions.find((c) => c.type === 'MemoryPressure')!.bad = true;
        for (const k of Object.keys(e.metrics!.memory))
          e.metrics!.memory[k] = e.metrics!.memory[k]!.map(([t]) => [t, peak]);
      });
    const below = pressured(10 * 2 ** 20);
    expect(nodeOrHost.match(below)).toMatchObject({ complete: true, covers: ['oom_limit'] });
    expect(runRules(below).map((c) => c.rule)).toEqual(['node_or_host']);
    const near = pressured(46 * 2 ** 20);
    expect(nodeOrHost.match(near)).toMatchObject({ complete: false });
    expect(runRules(near).map((c) => [c.rule, c.complete])).toEqual([
      ['oom_limit', false],
      ['node_or_host', false],
    ]);
  });
});

describe('node_or_host on Docker', () => {
  it('a silent host covers its containers: complete, since its last report', () => {
    const ev = evidence('docker-service-silent');
    expect(ev.hosts[0]!.status).toBe('inactive');
    const m = nodeOrHost.match(ev)!;
    expect(m).toMatchObject({
      complete: true,
      since: ev.hosts[0]!.lastSeenAt,
      headline: { code: 'node_or_host_silent' },
      explains: ['host'],
    });
    // While it reports, nothing.
    expect(
      nodeOrHost.match(evidence('docker-service-silent', (e) => (e.hosts[0]!.status = 'active'))),
    ).toBeNull();
  });

  it('OOM-killed without a memory limit: the host ran out', () => {
    const ev = evidence('docker-service-oom', (e) => {
      for (const c of e.containers) c.memoryLimitBytes = null;
    });
    expect(nodeOrHost.match(ev)).toMatchObject({
      complete: true,
      headline: { code: 'node_or_host_oom_host' },
    });
    expect(runRules(ev).map((c) => c.rule)).toContain('node_or_host');
    expect(runRules(ev).map((c) => c.rule)).not.toContain('oom_limit');
    expect(nodeOrHost.match(evidence('docker-service-oom'))).toBeNull();
  });

  it('a nearly full disk under a crashing container: possible, beside crash_exit', () => {
    const ev = evidence('docker-container-crash', (e) => (e.hosts[0]!.diskUtilization = 0.95));
    expect(nodeOrHost.match(ev)).toMatchObject({
      complete: false,
      headline: { code: 'node_or_host_host_disk', facts: { pct: 95 } },
    });
    expect(nodeOrHost.match(evidence('docker-container-crash'))).toBeNull();
  });
});

/** The hot fixture as the far end of caller's edge, its p95 risen since `risenSince`. */
function viaCaller(ev: Evidence, history: Partial<EdgeHistory>, edge: Partial<EvEdge> = {}): Via {
  return {
    edge: {
      id: 'e',
      source: 'w:causes-e2e/Deployment/caller',
      target: 'w:causes-e2e/Deployment/hot',
      port: 8080,
      service: 'hot',
      connectionsPerSecond: 1,
      failedPerSecond: 0,
      failedRatio: 0,
      latencyP95Seconds: 0.0005,
      failedLastMinute: 0,
      http: {
        requestsPerSecond: 1,
        serverErrorsPerSecond: 0,
        serverErrorRatio: 0,
        p50Seconds: 0.0003,
        p95Seconds: 0.23,
        p99Seconds: 0.3,
      },
      health: 'ok',
      ...edge,
    },
    history: {
      troubleSince: null,
      slowSince: null,
      p95Before: null,
      risenSince: ev.window.to,
      p95Usual: 0.001,
      lastConnectedAt: ev.window.to,
      end: ev.window.to,
      ...history,
    },
    from: 'caller',
    caller: { kind: 'workload', ref: 'causes-e2e/Deployment/caller', name: 'caller' },
    dnsErrorsPerSecond: 0,
  };
}

describe('cpu_throttled', () => {
  it('throttled seconds a second, at most 100 % (Docker measured 1.08 s/s), from its 5 minutes', () => {
    const d = throttled(evidence('docker-service-throttled'))!;
    expect(d).toMatchObject({ container: 'causes-e2e-hot-1', limitCores: 0.02 });
    expect(d.share).toBeLessThanOrEqual(1);
    expect(d.share).toBeGreaterThan(0.9);
    const k = throttled(evidence('kube-workload-throttled'))!;
    expect(k).toMatchObject({ container: 'hot', limitCores: 0.02, object: { kind: 'pod' } });
    expect(k.since).toBeTruthy();
    // Without a limit nothing is read; an idle container is not throttled.
    const idle = evidence('kube-workload-throttled', (e) => {
      for (const key of Object.keys(e.metrics!.cpuThrottled!))
        e.metrics!.cpuThrottled![key] = e.metrics!.cpuThrottled![key]!.map(([t]) => [t, 0.01]);
    });
    expect(throttled(idle)).toBeNull();
    expect(throttlings(idle)![0]!.share).toBeCloseTo(0.01);
  });

  it('a dipped minute inside the run does not restart it; a longer lull does (ADR-157)', () => {
    const base = throttled(evidence('kube-workload-throttled'))!;
    const since = Date.parse(base.since!) / 1000;
    // Raw rates near zero for `seconds`, 7 minutes after the run began (a busy node).
    const dipped = (seconds: number) =>
      throttled(
        evidence('kube-workload-throttled', (e) => {
          for (const key of Object.keys(e.metrics!.cpuThrottled!))
            e.metrics!.cpuThrottled![key] = e.metrics!.cpuThrottled![key]!.map(([t, v]) => [
              t,
              t > since + 420 && t <= since + 420 + seconds ? 0.02 : v,
            ]);
        }),
      )!;
    // One minute low: the minute's mean dips under 25% for up to a minute.
    expect(dipped(60).since).toBe(base.since);
    expect(dipped(75).since).toBe(base.since);
    // Two minutes low: the run begins again after it.
    expect(Date.parse(dipped(120).since!)).toBeGreaterThan(Date.parse(base.since!) + 420_000);
    expect(runFromTolerant([0, 15, 30, 45, 60, 75], (t) => t !== 30, 0, 15, 60)).toBeNull();
    expect(runFromTolerant([100, 115, 130, 145], (t) => t !== 115, 0, 15, 60)).toBe(100);
    expect(runFromTolerant([100, 115, 130, 145], (t) => t !== 145, 0, 15, 60)).toBeNull();
    expect(
      runFromTolerant(
        [100, 115, 130, 145, 160, 175, 190, 205],
        (t) => t < 115 || t > 175,
        0,
        15,
        60,
      ),
    ).toBe(190);
  });

  it('on the object itself: a lead, complete only for the throttling alert or slow callers', () => {
    const ev = evidence('kube-workload-throttled');
    expect(cpuThrottled.match(ev)).toMatchObject({
      complete: false,
      headline: { code: 'cpu_throttled', facts: { name: 'hot', limitCores: 0.02 } },
    });
    const alerted = evidence('kube-workload-throttled', (e) => {
      e.alert = {
        id: 'a',
        state: 'firing',
        severity: 'warning',
        rule: { id: 'r', key: THROTTLING_ALERT, name: 'Container CPU throttling' },
        labels: {},
        startedAt: e.window.to,
        firedAt: e.window.to,
        resolvedAt: null,
      };
    });
    expect(cpuThrottled.match(alerted)!.complete).toBe(true);
    expect(cpuThrottled.match(evidence('docker-service-throttled'))!.complete).toBe(false);
  });

  it('at the far end of a slower edge: complete when the throttling began before the rise', () => {
    const base = evidence('kube-workload-throttled');
    const since = throttled(base)!.since!;
    const later = new Date(Date.parse(since) + 5 * 60_000).toISOString();
    const earlier = new Date(Date.parse(since) - 5 * 60_000).toISOString();
    const at = (h: Partial<EdgeHistory>, edge?: Partial<EvEdge>) =>
      cpuThrottled.match({ ...base, via: viaCaller(base, h, edge) });
    expect(at({ risenSince: later })).toMatchObject({
      complete: true,
      headline: { code: 'cpu_throttled_dependency', facts: { name: 'caller', p95Ms: 230 } },
      explains: ['dependencies'],
    });
    // Slower first, throttled after: partial.
    expect(at({ risenSince: earlier })!.complete).toBe(false);
    // Failed connects are dependency_down's or connection_refused's.
    expect(
      at({ risenSince: later }, { failedRatio: 0.5, failedPerSecond: 0.5, failedLastMinute: 30 }),
    ).toBeNull();
    // An edge that didn't rise: not followed for it.
    expect(at({ risenSince: null })).toBeNull();
  });
});

describe('the walk: an edge slower than usual', () => {
  const series = (p95: (i: number) => number) => ({
    step: 15,
    connections: Array.from({ length: 240 }, (_, i) => [i * 15, 1] as [number, number]),
    failed: Array.from({ length: 240 }, (_, i) => [i * 15, 0] as [number, number]),
    httpRequests: Array.from({ length: 240 }, (_, i) => [i * 15, 1] as [number, number]),
    httpP95: Array.from({ length: 240 }, (_, i) => [i * 15, p95(i)] as [number, number]),
  });
  it('rose from 1 ms to 200 ms 10 minutes ago: risen, though under the 1 s slow bar', () => {
    const h = edgeHistory(
      series((i) => (i >= 200 ? 0.2 : 0.001)),
      0,
    );
    expect(h).toMatchObject({ slowSince: null, risenSince: new Date(200 * 15_000).toISOString() });
    expect(h.p95Usual).toBe(0.001);
  });
  it('200 ms for most of the hour is its usual; 20 ms is too little to say', () => {
    expect(
      edgeHistory(
        series((i) => (i >= 40 ? 0.2 : 0.001)),
        0,
      ).risenSince,
    ).toBeNull();
    expect(
      edgeHistory(
        series((i) => (i >= 200 ? 0.02 : 0.001)),
        0,
      ).risenSince,
    ).toBeNull();
  });
  it('dependenciesOf offers such an edge to the engine, which reads its hour first', () => {
    const ev = evidence('kube-workload-healthy', (e) => {
      e.map.outgoing[0]!.http = {
        requestsPerSecond: 1,
        serverErrorsPerSecond: 0,
        serverErrorRatio: 0,
        p50Seconds: 0.001,
        p95Seconds: 0.2,
        p99Seconds: 0.3,
      };
    });
    expect(dependenciesOf(ev)).toMatchObject([{ risen: true }]);
    expect(dependenciesOf(evidence('kube-workload-healthy'))).toEqual([]);
  });
});

describe('the CPU check', () => {
  it('throttled, fine, no limit, or no data', () => {
    const cpu = (ev: Evidence) => checksOf(ev).checks.find((c) => c.topic === 'cpu');
    expect(cpu(evidence('docker-service-throttled'))).toMatchObject({
      code: 'cpu_throttled',
      result: 'possible',
    });
    expect(cpu(evidence('kube-workload-cordoned'))).toMatchObject({ code: 'cpu_ok' });
    expect(
      cpu(
        evidence('docker-service-throttled', (e) => {
          for (const c of e.containers) c.cpuLimitCores = null;
        }),
      ),
    ).toMatchObject({ code: 'cpu_no_limit', result: 'not_applicable' });
    expect(cpu(evidence('kube-workload-healthy'))).toMatchObject({
      code: 'cpu_unknown',
      result: 'not_run',
    });
  });
});
