// SPDX-License-Identifier: AGPL-3.0-only
// What changed's learning week, as data (ADR-216, made gap-aware in ADR-217). Learning is
// 7 days of data: every hour of the week learned once (coverage.ts holds the rule). This
// file keeps the cluster's coverage and reports it.
//   - The anomaly-worker writes one row per cluster (`anomaly_learning`) with each hourly
//     recompute: which hours of the week have a baseline, when it last looked at each, when
//     the cluster became ready, the series it read and how many still learn, and their
//     objects in the kind's words. A cluster that learned before that row existed gets it
//     from its baselines, once.
//   - `coverageOf` gives that coverage to the worker's scoring (jobs.ts) and `learningOf` to
//     the page, the alert card, the sidebar, the email, the API and the MCP tool. They read
//     the same row through the same functions, so the page can't say one thing while the
//     worker does another. Never a scan of the baselines once the row exists.
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  clusterReady,
  coverageFromBaselines,
  emptyCoverage,
  estimateReady,
  estimateSeriesReady,
  learnedHours,
  learningDay,
  recordLook,
  resumedAt,
  seriesReady,
  weekString,
  type Coverage,
} from './coverage.js';
import { objectOf } from './read.js';
import { BUCKETS, DAY_MS, LEARNING_DAYS } from './stats.js';

/** The objects behind a cluster's series, in its kind's words; only the kinds it has. */
export interface Breakdown {
  /** Kubernetes. */
  nodes?: number;
  workloads?: number;
  /** A Server fleet: servers, systemd services, process groups, containers. */
  servers?: number;
  services?: number;
  processGroups?: number;
  containers?: number;
  /** Monitored services (PostgreSQL, Redis…), either kind. */
  applications?: number;
}
export const BREAKDOWN_KEYS = [
  'nodes',
  'workloads',
  'servers',
  'services',
  'processGroups',
  'containers',
  'applications',
] as const satisfies readonly (keyof Breakdown)[];

/** Counts the distinct objects of these series by what they are (ADR-124's vocabulary). */
export function breakdownOf(
  series: Iterable<{ key: string; subject: Record<string, string> }>,
): Breakdown {
  const seen = new Map<keyof Breakdown, Set<string>>();
  for (const s of series) {
    const { object: o } = objectOf(s.key, s.subject);
    let kind: keyof Breakdown;
    if (o.kind === 'node') kind = 'nodes';
    else if (o.kind === 'host') kind = 'servers';
    else if (o.kind === 'container') kind = 'containers';
    else if (o.kind === 'workload') {
      kind =
        o.host && o.workloadKind === 'Service'
          ? 'services'
          : o.host && o.workloadKind === 'ProcessGroup'
            ? 'processGroups'
            : 'workloads';
    } else if (s.key.startsWith('edge.')) {
      continue; // a map edge with no source object of its own
    } else kind = 'applications';
    const id = [o.namespace, o.workloadKind, o.host, o.id ?? o.name].join('\u0000');
    if (!o.name && !o.id) continue;
    let set = seen.get(kind);
    if (!set) seen.set(kind, (set = new Set()));
    set.add(id);
  }
  const out: Breakdown = {};
  for (const k of BREAKDOWN_KEYS) {
    const n = seen.get(k)?.size ?? 0;
    if (n) out[k] = n;
  }
  return out;
}

/** What one recompute of a bucket knows about its cluster. */
export interface BucketStats {
  /** Series with at least one minute behind this hour of the week. */
  withData: number;
  /** Each series' `first_seen` after the write, in ms. */
  firstSeen: number[];
  series: { key: string; subject: Record<string, string> }[];
}

/** What one recompute of a bucket knows about its cluster. */
export interface BucketStats {
  /** Series with at least one minute behind this hour of the week. */
  withData: number;
  /** Each series' `first_seen` after the write, in ms. */
  firstSeen: number[];
  series: { key: string; subject: Record<string, string> }[];
}

interface LearningRow {
  hours: number[];
  looked_at: (Date | string | null)[];
  looks: number[];
  ready_at: Date | null;
  resumed_at: Date | null;
  first_seen: Date | null;
}
const ROW = ['hours', 'looked_at', 'looks', 'ready_at', 'resumed_at', 'first_seen'] as const;
const ms = (v: Date | string | null | undefined): number | null =>
  v === null || v === undefined ? null : new Date(v).getTime();

/** A row from before 0.9.6: hours learned, but no record of when the worker looked. */
const legacy = (r: LearningRow): boolean =>
  r.looked_at.every((t) => t === null) && r.hours.some((n) => n > 0);

