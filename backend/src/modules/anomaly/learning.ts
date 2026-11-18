// SPDX-License-Identifier: AGPL-3.0-only
// What changed's learning week, as data (ADR-216, amending ADR-199 and ADR-204). Learning
// itself is unchanged: 7 days from the org's start or the cluster's first series, no
// look-back outside the demo. This file only reports it.
//   - The anomaly-worker writes one row per cluster (`anomaly_learning`) with each hourly
//     recompute, from what it already holds in memory: how many series have a baseline for
//     that hour of the week, how many series it read, how many are still inside their own
//     7 days, and their objects counted in the kind's words. The first time it sees a cluster
//     that already has baselines (the upgrade to 0.9.4), it fills the 168 hours from them once.
//   - The page, the alert card, the sidebar, the API and the MCP tool read that one row
//     (`learningOf`): the day, the hours of the week learned, the week as 168 characters, the
//     series and the caller's "email me when it's ready". Never a scan of the baselines.
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
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

/**
 * Records a recompute in the cluster's learning row. Always the bucket's hour; with `nowMs`
 * (the hourly run, not the demo's look-back) also the series read, how many are still
 * learning at `nowMs`, when the last of them is ready, and the breakdown. Runs inside the
 * org's context, like the recompute itself.
 */
export async function recordLearning(
  db: Database,
  t: { orgId: string; clusterId: string },
  bucket: number,
  stats: BucketStats,
  nowMs?: number,
): Promise<void> {
  const at = new Date(nowMs ?? Date.now());
  const known = await db
    .selectFrom('anomaly_learning')
    .select('cluster_id')
    .where('cluster_id', '=', t.clusterId)
    .executeTakeFirst();
  if (!known) {
    // Once per cluster: the hours its baselines already cover (a cluster that was learning
    // before this table existed), and its earliest series.
    await sql`
      INSERT INTO anomaly_learning (org_id, cluster_id, hours, first_seen, updated_at)
      SELECT ${t.orgId}::uuid, ${t.clusterId}::uuid,
             ARRAY(SELECT (count(bl.series_hash) FILTER (WHERE bl.minutes[b] > 0))::int
                     FROM generate_series(1, ${sql.lit(BUCKETS)}) AS b
                     LEFT JOIN anomaly_baselines bl ON bl.cluster_id = ${t.clusterId}::uuid
                    GROUP BY b ORDER BY b),
             (SELECT min(first_seen) FROM anomaly_baselines
               WHERE cluster_id = ${t.clusterId}::uuid),
             ${at}
      ON CONFLICT (cluster_id) DO NOTHING`.execute(db);
  }
  const first = stats.firstSeen.length ? new Date(least(stats.firstSeen)) : null;
  const el = sql.lit(bucket + 1);
  if (nowMs === undefined) {
    await sql`
      UPDATE anomaly_learning
         SET hours[${el}] = ${stats.withData}, first_seen = LEAST(first_seen, ${first}::timestamptz)
       WHERE cluster_id = ${t.clusterId}::uuid`.execute(db);
    return;
  }
  const learning = stats.firstSeen.filter((f) => nowMs - f < LEARNING_DAYS * DAY_MS);
  const until = learning.length ? new Date(greatest(learning) + LEARNING_DAYS * DAY_MS) : null;
  await sql`
    UPDATE anomaly_learning
       SET hours[${el}] = ${stats.withData},
           first_seen = LEAST(first_seen, ${first}::timestamptz),
           series = ${stats.series.length},
           series_learning = ${learning.length},
           learning_until = ${until}::timestamptz,
           breakdown = ${JSON.stringify(breakdownOf(stats.series))}::jsonb,
           updated_at = ${at}
     WHERE cluster_id = ${t.clusterId}::uuid`.execute(db);
}

const least = (values: number[]) => values.reduce((a, v) => (v < a ? v : a), Infinity);
const greatest = (values: number[]) => values.reduce((a, v) => (v > a ? v : a), -Infinity);

export interface Learning {
  /** True for 7 days from `since`: nothing is listed. */
  learning: boolean;
  /** When learning began: the later of the org's start and the cluster's first series. */
  since: string | null;
  /** 7 days after `since`; null when the worker hasn't seen the org yet. */
  until: string | null;
  /** The day of learning, 1 to 7; null before it started. */
  day: number | null;
  /** Hours of the week that have a baseline, of `hoursTotal` (168). */
  hoursLearned: number;
  hoursTotal: number;
  /** One character per hour of the week, UTC, Sunday 00:00 first: 1 learned, 0 not yet. */
  week: string;
  series: {
    /** Series read in the last hourly run; null before the first one. */
    total: number | null;
    /** How many are still inside their own 7 days. */
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
 * The learning state of an org's cluster (ADR-204, ADR-216): two or three single-row reads.
 * `userId` is the session's user, for "email me when it's ready"; leave it out for a token.
 */
export async function learningOf(
  db: Database,
  orgId: string,
  clusterId: string,
  nowMs: number,
  userId?: string,
): Promise<Learning> {
  const [org, row, asked] = await Promise.all([
    db
      .selectFrom('anomaly_orgs')
      .select('learning_since')
      .where('org_id', '=', orgId)
      .executeTakeFirst(),
    db
      .selectFrom('anomaly_learning')
      .select(['hours', 'series', 'series_learning', 'learning_until', 'first_seen', 'breakdown'])
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
  ]);
  const hours = row?.hours ?? [];
  const week = Array.from({ length: BUCKETS }, (_, i) => ((hours[i] ?? 0) > 0 ? '1' : '0')).join(
    '',
  );
  const hoursLearned = week.split('1').length - 1;
  const emailWhenReady = !!asked && asked.sent_at === null;
  const breakdown = cleanBreakdown(row?.breakdown);
  if (!org) {
    return {
      learning: true,
      since: null,
      until: null,
      day: null,
      hoursLearned,
      hoursTotal: BUCKETS,
      week,
      series: { total: null, learning: 0, readyAt: null, breakdown },
      emailWhenReady,
    };
  }
  const orgSince = org.learning_since.getTime();
  let first: Date | string | null | undefined = row?.first_seen;
  if (!row) {
    // Until the worker's next hourly run writes the row (the hour after an upgrade to 0.9.4).
    const f = await db
      .selectFrom('anomaly_baselines')
      .select((eb) => eb.fn.min('first_seen').as('first'))
      .where('org_id', '=', orgId)
      .where('cluster_id', '=', clusterId)
      .executeTakeFirst();
    first = f?.first as Date | string | null | undefined;
  }
  const since = Math.max(orgSince, first ? new Date(first).getTime() : orgSince);
  const until = since + LEARNING_DAYS * DAY_MS;
  const learning = nowMs < until;
  const total = row ? row.series : null;
  const lastReady = row?.learning_until ? row.learning_until.getTime() : null;
  // The cluster as a whole is learning: every series is. Afterwards: those that joined later.
  const stillLearning = learning
    ? (total ?? 0)
    : lastReady !== null && lastReady > nowMs
      ? (row?.series_learning ?? 0)
      : 0;
  const readyAt = learning
    ? Math.max(until, lastReady ?? until)
    : stillLearning > 0
      ? lastReady
      : null;
  return {
    learning,
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    day: Math.min(LEARNING_DAYS, Math.max(1, Math.floor((nowMs - since) / DAY_MS) + 1)),
    hoursLearned,
    hoursTotal: BUCKETS,
    week,
    series: {
      total,
      learning: stillLearning,
      readyAt: readyAt === null ? null : new Date(readyAt).toISOString(),
      breakdown,
    },
    emailWhenReady,
  };
}
