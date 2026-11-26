// SPDX-License-Identifier: AGPL-3.0-only
// Alerts on a user's own metrics (1.0.0, ADR-236): ordinary alert rules (type `own`), read by
// the same engine as every other rule, so they are grouped, held, silenced and sent the same
// way and show on the workload or server the metric belongs to. Five conditions:
//
//   above, below   the metric as it is shown, per owner, against a value
//   absent         no series of an owner reported for a while ("not reported for")
//   older          a timestamp is older than a while ("the last backup is 27 h old")
//   unusual        Pro: outside its usual range for this hour, for a watched metric (ADR-238)
//
// A rule names the metric; the expression is built here from expr.ts. Nobody writes a query.
import { authorisedScope } from '../../lib/victoria.js';
import type { OwnMetricLimits } from '../entitlements/own-metrics.js';
import type { EvalContext, RuleEvaluator } from '../alerts/engine.js';
import type { Observation } from '../alerts/state-machine.js';
import { ageExpr, exprFor, lagExpr } from './expr.js';
import type { OwnUnit, Shown } from './naming.js';
import { exprMetric, listMetrics, type MetricInfo } from './read.js';
import type { OwnUsual } from './usual.js';
import { durationWords, statUnit, writtenText, type Per } from './words.js';

export const OWN_RULE_TYPE = 'own';
export const OWN_IS = ['above', 'below', 'unusual', 'absent', 'older'] as const;
export type OwnIs = (typeof OWN_IS)[number];

/** What a rule is about, kept in `alert_rules.scope.own`. */
export interface OwnSpec {
  metric: string;
  is: OwnIs;
  /** How a rate's value is written (the unit the user typed it in). */
  per?: Per;
}

export const ownSpecOf = (scope: unknown): OwnSpec | null => {
  const s = (scope as { own?: Partial<OwnSpec> } | null)?.own;
  return s && typeof s.metric === 'string' && (OWN_IS as readonly string[]).includes(s.is ?? '')
    ? (s as OwnSpec)
    : null;
};

export interface OwnAlertDeps {
  /** The org's limits now: Free has no alerts, the usual range is Pro's. */
  limits: (orgId: string) => Promise<OwnMetricLimits>;
  usual: OwnUsual;
}
let deps: OwnAlertDeps | null = null;
/** Set once by the server and by the alert worker. */
export function configureOwnAlerts(d: OwnAlertDeps): void {
  deps = d;
}

// ------------------------------------------------------------------------------- words

export interface SentenceInput {
  words: string;
  /** "shop/worker", "db-1"; null when the metric is tied to nothing. */
  owner: string | null;
  is: OwnIs;
  /** The value now (for absent and older: seconds). */
  value: number | null;
  /** The value compared with (for absent and older: seconds). */
  threshold: number | null;
  forSeconds: number;
  showing: { unit: OwnUnit; shown: Shown };
  per?: Per;
  low?: number | null;
  high?: number | null;
}

const forWords = (s: number) => (s > 0 ? ` for ${durationWords(s)}` : '');

/** The condition alone: "above 500 for 15 min", "older than 26 h". */
export function conditionWords(p: Omit<SentenceInput, 'words' | 'owner' | 'value'>): string {
  const t = (v: number | null | undefined) => writtenText(v, p.showing, p.per);
  switch (p.is) {
    case 'above':
      return `above ${t(p.threshold)}${forWords(p.forSeconds)}`;
    case 'below':
      return `below ${t(p.threshold)}${forWords(p.forSeconds)}`;
    case 'absent':
      return `not reported for ${durationWords(p.threshold ?? 0)}`;
    case 'older':
      return `older than ${durationWords(p.threshold ?? 0)}`;
    default:
      return p.low !== null && p.low !== undefined && p.high !== null && p.high !== undefined
        ? `outside its usual ${t(p.low)} – ${t(p.high)} for this hour${forWords(p.forSeconds)}`
        : `outside its usual range${forWords(p.forSeconds)}`;
  }
}

/** An alert's title and why, and both as one sentence (the preview's "It will say"). */
export function ownSentence(p: SentenceInput): { title: string; why: string; full: string } {
  const on = p.owner ? ` on ${p.owner}` : '';
  const why = conditionWords(p);
  let title: string;
  if (p.is === 'absent') {
    title =
      p.value === null
        ? `${p.words}${on} has not reported`
        : `${p.words}${on} has not reported for ${durationWords(p.value)}`;
    return { title, why: `alerts after ${durationWords(p.threshold ?? 0)}`, full: `${title}.` };
  }
  if (p.is === 'older') {
    title = `${p.words}${on} is ${p.value === null ? 'old' : `${durationWords(p.value)} old`}`;
  } else {
    title = `${p.words}${on} is ${writtenText(p.value, p.showing, p.per)}`;
  }
  return { title, why, full: `${title}, ${why}.` };
}

/** "shop/worker" or "db-1" from a series' owner labels; the alert's own labels with it. */
export function ownerFromLabels(l: Record<string, string>): {
  owner: string | null;
  labels: Record<string, string>;
} {
  if (l.wl_workload) {
    return {
      owner: `${l.wl_ns}/${l.wl_workload}`,
      labels: {
        namespace: l.wl_ns ?? '',
        workload_kind: l.wl_wkind ?? '',
        workload: l.wl_workload,
      },
    };
  }
  if (l.wl_server) return { owner: l.wl_server, labels: { node: l.wl_server } };
  return { owner: null, labels: {} };
}

