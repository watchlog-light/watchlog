// SPDX-License-Identifier: AGPL-3.0-only
// Fixtures for probable-cause tests (ADR-146): evidence snapshots captured from the kind and
// Docker e2e demo (deploy/test/causes-e2e.sh; the host renamed docker-01, cluster ids fixed),
// and small builders for candidates, steps and rules.
//
//   evidence('kube-pod-oom', (ev) => { ev.nodes[0]!.status = 'NotReady'; })
//
// Fixtures: kube-workload-crashloop (causes-e2e/crasher), kube-pod-oom (a hog pod),
// kube-workload-healthy (web, calling api), docker-container-oom (causes-e2e-hog-1),
// docker-compose-crashloop (causes-e2e/crasher), docker-compose-healthy (causes-e2e/web);
// those have no `metrics` (captured before slice 2): the rules' fallbacks. With metrics:
// kube-workload-oom (hog), kube-workload-crash (crasher), kube-workload-image-pull (release
// with a missing tag), kube-workload-unschedulable (greedy, 64 CPUs requested),
// kube-cronjob-failed (report, a run past its backoff limit), docker-service-oom (Compose
// service hog), docker-container-crash (causes-e2e-crasher-1), docker-container-bad-recreate
// (causes-e2e-release-1 re-created with busybox:1.36 and a command that exits 1).
import { readFileSync } from 'node:fs';
import type { Evidence } from '../../src/modules/causes/evidence.js';
import type { Rule } from '../../src/modules/causes/rules.js';
import type { Candidate, ObjectRef, Step } from '../../src/modules/causes/types.js';

export type FixtureName =
  | 'kube-workload-crashloop'
  | 'kube-pod-oom'
  | 'kube-workload-healthy'
  | 'docker-container-oom'
  | 'docker-compose-crashloop'
  | 'docker-compose-healthy'
  // Slice 2, with the counted hour's metrics (restarts, OOM kills, memory):
  | 'kube-workload-oom'
  | 'kube-workload-crash'
  | 'kube-workload-image-pull'
  | 'kube-workload-unschedulable'
  | 'kube-cronjob-failed'
  | 'docker-service-oom'
  | 'docker-container-crash'
  | 'docker-container-bad-recreate';

/** A fresh copy of a captured snapshot, changed by `patch` when given. */
export function evidence(name: FixtureName, patch?: (ev: Evidence) => void): Evidence {
  const ev = JSON.parse(
    readFileSync(new URL(`../fixtures/causes/${name}.json`, import.meta.url), 'utf8'),
  ) as Evidence;
  ev.metrics ??= null;
  patch?.(ev);
  return ev;
}

export const objectRef = (over: Partial<ObjectRef> = {}): ObjectRef => ({
  kind: 'workload',
  ref: 'shop/Deployment/api',
  name: 'shop/api',
  platform: 'kubernetes',
  workloadKind: 'Deployment',
  ...over,
});

export const step = (over: Partial<Step> = {}): Step => ({
  object: objectRef(),
  source: 'kubernetes',
  code: 'test_step',
  facts: {},
  at: null,
  since: null,
  next: null,
  ...over,
});

/** A candidate as a rule would return it (complete, on the subject, since the symptom). */
export const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  rule: 'oom_limit',
  code: 'oom_limit',
  facts: {},
  since: null,
  chain: [step()],
  complete: true,
  hops: 0,
  headline: { code: over.rule ?? 'oom_limit', facts: {} },
  explains: ['self'],
  ...over,
});

/** A rule that matches when `when` says so, for engine and walk tests. */
export const fakeRule = (
  code: Rule['code'],
  when: (ev: Evidence) => Partial<Candidate> | null,
): Rule => ({
  code,
  platforms: ['kubernetes', 'docker'],
  applies: () => true,
  explains: ['self'],
  match(ev) {
    const m = when(ev);
    if (!m) return null;
    const c = candidate({ rule: code, ...m });
    return {
      code: c.code,
      facts: c.facts,
      since: c.since,
      chain: c.chain,
      complete: c.complete,
      headline: c.headline,
      explains: c.explains,
    };
  },
});
