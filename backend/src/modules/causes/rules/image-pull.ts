// SPDX-License-Identifier: AGPL-3.0-only
// image_pull (ADR-150 #5, Kubernetes only, ADR-149): a pod can't pull its image
// (ImagePullBackOff, ErrImagePull, InvalidImageName). The chain names the image and, from the
// container's waiting message, what the registry said (no such image or tag, access refused,
// unreachable); when a change of the subject set that image inside the window, the change is
// where it starts ("can't pull X, the image it was changed to"). A Compose `up` that can't
// pull fails on the operator's terminal and never reaches the agent: no Docker form.
import { shortName } from '../checks.js';
import type { EvMarker, EvPod, Evidence } from '../evidence.js';
import type { Match, Rule } from '../rules.js';
import type { Step } from '../types.js';
import { PULL_REASONS } from './bad-change.js';
import {
  changeStep,
  earliest,
  images,
  podContainer,
  podEvents,
  podRef,
  SAME_MS,
  versionChanges,
} from './common.js';

/** What the registry said, from the waiting message (containerd's and Docker's words). */
export function pullClass(reason: string | null, message: string | null | undefined): string {
  const m = (message ?? '').toLowerCase();
  if (reason === 'InvalidImageName' || /invalid reference format|invalid image name/.test(m))
    return 'pull_invalid';
  if (/notfound|not found|manifest unknown|does not exist/.test(m)) return 'pull_not_found';
  if (/unauthorized|denied|forbidden|authentication required|\b401\b|\b403\b/.test(m))
    return 'pull_denied';
  if (/no such host|i\/o timeout|connection refused|dial tcp|tls|deadline exceeded/.test(m))
    return 'pull_unreachable';
  return 'pull_failed';
}

const quoted = (s: string) => /image "([^"]+)"/.exec(s)?.[1] ?? null;

/** The image a pod can't pull: its container's, else the events' ("Back-off pulling image …"). */
function pullImage(
  ev: Evidence,
  p: EvPod,
): { image: string | null; reason: string; message: string | null } {
  const c = (p.containers ?? []).find((x) => PULL_REASONS.has(x.reason ?? ''));
  const fromEvents = podEvents(ev, p)
    .map((e) => quoted(e.message))
    .find((x) => !!x);
  return {
    image: c?.image ?? fromEvents ?? podContainer(p, null)?.image ?? ev.workload?.images[0] ?? null,
    reason: c?.reason ?? p.failing ?? 'ImagePullBackOff',
    message: c?.message ?? null,
  };
}

/** The change of the subject that set this image before the pod was created. */
function changeTo(ev: Evidence, image: string, p: EvPod): EvMarker | null {
  const created = p.createdAt ? Date.parse(p.createdAt) : Infinity;
  return (
    versionChanges(ev).find(
      (m) =>
        m.kind === 'image' &&
        images(m.details.to).includes(image) &&
        Date.parse(m.ts) <= created + SAME_MS,
    ) ?? null
  );
}

export const imagePull: Rule = {
  code: 'image_pull',
  platforms: ['kubernetes'],
  applies: (f) => f.kind === 'pod' || f.kind === 'workload',
  match(ev): Match | null {
    const p = ev.pods.find(
      (x) =>
        PULL_REASONS.has(x.failing ?? '') ||
        (x.containers ?? []).some((c) => PULL_REASONS.has(c.reason ?? '')),
    );
    if (!p) return null;
    const { image, reason, message } = pullImage(ev, p);
    const name = shortName(ev);
    const shown = image ?? '?';
    const change = image ? changeTo(ev, image, p) : null;
    const failed = podEvents(ev, p).filter((e) => e.reason === 'Failed' || e.reason === 'BackOff');
    const cls = pullClass(reason, message);
    const step: Step = {
      object: podRef(p),
      source: 'kubernetes',
      code: cls,
      facts: cls === 'pull_failed' ? { image: shown, reason } : { image: shown },
      at: null,
      since: earliest(...failed.map((e) => e.firstSeen), p.createdAt),
      next: change ? 'after' : null,
    };
    const match: Match = {
      code: 'image_pull',
      facts: { name, image: shown, reason, registry: cls.replace(/^pull_/, '') },
      since: change?.ts ?? step.since,
      chain: change ? [step, changeStep(ev, change)] : [step],
      complete: !!image,
      headline: change
        ? { code: 'image_pull_change', facts: { name, image: shown } }
        : { code: 'image_pull', facts: { name, image: shown } },
    };
    if (change) match.explains = ['self', 'events', 'changes'];
    return match;
  },
  explains: ['self', 'events'],
};
