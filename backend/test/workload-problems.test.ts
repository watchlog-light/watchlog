// SPDX-License-Identifier: AGPL-3.0-only
// The Workloads page's problem lines (ADR-111): alerts
// first, then the alert rules' own pod matchers, then replicas, runs and HPAs.
import { describe, expect, it } from 'vitest';
import type { ObjectRow, WorkloadView } from '../src/modules/kubernetes/views.js';
import { lastRuns, workloadProblems } from '../src/modules/kubernetes/workload-problems.js';
import type { FiringAlert } from '../src/modules/overview/problems.js';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const row = (kind: string, name: string, spec: object, status: object): ObjectRow =>
  ({
    kind,
    namespace: 'shop',
    name,
    node: 'n1',
    spec_summary: spec,
    status_summary: status,
  }) as ObjectRow;
const wl = (kind: string, name: string, over: Partial<WorkloadView> = {}) =>
  ({
    kind,
    namespace: 'shop',
    name,
    desired: 2,
    ready: 2,
    health: 'healthy',
    ...over,
  }) as WorkloadView;
const crashingPod = row(
  'Pod',
  'cart-1',
  { workload: { kind: 'Deployment', name: 'cart' } },
  {
    phase: 'Running',
    containers: [
      {
        name: 'app',
        state: 'waiting',
        reason: 'CrashLoopBackOff',
        restart_count: 5,
        last_termination: { reason: 'Error', exit_code: 1, finished_at: '2026-11-01T11:59:00Z' },
      },
    ],
  },
);
const alert = (ruleKey: string, over: Partial<FiringAlert> = {}): FiringAlert => ({
  id: `a-${ruleKey}`,
  ruleId: 'r',
  ruleKey,
  ruleName: ruleKey,
  severity: 'critical',
  silenced: false,
  labels: { namespace: 'shop', workload: 'cart', workload_kind: 'Deployment', pod: 'cart-1' },
  details: { restarts: 7, killedAt: '2026-11-01T11:55:00Z', limit: '64Mi' },
  startedAt: new Date(NOW),
  firedAt: new Date(NOW),
  ...over,
});
const base = {
  alerts: [] as FiringAlert[],
  workloads: [wl('Deployment', 'cart')],
  pods: [crashingPod],
  hpas: [],
  hpaEvents: [],
  runs: new Map(),
  clusterName: 'c',
  now: NOW,
};

describe('workload problems', () => {
  it("words a failing pod as the alert text's why line", () => {
    expect(workloadProblems(base).get('shop/Deployment/cart')).toEqual({
      severity: 'critical',
      reason: 'last exit: Error (code 1) · 5 restarts',
      alertId: null,
    });
  });

  it('prefers a firing alert, the most specific first; silenced alerts are ignored', () => {
    const p = workloadProblems({
      ...base,
      alerts: [alert('k8s.pod.crashloop'), alert('k8s.container.oomkilled')],
    });
    expect(p.get('shop/Deployment/cart')).toEqual({
      severity: 'critical',
      reason: 'OOMKilled 5 min ago · limit 64Mi · 7 restarts',
      alertId: 'a-k8s.container.oomkilled',
    });
    const muted = workloadProblems({
      ...base,
      alerts: [alert('k8s.container.oomkilled', { silenced: true })],
    });
    expect(muted.get('shop/Deployment/cart')?.alertId).toBeNull();
  });

  it('says how many replicas are missing, a failed run, an HPA without metrics', () => {
    const p = workloadProblems({
      ...base,
      pods: [],
      workloads: [
        wl('Deployment', 'cart', { desired: 3, ready: 1, health: 'degraded' }),
        wl('Deployment', 'web'),
        wl('CronJob', 'nightly', { desired: null, ready: 0 }),
      ],
      hpas: [
        row('HorizontalPodAutoscaler', 'web', { target: { kind: 'Deployment', name: 'web' } }, {}),
      ],
      hpaEvents: [{ namespace: 'shop', name: 'web', reason: 'FailedGetResourceMetric' }],
      runs: new Map([['shop/CronJob/nightly', { result: 'failed' as const, at: null }]]),
    });
    expect(p.get('shop/Deployment/cart')).toMatchObject({
      severity: 'warning',
      reason: '2 replicas unavailable',
    });
    expect(p.get('shop/Deployment/web')?.reason).toBe("HPA web can't read its metrics");
    expect(p.get('shop/CronJob/nightly')?.reason).toBe('Last run failed');
  });

  it("takes a CronJob's newest finished run over one still running", () => {
    const job = (name: string, state: string, started: string, completed: string | null) =>
      row(
        'Job',
        name,
        { cronjob: 'nightly' },
        { state, started_at: started, completed_at: completed },
      );
    const runs = lastRuns([
      job('n-1', 'failed', '2026-11-01T10:00:00Z', '2026-11-01T10:01:00Z'),
      job('n-2', 'complete', '2026-11-01T11:00:00Z', '2026-11-01T11:01:00Z'),
      job('n-3', 'running', '2026-11-01T11:59:00Z', null),
      row('Job', 'once', {}, { state: 'failed' }),
    ]);
    expect([...runs]).toEqual([
      ['shop/CronJob/nightly', { result: 'succeeded', at: '2026-11-01T11:01:00Z' }],
    ]);
  });
});
