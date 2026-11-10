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
import type { Evidence, Reader } from '../../src/modules/causes/evidence.js';
import type { ClusterRef } from '../../src/modules/causes/resolve.js';
import { ApiReadError } from '../../src/modules/mcp/reader.js';
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
  | 'docker-container-bad-recreate'
  // Slice 4 (with the throttling read): pinned held off the drained demo-worker2, hot
  // throttled at its 20m CPU limit (kind and Docker), Compose service pg on a silent host.
  | 'kube-workload-cordoned'
  | 'kube-workload-throttled'
  | 'docker-service-throttled'
  | 'docker-service-silent';

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

/**
 * Slice 3: whole answers, recorded. Every API read GET /causes made for one subject on the
 * e2e demo (test/fixtures/causes/map/<name>.json: the reads, one a line, pruned to the
 * fixtures' objects; the host renamed docker-01, cluster ids fixed), replayed by a Reader, so
 * the walk across the map runs on real data: the edges, their last hour, the far end's own
 * evidence, the applications. `expected` is what the live answer was.
 */
export type RecordingName =
  | 'kube-dependency-down'
  | 'docker-dependency-down'
  | 'kube-refused'
  | 'docker-refused'
  | 'kube-dns-typo'
  | 'docker-dns-typo'
  | 'kube-slow-change'
  | 'docker-slow-change'
  | 'kube-pg-leak'
  | 'docker-pg-leak'
  | 'kube-rabbit-consumer-oom'
  | 'docker-rabbit-consumer-oom'
  // Re-created minutes before (a Compose file change): its OOM kills follow a change.
  | 'docker-rabbit-consumer-change'
  // Slice 4: the node drain (pinned), the silent Docker host (pg), caller → the CPU-limited hot.
  | 'kube-node-drain'
  | 'docker-host-silent'
  | 'kube-cpu-throttle'
  | 'docker-cpu-throttle';

export interface Recording {
  cluster: ClusterRef;
  subject: string;
  now: number;
  expected: { state: string; headline: string; rule: string | null; chain: string[] | null };
  reads: Record<string, { status: number; body: unknown }>;
}

export function recording(name: RecordingName): Recording {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/causes/map/${name}.json`, import.meta.url), 'utf8'),
  ) as Recording;
}

/**
 * Reads slice 4 added that recordings made before it lack: the CPU throttling of a focus with
 * a CPU limit. They answer no series (the recording's time had none recorded), so the answer
 * stays as it was; any other read missing still fails the test.
 */
export const BEFORE_SLICE_4 = (key: string): unknown =>
  /^POST \/query\/range .*"metric":"(?:pod\.)?container\.cpu\.throttled"/.test(key)
    ? { metric: 'throttled', unit: 'cores', step: 15, series: [] }
    : undefined;

/** Whether a recording was made before slice 4 (it has no throttling read). */
export const beforeSlice4 = (rec: Recording) =>
  !Object.keys(rec.reads).some((k) => k.includes('cpu.throttled'));

/**
 * A Reader that answers from a recording (404 for a read it doesn't have); `patch` may change
 * it first; `fallback` answers reads the recording doesn't have (BEFORE_SLICE_4).
 */
export function replay(
  rec: Recording,
  patch?: (reads: Recording['reads']) => void,
  fallback?: (key: string) => unknown,
): Reader & { missed: string[] } {
  const reads = structuredClone(rec.reads);
  patch?.(reads);
  const missed: string[] = [];
  const answer = <T>(key: string): T => {
    const r =
      reads[key] ??
      (fallback?.(key) !== undefined ? { status: 200, body: fallback(key) } : undefined);
    if (!r) {
      missed.push(key);
      throw new ApiReadError(404, `not recorded: ${key}`);
    }
    if (r.status >= 400)
      throw new ApiReadError(r.status, (r.body as { detail?: string } | null)?.detail ?? '');
    return structuredClone(r.body) as T;
  };
  return {
    missed,
    get<T>(path: string, query: Record<string, unknown> = {}) {
      const q = Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== null)
        .sort();
      return Promise.resolve().then(() => answer<T>(`GET ${path} ${JSON.stringify(q)}`));
    },
    post<T>(path: string, body: object) {
      return Promise.resolve().then(() => answer<T>(`POST ${path} ${JSON.stringify(body)}`));
    },
  };
}
