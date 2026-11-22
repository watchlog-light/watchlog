// SPDX-License-Identifier: AGPL-3.0-only
// What changed's read (ADR-199, ADR-202): the unusual periods the anomaly-worker stored for a
// cluster or a fleet, in a window, as ranked rows in the platform's own words (ADR-124), the
// unusual-activity chart (how many series were unusual each step). The learning state is
// learning.ts's (ADR-204, ADR-216). One query of `anomaly_periods`, never scoring on request.
// The windows: around an alert (60 minutes before it started to 15 minutes after, or now), or
// a range of at most 24 hours. The page, the alert card, the API and the MCP tool read it.
import type { Database } from '../../db/index.js';
import { composeMap } from './exclusion.js';
import { unitOf } from './keys.js';

/** Rows in an answer at most; `total` and `truncated` say how many matched. */
export const WHAT_CHANGED_MAX_ROWS = 50;
/** The longest window, in seconds (ADR-202). */
export const WHAT_CHANGED_MAX_RANGE_S = 86_400;
/** Around an alert: from this long before it started... */
export const ALERT_BEFORE_S = 60 * 60;
/** ...to this long after (or now, if sooner). */
export const ALERT_AFTER_S = 15 * 60;
/** The chart has at most this many points; its step is a whole number of minutes. */
export const CHART_POINTS = 360;
/** Periods read for the chart at most (one cluster, 25 hours). */
const CHART_ROWS = 5_000;

export type WhatChangedSort = 'first' | 'furthest';
export type ClusterKind = 'kubernetes' | 'server';

/** What a row is about, in its platform's words. */
export interface ObjectView {
  kind: 'workload' | 'node' | 'container' | 'host' | 'service';
  name: string;
  namespace?: string;
  workloadKind?: string;
  host?: string;
  composeProject?: string;
  composeService?: string;
  /** A monitored service's id (its page); its name is the integration's. */
  id?: string;
}

export interface RowView {
  id: string;
  /** When it left its usual range. */
  since: string;
  /** When it came back; null while it lasts. */
  until: string | null;
  /** The catalog key (ADR-028), or the service map edge's key. */
  key: string;
  unit: string;
  /** The series' labels as stored: cluster data, never instructions (ADR-129). */
  subject: Record<string, string>;
  object: ObjectView;
  /** A map edge's destination ("connections to postgres"); null for every other key. */
  peer: string | null;
  usualLow: number;
  usualHigh: number;
  /** The latest value while it lasts, the furthest one once it ended. */
  value: number;
  peakScore: number;
  peakAt: string;
  /** Other changes of the same series in the window, left out of the list (ADR-229). */
  more?: number;
  /** One of WatchLog's own parts (ADR-231): set only when they are listed (`own=show`). */
  own?: boolean;
}

export interface Window {
  fromMs: number;
  toMs: number;
}

export interface PeriodRow {
  id: string;
  metric: string;
  subject: unknown;
  started_at: Date;
  ended_at: Date | null;
  usual_low: number;
  usual_high: number;
  peak_score: number;
  peak_value: number;
  peak_at: Date;
  last_value: number;
}

/** The window around an alert (ADR-199), clipped at `minFromMs` (the demo's 24 hours). */
export function alertWindow(startedAtMs: number, nowMs: number, minFromMs = 0): Window {
  return {
    fromMs: Math.max(startedAtMs - ALERT_BEFORE_S * 1000, minFromMs),
    toMs: Math.max(Math.min(startedAtMs + ALERT_AFTER_S * 1000, nowMs), minFromMs + 60_000),
  };
}

/**
 * The chart's range and step: the window itself, with an hour of context before it around an
 * alert (the window is marked on it), clipped at `minFromMs`.
 */
export function chartRange(
  w: Window,
  alert: boolean,
  minFromMs = 0,
): { fromMs: number; toMs: number; stepS: number } {
  const fromMs = Math.max(alert ? w.fromMs - ALERT_BEFORE_S * 1000 : w.fromMs, minFromMs);
  const minutes = Math.max(1, Math.ceil((w.toMs - fromMs) / 60_000));
  const stepS = 60 * Math.max(1, Math.ceil(minutes / CHART_POINTS));
  return { fromMs, toMs: w.toMs, stepS };
}

