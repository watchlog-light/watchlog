// SPDX-License-Identifier: AGPL-3.0-only
// "What we checked" from real evidence (fixtures captured on the kind and Docker e2e demo),
// and the panel's headline with no rule: every answer lists the facts it found (ADR-147).
import { describe, expect, it } from 'vitest';
import { checksOf } from '../src/modules/causes/checks.js';
import { headline } from '../src/modules/causes/engine.js';
import type { Evidence } from '../src/modules/causes/evidence.js';
import { evidence, type FixtureName } from './support/causes.js';

const codes = (ev: Evidence) =>
  Object.fromEntries(checksOf(ev).checks.map((c) => [c.topic, [c.code, c.result]]));

const head = (ev: Evidence) => {
  const { checks, flowsOff } = checksOf(ev);
  return headline('none', undefined, 0, ev, checks, flowsOff);
};

describe('checks on Kubernetes', () => {
  it('a crash-looping workload: the failing pod, its BackOff events, its scaling', () => {
    expect(codes(evidence('kube-workload-crashloop'))).toEqual({
      self: ['self_failing', 'possible'],
      events: ['events_warnings', 'possible'],
      changes: ['changes_own', 'possible'],
      node: ['node_ok', 'ok'],
      // Captured before slice 4: no throttling read.
      cpu: ['cpu_unknown', 'not_run'],
      dependencies: ['dependencies_none', 'not_applicable'],
      dns: ['dns_none', 'not_applicable'],
    });
    const self = checksOf(evidence('kube-workload-crashloop')).checks[0]!;
    expect(self.facts).toEqual({ name: 'crasher', reason: 'CrashLoopBackOff' });
  });

  it('an OOM-killed pod, its termination reported without finishedAt', () => {
    const ev = evidence('kube-pod-oom');
    expect(ev.pods[0]!.lastTermination).toMatchObject({ reason: 'OOMKilled', finishedAt: null });
    expect(codes(ev).self).toEqual(['self_oom_killed', 'possible']);
  });

  it('a healthy workload: every check ok, "nothing changed" headline', () => {
    const ev = evidence('kube-workload-healthy');
    expect(codes(ev)).toEqual({
      self: ['self_ok', 'ok'],
      events: ['events_none', 'ok'],
      changes: ['changes_none', 'ok'],
      node: ['node_ok', 'ok'],
      cpu: ['cpu_unknown', 'not_run'],
      dependencies: ['dependencies_ok', 'ok'],
      dns: ['dns_ok', 'ok'],
    });
    expect(head(ev)).toEqual({
      code: 'none_no_changes',
      facts: { name: 'web', n: 6, minutes: 60 },
    });
  });

  it('the node under it: NotReady, pressure, cordoned', () => {
    const notReady = evidence('kube-workload-healthy', (ev) => {
      ev.nodes[0]!.status = 'NotReady';
    });
    expect(checksOf(notReady).checks.find((c) => c.topic === 'node')).toMatchObject({
      code: 'node_not_ready',
      result: 'possible',
      object: { kind: 'node', ref: 'demo-worker', platform: 'kubernetes' },
    });
    const pressure = evidence('kube-workload-healthy', (ev) => {
      ev.nodes[0]!.conditions.find((c) => c.type === 'MemoryPressure')!.bad = true;
    });
    expect(codes(pressure).node).toEqual(['node_pressure', 'possible']);
    const cordoned = evidence('kube-workload-healthy', (ev) => {
      ev.nodes[0]!.unschedulable = true;
    });
    expect(codes(cordoned).node).toEqual(['node_unschedulable', 'possible']);
  });

  it('a pod not scheduled anywhere has no node to check', () => {
    const ev = evidence('kube-pod-oom', (e) => {
      e.pods[0]!.node = null;
      e.pods[0]!.phase = 'Pending';
      e.pods[0]!.failing = null;
      e.pods[0]!.lastTermination = null;
      e.nodes = [];
    });
    expect(codes(ev).self).toEqual(['self_pending', 'possible']);
    expect(codes(ev).node).toEqual(['node_none', 'not_applicable']);
  });

  it('network flows off on its node: dependencies and DNS could not run; the banner names it', () => {
    const ev = evidence('kube-workload-healthy', (e) => {
      const a = e.map.agents.find((x) => x.node === 'demo-worker')!;
      Object.assign(a, { ebpf: 'disabled', cause: 'kernel', reason: 'kernel without BTF' });
    });
    const { checks, flowsOff } = checksOf(ev);
    expect(flowsOff).toEqual([
      { node: 'demo-worker', cause: 'kernel', reason: 'kernel without BTF' },
    ]);
    expect(checks.filter((c) => c.result === 'not_run').map((c) => c.code)).toEqual([
      'cpu_unknown',
      'dependencies_flows_off',
      'dns_flows_off',
    ]);
    expect(head(ev)).toEqual({ code: 'none_flows_off', facts: { name: 'web' } });
  });

  it('flows off on another node only: nothing to say', () => {
    const ev = evidence('kube-workload-healthy', (e) => {
      e.map.agents.find((x) => x.node === 'demo-worker2')!.ebpf = 'disabled';
    });
    expect(checksOf(ev).flowsOff).toBeNull();
  });

  it('a failing call and DNS errors are possible leads', () => {
    const ev = evidence('kube-workload-healthy', (e) => {
      Object.assign(e.map.outgoing[0]!, {
        failedRatio: 0.38,
        failedLastMinute: 15,
        health: 'critical',
      });
      Object.assign(e.map.dns[0]!, { nxdomainPerSecond: 0.5, errorRatio: 0.25 });
    });
    const checks = checksOf(ev).checks;
    expect(checks.find((c) => c.topic === 'dependencies')).toMatchObject({
      code: 'dependencies_failing',
      result: 'possible',
      facts: { name: 'web', n: 1, target: 'api' },
    });
    expect(checks.find((c) => c.topic === 'dns')).toMatchObject({
      code: 'dns_errors',
      facts: { nxdomainPerMinute: 30 },
    });
    expect(head(ev)).toMatchObject({ code: 'none_found', facts: { name: 'web', found: 2 } });
  });

  it('metrics unavailable: the map checks could not run', () => {
    const ev = evidence('kube-workload-healthy', (e) => {
      e.map = { ...e.map, mode: 'unavailable', agents: [] };
    });
    expect(codes(ev).dependencies).toEqual(['dependencies_unavailable', 'not_run']);
    expect(checksOf(ev).flowsOff).toBeNull();
  });

  it('an object that no longer exists (an old alert)', () => {
    const ev = evidence('kube-pod-oom', (e) => {
      e.gone = true;
      e.pods = [];
      e.nodes = [];
    });
    expect(codes(ev).self).toEqual(['self_gone', 'not_run']);
  });
});

