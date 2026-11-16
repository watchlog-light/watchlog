// SPDX-License-Identifier: AGPL-3.0-only
// What changed in the dashboard (ADR-199): the windows the page offers, the request path, the
// rows in each platform's words (ADR-124), "usual → now" and the unusual-activity chart's
// geometry. The names in a row are cluster data: shown as text, never as markup.
import type {
  CauseCheck,
  WhatChanged,
  WhatChangedObject,
  WhatChangedRow,
} from '@watchlog/api-types';
import type { RouteLocationRaw } from 'vue-router';
import { ApiError } from '@/api/client';
import { checkLine, type Line } from './causes';
import { formatValue, type Unit } from './units';

export type WhatChangedWindow = 'alert' | '1h' | '6h' | 'custom';
export type WhatChangedSort = 'first' | 'furthest';
export const WHAT_CHANGED_SORTS: WhatChangedSort[] = ['first', 'furthest'];
/** The longest window the backend answers (ADR-202), and the demo's history (ADR-122). */
export const MAX_WINDOW_S = 86_400;
export const DEMO_HISTORY_S = 86_400;
export const WINDOW_SECONDS: Record<'1h' | '6h', number> = { '1h': 3600, '6h': 6 * 3600 };

/**
 * The windows the page offers: "around the alert" when it was opened from one, the last hour,
 * the last 6 hours and a custom range of at most 24 hours. Every one fits the demo's 24 hours;
 * there the custom range can't start before them either (`customBounds`).
 */
export function whatChangedWindows(hasAlert: boolean): WhatChangedWindow[] {
  return hasAlert ? ['alert', '1h', '6h', 'custom'] : ['1h', '6h', 'custom'];
}

/**
 * The custom range's bounds in unix seconds: the earliest start (the demo's last 24 hours;
 * elsewhere any time, the backend answering what retention keeps) and the latest end (now).
 */
export function customBounds(
  demo: boolean,
  nowMs = Date.now(),
): { min: number | null; max: number } {
  const now = Math.floor(nowMs / 1000);
  return { min: demo ? now - DEMO_HISTORY_S : null, max: now };
}

/**
 * A custom range made valid: `to` not after now, at most 24 hours long, and in the demo not
 * before its 24 hours. Returns null when nothing usable is left.
 */
export function clampCustom(
  from: number,
  to: number,
  demo: boolean,
  nowMs = Date.now(),
): { from: number; to: number } | null {
  const b = customBounds(demo, nowMs);
  let t = Math.min(to, b.max);
  let f = Math.max(from, t - MAX_WINDOW_S);
  if (b.min !== null) {
    f = Math.max(f, b.min);
    t = Math.max(t, f + 60);
  }
  if (!(f < t)) return null;
  return { from: f, to: t };
}

export interface WhatChangedQuery {
  window: WhatChangedWindow;
  alert?: string;
  from?: number;
  to?: number;
  sort?: WhatChangedSort;
}

/** GET /what-changed for a cluster and a window (1 h is the backend's default). */
export function whatChangedPath(
  clusterId: string,
  q: WhatChangedQuery,
  nowMs = Date.now(),
): string {
  const p = new URLSearchParams({ cluster: clusterId });
  if (q.window === 'alert' && q.alert) p.set('alert', q.alert);
  else if (q.window === '6h')
    p.set('from', String(Math.floor(nowMs / 1000) - WINDOW_SECONDS['6h']));
  else if (q.window === 'custom' && q.from !== undefined && q.to !== undefined) {
    p.set('from', String(q.from));
    p.set('to', String(q.to));
  }
  if (q.sort === 'furthest') p.set('sort', 'furthest');
  return `/what-changed?${p.toString()}`;
}

/** Who sees What changed: Pro (and the demo) the data; Cloud Free and Community a placeholder. */
export type WhatChangedAccess = 'pro' | 'free' | 'community';

/** Community asks nothing (the route isn't there); Cloud and the demo ask, and 403 means Free. */
export function initialAccess(isCloud: boolean, demo: boolean): WhatChangedAccess | null {
  return isCloud || demo ? null : 'community';
}

/** A 403 `pro-feature` from GET /what-changed: the org has no Pro (ADR-202). */
export function isProFeature(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 403 &&
    err.problem?.type === 'urn:watchlog:problem:pro-feature'
  );
}

type Tr = (key: string, values?: Record<string, unknown>) => string;