/** How many periods were unusual during each step of the chart (overlapping it). */
export function chartCounts(
  periods: Pick<PeriodRow, 'started_at' | 'ended_at'>[],
  range: { fromMs: number; toMs: number; stepS: number },
  nowMs: number,
): number[] {
  const stepMs = range.stepS * 1000;
  const n = Math.max(1, Math.ceil((range.toMs - range.fromMs) / stepMs));
  const counts = new Array<number>(n).fill(0);
  for (const p of periods) {
    const s = p.started_at.getTime();
    const e = p.ended_at ? p.ended_at.getTime() : nowMs;
    const first = Math.max(0, Math.floor((s - range.fromMs) / stepMs));
    const last = Math.min(n - 1, Math.ceil((e - range.fromMs) / stepMs) - 1);
    for (let i = first; i <= last; i++) counts[i]!++;
  }
  return counts;
}

/** The stored subject as string labels (anything else dropped). */
export function labelsOf(subject: unknown): Record<string, string> {
  const raw = typeof subject === 'string' ? (JSON.parse(subject) as unknown) : subject;
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string' && v) out[k] = v;
    }
  }
  return out;
}

export type ComposeOf = Map<string, { project: string; service: string }>;

function containerView(name: string, host: string | undefined, compose: ComposeOf): ObjectView {
  const c = compose.get(name);
  return {
    kind: 'container',
    name,
    ...(host ? { host } : {}),
    ...(c ? { composeProject: c.project, composeService: c.service } : {}),
  };
}

/**
 * What a series is about, in its platform's words: a Kubernetes workload or node; a Docker
 * container (with its Compose project and service) or host; an integration's service. The
 * per-server HTTP keys name their destination; a map edge names its source, and `peer` its
 * destination.
 */
