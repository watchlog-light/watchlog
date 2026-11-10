// SPDX-License-Identifier: AGPL-3.0-only
// Probable cause (ADR-146 to ADR-148): the panel's sentences as i18n keys and values, and
// where each object of a chain or a check links to. Codes come from GET /causes; every
// sentence lives in en.json under `causes.` (ADR-147), and web/test/cause-templates.test.ts
// renders each with its placeholders filled.
import type { Cause, CauseCheck, CauseObject, Causes, CauseStep } from '@watchlog/api-types';
import type { RouteLocationRaw } from 'vue-router';
import { formatBytes, formatValue } from './units';

export interface Line {
  key: string;
  values: Record<string, unknown>;
  /** The count that picks the sentence's form ("1 restart | {n} restarts"): `t(key, values, plural)`. */
  plural?: number;
}

/** Cores as a request reads: "64", "1.5", "500m". */
const cores = (v: number) => (v >= 1 ? String(+v.toFixed(2)) : `${Math.round(v * 1000)}m`);
/** "45 s", "2 min": how often something happens. */
const every = (s: number) => (s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);

/** Facts as the sentences show them: durations, bytes and cores in their units. */
function values(facts: Record<string, string | number | null>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...facts };
  if (typeof facts.p95Ms === 'number') out.p95 = formatValue(facts.p95Ms / 1000, 'seconds');
  if (typeof facts.limitBytes === 'number') out.limit = formatBytes(facts.limitBytes);
  if (typeof facts.perMinuteBytes === 'number') out.perMinute = formatBytes(facts.perMinuteBytes);
  if (typeof facts.requestBytes === 'number') out.request = formatBytes(facts.requestBytes);
  if (typeof facts.requestCores === 'number') out.request = cores(facts.requestCores);
  if (typeof facts.everyS === 'number') out.every = every(facts.everyS);
  return out;
}

const line = (key: string, facts: Record<string, string | number | null>): Line => ({
  key,
  values: values(facts),
  ...(typeof facts.n === 'number' ? { plural: facts.n } : {}),
});

/** The panel's first sentence. */
export function headlineLine(a: Pick<Causes, 'headline'>): Line {
  return line(`causes.headline.${a.headline.code}`, a.headline.facts);
}

/** A cause in one line (rules' own codes, slices 2–4). */
export function causeLine(c: Pick<Cause, 'code' | 'facts'>): Line {
  return line(`causes.cause.${c.code}`, c.facts);
}

/** A step's fact. */
export function stepLine(s: Pick<CauseStep, 'code' | 'facts'>): Line {
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
      return { name: 'containers', query: { ...cluster, project: parts[0] } };
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
