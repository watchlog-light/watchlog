// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  containerResources,
  lastTermination,
  needsAttention,
  nodeStatus,
  parseQuantity,
  podDisplayStatus,
  podView,
  workloadView,
  type ObjectRow,
  type PodStatus,
} from '../src/modules/kubernetes/views.js';

// Live objects of the kind test cluster (deploy/test/k8s/workloads.yaml), captured
// from the cluster-agent's summaries in PostgreSQL after `helm install` (slice 6).
interface Fixture {
  kind: string;
  uid: string;
  namespace: string;
  name: string;
  node: string;
  spec: Record<string, unknown>;
  status: Record<string, unknown>;
}
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/kind-objects.json', import.meta.url), 'utf8'),
) as Fixture[];
const rows: ObjectRow[] = fixture.map((o) => ({
  kind: o.kind,
  namespace: o.namespace,
  name: o.name,
  node: o.node,
  spec_summary: o.spec,
  status_summary: o.status,
}));
const row = (kind: string, namespace: string, name: string) => {
  const r = rows.find((x) => x.kind === kind && x.namespace === namespace && x.name === name);
  if (!r) throw new Error(`${kind} ${namespace}/${name} not in the fixture`);
  return r;
};
const ofKind = (kind: string) => rows.filter((r) => r.kind === kind);
/** When the fixture was captured: its newest timestamp. */
const CAPTURED = Math.max(
  ...JSON.stringify(fixture)
    .match(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/g)!
    .map((t) => Date.parse(t)),
);

