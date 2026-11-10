// SPDX-License-Identifier: AGPL-3.0-only
// The likely cause in other answers (v0.4 slice 5, ADR-148, ADR-155): its short form from
// recorded kind and Docker answers, only when the answer is likely; what a Needs-attention
// problem is asked as; and the list's bounds: one answer per subject, LIST_MAX subjects,
// LIST_WORKERS at a time, the process' slots, the time budget, the shared 15 s cache.
import { describe, expect, it } from 'vitest';
import { explain, type CausesAnswer } from '../src/modules/causes/engine.js';
import type { Reader } from '../src/modules/causes/evidence.js';
import {
  CausesService,
  causeSummary,
  likelyCause,
  problemSubject,
  type ListJob,
} from '../src/modules/causes/likely.js';
import type { ClusterRef } from '../src/modules/causes/resolve.js';
import { parseSubject, type Subject } from '../src/modules/causes/subject.js';
import {
  BEFORE_SLICE_4,
  beforeSlice4,
  recording,
  replay,
  type RecordingName,
} from './support/causes.js';

async function recorded(name: RecordingName): Promise<CausesAnswer> {
  const rec = recording(name);
  const reader = replay(rec, undefined, beforeSlice4(rec) ? BEFORE_SLICE_4 : undefined);
  return explain(reader, rec.cluster, parseSubject(rec.subject), { now: rec.now });
}

describe('likelyCause: the top cause, short', () => {
  it.each<[RecordingName, string, string]>([
    ['kube-dependency-down', 'dependency_down', 'dependency_down_scaled'],
    ['docker-dependency-down', 'dependency_down', 'dependency_down_stopped'],
    ['kube-pg-leak', 'application_finding', 'app_pg_held'],
    ['docker-pg-leak', 'application_finding', 'app_pg_held'],
    ['kube-rabbit-consumer-oom', 'application_finding', 'app_consumer_oom'],
    ['docker-rabbit-consumer-oom', 'application_finding', 'app_consumer_oom'],
    ['kube-node-drain', 'node_or_host', 'node_or_host_held_cordoned'],
    ['docker-host-silent', 'node_or_host', 'node_or_host_silent'],
    ['kube-cpu-throttle', 'cpu_throttled', 'cpu_throttled_dependency'],
    ['docker-cpu-throttle', 'cpu_throttled', 'cpu_throttled_dependency'],
  ])('%s: %s with its headline and the subject to ask GET /causes', async (name, rule, code) => {
    const a = await recorded(name);
    const lc = likelyCause(a);
    const top = a.causes[0]!;
    expect(lc).toEqual({
      rule,
      code: top.code,
      facts: top.facts,
      since: top.since,
      headline: { code, facts: a.headline.facts },
      subject: `${a.subject.kind}:${a.subject.ref}`,
    });
    // The subject is the canonical one: parsing it gives the answer's subject back.
    expect(parseSubject(lc!.subject).kind).toBe(a.subject.kind);
    // Short: no chain, no checks.
    expect(Object.keys(lc!)).not.toContain('chain');
  });

  it('is left out when the causes are only possible, or none is clear', async () => {
    const a = await recorded('kube-dependency-down');
    expect(
      likelyCause({
        ...a,
        state: 'possible',
        causes: a.causes.map((c) => ({ ...c, strength: 'possible' })),
      }),
    ).toBeUndefined();
    expect(likelyCause({ ...a, state: 'none', causes: [] })).toBeUndefined();
  });
});

