// SPDX-License-Identifier: AGPL-3.0-only
// The rules on the object itself (v0.4 slice 2, ADR-150 #2–#6 and #12), from evidence captured
// on the kind and Docker e2e demos (deploy/test/causes-e2e.sh), each with the cases that must
// not match: an OOM without a limit, an exit 0, a Docker stop, a change after the symptom,
// image_pull and unschedulable never on Docker, a CronJob whose last run succeeded.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { increase, interval, memoryTrend, runsOf } from '../src/modules/causes/counts.js';
import type { EvMarker, Evidence } from '../src/modules/causes/evidence.js';
import { rank } from '../src/modules/causes/rank.js';
import { RULES, runRules } from '../src/modules/causes/rules.js';
import { badChange } from '../src/modules/causes/rules/bad-change.js';
import { crashExit } from '../src/modules/causes/rules/crash-exit.js';
import { imagePull, pullClass } from '../src/modules/causes/rules/image-pull.js';
import { jobFailed } from '../src/modules/causes/rules/job-failed.js';
import { oomLimit } from '../src/modules/causes/rules/oom-limit.js';
import {
  mainReason,
  schedulingReasons,
  unschedulable,
} from '../src/modules/causes/rules/unschedulable.js';
import type { Candidate } from '../src/modules/causes/types.js';
import { evidence, type FixtureName } from './support/causes.js';

const MiB48 = 48 * 2 ** 20;

/** The top cause of a snapshot, as GET /causes ranks it. */
function top(ev: Evidence) {
  const r = rank(runRules(ev), ev.symptomAt, ev.window.from);
  return { state: r.state, cause: r.causes[0], candidate: r.kept[0]?.candidate };
}

const codes = (c: Candidate | undefined) => c?.chain.map((s) => s.code);

describe('the scenarios: the top cause on each platform', () => {
  it.each<[FixtureName, string, string]>([
    ['kube-workload-oom', 'oom_limit', 'oom_limit_restarts'],
    ['kube-pod-oom', 'oom_limit', 'oom_limit_last'],
    ['docker-service-oom', 'oom_limit', 'oom_limit'],
    ['docker-container-oom', 'oom_limit', 'oom_limit'],
    ['kube-workload-crash', 'crash_exit', 'crash_exit_every'],
    ['kube-workload-crashloop', 'crash_exit', 'crash_exit'],
    ['docker-container-crash', 'crash_exit', 'crash_exit_every'],
    ['docker-compose-crashloop', 'crash_exit', 'crash_exit'],
    ['kube-workload-image-pull', 'image_pull', 'image_pull_change'],
    ['docker-container-bad-recreate', 'bad_change', 'bad_change_crash'],
    ['kube-workload-unschedulable', 'unschedulable', 'unschedulable_cpu'],
    ['kube-cronjob-failed', 'job_failed', 'job_failed_exit'],
  ])('%s: %s, likely (%s)', (fixture, rule, headline) => {
    const t = top(evidence(fixture));
    expect(t.state).toBe('likely');
    expect(t.cause).toMatchObject({ rule, strength: 'likely' });
    expect(t.candidate!.headline.code).toBe(headline);
    expect(t.candidate!.complete).toBe(true);
  });

  it('healthy objects have no cause', () => {
    expect(runRules(evidence('kube-workload-healthy'))).toEqual([]);
    // web was stopped by Compose once (Died, exit 137) and runs again: a stop, not a crash.
    expect(runRules(evidence('docker-compose-healthy'))).toEqual([]);
  });

  it('every code a rule sends has its words in en.json', () => {
    const en = JSON.parse(
      readFileSync(new URL('../../web/src/i18n/en.json', import.meta.url), 'utf8'),
    ) as { causes: Record<string, Record<string, unknown>> };
    const all: FixtureName[] = [
      'kube-workload-oom',
      'kube-pod-oom',
      'docker-service-oom',
      'kube-workload-crash',
      'kube-workload-crashloop',
      'docker-container-crash',
      'kube-workload-image-pull',
      'docker-container-bad-recreate',
      'kube-workload-unschedulable',
      'kube-cronjob-failed',
    ];
    for (const f of all)
      for (const c of runRules(evidence(f))) {
        expect(en.causes.cause![c.code], `cause ${c.code}`).toBeTypeOf('string');
        expect(en.causes.headline![c.headline.code], `headline ${c.headline.code}`).toBeTypeOf(
          'string',
        );
        for (const s of c.chain)
          expect(en.causes.step![s.code], `step ${s.code}`).toBeTypeOf('string');
      }
  });
});