function fromRow(r: LearningRow, nowMs: number): Coverage {
  if (legacy(r)) return coverageFromBaselines(r.hours, ms(r.first_seen), nowMs);
  const c = emptyCoverage();
  for (let s = 0; s < BUCKETS; s++) {
    c.hours[s] = r.hours[s] ?? 0;
    c.lookedAt[s] = ms(r.looked_at[s]);
    c.looks[s] = r.looks[s] ?? 0;
  }
  c.readyAt = ms(r.ready_at);
  c.resumedAt = ms(r.resumed_at);
  c.firstSeen = ms(r.first_seen);
  return c;
}

/** A cluster with baselines and no learning row yet (0.8.0 to 0.9.3): one aggregate, once. */
async function fromBaselines(db: Database, clusterId: string, nowMs: number): Promise<Coverage> {
  const r = await sql<{ hours: number[]; first: Date | null }>`
    SELECT ARRAY(SELECT (count(bl.series_hash) FILTER (WHERE bl.minutes[b] > 0))::int
                   FROM generate_series(1, ${sql.lit(BUCKETS)}) AS b
                   LEFT JOIN anomaly_baselines bl ON bl.cluster_id = ${clusterId}::uuid
                  GROUP BY b ORDER BY b) AS hours,
           (SELECT min(first_seen) FROM anomaly_baselines
             WHERE cluster_id = ${clusterId}::uuid) AS first`.execute(db);
  const row = r.rows[0];
  return coverageFromBaselines(row?.hours ?? [], ms(row?.first), nowMs);
}

/**
 * A cluster's coverage as it stands: the one thing the worker's scoring and every report of
 * the learning week are worked out from. Runs inside the org's context.
 */
export async function coverageOf(
  db: Database,
  clusterId: string,
  nowMs: number,
): Promise<Coverage> {
  const row = await db
    .selectFrom('anomaly_learning')
    .select(ROW)
    .where('cluster_id', '=', clusterId)
    .executeTakeFirst();
  return row ? fromRow(row as LearningRow, nowMs) : fromBaselines(db, clusterId, nowMs);
}

const iso = (v: number | null) => (v === null ? null : new Date(v).toISOString());
const least = (values: number[]) => values.reduce((a, v) => (v < a ? v : a), Infinity);
const greatest = (values: number[]) => values.reduce((a, v) => (v > a ? v : a), -Infinity);

/**
 * Records one recompute in the cluster's learning row: the look at its hour, and from that
 * whether the cluster is ready (coverage.ts). `full` (the hourly run, not the demo's
 * look-back) also records the series it read, how many are still learning by the worker's
 * own rule and when the last of them is ready, and the breakdown. A recompute that read
 * nothing still counts as a look, and leaves what the row knows about the series. Runs
 * inside the org's context, like the recompute itself.
 */
export async function recordLearning(
  db: Database,
  t: { orgId: string; clusterId: string },
  hourMs: number,
  stats: BucketStats,
  clock: { nowMs: number; full: boolean },
): Promise<Coverage> {
  const { nowMs, full } = clock;
  const read = stats.series.length > 0;
  let c = await coverageOf(db, t.clusterId, nowMs);
  if (stats.firstSeen.length) {
    const first = least(stats.firstSeen);
    c = { ...c, firstSeen: c.firstSeen === null ? first : Math.min(c.firstSeen, first) };
  }
  c = recordLook(c, hourMs, read ? stats.withData : null, nowMs);
  const lookedAt = c.lookedAt.map(iso);
  await sql`
    INSERT INTO anomaly_learning
      (org_id, cluster_id, hours, looked_at, looks, ready_at, resumed_at, first_seen, updated_at)
    VALUES (${t.orgId}::uuid, ${t.clusterId}::uuid, ${c.hours}::int[],
            ${lookedAt}::timestamptz[], ${c.looks}::smallint[], ${iso(c.readyAt)}::timestamptz,
            ${iso(c.resumedAt)}::timestamptz, ${iso(c.firstSeen)}::timestamptz, ${new Date(nowMs)})
    ON CONFLICT (cluster_id) DO UPDATE
      SET hours = excluded.hours, looked_at = excluded.looked_at, looks = excluded.looks,
          ready_at = excluded.ready_at, resumed_at = excluded.resumed_at,
          first_seen = excluded.first_seen, updated_at = excluded.updated_at`.execute(db);
  if (!full || !read) return c;
  const learning = stats.firstSeen.filter((f) => !seriesReady(c, f, nowMs));
  const until = learning.length ? estimateSeriesReady(c, greatest(learning), nowMs) : null;
  await sql`
    UPDATE anomaly_learning
       SET series = ${stats.series.length},
           series_learning = ${learning.length},
           learning_until = ${iso(until)}::timestamptz,
           breakdown = ${JSON.stringify(breakdownOf(stats.series))}::jsonb
     WHERE cluster_id = ${t.clusterId}::uuid`.execute(db);
  return c;
}