describe('problemSubject: what a Needs-attention problem is asked as', () => {
  it('an alert by its id, a Kubernetes pod, a Docker container on its host; nodes are no subject', () => {
    expect(problemSubject({ alertId: 'a1', object: null }, 'kubernetes')).toEqual({
      kind: 'alert',
      id: 'a1',
    });
    expect(problemSubject({ alertId: 'a1', object: null }, 'docker')).toEqual({
      kind: 'alert',
      id: 'a1',
    });
    expect(
      problemSubject(
        { alertId: null, object: { kind: 'Pod', namespace: 'shop', name: 'api-1' } },
        'kubernetes',
      ),
    ).toEqual({ kind: 'pod', namespace: 'shop', name: 'api-1' });
    expect(
      problemSubject(
        {
          alertId: null,
          object: { kind: 'Container', namespace: 'docker-01', name: 'shop-api-1' },
        },
        'docker',
      ),
    ).toEqual({ kind: 'container', host: 'docker-01', name: 'shop-api-1' });
    for (const [o, p] of [
      [{ kind: 'Node', namespace: null, name: 'w1' }, 'kubernetes'],
      [{ kind: 'PersistentVolumeClaim', namespace: 'shop', name: 'data' }, 'kubernetes'],
      [{ kind: 'Pod', namespace: 'shop', name: 'x' }, 'docker'],
      [{ kind: 'Container', namespace: 'docker-01', name: 'x' }, 'kubernetes'],
    ] as const) {
      expect(problemSubject({ alertId: null, object: o }, p)).toBeNull();
    }
    expect(problemSubject({ alertId: null, object: null }, 'docker')).toBeNull();
  });
});

const kube: ClusterRef = { id: 'c1', name: 'kind', kind: 'kubernetes' };
const docker: ClusterRef = { id: 'c2', name: 'fleet', kind: 'docker' };
const nobody: Reader = { get: () => Promise.reject(new Error('no reads in this test')) };
const pod = (name: string): ListJob => ({
  cluster: kube,
  subject: { kind: 'pod', namespace: 'shop', name },
});

/** An explain() that answers a recorded answer after `ms`, counting calls and overlap. */
function fakeExplain(answers: Record<string, CausesAnswer | Error>, ms = 5) {
  const seen = { calls: [] as string[], running: 0, most: 0 };
  const fn = async (_r: Reader, _c: ClusterRef, s: Subject) => {
    const key = s.kind === 'pod' ? s.name : s.kind === 'container' ? s.name : s.kind;
    seen.calls.push(key);
    seen.running++;
    seen.most = Math.max(seen.most, seen.running);
    await new Promise((r) => setTimeout(r, ms));
    seen.running--;
    const a = answers[key] ?? answers['*'];
    if (!a || a instanceof Error) throw a ?? new Error('not found');
    return a;
  };
  return { fn: fn as unknown as typeof explain, seen };
}

