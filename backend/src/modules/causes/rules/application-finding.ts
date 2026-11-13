// SPDX-License-Identifier: AGPL-3.0-only
// application_finding (ADR-150 #8): a monitored application (ADR-137, ADR-145) has an active
// finding, and it explains the problem. Three forms:
//   - the application itself (an application subject): its top finding, followed to the
//     object the finding names when it names one (`linksOf`; the engine gathers that object
//     and `throughLink` puts the finding in front): RabbitMQ's lost consumer leads on to the
//     consumer's own cause ("orders has no consumers → consumer is OOM-killed at its limit"),
//     PostgreSQL's and MySQL's connections near max_connections to the client holding most of
//     them and when it started, MySQL's lock waits to the session holding the lock (ADR-163). Without such an object the finding alone is a partial chain: it says
//     what is wrong, not why (possible at best).
//   - the far end of an edge (`ev.via`): the caller's calls fail or are slow, and the
//     application monitoring what it calls has a finding ("api is slow → PostgreSQL's
//     connections at 98 % of max_connections → 85 held by nightly-export").
// RabbitMQ's "no consumers since" comes from the queue's consumer count over 6 hours, and is
// missing when the queue never had one in that time (slice 0, gap 9): the step then has no
// time, and the cause's time is the consumer's own cause's.
import type { EvApplication, Evidence } from '../evidence.js';
import { focusObject } from '../resolve.js';
import type { Match, Rule } from '../rules.js';
import type { Candidate, Facts, ObjectRef, Step } from '../types.js';
import { earliest, iso } from './common.js';
import { bestOf, tail } from './own.js';

type Finding = EvApplication['reasons'][number];

const SEVERITY: Record<string, number> = { critical: 0, warning: 1 };

/** The application's most severe active finding (critical, then warning); null when none. */
export function topFinding(a: EvApplication | null): Finding | null {
  if (!a || a.reason.code !== 'connected') return null;
  return (
    a.reasons
      .filter((r) => r.severity in SEVERITY && r.code !== 'connected')
      .sort((x, y) => SEVERITY[x.severity]! - SEVERITY[y.severity]!)[0] ?? null
  );
}

/** An object a finding names, for the engine to gather and ask about. */
export interface Link {
  /** The map-like id it is known by (w:…, c:…), so the walk doesn't come back to it. */
  key: string;
  finding: string;
  /** Its name as the finding has it ("shop/consumer", "causes-e2e-leak-1"). */
  name: string;
  target:
    | { kind: 'workload'; namespace: string; name: string; workloadKind: string | null }
    | { kind: 'container'; name: string };
  /** PostgreSQL and MySQL: the connections it holds. */
  n: number | null;
}

/** "causes-e2e/leak (37)" → its name and count. */
const HOLDER = /^(.+) \((\d+)\)$/;
const IP = /^[\d.:a-f]+$/i;

/** The objects the top finding names (the consumer that ended, the top connection holder). */
export function linksOf(ev: Evidence): Link[] {
  const f = topFinding(ev.application);
  if (!f) return [];
  if (f.code === 'queue_no_consumers') {
    const l = (f.links ?? []).find((x) => x.kind === 'workload' || x.kind === 'container');
    if (!l) return [];
    if (l.kind === 'container')
      return [
        {
          key: `c:${l.id}`,
          finding: f.code,
          name: l.name,
          target: { kind: 'container', name: l.id },
          n: null,
        },
      ];
    const [namespace, workloadKind, ...rest] = l.id.split('/');
    if (!namespace || !workloadKind || !rest.length) return [];
    const name = rest.join('/');
    return [
      {
        key: `w:${l.id}`,
        finding: f.code,
        name: l.name,
        target: { kind: 'workload', namespace, name, workloadKind },
        n: null,
      },
    ];
  }
  // MySQL's lock waits name the holder's workload ("ns/name") or container (ADR-163).
  if (f.code === 'lock_waits' && typeof f.facts.holder === 'string' && f.facts.holder) {
    if (ev.platform === 'kubernetes' && !f.facts.holder.includes('/')) return [];
    return [holderLink(ev, f.code, f.facts.holder, null)];
  }
  if (f.code === 'connections_near_max' && typeof f.facts.top === 'string') {
    // The first of "a (36), b (1), c (1)": the client holding most.
    const m = HOLDER.exec(f.facts.top.split(', ')[0]!);
    if (!m || IP.test(m[1]!)) return [];
    const who = m[1]!;
    const n = Number(m[2]);
    if (ev.platform === 'kubernetes') {
      const [namespace, ...rest] = who.split('/');
      if (!namespace || !rest.length) return [];
      return [
        {
          key: `holder:${who}`,
          finding: f.code,
          name: who,
          target: { kind: 'workload', namespace, name: rest.join('/'), workloadKind: null },
          n,
        },
      ];
    }
    return [
      { key: `c:${who}`, finding: f.code, name: who, target: { kind: 'container', name: who }, n },
    ];
  }
  return [];
}

