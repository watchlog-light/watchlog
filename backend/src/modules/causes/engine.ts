// SPDX-License-Identifier: AGPL-3.0-only
// The probable-cause engine (ADR-146 to ADR-148): resolve the subject, gather its evidence,
// ask the rules (and, when nothing on the object explains it, the rules at the far end of
// its failing edges, two hops at most), rank, and say what was checked. The answer is what
// GET /causes returns and what MCP and notifications will reuse.
import { checksOf, shortName } from './checks.js';
import { type Reader, WINDOW_BEFORE_MS, type Evidence, type Focus } from './evidence.js';
import { gather, memoReader } from './gather.js';
import { markChecks, rank } from './rank.js';
import { resolveTarget, sourceFocus, type ClusterRef } from './resolve.js';
import { RULES, runRules, type Rule } from './rules.js';
import type { Subject } from './subject.js';
import type { Candidate, Cause, Check, FlowsOff, ObjectRef, Sentence, State } from './types.js';
import { dependenciesOf, MAX_HOPS, throughEdge } from './walk.js';

export interface CausesAnswer {
  /** The subject as asked, canonical: `ref` is the form /causes takes back. */
  subject: ObjectRef;
  /** What an alert or edge is about (the subject itself for an object); null for none. */
  object: ObjectRef | null;
  cluster: ClusterRef;
  state: State;
  checkedAt: string;
  /** When the symptom began: the alert's start, or the object's problem in Needs attention. */
  symptomSince: string | null;
  /** A resolved alert: when it resolved (the panel's "Was likely"). */
  resolvedAt: string | null;
  /** What was looked at: from 60 minutes before the symptom to its end, or now. */
  window: { from: string; to: string };
  headline: Sentence;
  causes: Cause[];
  checks: Check[];
  flowsOff: FlowsOff[] | null;
}

export interface EngineOptions {
  rules?: Rule[];
  now?: number;
}

/** Explains one subject of one cluster, reading as the caller. */
export async function explain(
  api: Reader,
  cluster: ClusterRef,
  subject: Subject,
  opts: EngineOptions = {},
): Promise<CausesAnswer> {
  const reader = memoReader(api);
  const now = opts.now ?? Date.now();
  const rules = opts.rules ?? RULES;
  const target = await resolveTarget(reader, cluster, subject);
  const end = target.resolvedAt ? Date.parse(target.resolvedAt) : now;
  const anchor = target.symptomAt ? Math.min(Date.parse(target.symptomAt), end) : end;
  const window = {
    from: new Date(anchor - WINDOW_BEFORE_MS).toISOString(),
    to: new Date(Math.max(end, anchor)).toISOString(),
  };
  const ev = await gather(reader, {
    clusterId: cluster.id,
    platform: cluster.kind,
    focus: target.focus,
    window,
    symptomAt: target.symptomAt,
    alert: target.alert,
    edge: target.edge,
    now,
  });

  const look = async (e: Evidence, hops: number, seen: Set<string>): Promise<Candidate[]> => {
    const own = runRules(e, rules, hops);
    if (hops >= MAX_HOPS || own.some((c) => c.complete) || e.map.mode !== 'flows') return own;
    const far = await Promise.all(
      dependenciesOf(e)
        .filter((d) => !seen.has(d.target))
        .map(async (d) => {
          const focus: Focus = await sourceFocus(reader, cluster, d.target);
          if (focus.kind === 'none') return [];
          const fe = await gather(reader, {
            clusterId: cluster.id,
            platform: cluster.kind,
            focus,
            window,
            symptomAt: target.symptomAt,
            now,
          });
          const found = await look(fe, hops + 1, new Set([...seen, d.target]));
          return found.map((c) => throughEdge(e, d, c));
        }),
    );
    return [...own, ...far.flat()];
  };
  const candidates = await look(ev, 0, new Set(ev.map.ids));

  const ranked = rank(candidates, target.symptomAt, window.from);
  const found = checksOf(ev);
  const checks = markChecks(found.checks, ranked);
  const object =
    target.object?.kind === 'application' && ev.application
      ? { ...target.object, name: ev.application.name, type: ev.application.type }
      : target.object;
  return {
    subject: target.self,
    object,
    cluster,
    state: ranked.state,
    checkedAt: new Date(now).toISOString(),
    symptomSince: target.symptomAt,
    resolvedAt: target.resolvedAt,
    window,
    headline: headline(
      ranked.state,
      ranked.kept[0]?.candidate,
      ranked.causes.length,
      ev,
      checks,
      found.flowsOff,
    ),
    causes: ranked.causes,
    checks,
    flowsOff: found.flowsOff,
  };
}

/** The panel's first sentence (causes.headline.<code>). */
export function headline(
  state: State,
  top: Candidate | undefined,
  n: number,
  ev: Evidence,
  checks: Check[],
  flowsOff: FlowsOff[] | null,
): Sentence {
  const name = shortName(ev);
  if (state === 'likely' && top) return top.headline;
  if (state === 'possible') return { code: 'possible', facts: { name, n } };
  const ran = checks.filter((c) => c.result !== 'not_run' && c.result !== 'not_applicable');
  const notRun = checks.some((c) => c.topic === 'dependencies' && c.result === 'not_run');
  if (flowsOff && notRun) return { code: 'none_flows_off', facts: { name } };
  const abnormal = checks.filter((c) => c.result === 'possible').length;
  if (abnormal) return { code: 'none_found', facts: { name, n: ran.length, found: abnormal } };
  const minutes = Math.round(
    (Date.parse(ev.symptomAt ?? ev.window.to) - Date.parse(ev.window.from)) / 60_000,
  );
  return { code: 'none_no_changes', facts: { name, n: ran.length, minutes } };
}
