// SPDX-License-Identifier: AGPL-3.0-only
// What changed's live map (0.14.0, ADR-231): every scored series of a cluster or fleet as it
// stood at the anomaly-worker's last minute, coloured by its distance from its usual range for
// this hour of the week. The worker writes one row per cluster each minute (`anomaly_live`);
// GET /what-changed/live reads it in one query. No second score: the states come from the
// worker's own score (stats.ts) and its open periods.
//
// The thresholds (ADR-231), on the worker's score |value − median| / spread, whose usual
// range is a score of 2 or less (stats.ts's usualRange):
//   - inside: score ≤ 2, in three shades (≤ ⅔, ≤ 1⅓, ≤ 2);
//   - near the edge: past 2 without an open period: within a quarter of the band's width
//     outside it (score ≤ 3), or past the band but not for 10 minutes yet;
//   - outside: an open unusual period (past 4 for 10 minutes, until 10 minutes back).
import type { Database } from '../../db/index.js';
import { isWatchlogImage, isWatchlogPod } from '../integrations/discovery.js';
import { seriesHash, unitOf } from './keys.js';
import { labelsOf, objectOf, type ComposeOf, type ObjectView } from './read.js';

/** Inside the usual range: a score of 2 or less (the band is median ± 2 spreads). */
export const INSIDE_MAX = 2;
export type LiveState = 'inside' | 'near' | 'outside';

/** One series as the worker scored it at its last minute. */
export interface LiveEntry {
  key: string;
  subject: Record<string, string>;
  value: number | null;
  low: number;
  high: number;
  score: number | null;
  open: boolean;
}

/** The compact form stored in `anomaly_live.series`. */
export type StoredEntry = [
  string,
  Record<string, string>,
  number | null,
  number,
  number,
  number | null,
  boolean,
];

export const toStored = (e: LiveEntry): StoredEntry => [
  e.key,
  e.subject,
  e.value,
  e.low,
  e.high,
  e.score === null ? null : Math.round(e.score * 100) / 100,
  e.open,
];

export function fromStored(raw: unknown): LiveEntry | null {
  if (!Array.isArray(raw) || raw.length < 7 || typeof raw[0] !== 'string') return null;
  const [key, subject, value, low, high, score, open] = raw as StoredEntry;
  return {
    key,
    subject: labelsOf(subject),
    value: typeof value === 'number' ? value : null,
    low: Number(low),
    high: Number(high),
    score: typeof score === 'number' ? score : null,
    open: open === true,
  };
}

/** The state and the inside shade (0–2, lightest first) of a series (ADR-231). */
export function stateOf(e: Pick<LiveEntry, 'score' | 'open'>): { state: LiveState; shade: number } {
  if (e.open) return { state: 'outside', shade: 2 };
  const s = e.score ?? 0;
  if (s > INSIDE_MAX) return { state: 'near', shade: 1 };
  return { state: 'inside', shade: s <= INSIDE_MAX / 3 ? 0 : s <= (2 * INSIDE_MAX) / 3 ? 1 : 2 };
}

// ------------------------------------------------------------------- WatchLog's own parts

/** Units and process groups of WatchLog's agent on a server. */
const OWN_UNIT = /^watchlog-(agent|integrations)(\.service)?$/;
/** The agent's chart on Kubernetes (WatchLog's own chart is isWatchlogPod's). */
const AGENT_CHART = /^watchlog-agent-\d/;

export function isOwnPod(labels: Record<string, string> | undefined): boolean {
  if (!labels) return false;
  return (
    isWatchlogPod(labels) ||
    labels['app.kubernetes.io/name'] === 'watchlog-agent' ||
    AGENT_CHART.test(labels['helm.sh/chart'] ?? '')
  );
}

/** What makes a series WatchLog's own, read once per request from the cluster's objects. */
export interface OwnParts {
  /** "namespace/workload" of Kubernetes workloads whose pods are WatchLog's. */
  workloads: Set<string>;
  /** Containers of WatchLog's images, or in the Compose project that runs WatchLog. */
  containers: Set<string>;
}

