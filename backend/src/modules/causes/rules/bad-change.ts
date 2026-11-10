// SPDX-License-Identifier: AGPL-3.0-only
// bad_change (ADR-150 #2), the object's own form: a rollout or image change of the subject
// (Kubernetes), or a re-create, new image or Compose change (Docker, ADR-149), inside the
// window and not after the symptom, after which the new version fails: it crashes or is
// OOM-killed. The chain: the new version's failure, after the change (where it starts).
//
// - "The new version": Kubernetes pods created at or after the change, while no older pod
//   fails the same way (old pods failing too means it began before the change); on Docker the
//   container the change re-created (created within minutes of the marker).
// - A new version that can't pull its image is image_pull's, which names the change itself:
//   "can't pull X, the image it was changed to" says more than "fails since a change".
// - Its cause covers crash_exit and oom_limit on the same object: they are a step of its
//   chain, not a second cause.
// - The dependency form (a change of the thing the subject calls, which then fails or slows
//   down) comes with the walk's far-end rules (slice 3): `newVersionFailure` and `changeStep`
//   are exported for it.
import { shortName } from '../checks.js';
import type { EvContainer, EvMarker, EvPod, Evidence } from '../evidence.js';
import type { Match, Rule } from '../rules.js';
import type { Step } from '../types.js';
import {
  changeStep,
  containerRef,
  containerRestarts,
  lastDockerExit,
  oomKills,
  podMemoryLimit,
  podRef,
  RECREATE_SLACK_S,
  recentTermination,
  ROLLOUT_PODS_MS,
  ROLLOUT_SLACK_MS,
  terminations,
  versionChanges,
} from './common.js';

export const PULL_REASONS = new Set([
  'ImagePullBackOff',
  'ErrImagePull',
  'InvalidImageName',
  'ErrImageNeverPull',
]);

/** How the new version fails. */
export type Failure =
  | {
      kind: 'crash';
      exitCode: number;
      reason: string | null;
      object: Step['object'];
      since: string | null;
    }
  | { kind: 'oom'; limit: number | null; object: Step['object']; since: string | null }
  | { kind: 'pull'; object: Step['object']; since: string | null };

/** A Kubernetes pod's failure: pulling, OOM-killed, or exiting non-zero; null when fine. */
export function podFailure(ev: Evidence, p: EvPod): Failure | null {
  const object = podRef(p);
  const pulling =
    PULL_REASONS.has(p.failing ?? '') ||
    (p.containers ?? []).some((c) => PULL_REASONS.has(c.reason ?? ''));
  if (pulling) return { kind: 'pull', object, since: p.createdAt };
  const t = terminations(p)[0];
  if (!t || !recentTermination(ev, p, t)) return null;
  if (t.reason === 'OOMKilled')
    return { kind: 'oom', limit: podMemoryLimit(p, t.container), object, since: p.createdAt };
  if (t.exitCode !== 0)
    return { kind: 'crash', exitCode: t.exitCode, reason: t.reason, object, since: p.createdAt };
  return null;
}

/** A Docker container's failure in the window: OOM kills, or a non-zero exit. */
export function containerFailure(ev: Evidence, c: EvContainer): Failure | null {
  const object = containerRef(c);
  const since = c.createdAt ? new Date(c.createdAt * 1000).toISOString() : null;
  if ((oomKills(ev, c)?.n ?? 0) > 0 || (c.oomKilled && c.state !== 'running'))
    return { kind: 'oom', limit: c.memoryLimitBytes, object, since };
  const exit = lastDockerExit(ev, c);
  const restarted = (containerRestarts(ev, c)?.n ?? c.restartCount) > 0;
  if (exit && exit.exitCode !== 0 && (restarted || c.state !== 'running'))
    return { kind: 'crash', exitCode: exit.exitCode, reason: null, object, since };
  return null;
}

/** The failure of the version a change brought, when it fails; null otherwise. */
export function newVersionFailure(ev: Evidence, m: EvMarker): Failure | null {
  const at = Date.parse(m.ts);
  if (ev.platform === 'kubernetes') {
    const created = (p: EvPod) => (p.createdAt ? Date.parse(p.createdAt) : NaN);
    const after = ev.pods.filter(
      (p) => created(p) >= at - ROLLOUT_SLACK_MS && created(p) <= at + ROLLOUT_PODS_MS,
    );
    const before = ev.pods.filter((p) => created(p) < at - ROLLOUT_SLACK_MS);
    for (const p of after) {
      const f = podFailure(ev, p);
      if (!f) continue;
      // Old pods failing the same way: it isn't the new version's.
      if (before.some((o) => podFailure(ev, o)?.kind === f.kind)) return null;
      return f;
    }
    return null;
  }
  // Docker: the containers this change re-created.
  const target = m.target.split('/');
  for (const c of ev.containers) {
    const mine =
      m.kind === 'compose'
        ? c.composeProject === target[2] && c.host === target[1]
        : m.target === `Container/${c.host}/${c.name}`;
    if (!mine || !c.createdAt || Math.abs(c.createdAt - at / 1000) > RECREATE_SLACK_S) continue;
    const f = containerFailure(ev, c);
    if (f) return f;
  }
  return null;
}

function failureStep(ev: Evidence, f: Exclude<Failure, { kind: 'pull' }>): Step {
  const kube = ev.platform === 'kubernetes';
  if (f.kind === 'oom')
    return {
      object: f.object,
      source: kube ? 'kubernetes' : 'docker',
      code: f.limit ? 'new_version_oom' : 'new_version_oom_no_limit',
      facts: f.limit ? { limitBytes: f.limit } : {},
      at: null,
      since: f.since,
      next: 'after',
    };
  return {
    object: f.object,
    source: kube ? 'kubernetes' : 'docker',
    code: kube ? 'new_version_crash' : 'new_container_crash',
    facts: kube ? { exitCode: f.exitCode, reason: f.reason ?? 'Error' } : { exitCode: f.exitCode },
    at: null,
    since: f.since,
    next: 'after',
  };
}

export const badChange: Rule = {
  code: 'bad_change',
  platforms: ['kubernetes', 'docker'],
  applies: (f) => ['pod', 'workload', 'container', 'compose_service'].includes(f.kind),
  match(ev): Match | null {
    for (const m of versionChanges(ev)) {
      const f = newVersionFailure(ev, m);
      if (!f) continue;
      if (f.kind === 'pull') return null;
      const name = shortName(ev);
      const change = changeStep(ev, m);
      return {
        code: 'bad_change',
        facts: { name, change: m.kind, target: m.target, failure: f.kind },
        since: m.ts,
        chain: [failureStep(ev, f), change],
        complete: true,
        headline:
          f.kind === 'oom' && f.limit
            ? { code: 'bad_change_oom', facts: { name, limitBytes: f.limit } }
            : f.kind === 'crash'
              ? { code: 'bad_change_crash', facts: { name, exitCode: f.exitCode } }
              : { code: 'bad_change', facts: { name } },
        covers: ['crash_exit', 'oom_limit'],
      };
    }
    return null;
  },
  explains: ['self', 'events', 'changes'],
};