/** A workload ("ns/name", its kind unknown) on Kubernetes, a container on Docker. */
function holderLink(ev: Evidence, finding: string, who: string, n: number | null): Link {
  if (ev.platform === 'kubernetes') {
    const [namespace, ...rest] = who.split('/');
    return {
      key: `holder:${who}`,
      finding,
      name: who,
      target: { kind: 'workload', namespace: namespace!, name: rest.join('/'), workloadKind: null },
      n,
    };
  }
  return { key: `c:${who}`, finding, name: who, target: { kind: 'container', name: who }, n };
}

const appObject = (ev: Evidence, a: EvApplication): ObjectRef => ({
  kind: 'application',
  ref: a.id,
  name: a.name,
  platform: ev.platform,
  type: a.type,
});

const num = (v: unknown) => (typeof v === 'number' ? v : null);

/** The finding as the first step of a chain. */
export function findingStep(ev: Evidence, a: EvApplication, f: Finding, next: Step['next']): Step {
  const base = { object: appObject(ev, a), source: 'application' as const, at: null, next };
  if (f.code === 'queue_no_consumers')
    return {
      ...base,
      code: 'queue_no_consumers',
      facts: {
        queue: f.facts.queue ?? '?',
        ready: num(f.facts.ready),
        perMin: num(f.facts.perMin),
      },
      since: iso(num(f.facts.sinceAt)),
    };
  if (f.code === 'connections_near_max')
    return {
      ...base,
      code: 'pg_connections',
      facts: { pct: num(f.facts.pct), n: num(f.facts.n), max: num(f.facts.max) },
      since: null,
    };
  if (f.code === 'lock_waits' && typeof f.facts.holder === 'string')
    return {
      ...base,
      code: 'lock_waits',
      facts: {
        n: num(f.facts.n),
        table: typeof f.facts.table === 'string' ? f.facts.table : null,
        duration: typeof f.facts.duration === 'string' ? f.facts.duration : null,
      },
      since: iso(num(f.facts.sinceAt)),
    };
  return {
    ...base,
    code: 'app_finding',
    facts: { ...f.facts, finding: f.code, type: a.type },
    since: null,
  };
}

/** When the object started: its pods' or containers' earliest start. */
function started(ev: Evidence): string | null {
  return ev.platform === 'kubernetes'
    ? earliest(...ev.pods.map((p) => p.startedAt ?? p.createdAt))
    : earliest(...ev.containers.filter((c) => c.state === 'running').map((c) => c.startedAt));
}

/**
 * The finding's cause through the object it names: the finding in front, then the
 * consumer's own cause (or how it ended) or the connection holder; null when the object
 * isn't there to say so.
 */