describe('oom_limit', () => {
  it('Kubernetes: the limit, the restarts in the counted hour, and the climb to the limit', () => {
    const m = oomLimit.match(evidence('kube-workload-oom'))!;
    expect(m.headline).toEqual({
      code: 'oom_limit_restarts',
      facts: { name: 'hog', limitBytes: MiB48, n: 7 },
    });
    expect(m.chain[0]).toMatchObject({
      object: { kind: 'pod', name: 'hog-76cf876d44-dn2jz' },
      code: 'oom_killed_restarts',
      facts: { container: 'hog', limitBytes: MiB48, n: 7 },
      next: 'because',
    });
    // The hog grows 1 MiB/s to its 48 MiB limit: about a minute after each start.
    expect(m.chain[1]).toMatchObject({ source: 'metrics', code: 'memory_climbs' });
    expect(m.chain[1]!.facts.minutes).toBe(1);
    expect(m.chain[1]!.facts.perMinuteBytes).toBeGreaterThan(40 * 2 ** 20);
    expect(m.chain[1]!.facts.perMinuteBytes).toBeLessThan(70 * 2 ** 20);
  });

  it('Docker: kills counted from the oom events in the hour, not Docker’s total', () => {
    const ev = evidence('docker-service-oom');
    const m = oomLimit.match(ev)!;
    // The OOMKilled event's count (56) reaches back before the window; the counter's increase
    // over the hour is 45.
    expect(ev.events.find((e) => e.reason === 'OOMKilled')!.count).toBe(56);
    expect(m.headline).toEqual({
      code: 'oom_limit',
      facts: { name: 'hog', limitBytes: MiB48, n: 45 },
    });
    expect(codes(m as Candidate)).toEqual(['oom_killed_kills', 'memory_climbs']);
  });

  it('without the metrics: the termination reason alone (kind reports no finishedAt)', () => {
    const m = oomLimit.match(evidence('kube-pod-oom'))!;
    expect(m.chain).toHaveLength(1);
    expect(m.chain[0]!.code).toBe('oom_killed');
  });

  it('not at the limit: no memory limit (the node or host ran out) is no match', () => {
    expect(
      oomLimit.match(
        evidence('kube-workload-oom', (ev) => {
          for (const p of ev.pods) {
            p.memoryLimitBytes = null;
            for (const c of p.containers ?? []) c.memoryLimitBytes = null;
          }
        }),
      ),
    ).toBeNull();
    expect(
      oomLimit.match(
        evidence('docker-service-oom', (ev) => {
          ev.containers[0]!.memoryLimitBytes = null;
        }),
      ),
    ).toBeNull();
  });

  it('under node memory pressure, or on a nearly full host, the chain is partial', () => {
    const k = oomLimit.match(
      evidence('kube-workload-oom', (ev) => {
        ev.nodes[0]!.conditions.push({
          type: 'MemoryPressure',
          status: 'True',
          reason: null,
          since: null,
          bad: true,
        });
      }),
    )!;
    expect(k.complete).toBe(false);
    const d = oomLimit.match(
      evidence('docker-service-oom', (ev) => {
        ev.hosts[0]!.memoryUtilization = 0.97;
      }),
    )!;
    expect(d.complete).toBe(false);
  });

  it('Docker keeps oomKilled on a container that runs again: alone, it is no kill', () => {
    const ev = evidence('docker-compose-healthy', (e) => {
      e.containers[0]!.oomKilled = true;
      e.containers[0]!.state = 'running';
    });
    expect(oomLimit.match(ev)).toBeNull();
  });
});