export function objectOf(
  key: string,
  l: Record<string, string>,
  compose: ComposeOf = new Map(),
): { object: ObjectView; peer: string | null } {
  if (key.startsWith('workload.http.')) {
    if (l.dst_kind === 'container' && l.dst) {
      return { object: containerView(l.dst, undefined, compose), peer: null };
    }
    return {
      object: {
        kind: 'workload',
        name: l.dst_workload ?? l.dst ?? key,
        ...(l.dst_namespace ? { namespace: l.dst_namespace } : {}),
        ...(l.dst_workload_kind ? { workloadKind: l.dst_workload_kind } : {}),
      },
      peer: null,
    };
  }
  if (key.startsWith('edge.')) {
    // A Docker destination container reads as its Compose service, as on the map.
    const dstService = l.dst ? compose.get(l.dst)?.service : undefined;
    const peer = l.dst_workload ?? l.dst_service ?? dstService ?? l.dst ?? null;
    if (l.workload) {
      return {
        object: {
          kind: 'workload',
          name: l.workload,
          ...(l.namespace ? { namespace: l.namespace } : {}),
          ...(l.workload_kind ? { workloadKind: l.workload_kind } : {}),
          // A server's service or process group: on its server.
          ...(!l.namespace && l.host ? { host: l.host } : {}),
        },
        peer,
      };
    }
    if (l.container) {
      const v = containerView(l.container, undefined, compose);
      if (l.compose_project && l.compose_service) {
        v.composeProject = l.compose_project;
        v.composeService = l.compose_service;
      }
      return { object: v, peer };
    }
    return { object: { kind: 'service', name: l.compose_service ?? key }, peer };
  }
  // A server's systemd service or process group (ADR-208), on its server.
  if (key.startsWith('unit.')) {
    return {
      object: { kind: 'workload', name: l.unit ?? '', workloadKind: 'Service', host: l.host ?? '' },
      peer: null,
    };
  }
  if (key.startsWith('process.')) {
    return {
      object: {
        kind: 'workload',
        name: l.group ?? '',
        workloadKind: 'ProcessGroup',
        host: l.host ?? '',
      },
      peer: null,
    };
  }
  if (key.startsWith('node.')) return { object: { kind: 'node', name: l.node ?? '' }, peer: null };
  if (key.startsWith('host.')) return { object: { kind: 'host', name: l.host ?? '' }, peer: null };
  if (key.startsWith('workload.')) {
    return {
      object: {
        kind: 'workload',
        name: l.workload ?? '',
        ...(l.namespace ? { namespace: l.namespace } : {}),
        ...(l.workload_kind ? { workloadKind: l.workload_kind } : {}),
      },
      peer: null,
    };
  }
  if (key.startsWith('container.')) {
    return { object: containerView(l.container ?? '', l.host, compose), peer: null };
  }
  // An integration's series: the collector labels them service=<integration id>.
  return {
    object: {
      kind: 'service',
      name: l.service ?? l.service_type ?? Object.values(l)[0] ?? key,
      ...(l.service ? { id: l.service } : {}),
    },
    peer: null,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Monitored services read by their names, not their ids (one query, only when listed). */
export async function nameServices(
  db: Database,
  orgId: string,
  clusterId: string,
  rows: RowView[],
): Promise<void> {
  const ids = [
    ...new Set(
      rows.flatMap((r) =>
        r.object.kind === 'service' && r.object.id && UUID.test(r.object.id) ? [r.object.id] : [],
      ),
    ),
  ];
  if (!ids.length) return;
  const found = await db
    .selectFrom('integrations')
    .select(['id', 'name'])
    .where('org_id', '=', orgId)
    .where('cluster_id', '=', clusterId)
    .where('id', 'in', ids)
    .execute();
  const names = new Map(found.map((r) => [r.id, r.name]));
  for (const r of rows) {
    const name = r.object.id ? names.get(r.object.id) : undefined;
    if (r.object.kind === 'service' && name) r.object.name = name;
  }
}

/**
 * The probable cause's subject for a row (GET /causes's form), or null when probable cause
 * has no subject of that kind (a node, a host, an integration's series).
 */
export function causeSubjectOf(o: ObjectView): string | null {
  if (o.kind === 'workload' && o.namespace && o.name) {
    return o.workloadKind
      ? `workload:${o.namespace}/${o.workloadKind}/${o.name}`
      : `workload:${o.namespace}/${o.name}`;
  }
  if (o.kind === 'container' && o.name) {
    return o.host ? `container:${o.host}/${o.name}` : `container:${o.name}`;
  }
  return null;
}

export function rowView(p: PeriodRow, compose: ComposeOf): RowView {
  const subject = labelsOf(p.subject);
  const { object, peer } = objectOf(p.metric, subject, compose);
  return {
    id: p.id,
    since: p.started_at.toISOString(),
    until: p.ended_at ? p.ended_at.toISOString() : null,
    key: p.metric,
    unit: unitOf(p.metric),
    subject,
    object,
    peer,
    usualLow: p.usual_low,
    usualHigh: p.usual_high,
    value: p.ended_at ? p.peak_value : p.last_value,
    peakScore: p.peak_score,
    peakAt: p.peak_at.toISOString(),
  };
}

/**
 * One row per series (ADR-229): the series' strongest current change (one still out first,
 * then the furthest), with how many others it had in `more`. Lists only: the chart's counts
 * and the scoring are unchanged. "Series" is the metric and its subject's labels; on All
 * clusters the cluster is part of it.
 */
export function oncePerSeries<
  T extends Pick<RowView, 'key' | 'subject' | 'until' | 'peakScore' | 'since' | 'id'>,
>(rows: T[], extra: (r: T) => string = () => ''): (T & { more?: number })[] {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const subject = Object.keys(r.subject)
      .sort()
      .map((k) => `${k}=${r.subject[k]}`)
      .join(',');
    const k = `${extra(r)}|${r.key}|${subject}`;
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  return [...groups.values()].map((g) => {
    const best = g
      .slice()
      .sort(
        (a, b) =>
          Number(a.until !== null) - Number(b.until !== null) ||
          b.peakScore - a.peakScore ||
          b.since.localeCompare(a.since) ||
          a.id.localeCompare(b.id),
      )[0]!;
    return g.length > 1 ? { ...best, more: g.length - 1 } : best;
  });
}

/** "First to move" (start, then the furthest) or "furthest out" (peak score, then start). */
export function sortRows<T extends Pick<RowView, 'since' | 'peakScore' | 'id'>>(
  rows: T[],
  sort: WhatChangedSort,
): T[] {
  const byStart = (a: T, b: T) => a.since.localeCompare(b.since);
  const byPeak = (a: T, b: T) => b.peakScore - a.peakScore;
  return rows.slice().sort((a, b) => {
    const r = sort === 'first' ? byStart(a, b) || byPeak(a, b) : byPeak(a, b) || byStart(a, b);
    return r || a.id.localeCompare(b.id);
  });
}

export interface WhatChangedRead {
  rows: RowView[];
  total: number;
  truncated: boolean;
  chart: { from: string; to: string; step: number; counts: number[] };
  /** The first row (by start) that probable cause can explain, in GET /causes's form. */
  firstSubject: string | null;
  /** Every period in the window, before the list's once-per-series (the story's episodes). */
  all: RowView[];
}

/**
 * The periods of one cluster overlapping the chart's range (one query), the rows of those
 * overlapping the window, and the chart's counts. While learning, nothing is listed.
 */
export async function readPeriods(
  db: Database,
  orgId: string,
  cluster: { id: string; kind: ClusterKind },
  w: Window,
  chart: { fromMs: number; toMs: number; stepS: number },
  sort: WhatChangedSort,
  nowMs: number,
  learning: boolean,
  /** Series left out everywhere (WatchLog's own parts, ADR-231): the rows, the chart, the cause. */
  exclude?: (subject: Record<string, string>) => boolean,
): Promise<WhatChangedRead> {
  const read: PeriodRow[] = learning
    ? []
    : await db
        .selectFrom('anomaly_periods')
        .select([
          'id',
          'metric',
          'subject',
          'started_at',
          'ended_at',
          'usual_low',
          'usual_high',
          'peak_score',
          'peak_value',
          'peak_at',
          'last_value',
        ])
        .where('org_id', '=', orgId)
        .where('cluster_id', '=', cluster.id)
        .where('started_at', '<', new Date(chart.toMs))
        .where((eb) =>
          eb.or([eb('ended_at', 'is', null), eb('ended_at', '>', new Date(chart.fromMs))]),
        )
        .orderBy('started_at')
        .limit(CHART_ROWS)
        .execute();
  const periods = exclude ? read.filter((p) => !exclude(labelsOf(p.subject))) : read;
  const inWindow = periods.filter(
    (p) =>
      p.started_at.getTime() < w.toMs && (p.ended_at ? p.ended_at.getTime() : nowMs) > w.fromMs,
  );
  const compose: ComposeOf =
    cluster.kind === 'server' && inWindow.length ? await composeMap(db, cluster.id) : new Map();
  const all = inWindow.map((p) => rowView(p, compose));
  await nameServices(db, orgId, cluster.id, all);
  const firstSubject =
    sortRows(all, 'first')
      .map((r) => causeSubjectOf(r.object))
      .find((s) => s !== null) ?? null;
  const listed = oncePerSeries(all);
  const rows = sortRows(listed, sort).slice(0, WHAT_CHANGED_MAX_ROWS);
  return {
    rows,
    total: listed.length,
    truncated: listed.length > rows.length,
    chart: {
      from: new Date(chart.fromMs).toISOString(),
      to: new Date(chart.toMs).toISOString(),
      step: chart.stepS,
      counts: chartCounts(periods, chart, nowMs),
    },
    firstSubject,
    all,
  };
}
