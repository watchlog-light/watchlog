// SPDX-License-Identifier: AGPL-3.0-only
// Probable cause (ADR-146 to ADR-148): the panel's sentences as i18n keys and values, and
// where each object of a chain or a check links to. Codes come from GET /causes; every
// sentence lives in en.json under `causes.` (ADR-147; the headlines come from
// @watchlog/cause-words, which the notifications render too, ADR-157), and
// web/test/cause-templates.test.ts renders each with its placeholders filled.
import type {
  Cause,
  CauseCheck,
  CauseObject,
  Causes,
  CauseStep,
  OverviewProblem,
  PossibleCause,
} from '@watchlog/api-types';
import type { RouteLocationRaw } from 'vue-router';
import { reasonLine, serviceName } from './applications';
import { causeValues } from '@watchlog/cause-words';

export interface Line {
  key: string;
  values: Record<string, unknown>;
  /** The count that picks the sentence's form ("1 restart | {n} restarts"): `t(key, values, plural)`. */
  plural?: number;
  /**
   * The object a step's sentence is about, for a line that stands alone (a possible cause on
   * Needs attention): named in front when the sentence doesn't name it, without the full stop.
   */
  about?: string;
}

/** Facts as the sentences show them: durations, bytes and cores (shared with the backend). */
const values = (facts: Record<string, string | number | null>) => causeValues(facts);

const line = (key: string, facts: Record<string, string | number | null>): Line => ({
  key,
  values: values(facts),
  ...(typeof facts.n === 'number' ? { plural: facts.n } : {}),
});

/**
 * An application's finding (application_finding's `app_finding` step and headline): the
 * finding's own sentence from "What WatchLog sees" (finding-templates.test.ts), with
 * `facts.finding` as its code.
 */
function findingLine(facts: Record<string, string | number | null>): Line {
  const { finding, ...rest } = facts;
  const r = reasonLine(
    { severity: 'warning', code: String(finding), facts: rest },
    { id: '', name: '', kind: 'kubernetes' },
    (iso) => iso,
  );
  return { key: r.key, values: r.values };
}

/** The panel's first sentence. */
export function headlineLine(a: Pick<Causes, 'headline'>): Line {
  if (a.headline.code === 'app_finding') return findingLine(a.headline.facts);
  return line(`causes.headline.${a.headline.code}`, a.headline.facts);
}

/** A cause in one line (the rules' own codes). */
export function causeLine(c: Pick<Cause, 'code' | 'facts'>): Line {
  return line(`causes.cause.${c.code}`, c.facts);
}

/** A step's fact. */
export function stepLine(s: Pick<CauseStep, 'code' | 'facts'>): Line {
  if (s.code === 'app_finding') return findingLine(s.facts);
  return line(`causes.step.${s.code}`, s.facts);
}

const WHAT: Record<string, string> = { self_no_object: 'alert', node_none: 'node_none' };

/** A line of "What we checked": what was looked at, and what was found. */
export function checkLine(c: Pick<CauseCheck, 'topic' | 'code' | 'facts'>): {
  what: Line;
  result: Line;
} {
  const v = values(c.facts);
  // A few codes are about something else than their topic's usual object.
  const what = WHAT[c.code] ?? c.topic;
  return {
    what: { key: `causes.check.what.${what}`, values: v },
    result: { key: `causes.check.result.${c.code}`, values: v },
  };
}

/** The hop word between two steps, or null on the last. */
export const connectorKey = (s: Pick<CauseStep, 'next'>) =>
  s.next ? `causes.connector.${s.next}` : null;

/** The source chip of a step. */
export const sourceKey = (s: Pick<CauseStep, 'source'>) => `causes.source.${s.source}`;

