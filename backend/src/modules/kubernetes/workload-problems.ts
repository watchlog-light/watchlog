// SPDX-License-Identifier: AGPL-3.0-only
// What is wrong with each workload, in one line (ADR-111):
// a firing alert about it, else its pods matched by the alert rules' own matchers, else
// its replica count, a failed Job or CronJob run, or an HPA that cannot read metrics.
// The words are the alert texts' "why" lines, so the Workloads page and the alerts agree.
import { POD_MATCHERS } from '../alerts/defaults.js';
import { alertText } from '../alerts/text.js';
import { rank, type FiringAlert } from '../overview/problems.js';
import {
  PENDING_AFTER_MS,
  podIsActive,
  type ObjectRow,
  type PodSpec,
  type PodStatus,
  type WorkloadView,
} from './views.js';

export interface WorkloadProblem {
  severity: 'critical' | 'warning';
  reason: string;
  /** The firing alert behind it, when there is one. */
  alertId: string | null;
}

export interface LastRun {
  result: 'succeeded' | 'failed' | 'running';
  at: string | null;
}

/** HPA events that mean it cannot scale its target. */
const HPA_REASONS = new Set(['FailedGetResourceMetric', 'FailedComputeMetricsReplicas']);
const CRITICAL_RULES = new Set(['k8s.pod.crashloop', 'k8s.container.oomkilled']);

export const workloadKey = (namespace: string, kind: string, name: string) =>
  `${namespace}/${kind}/${name}`;

/**
 * The last run of each CronJob: its newest finished Job (succeeded or failed, and when);
 * a running Job only while none has finished yet.
 */
export function lastRuns(jobs: ObjectRow[]): Map<string, LastRun> {
  const out = new Map<string, LastRun & { order: string }>();
  for (const j of jobs) {
    const cron = (j.spec_summary as { cronjob?: string }).cronjob;
    if (!cron) continue;
    const st = j.status_summary as { state?: string; started_at?: string; completed_at?: string };
    const result =
      st.state === 'complete' ? 'succeeded' : st.state === 'failed' ? 'failed' : 'running';
    // Finished runs sort after running ones, then by start.
    const order = `${result === 'running' ? 0 : 1}${st.started_at ?? ''}`;
    const k = workloadKey(j.namespace, 'CronJob', cron);
    const cur = out.get(k);
    if (cur && cur.order >= order) continue;
    out.set(k, { result, at: st.completed_at ?? st.started_at ?? null, order });
  }
  return new Map([...out].map(([k, v]) => [k, { result: v.result, at: v.at }]));
}

export function workloadProblems(input: {
  alerts: FiringAlert[];
  workloads: WorkloadView[];
  pods: ObjectRow[];
  hpas: ObjectRow[];
  /** Recent Warning events about HPAs: namespace, HPA name, reason. */
  hpaEvents: { namespace: string | null; name: string; reason: string }[];
  runs: Map<string, LastRun>;
  clusterName: string;
  now: number;
}): Map<string, WorkloadProblem> {
  const { alerts, workloads, pods, hpas, hpaEvents, runs, clusterName, now } = input;
  const out = new Map<string, WorkloadProblem & { rank: number }>();
  const byName = new Map<string, string>();
  for (const w of workloads) byName.set(`${w.namespace}/${w.name}`, w.kind);
  const text = (ruleKey: string, labels: Record<string, string>, details: object) =>
    alertText({
      ruleKey,
      ruleName: ruleKey,
      labels,
      details: details as Record<string, unknown>,
      cluster: { name: clusterName },
      now,
    });
  const offer = (k: string, p: WorkloadProblem, r: number) => {
    const cur = out.get(k);
    if (!cur || r < cur.rank || (r === cur.rank && p.severity === 'critical'))
      out.set(k, { ...p, rank: r });
  };

  // 1. Firing alerts about a workload or one of its pods.
  for (const a of alerts) {
    const l = a.labels;
    if (a.silenced || !l.namespace || !l.workload) continue;
    const kind = l.workload_kind ?? byName.get(`${l.namespace}/${l.workload}`);
    if (!kind) continue;
    const t = alertText({
      ruleKey: a.ruleKey,
      ruleName: a.ruleName,
      labels: l,
      details: a.details,
      cluster: { name: clusterName },
      now,
    });
    offer(
      workloadKey(l.namespace, kind, l.workload),
      {
        severity: a.severity === 'critical' ? 'critical' : 'warning',
        reason: t.why ?? t.title,
        alertId: a.id,
      },
      rank(a.ruleKey),
    );
  }

  // 2. Its pods, matched as the alert rules match them (no alert yet, or alerting off).
  for (const p of pods) {
    const st = p.status_summary as PodStatus;
    const spec = p.spec_summary as PodSpec;
    const wl = spec.workload;
    if (!wl || !podIsActive(st) || st.deleting_since) continue;
    for (const [ruleKey, match] of POD_MATCHERS) {
      const m = match(spec, st, now);
      if (!m) continue;
      if (
        ruleKey === 'k8s.pod.pending' &&
        (m.since === undefined || now - m.since < PENDING_AFTER_MS)
      )
        continue;
      const t = text(
        ruleKey,
        { namespace: p.namespace, workload: wl.name, pod: p.name },
        {
          summary: m.summary,
          ...m.facts,
        },
      );
      offer(
        workloadKey(p.namespace, wl.kind, wl.name),
        {
          severity: CRITICAL_RULES.has(ruleKey) ? 'critical' : 'warning',
          reason: t.why ?? t.title,
          alertId: null,
        },
        rank(ruleKey) + 0.5,
      );
      break;
    }
  }

  // 3. The workload itself: replicas missing, a failed Job or CronJob run.
  for (const w of workloads) {
    const k = workloadKey(w.namespace, w.kind, w.name);
    if (out.has(k)) continue;
    if ((w.health === 'failed' || w.health === 'degraded') && w.desired !== null) {
      const t = text(
        'k8s.deployment.unavailable',
        { workload: w.name },
        {
          desired: w.desired,
          ready: w.ready ?? 0,
        },
      );
      offer(
        k,
        {
          severity: w.health === 'failed' && w.kind !== 'Job' ? 'critical' : 'warning',
          reason: w.kind === 'Job' ? 'Job failed' : (t.why ?? t.title),
          alertId: null,
        },
        90,
      );
    }
    const run = runs.get(k);
    if (w.kind === 'CronJob' && run?.result === 'failed')
      offer(k, { severity: 'warning', reason: 'Last run failed', alertId: null }, 91);
  }

  // 4. An HPA that cannot read the metrics it scales on.
  const hpaTarget = new Map<string, { kind: string; name: string }>();
  for (const h of hpas) {
    const target = (h.spec_summary as { target?: { kind?: string; name?: string } }).target;
    if (target?.kind && target.name)
      hpaTarget.set(`${h.namespace}/${h.name}`, { kind: target.kind, name: target.name });
  }
  for (const e of hpaEvents) {
    if (!HPA_REASONS.has(e.reason) || !e.namespace) continue;
    const target = hpaTarget.get(`${e.namespace}/${e.name}`);
    if (!target) continue;
    offer(
      workloadKey(e.namespace, target.kind, target.name),
      { severity: 'warning', reason: `HPA ${e.name} can't read its metrics`, alertId: null },
      92,
    );
  }

  return new Map(
    [...out].map(([k, p]) => [k, { severity: p.severity, reason: p.reason, alertId: p.alertId }]),
  );
}
