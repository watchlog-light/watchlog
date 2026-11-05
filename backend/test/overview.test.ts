// SPDX-License-Identifier: AGPL-3.0-only
// The overview's problems, events and change markers (ADR-110).
import { describe, expect, it } from 'vitest';
import { changeMarkers } from '../src/modules/ingest/kubernetes-objects.js';
import type { AttentionItem } from '../src/modules/kubernetes/views.js';
import { groupEvents, stripUids, workloadFromPodName } from '../src/modules/overview/events.js';
import { buildProblems, type FiringAlert } from '../src/modules/overview/problems.js';
import { heatPods } from '../src/modules/overview/routes.js';
import { sparkStep } from '../src/modules/overview/step.js';

const NOW = Date.parse('2026-11-01T20:00:00Z');
let n = 0;
const alert = (
  ruleKey: string,
  labels: Record<string, string>,
  over: Partial<FiringAlert> = {},
): FiringAlert => ({
  id: `a${n++}`,
  ruleId: `rule-${ruleKey}`,
  ruleKey,
  ruleName: ruleKey,
  severity: 'critical',
  silenced: false,
  labels,
  details: {},
  startedAt: new Date(NOW - 3 * 3600_000),
  firedAt: new Date(NOW - 3 * 3600_000),
  ...over,
});
const pod = (
  name: string,
  kind: AttentionItem['kind'],
  detail: string,
  ns = 'wl-test',
): AttentionItem => ({
  severity: kind === 'CrashLoopBackOff' ? 'critical' : 'warning',
  kind,
  objectKind: 'Pod',
  namespace: ns,
  name,
  detail,
  since: '2026-11-01T17:00:00Z',
});

describe('overview problems', () => {
  it('counts the strip and the list from the same items: one per object, alerts first', () => {
    const alerts = [
      alert(
        'k8s.pod.crashloop',
        { namespace: 'wl-test', workload: 'crashloop', pod: 'crashloop' },
        { details: { reason: 'Error', exitCode: 1, restarts: 154 } },
      ),
      // Two alerts on the same pod are one problem, named for the OOM.
      alert('k8s.pod.crashloop', { namespace: 'wl-test', workload: 'oom', pod: 'oom' }),
      alert(
        'k8s.container.oomkilled',
        { namespace: 'wl-test', workload: 'oom', pod: 'oom' },
        { severity: 'warning', details: { limit: '64Mi' } },
      ),
      alert(
        'network.connections.failed',
        {
          namespace: 'watchlog-dev',
          workload: 'wl-dev',
          dst: '203.0.113.10',
          dst_kind: 'external',
        },
        { severity: 'warning', startedAt: new Date(NOW - 18 * 60_000), firedAt: null },
      ),
      alert('k8s.pod.crashloop', { namespace: 'shop', workload: 'cart' }, { silenced: true }),
    ];
    const attention = [
      pod('crashloop', 'CrashLoopBackOff', 'main: Error (exit 1), 154 restarts'), // covered by its alert
      pod('cart-7d9f-x2', 'CrashLoopBackOff', 'main: Error (exit 1), 4 restarts', 'shop'), // silenced: hidden
      pod('api-1', 'PendingPod', 'Unschedulable', 'shop'),
      pod('api-2', 'PendingPod', 'Unschedulable', 'shop'), // same workload: one problem
    ];
    const p = buildProblems({
      alerts,
      attention,
      podWorkload: new Map([
        ['shop/cart-7d9f-x2', 'cart'],
        ['shop/api-1', 'api'],
        ['shop/api-2', 'api'],
      ]),
      clusterName: 'kind-demo',
      now: NOW,
    });
    expect(p.items.map((i) => [i.source, i.severity, i.type, i.title])).toEqual([
      ['alert', 'critical', 'crashloop', 'crashloop is crash-looping'],
      ['alert', 'critical', 'oom', 'oom was killed for using too much memory'],
      ['alert', 'warning', 'connections', expect.stringContaining('wl-dev')],
      ['object', 'warning', 'other', expect.stringContaining('api')],
    ]);
    expect(p.items[1]!.related).toBe(1);
    expect(p.items[0]!.why).toContain('wl-test');
    expect(p.critical + p.warning).toBe(p.items.length);
    expect(p.types).toEqual([
      { type: 'crashloop', count: 1, severity: 'critical', ruleId: 'rule-k8s.pod.crashloop' },
      { type: 'oom', count: 1, severity: 'critical', ruleId: expect.any(String) },
      {
        type: 'connections',
        count: 1,
        severity: 'warning',
        ruleId: 'rule-network.connections.failed',
      },
      { type: 'other', count: 1, severity: 'warning', ruleId: null },
    ]);
    expect(p.types.reduce((s, t) => s + t.count, 0)).toBe(p.items.length);
    expect(p.silenced).toBe(1);
    expect(p.oldestSince).toBe('2026-11-01T17:00:00.000Z');
  });

  it('is empty when nothing is wrong', () => {
    const p = buildProblems({
      alerts: [],
      attention: [],
      podWorkload: new Map(),
      clusterName: 'c',
      now: NOW,
    });
    expect(p).toMatchObject({
      items: [],
      critical: 0,
      warning: 0,
      types: [],
      silenced: 0,
      oldestSince: null,
    });
  });
});