// ------------------------------------------------------------------------------- evaluation

export interface OwnHit {
  owner: string | null;
  labels: Record<string, string>;
  value: number;
  low?: number;
  high?: number;
}

/** The expression a rule reads, without its comparison: one line per owner. */
export function ruleExpr(m: MetricInfo, is: OwnIs): string {
  const em = exprMetric(m);
  if (is === 'absent') return lagExpr(em);
  if (is === 'older') return ageExpr(em);
  return exprFor(em, is === 'unusual' ? {} : { perOwner: true });
}

/**
 * What a rule sees now. With `all`, every owner's value (a preview); without, only the ones
 * the condition holds for.
 */
export async function ownHits(
  ctx: Pick<EvalContext, 'victoria' | 'cluster' | 'now'>,
  m: MetricInfo,
  spec: OwnSpec,
  threshold: number | null,
  usual: OwnUsual | null,
  all = false,
): Promise<OwnHit[]> {
  if (!ctx.victoria) throw new Error('VictoriaMetrics is not configured');
  // The org's own cluster, read under withOrg by the engine (ADR-174).
  const scope = authorisedScope(ctx.cluster.id);
  const expr = ruleExpr(m, spec.is);
  const at = ctx.now / 1000;
  if (spec.is === 'unusual') {
    if (!usual) return [];
    const em = exprMetric(m);
    const [rows, band] = await Promise.all([
      ctx.victoria.query(scope, expr, at),
      usual.now(scope, ctx.cluster.id, exprFor(em, { step: 300 }), ctx.now, statUnit(m)),
    ]);
    const value = rows[0]?.points[0]?.[1];
    if (value === null || value === undefined) return [];
    // Until the metric has a week behind it, it is learning: nothing is "unusual" yet.
    if (!band || band.learning) return all ? [{ ...oneOwner(m), value }] : [];
    if (!all && value >= band.low && value <= band.high) return [];
    return [{ ...oneOwner(m), value, low: band.low, high: band.high }];
  }
  const op = spec.is === 'below' ? '<' : '>';
  const query = all || threshold === null ? expr : `(${expr}) ${op} ${Number(threshold)}`;
  const rows = await ctx.victoria.query(scope, query, at);
  const out: OwnHit[] = [];
  for (const r of rows) {
    const value = r.points[0]?.[1];
    if (value === null || value === undefined) continue;
    out.push({ ...ownerFromLabels(r.labels), value });
  }
  return out;
}

/** A metric read as a whole belongs to its owner when it has exactly one. */
function oneOwner(m: MetricInfo): { owner: string | null; labels: Record<string, string> } {
  const o = m.ownerCount === 1 && !m.untied ? m.owners[0] : undefined;
  if (o?.kind === 'workload')
    return ownerFromLabels({ wl_ns: o.namespace, wl_wkind: o.workloadKind, wl_workload: o.name });
  if (o?.kind === 'server') return ownerFromLabels({ wl_server: o.name });
  return { owner: null, labels: {} };
}

export const ownEvaluator: RuleEvaluator = {
  kinds: ['kubernetes', 'server'],
  async evaluate(ctx: EvalContext): Promise<Observation[]> {
    const spec = ownSpecOf(ctx.rule.scope);
    if (!spec || !deps) return [];
    const limits = await deps.limits(ctx.rule.org_id);
    // After a downgrade the rule stays and rests: Free has no alerts on own metrics, and the
    // usual range is Pro's.
    if (limits.alerts === 'none') return [];
    if (spec.is === 'unusual' && !limits.usualRange) return [];
    const metrics = await ctx.memo(`own-metrics:${ctx.cluster.id}`, () =>
      listMetrics(ctx.db, ctx.cluster.id),
    );
    const m = metrics.find((x) => x.name === spec.metric);
    if (!m) return [];
    if (spec.is === 'unusual' && !m.watched) return [];
    const threshold = (ctx.rule.condition as { value?: number }).value ?? null;
    const hits = await ownHits(ctx, m, spec, threshold, deps.usual);
    return hits.map((h) => {
      const s = ownSentence({
        words: m.words,
        owner: h.owner,
        is: spec.is,
        value: h.value,
        threshold,
        forSeconds: ctx.rule.for_seconds,
        showing: m,
        per: spec.per,
        low: h.low,
        high: h.high,
      });
      return {
        fingerprint: `own:${m.name}:${h.owner ?? ''}`,
        severity: ctx.rule.severity as 'warning' | 'critical',
        labels: { ...h.labels, own_metric: m.name },
        details: {
          own: true,
          title: s.title,
          why: `${s.why} · ${m.name}`,
          summary: s.full,
          is: spec.is,
          metric: m.name,
          value: h.value,
          threshold,
          unit: m.unit,
          forSeconds: ctx.rule.for_seconds,
          ...(h.low !== undefined ? { usualLow: h.low, usualHigh: h.high } : {}),
        },
      };
    });
  },
};