/** The row's subject as it reads in its platform: the workload, the Compose service, the node. */
export function objectName(o: WhatChangedObject): string {
  if (o.kind === 'container' && o.composeService) return o.composeService;
  return o.name;
}

/** Where the subject lives, in its platform's words: "shop · Deployment", "Compose shop". */
export function objectContext(o: WhatChangedObject, tr: Tr): string {
  switch (o.kind) {
    case 'workload':
      return [o.namespace, o.workloadKind].filter(Boolean).join(' · ');
    case 'container':
      return o.composeProject
        ? tr('whatChanged.context.compose', { project: o.composeProject, container: o.name })
        : o.host
          ? tr('whatChanged.context.container', { host: o.host })
          : tr('whatChanged.context.containerOnly');
    case 'node':
      return tr('whatChanged.context.node');
    case 'host':
      return tr('whatChanged.context.host');
    default:
      return tr('whatChanged.context.service');
  }
}

/**
 * Where a row's subject has its own page: a workload's pods (as the Egress page links a
 * source), a node, a Docker container (its Compose service when the host isn't known), a host,
 * a monitored service. Undefined when there is none.
 */
export function objectLink(o: WhatChangedObject, clusterId: string): RouteLocationRaw | undefined {
  const cluster = { cluster: clusterId };
  switch (o.kind) {
    case 'workload':
      if (!o.namespace || !o.name) return undefined;
      return {
        name: 'workloads',
        query: {
          ...cluster,
          view: 'pods',
          ...(o.workloadKind ? { wkind: o.workloadKind } : {}),
          wname: o.name,
          wns: o.namespace,
        },
      };
    case 'node':
      return o.name ? { name: 'node', params: { name: o.name }, query: cluster } : undefined;
    case 'container':
      if (o.host && o.name)
        return { name: 'docker-container', params: { host: o.host, name: o.name }, query: cluster };
      if (o.composeProject && o.composeService)
        return {
          name: 'containers',
          query: { ...cluster, project: o.composeProject, service: o.composeService },
        };
      return undefined;
    case 'host':
      return o.name ? { name: 'docker-host', params: { host: o.name }, query: cluster } : undefined;
    default:
      return o.id ? { name: 'application', params: { id: o.id } } : undefined;
  }
}

const KNOWN_METRICS = new Set([
  'node.cpu.utilization',
  'node.memory.utilization',
  'node.network.bytes',
  'node.disk.io',
  'host.cpu.utilization',
  'host.memory.utilization',
  'host.network.bytes',
  'host.disk.io',
  'workload.cpu.usage',
  'workload.memory.working_set',
  'container.cpu.usage',
  'container.memory.working_set',
  'container.network.bytes',
  'workload.http.requests.rate',
  'workload.http.errors.ratio',
  'workload.http.latency.p95',
  'edge.connections.rate',
  'edge.http.requests.rate',
  'edge.http.latency.p95',
]);
const keyOf = (key: string) => key.replace(/\./g, '_');

/** What moved, short: "p95 response time", "connections to postgres", "Redis commands/s". */
export function metricText(row: Pick<WhatChangedRow, 'key' | 'peer'>, tr: Tr): string {
  if (KNOWN_METRICS.has(row.key)) {
    return tr(`whatChanged.metric.${keyOf(row.key)}`, { peer: row.peer ?? '?' });
  }
  const name = tr(`metricNames.${keyOf(row.key)}`);
  return name === `metricNames.${keyOf(row.key)}` ? row.key : name;
}

/** A value in the row's unit; CPU in cores says so. */
export function valueText(v: number, unit: string): string {
  const s = formatValue(v, unit as Unit);
  return unit === 'cores' ? `${s} cores` : s;
}

/** The usual range, "120–180 ms": the unit written once when both ends share it. */
export function rangeText(low: number, high: number, unit: string): string {
  const a = valueText(low, unit);
  const b = valueText(high, unit);
  if (a === b) return a;
  const sa = a.lastIndexOf(' ');
  const sb = b.lastIndexOf(' ');
  if (sa > 0 && sb > 0 && a.slice(sa) === b.slice(sb)) return `${a.slice(0, sa)}–${b}`;
  const ra = /\/s$/.test(a) && /\/s$/.test(b);
  if (ra) return `${a.slice(0, -2)}–${b}`;
  return `${a}–${b}`;
}