/** Where an object of a chain or a check is shown. */
export function objectLink(o: CauseObject, clusterId: string): RouteLocationRaw | undefined {
  const parts = o.ref.split('/');
  const cluster = { cluster: clusterId };
  switch (o.kind) {
    case 'pod':
      return { name: 'pod', params: { namespace: parts[0], name: parts[1] }, query: cluster };
    case 'workload':
      return {
        name: 'workloads',
        query: { ...cluster, view: 'pods', wns: parts[0], wkind: parts[1], wname: parts[2] },
      };
    case 'container':
      return {
        name: 'docker-container',
        params: { host: parts[0], name: parts[1] },
        query: cluster,
      };
    case 'compose_service':
      return { name: 'containers', query: { ...cluster, project: parts[0], service: parts[1] } };
    case 'node':
      return { name: 'node', params: { name: o.ref }, query: cluster };
    case 'host':
      return { name: 'docker-host', params: { host: o.ref }, query: cluster };
    case 'edge':
      return { name: 'service-map', query: { ...cluster, edge: o.ref } };
    case 'application':
      return { name: 'application', params: { id: o.ref } };
    case 'alert':
      return { name: 'alert', params: { id: o.ref } };
    case 'change':
      // Kind/namespace/name, Node/name; Container/host/name, Compose/host/project.
      if (parts[0] === 'Node') return { name: 'node', params: { name: parts[1] }, query: cluster };
      if (parts[0] === 'Container' && parts.length === 3)
        return {
          name: 'docker-container',
          params: { host: parts[1], name: parts[2] },
          query: cluster,
        };
      if (parts[0] === 'Compose' && parts.length === 3)
        return { name: 'containers', query: { ...cluster, project: parts[2] } };
      if (parts.length === 3)
        return {
          name: 'workloads',
          query: { ...cluster, view: 'pods', wkind: parts[0], wns: parts[1], wname: parts[2] },
        };
      return undefined;
    default:
      return undefined;
  }
}

// ---- The panel (v0.4 slice 6, ADR-148, ADR-156) ----

/** How sure the answer is, as the chip says: a resolved alert's likely cause "was likely". */
export type PanelState = 'likely' | 'possible' | 'none' | 'was';

export function panelState(a: Pick<Causes, 'state' | 'resolvedAt'>): PanelState {
  if (a.state === 'likely' && a.resolvedAt) return 'was';
  return a.state;
}

/** The likely cause, whose chain the panel draws; null when there is none. */
export const likelyOf = (a: Pick<Causes, 'causes'>) =>
  a.causes.find((c) => c.strength === 'likely') ?? null;

/** The other causes ("Also possible"), or all of them when none is likely. */
export const possibleOf = (a: Pick<Causes, 'causes'>) =>
  a.causes.filter((c) => c.strength === 'possible');

/** A step's or a cause's time: a moment ("at 10:00:12") or a state ("since 10:01"). */
export function stepTime(
  s: Pick<CauseStep, 'at' | 'since'>,
  format: (iso: string) => string,
): Line | null {
  if (s.at) return { key: 'causes.panel.at', values: { time: format(s.at) } };
  if (s.since) return { key: 'causes.panel.since', values: { time: format(s.since) } };
  return null;
}

/** What an object is, next to its name: "Deployment", "Pod", "Compose service on docker-01". */
export function objectKind(o: CauseObject): Line {
  if (o.kind === 'workload' && o.workloadKind) return { key: '', values: { text: o.workloadKind } };
  if (o.kind === 'compose_service' && o.host)
    return { key: 'causes.object.compose_service_on', values: { host: o.host } };
  if (o.kind === 'application' && o.type) return { key: '', values: { text: serviceName(o.type) } };
  return { key: `causes.object.${o.kind}`, values: {} };
}

/** "Open workload", "Open in service map": the link under a step. */
export const openKey = (o: Pick<CauseObject, 'kind'>) => `causes.panel.open.${o.kind}`;

/** The parts of "What we checked · 7 checks, 1 explains it". */
export function checksSummary(checks: Pick<CauseCheck, 'result'>[], resolved = false): Line[] {
  const n = (r: CauseCheck['result']) => checks.filter((c) => c.result === r).length;
  // Counted as the headline counts them ("We checked 5 things"): what applies.
  const total = checks.length - n('not_applicable');
  const out: Line[] = [{ key: 'causes.panel.checksSummary', values: { n: total }, plural: total }];
  const explains = n('explains');
  const possible = n('possible');
  const notRun = n('not_run');
  if (explains)
    out.push({
      key: resolved ? 'causes.panel.summary.explained' : 'causes.panel.summary.explains',
      values: { n: explains },
      plural: explains,
    });
  if (possible) out.push({ key: 'causes.panel.summary.possible', values: { n: possible } });
  if (notRun) out.push({ key: 'causes.panel.summary.notRun', values: { n: notRun } });
  if (!explains && !possible) out.push({ key: 'causes.panel.summary.none', values: {} });
  return out;
}