describe('CausesService.likely: a list stays fast', () => {
  it('explains each subject once, in order, on both platforms', async () => {
    const k = await recorded('kube-dependency-down');
    const d = await recorded('docker-host-silent');
    const { fn, seen } = fakeExplain({ a: k, b: k, 'causes-e2e-pg-1': d });
    const s = new CausesService({ explainFn: fn });
    const out = await s.likely(nobody, 'o1', [
      pod('a'),
      pod('b'),
      pod('a'),
      {
        cluster: docker,
        subject: { kind: 'container', host: 'docker-01', name: 'causes-e2e-pg-1' },
      },
    ]);
    expect(out.map((x) => x?.rule)).toEqual([
      'dependency_down',
      'dependency_down',
      'dependency_down',
      'node_or_host',
    ]);
    expect(seen.calls).toEqual(['a', 'b', 'causes-e2e-pg-1']);
  });

  it('leaves out what is not likely and what fails', async () => {
    const k = await recorded('kube-dependency-down');
    const possible = { ...k, state: 'possible' as const };
    const { fn } = fakeExplain({ a: k, b: possible, c: new Error('gone') });
    const out = await new CausesService({ explainFn: fn }).likely(nobody, 'o1', [
      pod('a'),
      pod('b'),
      pod('c'),
    ]);
    expect(out.map((x) => x?.rule)).toEqual(['dependency_down', undefined, undefined]);
  });

  it('explains at most listMax subjects, workers at a time', async () => {
    const k = await recorded('kube-dependency-down');
    const { fn, seen } = fakeExplain({ '*': k });
    const s = new CausesService({ explainFn: fn, listMax: 5, workers: 2 });
    const jobs = Array.from({ length: 9 }, (_, i) => pod(`p${i}`));
    const out = await s.likely(nobody, 'o1', jobs);
    expect(out.filter(Boolean)).toHaveLength(5);
    expect(out.slice(5)).toEqual([undefined, undefined, undefined, undefined]);
    expect(seen.calls).toHaveLength(5);
    expect(seen.most).toBe(2);
  });

  it('answers within its budget; what was started still fills the cache', async () => {
    const k = await recorded('kube-dependency-down');
    const { fn, seen } = fakeExplain({ '*': k }, 120);
    const s = new CausesService({ explainFn: fn, budgetMs: 40 });
    const t = Date.now();
    const out = await s.likely(nobody, 'o1', [pod('slow')]);
    expect(Date.now() - t).toBeLessThan(110);
    expect(out).toEqual([undefined]);
    await new Promise((r) => setTimeout(r, 150));
    // The next refresh reads the answer from the cache.
    const again = await s.likely(nobody, 'o1', [pod('slow')]);
    expect(again[0]?.rule).toBe('dependency_down');
    expect(seen.calls).toEqual(['slow']);
  });

  it('shares the process slots between lists: a waiting list gives up at its deadline', async () => {
    const k = await recorded('kube-dependency-down');
    const { fn, seen } = fakeExplain({ '*': k }, 80);
    const s = new CausesService({ explainFn: fn, slots: 1, budgetMs: 40 });
    const [first, second] = await Promise.all([
      s.likely(nobody, 'o1', [pod('x')]),
      s.likely(nobody, 'o1', [pod('y')]),
    ]);
    expect(first).toEqual([undefined]);
    expect(second).toEqual([undefined]);
    // Only one ran: the second never got the slot before its deadline.
    expect(seen.calls).toEqual(['x']);
    expect(seen.most).toBe(1);
    // The slot is free again afterwards.
    await new Promise((r) => setTimeout(r, 100));
    const later = new CausesService({ explainFn: fn, slots: 1 });
    expect((await later.likely(nobody, 'o1', [pod('z')]))[0]?.rule).toBe('dependency_down');
    const freed = await s.likely(nobody, 'o1', [pod('x')]);
    expect(freed[0]?.rule).toBe('dependency_down');
  });

  it('shares its cache with GET /causes (answer)', async () => {
    const k = await recorded('kube-dependency-down');
    const { fn, seen } = fakeExplain({ '*': k });
    const s = new CausesService({ explainFn: fn });
    await s.answer(nobody, 'o1', kube, { kind: 'pod', namespace: 'shop', name: 'web' });
    const out = await s.likely(nobody, 'o1', [pod('web')]);
    expect(out[0]?.rule).toBe('dependency_down');
    // Another org's same subject is its own answer.
    await s.likely(nobody, 'o2', [pod('web')]);
    expect(seen.calls).toEqual(['web', 'web']);
  });
});

describe('causeSummary: the Needs-attention line (ADR-156)', () => {
  it('likely: the short form and no possible ones', async () => {
    const a = await recorded('kube-dependency-down');
    const s = causeSummary(a);
    expect(s.state).toBe('likely');
    expect(s.likely).toEqual(likelyCause(a));
    expect(s.possible).toEqual([]);
  });

  it('possible: the first two possible causes, short; none: only the state', async () => {
    const a = await recorded('docker-cpu-throttle');
    const c = a.causes[0]!;
    const possible = {
      ...a,
      state: 'possible' as const,
      causes: [0, 1, 2].map((i) => ({
        ...c,
        code: `${c.code}_${i}`,
        strength: 'possible' as const,
      })),
    };
    const s = causeSummary(possible);
    expect(s.likely).toBeUndefined();
    expect(s.possible).toEqual(
      [0, 1].map((i) => ({
        rule: c.rule,
        code: `${c.code}_${i}`,
        facts: c.facts,
        since: c.since,
      })),
    );
    expect(causeSummary({ ...a, state: 'none', causes: [] })).toEqual({
      state: 'none',
      possible: [],
    });
  });

  it('CausesService.summaries: the same bounds as likely, with the state', async () => {
    const k = await recorded('kube-dependency-down');
    const none = { ...k, state: 'none' as const, causes: [] };
    const { fn } = fakeExplain({ a: k, b: none, c: new Error('gone') });
    const out = await new CausesService({ explainFn: fn }).summaries(nobody, 'o1', [
      pod('a'),
      pod('b'),
      pod('c'),
    ]);
    expect(out.map((x) => x?.state)).toEqual(['likely', 'none', undefined]);
  });
});