describe('Kubernetes views', () => {
  it('parses Kubernetes quantities', () => {
    expect(parseQuantity('100m')).toBeCloseTo(0.1);
    expect(parseQuantity('4')).toBe(4);
    expect(parseQuantity('70Mi')).toBe(70 * 2 ** 20);
    expect(parseQuantity('6053276Ki')).toBe(6053276 * 1024);
    expect(parseQuantity('30083776512')).toBe(30083776512);
    expect(parseQuantity('1.5G')).toBe(1.5e9);
    expect(parseQuantity('1e3')).toBe(1000);
    expect(parseQuantity('')).toBeNull();
    expect(parseQuantity('12Qi')).toBeNull();
    expect(parseQuantity(undefined)).toBeNull();
  });

  it('sums requests; a limit is null when any container has none', () => {
    expect(
      containerResources([
        { name: 'a', image: 'x', requests: { cpu: '100m', memory: '64Mi' }, limits: { cpu: '1' } },
        { name: 'b', image: 'x', requests: { cpu: '50m' }, limits: { cpu: '500m' } },
      ]),
    ).toEqual({
      cpuRequestCores: 0.15000000000000002,
      cpuLimitCores: 1.5,
      memoryRequestBytes: 64 * 2 ** 20,
      memoryLimitBytes: null,
    });
    expect(containerResources([]).cpuLimitCores).toBeNull();
  });

  it('shows pod status as kubectl does', () => {
    const status = (ns: string, name: string) =>
      podDisplayStatus(row('Pod', ns, name).status_summary as PodStatus);
    expect(status('wl-test', 'crashloop')).toBe('CrashLoopBackOff');
    expect(status('wl-test', 'oom')).toBe('CrashLoopBackOff');
    expect(status('wl-test', 'besteffort')).toBe('Running');
    // web pods: a completed init container and two running containers.
    expect(status('wl-test', 'web-674987bb67-b24ww')).toBe('Running');
    expect(status('wl-test', 'once-86lp4')).toBe('Completed');
    expect(
      podDisplayStatus({
        phase: 'Pending',
        containers: [
          {
            name: 'i',
            init: true,
            ready: false,
            restart_count: 3,
            state: 'waiting',
            reason: 'CrashLoopBackOff',
          },
        ],
      }),
    ).toBe('Init:CrashLoopBackOff');
    expect(podDisplayStatus({ phase: 'Failed', reason: 'Evicted' })).toBe('Evicted');
    expect(podDisplayStatus({ phase: 'Running', deleting_since: '2026-10-31T00:00:00Z' })).toBe(
      'Terminating',
    );
  });

  it('finds the last termination reason and exit code', () => {
    expect(lastTermination(row('Pod', 'wl-test', 'oom').status_summary as PodStatus)).toMatchObject(
      {
        container: 'main',
        reason: 'OOMKilled',
        exitCode: 137,
      },
    );
    expect(
      lastTermination(row('Pod', 'wl-test', 'crashloop').status_summary as PodStatus),
    ).toMatchObject({ reason: 'Error', exitCode: 1 });
    expect(
      lastTermination(row('Pod', 'wl-test', 'besteffort').status_summary as PodStatus),
    ).toBeNull();
  });

  it('builds pod views with workload, readiness and usage only while active', () => {
    const web = podView(row('Pod', 'wl-test', 'web-674987bb67-b24ww'), {
      cpuCores: 0.01,
      memoryBytes: 5e6,
    });
    expect(web).toMatchObject({
      workloadKind: 'Deployment',
      workload: 'web',
      readyContainers: 2,
      totalContainers: 2,
      cpuCores: 0.01,
    });
    expect(web.createdAt).toMatch(/^2026-/);
    const done = podView(row('Pod', 'wl-test', 'once-86lp4'), { cpuCores: 1, memoryBytes: 1 });
    expect(done.cpuCores).toBeNull();
  });

  it('reads node status from the Ready condition', () => {
    for (const n of ofKind('Node')) {
      expect(nodeStatus(n.status_summary as Record<string, unknown>)).toBe('Ready');
    }
    expect(nodeStatus({ conditions: [{ type: 'Ready', status: 'False' }] })).toBe('NotReady');
    expect(nodeStatus({ conditions: [{ type: 'Ready', status: 'Unknown' }] })).toBe('Unknown');
    expect(nodeStatus({})).toBe('Unknown');
  });

  it('derives workload health from replicas', () => {
    const web = row('Deployment', 'wl-test', 'web');
    expect(workloadView(web, [], undefined, null)).toMatchObject({
      desired: 2,
      ready: 2,
      health: 'healthy',
    });
    const status = web.status_summary as Record<string, unknown>;
    const half = { ...web, status_summary: { ...status, ready: 1 } };
    expect(workloadView(half, [], undefined, null).health).toBe('degraded');
    const rolling = { ...web, status_summary: { ...status, ready: 1, updated: 1 } };
    expect(workloadView(rolling, [], undefined, null).health).toBe('progressing');
    const down = { ...web, status_summary: { ...status, ready: 0 } };
    expect(workloadView(down, [], undefined, null).health).toBe('failed');
    expect(
      workloadView(row('CronJob', 'wl-test', 'every-minute'), [], undefined, null),
    ).toMatchObject({
      schedule: '* * * * *',
      health: 'healthy',
    });
  });

  it('lists what needs attention, most severe first', () => {
    const pods = ofKind('Pod');
    const nodes = ofKind('Node');
    const { items } = needsAttention(nodes, pods, [], CAPTURED);
    expect(items.map((i) => `${i.kind} ${i.name}`)).toEqual([
      'CrashLoopBackOff crashloop',
      'CrashLoopBackOff oom',
    ]);
    expect(items[1]!.detail).toContain('OOMKilled (exit 137)');

    const notReady = {
      ...nodes[0]!,
      status_summary: {
        conditions: [{ type: 'Ready', status: 'False', reason: 'KubeletNotReady' }],
      },
    };
    const pending = {
      ...row('Pod', 'wl-test', 'besteffort'),
      name: 'stuck',
      spec_summary: { created_at: new Date(CAPTURED - 10 * 60_000).toISOString() },
      status_summary: { phase: 'Pending', message: '0/3 nodes are available' },
    };
    const fresh = {
      ...pending,
      name: 'just-created',
      spec_summary: { created_at: new Date(CAPTURED - 60_000).toISOString() },
    };
    const res = needsAttention(
      [notReady],
      [pending, fresh],
      [
        { namespace: 'wl-test', name: 'data-db-0', ratio: 0.9 },
        { namespace: 'wl-test', name: 'ok', ratio: 0.5 },
      ],
      CAPTURED,
    );
    expect(res.items.map((i) => `${i.severity} ${i.kind} ${i.name}`)).toEqual([
      'critical NodeNotReady watchlog-control-plane',
      'warning PendingPod stuck',
      'warning PVCFull data-db-0',
    ]);
    expect(needsAttention(nodes, [], [], CAPTURED).total).toBe(0);
  });

  it('keeps a crash-looping pod on the list between back-offs', () => {
    const crash = row('Pod', 'wl-test', 'crashloop');
    const st = crash.status_summary as PodStatus;
    const c = st.containers![0]!;
    const finished = Date.parse(c.last_termination!.finished_at!);
    const as = (container: object) => ({
      ...crash,
      status_summary: { ...st, containers: [{ ...c, reason: undefined, ...container }] },
    });
    // Restarted and running for a moment, two seconds before it fails again.
    const running = needsAttention([], [as({ state: 'running' })], [], finished + 5_000);
    expect(running.items.map((i) => i.kind)).toEqual(['CrashLoopBackOff']);
    // Just failed: terminated with its reason, before the kubelet backs off.
    const failed = needsAttention(
      [],
      [as({ state: 'terminated', reason: 'Error', exit_code: 1 })],
      [],
      finished + 5_000,
    );
    expect(failed.items[0]!.detail).toBe(`main: Error (exit 1), ${c.restart_count} restarts`);
    // Running for good: the last failure is old.
    expect(needsAttention([], [as({ state: 'running' })], [], finished + 3600_000).total).toBe(0);
    // A first restart is not a loop.
    expect(
      needsAttention([], [as({ state: 'running', restart_count: 1 })], [], finished + 5_000).total,
    ).toBe(0);
  });

  it('counts a recent OOM kill of a running container', () => {
    const oom = row('Pod', 'wl-test', 'oom');
    const st = oom.status_summary as PodStatus;
    const finished = st.containers![0]!.last_termination!.finished_at!;
    const running = {
      ...oom,
      status_summary: {
        ...st,
        // One restart: an OOM kill, not (yet) a crash loop.
        containers: [
          { ...st.containers![0]!, state: 'running', reason: undefined, restart_count: 1 },
        ],
      },
    };
    const soon = needsAttention([], [running], [], Date.parse(finished) + 60_000);
    expect(soon.items.map((i) => i.kind)).toEqual(['OOMKilled']);
    expect(soon.items[0]!.detail).toBe('main: OOMKilled (exit 137), 1 restart');
    expect(needsAttention([], [running], [], Date.parse(finished) + 2 * 3600_000).total).toBe(0);
  });
});