/** The MCP tool that gives the same answer (ADR-148): explain_alert for an alert. */
export const mcpTool = (subject: string) =>
  subject.startsWith('alert:') ? 'explain_alert' : 'explain_problem';

type Translate = (key: string, values?: Record<string, unknown>, plural?: number) => string;

/** A Line in words; a Line with no key is its `text` as is (a Kubernetes kind, a product). */
export function say(t: Translate, l: Line): string {
  if (!l.key) return String(l.values.text ?? '');
  const text = l.plural === undefined ? t(l.key, l.values) : t(l.key, l.values, l.plural);
  if (l.about === undefined) return text;
  const fact = text.replace(/\.$/, '');
  return fact.includes(l.about) ? fact : t('causes.line.where', { name: l.about, fact });
}

/**
 * "Copy as text": the headline and the chain in plain words, for an AI chat or a ticket.
 * The possible causes follow when none is likely.
 */
export function causesText(a: Causes, t: Translate, format: (iso: string) => string): string {
  const state = panelState(a);
  const lines = [
    t('causes.text.header', {
      state: t(`causes.panel.title.${state}`),
      headline: say(t, headlineLine(a)),
    }),
  ];
  const top = likelyOf(a);
  if (top) {
    top.chain.forEach((s, i) => {
      const time = stepTime(s, format);
      let line = t('causes.text.step', {
        n: i + 1,
        name: s.object.name,
        kind: say(t, objectKind(s.object)),
        source: t(sourceKey(s)),
        fact: say(t, stepLine(s)),
      });
      if (time) line += t('causes.text.time', { time: say(t, time) });
      if (i === top.chain.length - 1) line += t('causes.text.root');
      lines.push(line);
      const hop = connectorKey(s);
      if (hop && i < top.chain.length - 1) lines.push(`   ↓ ${t(hop)}`);
    });
  }
  for (const c of possibleOf(a)) {
    const where = c.chain[c.chain.length - 1]?.object;
    lines.push(
      t('causes.text.possible', {
        name: where?.name ?? a.subject.name,
        cause: say(t, causeLine(c)),
      }),
    );
  }
  if (a.resolvedAt) lines.push(t('causes.panel.resolved', { time: format(a.resolvedAt) }));
  lines.push(t('causes.text.footer'));
  return lines.join('\n');
}

/**
 * Lines on an alert's chart where the cause's moments are (a change, a kill): the chain's
 * steps that have a time `at`, in seconds, with the step's sentence.
 */
export function causeMarkers(
  a: Causes,
  t: Translate,
  format: (iso: string) => string,
): { ts: number; label: string; colorToken: string }[] {
  const top = likelyOf(a) ?? possibleOf(a)[0];
  if (!top) return [];
  return top.chain
    .filter((s): s is CauseStep & { at: string } => !!s.at)
    .map((s) => ({
      ts: Math.floor(Date.parse(s.at) / 1000),
      label: t('causes.panel.marker', {
        what: say(t, stepLine(s)).replace(/\.$/, ''),
        at: format(s.at),
      }),
      colorToken: '--info',
    }));
}

/**
 * A possible cause in a line that stands alone: where it starts, by its step's sentence and
 * the object it is about ("hot is throttled 98% of the time at its 20m CPU limit"); the
 * rule's one-line cause when the answer has no step.
 */
export function possibleLine(c: PossibleCause): Line {
  if (!c.where) return causeLine(c);
  return { ...stepLine(c.where), about: c.where.name };
}

/**
 * A Needs-attention problem's line (ADR-156): the chip's state and the sentence. "No clear
 * cause" is the chip alone: the panel says what was checked (ADR-159).
 */
export function problemCause(p: OverviewProblem): { state: PanelState; line: Line[] } | null {
  if (p.likelyCause) return { state: 'likely', line: [headlineLine(p.likelyCause)] };
  if (p.causeState === 'possible' && p.possibleCauses?.length)
    return { state: 'possible', line: p.possibleCauses.map(possibleLine) };
  if (p.causeState === 'none') return { state: 'none', line: [] };
  return null;
}