describe('checks on Docker', () => {
  it('an OOM-killed container: its oom events, though it runs again', () => {
    const ev = evidence('docker-container-oom');
    expect(ev.containers[0]).toMatchObject({ state: 'running', oomKilled: true });
    const self = checksOf(ev).checks[0]!;
    expect(self).toMatchObject({ code: 'self_oom_killed', result: 'possible' });
    expect(self.facts.n).toBeGreaterThan(0);
    expect(codes(ev).host).toEqual(['host_ok', 'ok']);
  });

  it('a crash-looping Compose service: restarts and the exit code of its Died events', () => {
    const self = checksOf(evidence('docker-compose-crashloop')).checks[0]!;
    expect(self).toMatchObject({
      code: 'self_restarts_code',
      facts: { name: 'crasher', exitCode: 3 },
    });
  });

  it('a healthy Compose service, its calls and lookups fine', () => {
    expect(codes(evidence('docker-compose-healthy'))).toMatchObject({
      self: ['self_ok', 'ok'],
      host: ['host_ok', 'ok'],
      dependencies: ['dependencies_ok', 'ok'],
      dns: ['dns_ok', 'ok'],
    });
  });

  it('a stopped container, and a service with fewer running than it has', () => {
    const stopped = evidence('docker-container-oom', (e) => {
      Object.assign(e.containers[0]!, { state: 'exited', exitCode: 1, oomKilled: false });
      e.events = [];
    });
    expect(checksOf(stopped).checks[0]).toMatchObject({
      code: 'self_stopped',
      facts: { exitCode: 1 },
    });
    const partial = evidence('docker-compose-healthy', (e) => {
      e.containers.push({ ...e.containers[0]!, name: 'causes-e2e-web-2', state: 'exited' });
    });
    expect(checksOf(partial).checks[0]).toMatchObject({
      code: 'self_not_running',
      facts: { running: 1, total: 2 },
    });
  });

  it('the host: silent, memory or disk nearly full (ADR-149)', () => {
    const silent = evidence('docker-compose-healthy', (e) => {
      e.hosts[0]!.status = 'inactive';
      e.hosts[0]!.lastSeenAt = new Date(e.now - 5 * 60_000).toISOString();
    });
    expect(checksOf(silent).checks.find((c) => c.topic === 'host')).toMatchObject({
      code: 'host_silent',
      facts: { host: 'docker-01', minutes: 5 },
      object: { kind: 'host', ref: 'docker-01', platform: 'docker' },
    });
    const full = evidence('docker-compose-healthy', (e) => {
      e.hosts[0]!.diskUtilization = 0.95;
    });
    expect(codes(full).host).toEqual(['host_disk', 'possible']);
  });

  it('flows off on the host: the banner and the checks say so', () => {
    const ev = evidence('docker-compose-healthy', (e) => {
      e.map.agents[0]!.ebpf = 'disabled';
      e.map.mode = 'topology';
    });
    expect(checksOf(ev).flowsOff).toEqual([{ node: 'docker-01', cause: null, reason: null }]);
    expect(codes(ev).dns).toEqual(['dns_flows_off', 'not_run']);
  });
});

describe('every fixture', () => {
  const all: FixtureName[] = [
    'kube-workload-crashloop',
    'kube-pod-oom',
    'kube-workload-healthy',
    'docker-container-oom',
    'docker-compose-crashloop',
    'docker-compose-healthy',
  ];
  it.each(all)('%s: checks have codes and facts, a headline with a name', (name) => {
    const ev = evidence(name);
    const { checks } = checksOf(ev);
    expect(checks.length).toBeGreaterThanOrEqual(5);
    for (const c of checks) {
      expect(c.code).toMatch(new RegExp(`^${c.topic}_`));
      for (const v of Object.values(c.facts))
        expect(['string', 'number', 'object']).toContain(typeof v);
    }
    expect(head(ev).facts.name).toBeTruthy();
  });
});