describe('crash_exit', () => {
  it('Kubernetes: restarts with back-off because its container exits with code 3', () => {
    const m = crashExit.match(evidence('kube-workload-crash'))!;
    expect(m.chain.map((s) => [s.code, s.next])).toEqual([
      ['restarts_backoff', 'because'],
      ['exit_code_every', null],
    ]);
    expect(m.chain[1]!.facts).toMatchObject({ container: 'crasher', exitCode: 3, reason: 'Error' });
    expect(m.headline).toMatchObject({ code: 'crash_exit_every', facts: { exitCode: 3, n: 8 } });
  });

  it('Docker: restarted by its policy because it exits with code 3', () => {
    const m = crashExit.match(evidence('docker-container-crash'))!;
    expect(codes(m as Candidate)).toEqual(['restarts_policy', 'exit_code_docker_every']);
    expect(m.chain[1]!.facts.exitCode).toBe(3);
  });

  it('exit 0 is no crash, on either platform', () => {
    const k = evidence('kube-workload-crash', (ev) => {
      for (const p of ev.pods) {
        p.lastTermination = {
          container: 'crasher',
          reason: 'Completed',
          exitCode: 0,
          finishedAt: null,
        };
        for (const c of p.containers ?? []) {
          c.state = 'running';
          c.reason = null;
          c.lastTermination = { reason: 'Completed', exitCode: 0, finishedAt: null };
        }
      }
    });
    expect(crashExit.match(k)).toBeNull();
    const d = evidence('docker-container-crash', (ev) => {
      ev.events = ev.events.filter((e) => e.reason !== 'Died');
      ev.containers[0]!.exitCode = 0;
    });
    expect(crashExit.match(d)).toBeNull();
  });

  it('an OOM kill is oom_limit’s, not a crash', () => {
    expect(crashExit.match(evidence('kube-workload-oom'))).toBeNull();
    expect(crashExit.match(evidence('docker-service-oom'))).toBeNull();
  });

  it('Docker has no Jobs: a one-shot container that exited non-zero is crash_exit', () => {
    const ev = evidence('docker-container-crash', (e) => {
      const c = e.containers[0]!;
      c.state = 'exited';
      c.exitCode = 2;
      c.finishedAt = e.window.to;
      e.events = [];
      e.metrics!.restarts = {};
    });
    const m = crashExit.match(ev)!;
    expect(m.headline).toMatchObject({ code: 'crash_exit_once', facts: { exitCode: 2 } });
    expect(codes(m as Candidate)).toEqual(['exited_code']);
  });

  it('a container stopped by a signal (docker stop) is no crash', () => {
    const ev = evidence('docker-container-crash', (e) => {
      const c = e.containers[0]!;
      c.state = 'exited';
      c.exitCode = 143;
      c.finishedAt = e.window.to;
      e.events = [];
      e.metrics!.restarts = {};
    });
    expect(crashExit.match(ev)).toBeNull();
  });
});

/** A rollout of crasher a minute before its pod was created, with the image it brought. */
const rollout = (ev: Evidence, at: string): EvMarker[] => [
  {
    kind: 'rollout',
    target: 'Deployment/causes-e2e/crasher',
    namespace: 'causes-e2e',
    details: { from: '3', to: '4' },
    ts: at,
  },
  {
    kind: 'image',
    target: 'Deployment/causes-e2e/crasher',
    namespace: 'causes-e2e',
    details: { from: ['crasher=busybox:1.36'], to: ['crasher=busybox:1.37'] },
    ts: at,
  },
  ...ev.changes,
];

describe('bad_change', () => {
  it('Docker: re-created with a new image, then exits with code 1; crash_exit is a step of it', () => {
    const ev = evidence('docker-container-bad-recreate');
    const m = badChange.match(ev)!;
    expect(m.chain.map((s) => [s.code, s.facts, s.next])).toEqual([
      ['new_container_crash', { exitCode: 1 }, 'after'],
      ['changed_image', { from: 'busybox:latest', to: 'busybox:1.36' }, null],
    ]);
    expect(m.since).toBe('2026-11-10T17:51:17.790Z');
    expect(runRules(ev).map((c) => c.rule)).toEqual(['bad_change']);
  });

  it('Kubernetes: a rollout before the new pod, which crashes', () => {
    const ev = evidence('kube-workload-crash', (e) => {
      e.changes = rollout(e, '2026-11-10T17:33:00.000Z');
      e.symptomAt = '2026-11-10T17:35:00.000Z';
    });
    const t = top(ev);
    expect(t.cause).toMatchObject({ rule: 'bad_change', strength: 'likely' });
    expect(t.candidate!.chain.map((s) => s.code)).toEqual(['new_version_crash', 'changed_image']);
    expect(t.candidate!.chain[1]!.facts).toEqual({ from: 'busybox:1.36', to: 'busybox:1.37' });
    expect(t.candidate!.headline).toMatchObject({
      code: 'bad_change_crash',
      facts: { exitCode: 3 },
    });
  });

  it('a change after the symptom is no bad_change', () => {
    const k = evidence('kube-workload-crash', (e) => {
      e.changes = rollout(e, '2026-11-10T17:33:00.000Z');
      e.symptomAt = '2026-11-10T17:20:00.000Z';
    });
    expect(badChange.match(k)).toBeNull();
    const d = evidence('docker-container-bad-recreate', (e) => {
      e.symptomAt = '2026-11-10T17:40:00.000Z';
    });
    expect(badChange.match(d)).toBeNull();
    expect(top(d).cause?.rule).toBe('crash_exit');
  });

  it('a pod created long after the rollout (a scale-up) was not brought by it', () => {
    const ev = evidence('kube-workload-crash', (e) => {
      e.changes = rollout(e, '2026-11-10T17:00:00.000Z');
    });
    expect(badChange.match(ev)).toBeNull();
  });

  it('a new version that cannot pull its image is image_pull’s (it names the change)', () => {
    expect(badChange.match(evidence('kube-workload-image-pull'))).toBeNull();
  });
});

