// SPDX-License-Identifier: AGPL-3.0-only
// The probable-cause engine (ADR-146 to ADR-148): resolve the subject, gather its evidence,
// ask the rules (and, when nothing on the object explains it, the rules at the far end of
// its failing edges, two hops at most), rank, and say what was checked. The answer is what
// GET /causes returns and what MCP and notifications will reuse.
import { checksOf, dnsTotals, shortName } from './checks.js';
import {
  type Reader,
  WINDOW_BEFORE_MS,
  type EdgeHistory,
  type Evidence,
  type Focus,
} from './evidence.js';
import { gather, memoReader, soft } from './gather.js';
import { markChecks, rank } from './rank.js';
import {
  findContainer,
  findWorkload,
  focusObject,
  resolveTarget,
  sourceFocus,
  type ClusterRef,
} from './resolve.js';
import { CALL_RULES, RULES, runRules, type Rule } from './rules.js';
import { linksOf, throughLink, type Link } from './rules/application-finding.js';
import type { Subject } from './subject.js';
import type { Candidate, Cause, Check, FlowsOff, ObjectRef, Sentence, State } from './types.js';
import {
  dependenciesOf,
  edgeHistory,
  MAX_HOPS,
  risenEdge,
  throughEdge,
  type Dependency,
  type EdgeSeries,
} from './walk.js';

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

  const gatherFar = (focus: Focus, via: Evidence['via']) =>
    gather(reader, {
      clusterId: cluster.id,
      platform: cluster.kind,
      focus,
      window,
      symptomAt: target.symptomAt,
      now,
      via,
    });

  /** The subject's dependencies whose p95 rose under the slow bar (its dependency check). */
  const risen: Dependency[] = [];

  /**
   * The object's own causes and, unless one of them explains it on the object itself, those
   * found through what it calls (its failing, slow or quiet edges) and the objects its
   * application's finding names (a consumer, a connection holder): two hops at most.
   */
  const look = async (e: Evidence, hops: number, seen: Set<string>): Promise<Candidate[]> => {
    const own = runRules(e, rules, hops);
    const blocks = own.some((c) => c.complete && !CALL_RULES.includes(c.rule));
    if (hops >= MAX_HOPS || blocks) return own;
    const edges =
      e.map.mode === 'flows' ? dependenciesOf(e).filter((d) => !seen.has(d.target)) : [];
    const links = linksOf(e).filter((l) => !seen.has(l.key));
    const far = await Promise.all([
      ...edges.map(async (d) => {
        const followed: Dependency = {
          ...d,
          history: await history(reader, cluster.id, d, now, target.resolvedAt ? window : null),
        };
        // A p95 under the slow bar is followed only when it rose well above its usual one.
        if (d.risen && !risenEdge(d.edge, followed.history)) return [];
        if (d.risen && hops === 0) risen.push(followed);
        const focus = await sourceFocus(reader, cluster, d.target);
        if (focus.kind === 'none') return [];
        const fe = await gatherFar(focus, {
          edge: d.edge,
          history: followed.history ?? null,
          from: shortName(e),
          caller: callerOf(e),
          dnsErrorsPerSecond: dnsTotals(e).errors,
        });
        const found = await look(fe, hops + 1, new Set([...seen, d.target]));
        return found.map((c) => ({ c, through: throughEdge(e, followed, c) }));
      }),
      ...links.map(async (l) => {
        const focus = await linkFocus(reader, cluster, l);
        if (focus.kind === 'none') return [];
        const fe = await gatherFar(focus, null);
        const found = await look(fe, hops + 1, new Set([...seen, l.key]));
        const c = throughLink(e, l, found, fe);
        return c ? [{ c, through: c }] : [];
      }),
    ]);
    const flat = far.flat();
    // What a cause further on explains better on this object (Candidate.coversCaller).
    const drop = new Set(flat.filter((x) => x.c.complete).flatMap((x) => x.c.coversCaller ?? []));
    return [
      ...own.filter((c) => !drop.has(c.rule)),
      ...flat.map(({ through }) => withoutCovers(through)),
    ];
  };
  const candidates = await look(ev, 0, new Set(ev.map.ids));

  const ranked = rank(candidates, target.symptomAt, window.from);
  const found = checksOf(ev, { risen });
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
    causes: target.resolvedAt ? ranked.causes.map((c) => closedSteps(c, window.to)) : ranked.causes,
    checks,
    flowsOff: found.flowsOff,
  };
}

/**
 * A resolved alert's chain says nothing about later: a state step whose start is after the
 * alert ended (today's object, failing again since) has no start the alert can claim.
 */
export function closedSteps(c: Cause, end: string): Cause {
  const after = (t: string | null) => t !== null && Date.parse(t) > Date.parse(end);
  if (!c.chain.some((s) => after(s.since))) return c;
  return { ...c, chain: c.chain.map((s) => (after(s.since) ? { ...s, since: null } : s)) };
}

/** A candidate as the caller keeps it: what it covered one hop back is done with. */
function withoutCovers(c: Candidate): Candidate {
  const out = { ...c };
  delete out.coversCaller;
  return out;
}

/** The caller's object, for the far end's rules (`via.caller`). */
function callerOf(e: Evidence): { kind: string; ref: string; name: string } {
  const o = focusObject(e.focus, e.platform);
  return o ? { kind: o.kind, ref: o.ref, name: o.name } : { kind: 'none', ref: '', name: '' };
}

/** The longest an edge's history reaches back for a resolved alert (the demo's range cap). */
export const HISTORY_MAX_S = 86_400;

/**
 * A followed edge's last hour (GET /service-map/edge); null when it can't be read. For a
 * resolved alert (`closed`, its window) it reaches back to the window's start and counts only
 * up to its end, so a step's start is the alert's, not that of a later failure.
 */
async function history(
  reader: Reader,
  clusterId: string,
  d: Dependency,
  now: number,
  closed: { from: string; to: string } | null,
): Promise<EdgeHistory | null> {
  const back = closed ? Math.ceil((now - Date.parse(closed.from)) / 60_000) * 60 : 0;
  const range = Math.min(HISTORY_MAX_S, Math.max(3600, back));
  const s = await soft(
    reader.get<EdgeSeries>(`/clusters/${clusterId}/service-map/edge`, {
      source: d.edge.source,
      target: d.edge.target,
      port: d.edge.port ?? undefined,
      range,
    }),
    null,
  );
  const endS = closed ? Math.floor(Date.parse(closed.to) / 1000) : null;
  return s ? edgeHistory(s, Math.floor(now / 1000) - range, endS) : null;
}

/** The focus of an object a finding names: its workload (any kind) or container. */
async function linkFocus(reader: Reader, cluster: ClusterRef, l: Link): Promise<Focus> {
  const t = l.target;
  if (t.kind === 'workload') {
    if (cluster.kind !== 'kubernetes') return { kind: 'none' };
    if (t.workloadKind)
      return {
        kind: 'workload',
        namespace: t.namespace,
        workloadKind: t.workloadKind,
        name: t.name,
      };
    const w = await soft(findWorkload(reader, cluster, t.namespace, t.name, null), null);
    return w
      ? { kind: 'workload', namespace: w.namespace, workloadKind: w.kind, name: w.name }
      : { kind: 'none' };
  }
  if (cluster.kind !== 'docker') return { kind: 'none' };
  const c = await soft(findContainer(reader, cluster, t.name, null), null);
  return c ? { kind: 'container', host: c.host, name: c.name } : { kind: 'none' };
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