export async function ownParts(db: Database, clusterId: string): Promise<OwnParts> {
  const rows = await db
    .selectFrom('objects')
    .select(['kind', 'namespace', 'name', 'spec_summary'])
    .where('cluster_id', '=', clusterId)
    .where('kind', 'in', ['Pod', 'DockerContainer'])
    .where('deleted_at', 'is', null)
    .execute();
  const workloads = new Set<string>();
  const containers = new Set<string>();
  const ownProjects = new Set<string>();
  for (const r of rows) {
    const spec = (r.spec_summary ?? {}) as {
      labels?: Record<string, string>;
      workload?: { name?: string };
      image?: string;
    };
    if (r.kind === 'Pod' && isOwnPod(spec.labels) && spec.workload?.name) {
      workloads.add(`${r.namespace}/${spec.workload.name}`);
    }
    if (r.kind === 'DockerContainer' && /(^|\/)watchlog-light\//.test(spec.image ?? '')) {
      containers.add(r.name);
      if (r.namespace && isWatchlogImage(spec.image)) ownProjects.add(r.namespace);
    }
  }
  for (const r of rows) {
    if (r.kind === 'DockerContainer' && r.namespace && ownProjects.has(r.namespace)) {
      containers.add(r.name);
    }
  }
  return { workloads, containers };
}

/** Whether a series is about WatchLog itself: its chart's workloads, its containers, its units. */
export function isOwnSeries(subject: Record<string, string>, own: OwnParts): boolean {
  if (
    subject.namespace &&
    subject.workload &&
    own.workloads.has(`${subject.namespace}/${subject.workload}`)
  ) {
    return true;
  }
  if (subject.dst_namespace && subject.dst_workload) {
    // A per-destination HTTP key is about its destination.
    if (own.workloads.has(`${subject.dst_namespace}/${subject.dst_workload}`)) return true;
  }
  if (subject.container && own.containers.has(subject.container)) return true;
  if (subject.unit && OWN_UNIT.test(subject.unit)) return true;
  if (subject.group && OWN_UNIT.test(subject.group)) return true;
  // A server's edge from WatchLog's agent process.
  if (!subject.namespace && subject.workload && OWN_UNIT.test(subject.workload)) return true;
  return false;
}

// --------------------------------------------------------------------------- the answer

export interface LiveSeriesView {
  /** The series' hash, short: stable across minutes. */
  id: string;
  key: string;
  unit: string;
  object: ObjectView;
  peer: string | null;
  value: number | null;
  usualLow: number;
  usualHigh: number;
  score: number | null;
  state: LiveState;
  shade: number;
  own: boolean;
}

export interface LiveView {
  scoredAt: string | null;
  learning: number;
  series: LiveSeriesView[];
}

export function liveView(
  row: { scored_at: Date; learning: number; series: unknown } | undefined,
  own: OwnParts,
  compose: ComposeOf,
): LiveView {
  if (!row) return { scoredAt: null, learning: 0, series: [] };
  const list = Array.isArray(row.series) ? row.series : [];
  const series: LiveSeriesView[] = [];
  for (const raw of list) {
    const e = fromStored(raw);
    if (!e) continue;
    const { object, peer } = objectOf(e.key, e.subject, compose);
    series.push({
      id: seriesHash(e.key, e.subject).toString('hex').slice(0, 16),
      key: e.key,
      unit: unitOf(e.key),
      object,
      peer,
      value: e.value,
      usualLow: e.low,
      usualHigh: e.high,
      score: e.score,
      ...stateOf(e),
      own: isOwnSeries(e.subject, own),
    });
  }
  return { scoredAt: row.scored_at.toISOString(), learning: row.learning, series };
}

/** The worker's write: the cluster's row, replaced. */
export async function writeLive(
  db: Database,
  t: { orgId: string; clusterId: string },
  at: number,
  entries: LiveEntry[],
  learning: number,
): Promise<void> {
  const series = JSON.stringify(entries.map(toStored));
  await db
    .insertInto('anomaly_live')
    .values({
      org_id: t.orgId,
      cluster_id: t.clusterId,
      scored_at: new Date(at),
      learning,
      series,
    })
    .onConflict((oc) =>
      oc.column('cluster_id').doUpdateSet({ scored_at: new Date(at), learning, series }),
    )
    .execute();
}