/** How far out a row went, as a share of the bar (the furthest row fills most of it). */
export function barShare(score: number, max: number): number {
  if (!(max > 0)) return 0.1;
  return Math.min(0.96, Math.max(0.1, (score / max) * 0.96));
}

/** "13:58": hours and minutes in the viewer's time zone. */
export function hhmm(iso: string, locale = 'en'): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}

export interface ChartGeometry {
  line: string;
  area: string;
  /** The window, in the 0–1000 viewBox. */
  winX: number;
  winW: number;
  /** Four time labels along the axis. */
  ticks: string[];
  max: number;
}

/** The unusual-activity chart in a 1000 × 190 box: the line, its area and the window. */
export function chartGeometry(
  a: Pick<WhatChanged, 'chart' | 'window'>,
  W = 1000,
  H = 190,
): ChartGeometry {
  const counts = a.chart.counts.length ? a.chart.counts : [0];
  const max = Math.max(1, ...counts);
  const n = counts.length;
  const x = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => H - 8 - (v / max) * (H - 24);
  const pts = counts.map((v, i) => `${x(i).toFixed(1)} ${y(v).toFixed(1)}`);
  const line =
    n === 1
      ? `M0 ${y(counts[0]!).toFixed(1)} L${W} ${y(counts[0]!).toFixed(1)}`
      : `M${pts.join(' L')}`;
  const area = `${line} L${W} ${H} L0 ${H} Z`;
  const from = Date.parse(a.chart.from);
  const to = Date.parse(a.chart.to);
  const span = Math.max(1, to - from);
  const wx = ((Date.parse(a.window.from) - from) / span) * W;
  const wr = ((Date.parse(a.window.to) - from) / span) * W;
  const winX = Math.max(0, Math.min(W, wx));
  const winW = Math.max(0, Math.min(W, wr) - winX);
  const ticks = [0, 1, 2, 3].map((k) => hhmm(new Date(from + (span * k) / 3).toISOString()));
  return { line, area, winX, winW, ticks, max };
}

// ---- The cause card (the screen Main): the probable-cause answer in What changed's form ----

/** The card's tone and label: likely (or was likely), possible, none; couldn't run. */
export type CauseCardState = 'likely' | 'was' | 'possible' | 'none' | 'error' | 'noSubject';

/** Checks whose finding has a short form in the card's row ("No rollout in the last hour"). */
const SHORT_FACTS = new Set([
  'self_ok',
  'events_none',
  'changes_none',
  'changes_cluster_none',
  'node_ok',
  'host_ok',
  'cpu_ok',
  'dependencies_ok',
  'dependencies_failing',
  'dependencies_slower',
  'dns_ok',
  'application_ok',
  'edge_ok',
]);

export interface CauseFact {
  /** The fact in words: one sentence, or what was checked and what was found (": "). */
  lines: Line[];
  result: CauseCheck['result'];
}

/**
 * The card's row of checked facts: where the answer started (the alert, or what moved first),
 * then what the answer itself checked and found, the findings that explain it first, at most
 * `max` in all (the screen's one line of three). Only checks that were run (explains or ok);
 * the full list is the evidence.
 */
export function causeFacts(
  checks: Pick<CauseCheck, 'topic' | 'code' | 'facts' | 'result'>[],
  fromAlert: boolean,
  max = 3,
): CauseFact[] {
  const out: CauseFact[] = [
    {
      lines: [{ key: `whatChanged.cause.fact.${fromAlert ? 'alert' : 'first'}`, values: {} }],
      result: 'ok',
    },
  ];
  const ran = [
    ...checks.filter((c) => c.result === 'explains'),
    ...checks.filter((c) => c.result === 'ok'),
  ];
  for (const c of ran) {
    if (out.length >= max) break;
    const l = checkLine(c);
    const n = typeof c.facts.n === 'number' ? { plural: c.facts.n } : {};
    out.push({
      lines: SHORT_FACTS.has(c.code)
        ? [{ key: `whatChanged.cause.fact.${c.code}`, values: l.result.values, ...n }]
        : [l.what, l.result],
      result: c.result,
    });
  }
  return out;
}

/** The MCP call that gives the same answer (ADR-148), as the alert page shows it. */
export function askCall(subject: string, clusterName: string): string {
  const q = (s: string) => JSON.stringify(s);
  if (subject.startsWith('alert:')) return `explain_alert(id: ${q(subject.slice(6))})`;
  return `explain_problem(cluster: ${q(clusterName)}, subject: ${q(subject)})`;
}