describe('image_pull', () => {
  it('the image, what the registry said, and the change that set it', () => {
    const m = imagePull.match(evidence('kube-workload-image-pull'))!;
    expect(m.chain.map((s) => [s.code, s.facts, s.next])).toEqual([
      ['pull_not_found', { image: 'busybox:0.0-causes-e2e-missing' }, 'after'],
      ['changed_image', { from: 'busybox:1.37', to: 'busybox:0.0-causes-e2e-missing' }, null],
    ]);
    expect(m.explains).toContain('changes');
    expect(m.since).toBe(m.chain[1]!.at);
  });

  it('without a change of that image: the pull failure alone', () => {
    const m = imagePull.match(
      evidence('kube-workload-image-pull', (e) => {
        e.changes = [];
      }),
    )!;
    expect(m.headline.code).toBe('image_pull');
    expect(m.chain).toHaveLength(1);
  });

  it('reads what the registry said', () => {
    expect(pullClass('ErrImagePull', 'rpc error: code = NotFound desc = failed to resolve')).toBe(
      'pull_not_found',
    );
    expect(pullClass('ErrImagePull', '401 Unauthorized')).toBe('pull_denied');
    expect(pullClass('ErrImagePull', 'dial tcp: lookup reg.example: no such host')).toBe(
      'pull_unreachable',
    );
    expect(pullClass('InvalidImageName', null)).toBe('pull_invalid');
    expect(pullClass('ImagePullBackOff', null)).toBe('pull_failed');
  });

  it('Kubernetes only (ADR-149): never on a Docker fleet', () => {
    expect(imagePull.platforms).toEqual(['kubernetes']);
    expect(unschedulable.platforms).toEqual(['kubernetes']);
    expect(jobFailed.platforms).toEqual(['kubernetes']);
    for (const f of [
      'docker-container-bad-recreate',
      'docker-container-crash',
      'docker-service-oom',
    ] as const)
      expect(runRules(evidence(f)).map((c) => c.rule)).not.toContain('image_pull');
  });
});

describe('unschedulable', () => {
  it('Pending because it requests more CPU than any node has free', () => {
    const m = unschedulable.match(evidence('kube-workload-unschedulable'))!;
    expect(m.chain.map((s) => [s.code, s.facts])).toEqual([
      ['pending_unscheduled', {}],
      ['scheduling_cpu', { n: 2, nodes: 3, requestCores: 64 }],
    ]);
  });

  it('reads the scheduler’s message, old and new forms', () => {
    const s = schedulingReasons(
      '0/3 nodes are available: 1 node(s) had untolerated taint(s), 2 Insufficient cpu. preemption: 0/3 nodes are available: 3 Preemption is not helpful for scheduling.',
    );
    expect(s.nodes).toBe(3);
    expect(s.reasons).toEqual([
      { reason: 'taint', n: 1, detail: null },
      { reason: 'cpu', n: 2, detail: null },
    ]);
    expect(
      schedulingReasons(
        "0/3 nodes are available: 1 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }, 2 node(s) didn't match Pod's node affinity/selector.",
      ).reasons.map((r) => [r.reason, r.n, r.detail]),
    ).toEqual([
      ['taint', 1, 'node-role.kubernetes.io/control-plane: '],
      ['selector', 2, null],
    ]);
    expect(
      mainReason(schedulingReasons('0/3 nodes are available: 3 Insufficient nvidia.com/gpu.')),
    ).toEqual({ reason: 'resource', n: 3, detail: 'nvidia.com/gpu' });
    expect(
      mainReason(
        schedulingReasons('0/2 nodes are available: 2 node(s) had volume node affinity conflict.'),
      ),
    ).toMatchObject({ reason: 'other' });
  });

  it('a cordoned node is where it starts (node_or_host, slice 4): a partial chain', () => {
    const m = unschedulable.match(
      evidence('kube-workload-unschedulable', (e) => {
        e.events[0]!.message =
          "0/3 nodes are available: 1 node(s) didn't match Pod's node affinity/selector, 1 node(s) had untolerated taint(s), 1 node(s) were unschedulable. preemption: 0/3 nodes are available: 3 Preemption is not helpful for scheduling.";
      }),
    )!;
    expect(m.complete).toBe(false);
    expect(m.chain[1]).toMatchObject({ code: 'scheduling_cordoned', facts: { n: 1, nodes: 3 } });
  });

  it('a scheduled pod, or a FailedScheduling before the window, is no match', () => {
    expect(unschedulable.match(evidence('kube-workload-healthy'))).toBeNull();
    expect(
      unschedulable.match(
        evidence('kube-workload-unschedulable', (e) => {
          e.events[0]!.lastSeen = '2026-11-10T10:00:00.000Z';
        }),
      ),
    ).toBeNull();
  });
});