export interface Learning {
  /** True until the worker has learned every hour of the week: nothing is listed. */
  learning: boolean;
  /** When learning began: the later of the org's start and the cluster's first series. */
  since: string | null;
  /**
   * When the list turns on, by the worker's own rule: the moment it did, or, while learning,
   * when it will if learning goes on from now without another gap. Null before the worker
   * has seen the org.
   */
  until: string | null;
  /** The day of learning, 1 to 7: a day for every 24 hours of the week learned. */
  day: number | null;
  /** Hours of the week that have a baseline, of `hoursTotal` (168). */
  hoursLearned: number;
  hoursTotal: number;
  /**
   * One character per hour of the week, UTC, Sunday 00:00 first: 1 learned, 0 not seen yet,
   * 2 looked at twice with no data (nothing to learn there).
   */
  week: string;
  /** When learning went on after a gap (the org was off Pro, or nothing ran); null if none. */
  resumedAt: string | null;
  series: {
    /** Series read in the last hourly run; null before the first one. */
    total: number | null;
    /** How many the worker isn't scoring yet. */
    learning: number;
    /** When the last of those is ready; null when none is learning. */
    readyAt: string | null;
    breakdown: Breakdown;
  };
  /** The caller asked for the email when this cluster is ready (a session's user only). */
  emailWhenReady: boolean;
}

const cleanBreakdown = (raw: unknown): Breakdown => {
  const v = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  const out: Breakdown = {};
  if (v && typeof v === 'object') {
    for (const k of BREAKDOWN_KEYS) {
      const n = (v as Record<string, unknown>)[k];
      if (typeof n === 'number' && Number.isInteger(n) && n > 0) out[k] = n;
    }
  }
  return out;
};

/**
 * The learning state of an org's cluster (ADR-204, ADR-216, ADR-217), from the same coverage
 * the worker scores with. `userId` is the session's user, for "email me when it's ready";
 * leave it out for a token.
 */
export async function learningOf(
  db: Database,
  orgId: string,
  clusterId: string,
  nowMs: number,
  userId?: string,
): Promise<Learning> {
  const [org, row, asked, c] = await Promise.all([
    db
      .selectFrom('anomaly_orgs')
      .select('learning_since')
      .where('org_id', '=', orgId)
      .executeTakeFirst(),
    db
      .selectFrom('anomaly_learning')
      .select(['series', 'series_learning', 'learning_until', 'breakdown'])
      .where('org_id', '=', orgId)
      .where('cluster_id', '=', clusterId)
      .executeTakeFirst(),
    userId
      ? db
          .selectFrom('anomaly_ready_emails')
          .select('sent_at')
          .where('org_id', '=', orgId)
          .where('cluster_id', '=', clusterId)
          .where('user_id', '=', userId)
          .executeTakeFirst()
      : undefined,
    coverageOf(db, clusterId, nowMs),
  ]);
  const emailWhenReady = !!asked && asked.sent_at === null;
  const breakdown = cleanBreakdown(row?.breakdown);
  const hoursLearned = learnedHours(c);
  const base = { hoursLearned, hoursTotal: BUCKETS, week: weekString(c), emailWhenReady };
  if (!org) {
    return {
      ...base,
      learning: true,
      since: null,
      until: null,
      day: null,
      resumedAt: null,
      series: { total: null, learning: 0, readyAt: null, breakdown },
    };
  }
  const orgSince = org.learning_since.getTime();
  const since = Math.max(orgSince, c.firstSeen ?? orgSince);
  const learning = !clusterReady(c, nowMs);
  // Never before 7 days from the start, also while the first hour hasn't been read yet.
  const until = learning
    ? Math.max(estimateReady(c, nowMs), since + LEARNING_DAYS * DAY_MS)
    : estimateReady(c, nowMs);
  const total = row ? row.series : null;
  const lastReady = row?.learning_until ? row.learning_until.getTime() : null;
  // The cluster as a whole is learning: every series is. Afterwards: those that joined later
  // (the last hourly run's count, so up to an hour old).
  const stillLearning = learning
    ? (total ?? 0)
    : lastReady !== null && lastReady > nowMs
      ? (row?.series_learning ?? 0)
      : 0;
  const readyAt = learning ? until : stillLearning > 0 ? lastReady : null;
  return {
    ...base,
    learning,
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    day: learningDay(c),
    // What the worker recorded, or, for a gap older than the record, what the looks show.
    resumedAt: learning ? iso(c.resumedAt ?? resumedAt(c)) : null,
    series: {
      total,
      learning: stillLearning,
      readyAt: readyAt === null ? null : new Date(readyAt).toISOString(),
      breakdown,
    },
  };
}