describe('overview warning events', () => {
  it('strips pod UIDs from messages', () => {
    expect(
      stripUids(
        'Back-off restarting failed container main in pod crashloop_wl-test(1d4c5622-c34e-4beb-9c6c-f266104c9d31)',
      ),
    ).toBe('Back-off restarting failed container main in pod wl-test/crashloop');
    expect(stripUids('Deleted pod: 3e495d18-a897-4b74-ad35-cddc28447592 done')).toBe(
      'Deleted pod: done',
    );
    expect(stripUids('volume "data" (uid 3e495d18-a897-4b74-ad35-cddc28447592) is busy')).toBe(
      'volume "data" is busy',
    );
    expect(stripUids('nothing to strip')).toBe('nothing to strip');
  });

  it('groups by object and reason, flags covered objects and WatchLog pods, newest first', () => {
    const at = (m: number) => new Date(NOW - m * 60_000);
    const groups = groupEvents(
      [
        {
          involvedKind: 'Pod',
          namespace: 'wl-test',
          name: 'crashloop',
          reason: 'BackOff',
          message: 'Back-off … crashloop_wl-test(1d4c5622-c34e-4beb-9c6c-f266104c9d31)',
          count: 200,
          lastSeen: at(2),
        },
        {
          involvedKind: 'Pod',
          namespace: 'wl-test',
          name: 'crashloop',
          reason: 'BackOff',
          message: 'older',
          count: 79,
          lastSeen: at(1500),
        },
        {
          involvedKind: 'HorizontalPodAutoscaler',
          namespace: 'wl-test',
          name: 'web',
          reason: 'FailedGetResourceMetric',
          message: 'failed to get cpu utilization',
          count: 1301,
          lastSeen: at(4),
        },
        // A pod of an earlier rollout of WatchLog's backend: gone, matched by its name.
        {
          involvedKind: 'Pod',
          namespace: 'watchlog',
          name: 'watchlog-backend-5c9f948d44-g8fc5',
          reason: 'Unhealthy',
          message: 'Readiness probe failed',
          count: 1,
          lastSeen: at(30),
        },
        // Node events are stored in "default"; a node has no namespace.
        {
          involvedKind: 'Node',
          namespace: 'default',
          name: 'worker-2',
          reason: 'Rebooted',
          message: 'Node worker-2 has been rebooted',
          count: 1,
          lastSeen: at(60),
        },
      ],
      {
        pods: new Set(['wl-test/crashloop']),
        workloads: new Set(['wl-test/crashloop']),
        nodes: new Set(),
        podWorkload: new Map([['wl-test/crashloop', 'crashloop']]),
        ownWorkloads: new Set(['watchlog/watchlog-backend']),
      },
    );
    expect(groups.map((g) => [g.reason, g.name, g.count, g.covered, g.watchlog])).toEqual([
      ['BackOff', 'crashloop', 279, true, false],
      ['FailedGetResourceMetric', 'web', 1301, false, false],
      ['Unhealthy', 'watchlog-backend-5c9f948d44-g8fc5', 1, false, true],
      ['Rebooted', 'worker-2', 1, false, false],
    ]);
    expect(groups[3]!.namespace).toBeNull();
    expect(groups[0]!.message).toBe('Back-off … wl-test/crashloop');
  });

  it('finds the workload of a deleted pod only among known workloads', () => {
    const known = (n: string) => ['watchlog-backend', 'watchlog-agent', 'postgres'].includes(n);
    expect(workloadFromPodName('watchlog-backend-5c9f948d44-g8fc5', known)).toBe(
      'watchlog-backend',
    );
    expect(workloadFromPodName('watchlog-agent-x7k2p', known)).toBe('watchlog-agent');
    expect(workloadFromPodName('postgres-0', known)).toBe('postgres');
    expect(workloadFromPodName('random-thing-abcde', known)).toBeUndefined();
  });
});

describe('overview pod heatmap', () => {
  it('draws every failing pod, then the same share of each node', () => {
    const pods = Array.from({ length: 5000 }, (_, i) => ({ node: `n${i % 500}`, i }));
    const out = heatPods(pods, (p) => p.i === 4999);
    expect(out.length).toBe(2000);
    expect(out[0]!.i).toBe(4999);
    const perNode = new Map<string | null, number>();
    for (const p of out) perNode.set(p.node, (perNode.get(p.node) ?? 0) + 1);
    expect(perNode.size).toBe(500);
    expect(Math.max(...perNode.values())).toBe(4);
    const few = pods.slice(0, 10);
    expect(heatPods(few, () => false)).toBe(few);
  });
});

describe('overview change markers and steps', () => {
  it('marks a namespace created after the first snapshot', () => {
    const live = { spec: {}, status: {}, deleted: false };
    expect(changeMarkers('Namespace', '', 'wl-demo', undefined, live, true)).toEqual([
      {
        kind: 'namespace',
        target: 'Namespace/wl-demo',
        namespace: 'wl-demo',
        details: { action: 'created' },
      },
    ]);
    // The first snapshot lists existing namespaces: not a change.
    expect(changeMarkers('Namespace', '', 'wl-demo', undefined, live, false)).toEqual([]);
    expect(changeMarkers('Namespace', '', 'wl-demo', live, live, true)).toEqual([]);
  });

  it('picks at most 60 points per range', () => {
    expect(sparkStep(900)).toBe(15);
    expect(sparkStep(3600)).toBe(60);
    expect(sparkStep(6 * 3600)).toBe(600);
    expect(sparkStep(7 * 86400)).toBe(14400);
  });
});