describe('job_failed', () => {
  it('a CronJob run that reached its backoff limit, and how its pods exited', () => {
    const m = jobFailed.match(evidence('kube-cronjob-failed'))!;
    expect(m.chain.map((s) => [s.code, s.facts])).toEqual([
      ['job_backoff_limit', { job: 'report-e2e-1794332238' }],
      ['job_pod_exit', { exitCode: 2, reason: 'Error', n: 2 }],
    ]);
    expect(m.covers).toEqual(['crash_exit', 'oom_limit']);
  });

  it('a CronJob whose last run succeeded, or a Deployment, is no match', () => {
    expect(
      jobFailed.match(
        evidence('kube-cronjob-failed', (e) => {
          e.workload!.lastRun = { result: 'succeeded', at: e.window.to };
        }),
      ),
    ).toBeNull();
    expect(jobFailed.match(evidence('kube-workload-crash'))).toBeNull();
  });
});

describe('the catalog', () => {
  it('has the six object rules of slice 2, Docker forms where ADR-149 has them', () => {
    expect(RULES.map((r) => [r.code, r.platforms.join('+')])).toEqual([
      ['bad_change', 'kubernetes+docker'],
      ['oom_limit', 'kubernetes+docker'],
      ['crash_exit', 'kubernetes+docker'],
      ['image_pull', 'kubernetes'],
      ['unschedulable', 'kubernetes'],
      ['job_failed', 'kubernetes'],
    ]);
  });
});

describe('counts', () => {
  it('a counter’s increase: rises, resets, and a series born inside the range', () => {
    expect(
      increase([
        [0, 3],
        [15, 4],
        [30, 4],
        [45, 0],
        [60, 2],
        [75, null],
        [90, 3],
      ]),
    ).toEqual({ n: 4, first: 15, last: 90 });
    // A pod created at 100: its first value is in the range.
    expect(
      increase(
        [
          [105, 2],
          [120, 3],
        ],
        100,
      ),
    ).toEqual({ n: 3, first: 105, last: 120 });
    // The first points are an earlier container's of the same name: the baseline.
    expect(
      increase(
        [
          [0, 18],
          [600, 0],
          [615, 1],
        ],
        600,
      ).n,
    ).toBe(1);
  });

  it('the climb to the limit only when two runs or more show it', () => {
    const run = (start: number) =>
      [0, 15, 30, 45].map((s, i) => [start + s, (2 + i * 14) * 2 ** 20] as [number, number]);
    const pts = [...run(0), ...run(60), ...run(120)];
    expect(runsOf(pts, 15)).toHaveLength(3);
    const t = memoryTrend(pts, MiB48, 15)!;
    expect(t.runs).toBe(2);
    expect(t.minutes).toBe(1);
    expect(Math.round(t.perMinute / 2 ** 20)).toBe(56);
    // One run is one data point, not a pattern; flat memory never reaches the limit.
    expect(memoryTrend(run(0).concat([[60, 2 * 2 ** 20]]), MiB48, 15)).toBeNull();
    expect(
      memoryTrend(
        [
          [0, 1e6],
          [15, 1e6],
          [30, 1e6],
        ],
        MiB48,
        15,
      ),
    ).toBeNull();
  });

  it('"about every" needs three restarts', () => {
    expect(interval({ n: 3, first: 0, last: 240 })).toBe(120);
    expect(interval({ n: 2, first: 0, last: 240 })).toBeNull();
    expect(interval(null)).toBeNull();
  });
});
