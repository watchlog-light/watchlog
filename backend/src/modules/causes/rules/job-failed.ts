// SPDX-License-Identifier: AGPL-3.0-only
// job_failed (ADR-150 #12, Kubernetes): a Job run that failed in the window — a failed Job, a
// CronJob whose newest run failed, or a pod of one — with why the Job gave up (its backoff
// limit, its deadline) and how its pods exited. Its cause covers crash_exit and oom_limit on
// the same pods: the exits are a step of its chain.
//
// Docker has no Jobs. A one-shot container (no restart policy) that exited non-zero is
// crash_exit's ("exited with code N and stays stopped"); there is no Docker form here.
import { shortName } from '../checks.js';
import type { EvEvent, EvPod, Evidence } from '../evidence.js';
import type { Match, Rule } from '../rules.js';
import type { Step } from '../types.js';
import { workloadObject } from '../resolve.js';
import { earliest, podRef, terminations } from './common.js';

const JOB_KINDS = new Set(['Job', 'CronJob']);
const GAVE_UP: Record<string, string> = {
  BackoffLimitExceeded: 'job_backoff_limit',
  DeadlineExceeded: 'job_deadline',
};

/** The Job a pod ran for: its name without the pod's random suffix. */
const jobOfPod = (p: EvPod) => p.name.replace(/-[a-z0-9]{5}$/, '');

const failedPod = (p: EvPod) => {
  const t = terminations(p)[0];
  return p.phase === 'Failed' || (!!t && t.exitCode !== 0) ? (t ?? null) : undefined;
};

export const jobFailed: Rule = {
  code: 'job_failed',
  platforms: ['kubernetes'],
  applies: (f) => f.kind === 'pod' || f.kind === 'workload',
  match(ev: Evidence): Match | null {
    const from = Date.parse(ev.window.from);
    const f = ev.focus;
    const w = ev.workload;
    const kind = f.kind === 'workload' ? f.workloadKind : (ev.pods[0]?.workloadKind ?? null);
    if (!JOB_KINDS.has(kind ?? '')) return null;
    // Why the Job gave up: its own event in the window (Job events name the Job).
    const gaveUp: EvEvent | undefined = ev.events.find(
      (e) => e.involvedKind === 'Job' && GAVE_UP[e.reason] && Date.parse(e.lastSeen) >= from,
    );
    let failed: boolean;
    let job: string | null = gaveUp?.involvedName ?? null;
    if (f.kind === 'workload' && w?.kind === 'CronJob') {
      const run = w.lastRun;
      failed = run?.result === 'failed' && (!run.at || Date.parse(run.at) >= from || !!gaveUp);
    } else if (f.kind === 'workload') {
      failed = w?.health === 'failed';
      job = w?.name ?? job;
    } else {
      failed = ev.pods.some((p) => p.phase === 'Failed');
    }
    if (!failed) return null;
    const pods = ev.pods.filter((p) => failedPod(p) !== undefined);
    job ??= pods[0] ? jobOfPod(pods[0]) : (w?.name ?? null);
    if (!job) return null;
    const mine = pods
      .filter((p) => jobOfPod(p) === job || p.name.startsWith(`${job}-`))
      .sort((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? ''));
    const last = mine[0];
    const t = last ? failedPod(last) : null;
    const name = shortName(ev);
    const object =
      f.kind === 'workload'
        ? workloadObject(f.namespace, f.workloadKind, f.name)
        : last
          ? podRef(last)
          : null;
    if (!object) return null;
    const runStep: Step = {
      object,
      source: 'kubernetes',
      code: gaveUp ? GAVE_UP[gaveUp.reason]! : 'job_run_failed',
      facts: { job },
      at: gaveUp?.lastSeen ?? w?.lastRun?.at ?? null,
      since: null,
      next: t ? 'because' : null,
    };
    const exitStep: Step | null =
      last && t
        ? {
            object: podRef(last),
            source: 'kubernetes',
            code: 'job_pod_exit',
            facts: { exitCode: t.exitCode, reason: t.reason, n: mine.length },
            at: t.finishedAt,
            since: null,
            next: null,
          }
        : null;
    return {
      code: 'job_failed',
      facts: {
        name,
        job,
        why: gaveUp?.reason ?? null,
        exitCode: t?.exitCode ?? null,
        attempts: mine.length,
      },
      since: earliest(...mine.map((p) => p.createdAt), gaveUp?.firstSeen),
      chain: exitStep ? [runStep, exitStep] : [runStep],
      complete: true,
      headline: t
        ? { code: 'job_failed_exit', facts: { name, job, exitCode: t.exitCode } }
        : { code: 'job_failed', facts: { name, job } },
      covers: ['crash_exit', 'oom_limit'],
    };
  },
  explains: ['self', 'events'],
};