export function throughLink(
  ev: Evidence,
  link: Link,
  found: Candidate[],
  far: Evidence,
): Candidate | null {
  const a = ev.application;
  const f = topFinding(a);
  if (!a || !f) return null;
  const object = focusObject(far.focus, far.platform);
  if (!object) return null;
  const hops = Math.max(0, ...found.map((c) => c.hops)) + 1;
  const base = {
    rule: 'application_finding',
    code: 'application_finding',
    hops,
    complete: true,
    explains: ['application' as const],
    coversCaller: ['application_finding'],
  };
  if (f.code === 'queue_no_consumers') {
    const own = bestOf(found, far);
    const queue = String(f.facts.queue ?? '?');
    const how = String(f.facts.how ?? (far.gone ? 'gone' : 'stopped'));
    const first = findingStep(ev, a, f, 'consumed_by');
    const ended: Step = {
      object,
      source: 'application',
      code: 'consumer_ended',
      facts: { how },
      at: null,
      since: null,
      next: null,
    };
    const facts: Facts = { name: a.name, finding: f.code, queue, consumer: link.name, how };
    const of = own?.facts ?? {};
    return {
      ...base,
      facts,
      since: own?.since ?? first.since,
      chain: own ? [first, ...tail(own.chain, 2)] : [first, ended],
      headline:
        own?.rule === 'oom_limit' && typeof of.limitBytes === 'number'
          ? {
              code: 'app_consumer_oom',
              facts: { queue, consumer: link.name, limitBytes: of.limitBytes },
            }
          : own?.rule === 'crash_exit' && typeof of.exitCode === 'number'
            ? {
                code: 'app_consumer_crash',
                facts: { queue, consumer: link.name, exitCode: of.exitCode },
              }
            : own?.rule === 'bad_change'
              ? { code: 'app_consumer_change', facts: { queue, consumer: link.name } }
              : { code: 'app_consumer_ended', facts: { queue, consumer: link.name, how } },
    };
  }
  if (f.code === 'lock_waits') {
    if (far.gone) return null;
    const first = findingStep(ev, a, f, 'because');
    const table = typeof f.facts.table === 'string' && f.facts.table ? f.facts.table : null;
    const held = typeof f.facts.held === 'string' ? f.facts.held : null;
    return {
      ...base,
      facts: { name: a.name, finding: f.code, holder: link.name, table, held },
      since: first.since,
      chain: [
        first,
        {
          object,
          source: 'application',
          code: 'holds_lock',
          facts: { held, table },
          at: null,
          since: first.since,
          next: null,
        },
      ],
      headline: {
        code: table ? 'app_lock_held' : 'app_lock_held_any',
        facts: { name: a.name, holder: link.name, table, held },
      },
    };
  }
  if (f.code === 'connections_near_max') {
    if (far.gone) return null;
    const since = started(far);
    const n = link.n;
    const pct = num(f.facts.pct);
    return {
      ...base,
      facts: { name: a.name, finding: f.code, holder: link.name, n, pct },
      since,
      chain: [
        findingStep(ev, a, f, 'because'),
        {
          object,
          source: 'application',
          code: 'holds_connections',
          facts: { n },
          at: null,
          since,
          next: null,
        },
      ],
      headline: { code: 'app_pg_held', facts: { name: a.name, pct, holder: link.name, n } },
    };
  }
  return null;
}

export const applicationFinding: Rule = {
  code: 'application_finding',
  platforms: ['kubernetes', 'docker'],
  applies: (f) => ['application', 'workload', 'container', 'compose_service'].includes(f.kind),
  match(ev: Evidence): Match | null {
    const a = ev.application;
    const f = topFinding(a);
    if (!a || !f) return null;
    const via = ev.focus.kind === 'application' ? null : ev.via;
    // An object's own application counts only at the far end of a failing edge.
    if (ev.focus.kind !== 'application' && !via) return null;
    const step = findingStep(ev, a, f, null);
    const facts: Facts = { name: a.name, finding: f.code };
    if (!via)
      return {
        code: 'application_finding',
        facts,
        since: step.since,
        chain: [step],
        // The finding says what is wrong, not why: partial until a link explains it.
        complete: false,
        headline: {
          code: 'app_finding',
          facts: { ...f.facts, name: a.name, finding: f.code, type: a.type },
        },
      };
    return {
      code: 'application_finding',
      facts: { ...facts, caller: via.from },
      since: step.since ?? via.history?.troubleSince ?? via.history?.slowSince ?? null,
      chain: [step],
      complete: true,
      headline: {
        code: 'app_finding_caller',
        facts: { ...f.facts, name: via.from, app: a.name, finding: f.code, type: a.type },
      },
    };
  },
  explains: ['application'],
};
