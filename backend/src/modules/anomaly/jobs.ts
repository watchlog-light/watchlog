// SPDX-License-Identifier: AGPL-3.0-only
// The anomaly-worker's jobs (ADR-196, ADR-197, ADR-198, ADR-204), on an injectable clock:
//   - every minute, per cluster of each entitled org: the last 11 minutes of each scored
//     series against its hour-of-week baseline; unusual periods open, extend or end. A series
//     is scored once the worker has learned every hour of the week since it was first seen
//     (coverage.ts, ADR-217): 7 days without a gap, longer when the org was off Pro, the
//     worker was down or the agents sent nothing for a while;
//   - every hour: the bucket of the hour that just ended, from that hour and the same hour
//     7 days before (two occurrences in 14 days), minus the minutes under a firing alert on
//     the series' subject; never data older than the org's `learning_since`; and the look at
//     that hour in the cluster's learning row, which the scoring above and the learning page
//     both read (ADR-216, ADR-217);
//   - the live demo only (ADR-203): the look-back, the 168 buckets before the worker's start
//     recomputed from the retained history, a day of them a run;
//   - with the hourly run: the housekeeping. Orgs that lost What changed stop at once (their
//     open periods end); 30 days later their baselines are deleted. Periods older than the
//     org's retention, and series gone for 14 days, are deleted.
// Each org's work runs inside withOrg (Cloud: watchlog_app under RLS, ADR-174); only the
// list of orgs and of the orgs' learning rows is read on the owner's connection.
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { withOrg } from '../../db/org-context.js';
import type { ClusterScope, QuerySeries, VictoriaQueryClient } from '../../lib/victoria.js';
import { clusterForOrg, listClusters } from '../clusters/service.js';
import { composeMap, excluded, firingAlerts, seriesTokens, type ComposeOf } from './exclusion.js';
import { seriesReady } from './coverage.js';
import { coverageOf, recordLearning } from './learning.js';
import {
  queriesFor,
  seriesHash,
  STEP_S,
  subjectOf,
  type ClusterKind,
  type KeyQuery,
} from './keys.js';
import {
  BUCKETS,
  DAY_MS,
  DEFAULT_RULE,
  HOUR_MS,
  MIN_BUCKET_MINUTES,
  WEEK_MS,
  WINDOW_DAYS,
  bucketOf,
  medianAndMad,
  scoreOf,
  usualRange,
  verdict,
  type Minute,
  type Rule,
} from './stats.js';

const MIN_MS = 60_000;
/** An org that lost What changed keeps its baselines this long (ADR-198, ADR-204). */
export const DOWNGRADE_KEEP_DAYS = 30;
/** Queries in flight per cluster. */
const CONCURRENCY = 4;
const CHUNK = 1_000;

export interface AnomalyLogger {
  warn(obj: object, msg: string): void;
}

export interface AnomalyDeps {
  /** The app connection; each org's work runs inside withOrg. */
  db: Database;
  /** The owner's connection: the learning rows across orgs (ADR-174's allow-list). */
  systemDb: Database;
  victoria: Pick<VictoriaQueryClient, 'queryRange'>;
  /** The orgs with What changed now (gate.ts entitledOrgs). */
  orgs: () => Promise<string[]>;
  /** Days an org's unusual periods are kept (its retention; default 30). */
  retentionDays?: (orgId: string) => Promise<number>;
  rule?: Rule;
  /** Spreads one minute's clusters over this many ms, so queries don't burst (0 in tests). */
  spreadMs?: number;
  /**
   * Days of retained history a newly seen org learns from (gate.ts lookBackDays): the live
   * demo's 14, everywhere else 0, so learning starts at the upgrade (ADR-203, ADR-204).
   */
  lookBackDays?: number;
  log: AnomalyLogger;
}

export interface AnomalyReport {
  orgs: number;
  clusters: number;
  series: number;
  opened: number;
  ended: number;
  errors: string[];
}

const emptyReport = (): AnomalyReport => ({
  orgs: 0,
  clusters: 0,
  series: 0,
  opened: 0,
  ended: 0,
  errors: [],
});

const hex = (b: Buffer) => b.toString('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Target {
  orgId: string;
  learningSince: number;
  clusterId: string;
  kind: ClusterKind;
  scope: ClusterScope;
}

/**
 * Records each entitled org's learning row: `learning_since` the first time it is seen with
 * What changed (the 0.8.0 deploy, or the switch to Pro), `entitled_at` every time (ADR-204).
 * Returns the orgs with their learning start.
 */
export async function syncOrgs(deps: AnomalyDeps, nowMs: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const now = new Date(nowMs);
  const since = new Date(nowMs - (deps.lookBackDays ?? 0) * DAY_MS);
  for (const orgId of await deps.orgs()) {
    const row = await withOrg(orgId, () =>
      deps.db
        .insertInto('anomaly_orgs')
        .values({ org_id: orgId, learning_since: since, entitled_at: now })
        .onConflict((oc) => oc.column('org_id').doUpdateSet({ entitled_at: now }))
        .returning('learning_since')
        .executeTakeFirstOrThrow(),
    );
    out.set(orgId, row.learning_since.getTime());
  }
  return out;
}

/** Every Kubernetes and Docker cluster of the entitled orgs. */
async function targets(deps: AnomalyDeps, orgs: Map<string, number>): Promise<Target[]> {
  const out: Target[] = [];
  for (const [orgId, learningSince] of orgs) {
    await withOrg(orgId, async () => {
      for (const { id } of await listClusters(deps.db, orgId)) {
        const c = await clusterForOrg(deps.db, orgId, id);
        if (!c || (c.kind !== 'kubernetes' && c.kind !== 'server')) continue;
        out.push({ orgId, learningSince, clusterId: id, kind: c.kind, scope: c.scope });
      }
    });
  }
  return out;
}

async function eachTarget(
  deps: AnomalyDeps,
  job: string,
  list: Target[],
  report: AnomalyReport,
  fn: (t: Target) => Promise<void>,
): Promise<void> {
  report.orgs = new Set(list.map((t) => t.orgId)).size;
  const pause = list.length > 1 && deps.spreadMs ? deps.spreadMs / list.length : 0;
  for (const [i, t] of list.entries()) {
    if (i > 0 && pause) await sleep(pause);
    try {
      await withOrg(t.orgId, () => fn(t));
      report.clusters++;
    } catch (err) {
      const msg = (err as Error).message;
      report.errors.push(`${t.clusterId}: ${msg}`);
      deps.log.warn({ job, cluster: t.clusterId, err: msg }, 'anomaly job failed for a cluster');
    }
  }
}

/** The keys a cluster has: its platform's, the edges, its integrations' types. */
async function clusterQueries(db: Database, t: Target): Promise<KeyQuery[]> {
  const types = await db
    .selectFrom('integrations')
    .select('type')
    .distinct()
    .where('cluster_id', '=', t.clusterId)
    .execute();
  return queriesFor(
    t.kind,
    types.map((r) => r.type),
  );
}

/** Runs the queries a few at a time. */
async function readAll(
  victoria: AnomalyDeps['victoria'],
  scope: ClusterScope,
  queries: KeyQuery[],
  ranges: { start: number; end: number }[],
): Promise<{ q: KeyQuery; series: QuerySeries[] }[]> {
  const jobs = queries.flatMap((q) => ranges.map((r) => ({ q, r })));
  const out: { q: KeyQuery; series: QuerySeries[] }[] = [];
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const part = await Promise.all(
      jobs.slice(i, i + CONCURRENCY).map(async ({ q, r }) => ({
        q,
        series: await victoria.queryRange(scope, q.expr, r.start / 1000, r.end / 1000, STEP_S),
      })),
    );
    out.push(...part);
  }
  return out;
}

// ------------------------------------------------------------------------------ the minute

interface Baseline {
  firstSeen: number;
  /** By bucket: median, MAD, minutes and the spread "normal for us" keeps (0: none). */
  buckets: Map<number, { median: number; mad: number; minutes: number; minSpread: number }>;
}

async function loadBaselines(db: Database, clusterId: string, buckets: number[]) {
  const idx = buckets.map((b) => sql.lit(b + 1));
  const rows = await sql<{
    series_hash: Buffer;
    first_seen: Date;
    med: (number | null)[];
    mad: (number | null)[];
    n: (number | null)[];
  }>`SELECT series_hash, first_seen,
            ARRAY[${sql.join(idx.map((i) => sql`medians[${i}]`))}] AS med,
            ARRAY[${sql.join(idx.map((i) => sql`mads[${i}]`))}] AS mad,
            ARRAY[${sql.join(idx.map((i) => sql`minutes[${i}]`))}] AS n
       FROM anomaly_baselines WHERE cluster_id = ${clusterId}`.execute(db);
  const widened = await loadWidenings(db, clusterId, buckets);
  const out = new Map<string, Baseline>();
  for (const r of rows.rows) {
    const key = hex(r.series_hash);
    const map: Baseline['buckets'] = new Map();
    buckets.forEach((b, i) =>
      map.set(b, {
        median: r.med[i] ?? 0,
        mad: r.mad[i] ?? 0,
        minutes: r.n[i] ?? 0,
        minSpread: widened.get(`${key}:${b}`) ?? 0,
      }),
    );
    out.set(key, { firstSeen: r.first_seen.getTime(), buckets: map });
  }
  return out;
}

/**
 * "Normal for us" answers not undone (ADR-200), for these buckets: the largest spread kept per
 * series and bucket, keyed `<series hash>:<bucket>`.
 */
async function loadWidenings(db: Database, clusterId: string, buckets: number[]) {
  const rows = await db
    .selectFrom('anomaly_feedback')
    .select(['series_hash', 'bucket', (eb) => eb.fn.max('min_spread').as('spread')])
    .where('cluster_id', '=', clusterId)
    .where('answer', '=', 'normal')
    .where('undone_at', 'is', null)
    .where('bucket', 'in', buckets)
    .groupBy(['series_hash', 'bucket'])
    .execute();
  return new Map(rows.map((r) => [`${hex(r.series_hash)}:${r.bucket}`, Number(r.spread) || 0]));
}

interface OpenPeriod {
  id: string;
  peakScore: number;
  lastAt: number;
}

/**
 * Every minute: each cluster's scored series over the last `rule.minutes + 1` minutes. A
 * series is scored once it has 7 days of data (every hour of the week recomputed since its
 * first sighting, coverage.ts; never data from before the org's learning start) and its
 * bucket has at least 30 minutes behind it.
 */
export async function runAnomalyMinute(deps: AnomalyDeps, nowMs: number): Promise<AnomalyReport> {
  const report = emptyReport();
  const list = await targets(deps, await syncOrgs(deps, nowMs));
  await eachTarget(deps, 'minute', list, report, (t) => scoreCluster(deps, t, nowMs, report));
  return report;
}

async function scoreCluster(deps: AnomalyDeps, t: Target, nowMs: number, report: AnomalyReport) {
  const rule = deps.rule ?? DEFAULT_RULE;
  const end = Math.floor(nowMs / MIN_MS) * MIN_MS - MIN_MS;
  const start = end - rule.minutes * MIN_MS;
  const minutes: number[] = [];
  for (let m = start; m <= end; m += MIN_MS) minutes.push(m);
  const buckets = [...new Set(minutes.map(bucketOf))];
  const baselines = await loadBaselines(deps.db, t.clusterId, buckets);
  const open = new Map<string, OpenPeriod>();
  for (const p of await deps.db
    .selectFrom('anomaly_periods')
    .select(['id', 'series_hash', 'peak_score', 'last_at'])
    .where('cluster_id', '=', t.clusterId)
    .where('ended_at', 'is', null)
    .execute()) {
    open.set(hex(p.series_hash), {
      id: p.id,
      peakScore: p.peak_score,
      lastAt: p.last_at.getTime(),
    });
  }
  if (!baselines.size && !open.size) return;
  // The one decision the learning page reports too (learning.ts reads the same coverage).
  const coverage = await coverageOf(deps.db, t.clusterId, nowMs);
  const ready = (b: Baseline) => seriesReady(coverage, b.firstSeen, nowMs);
  const seen = new Set<string>();
  const queries = await clusterQueries(deps.db, t);
  for (const { q, series } of await readAll(deps.victoria, t.scope, queries, [{ start, end }])) {
    for (const s of series) {
      const subject = subjectOf(s.labels);
      const hash = seriesHash(q.key, subject);
      const key = hex(hash);
      const base = baselines.get(key);
      if (!base || !ready(base)) continue;
      seen.add(key);
      report.series++;
      const values = new Map<number, number>();
      for (const [ts, v] of s.points) if (v !== null) values.set(ts * 1000, v);
      const window: Minute[] = minutes.map((m) => {
        const value = values.get(m) ?? null;
        const b = base.buckets.get(bucketOf(m));
        const usable = b && b.minutes >= MIN_BUCKET_MINUTES;
        return {
          t: m,
          value,
          score:
            value === null || !usable
              ? null
              : scoreOf(value, b.median, b.mad, q.unit, rule, b.minSpread),
        };
      });
      const was = open.get(key);
      const v = verdict(window, !!was, rule);
      const scored = window.filter((m) => m.score !== null);
      const newest = scored.at(-1);
      if (v.kind === 'open') {
        const run = window.filter((m) => m.t >= v.startedAt);
        const peak = run.reduce((a, m) => (m.score! > a.score! ? m : a));
        const bucket = bucketOf(v.startedAt);
        const b = base.buckets.get(bucket)!;
        const range = usualRange(b.median, b.mad, q.unit, rule, b.minSpread);
        const res = await deps.db
          .insertInto('anomaly_periods')
          .values({
            org_id: t.orgId,
            cluster_id: t.clusterId,
            series_hash: hash,
            metric: q.key,
            subject: JSON.stringify(subject),
            started_at: new Date(v.startedAt),
            bucket,
            median: b.median,
            usual_low: range.low,
            usual_high: range.high,
            peak_score: peak.score!,
            peak_value: peak.value!,
            peak_at: new Date(peak.t),
            last_value: newest!.value!,
            last_at: new Date(newest!.t),
          })
          .onConflict((oc) =>
            oc.columns(['cluster_id', 'series_hash']).where('ended_at', 'is', null).doNothing(),
          )
          .returning('id')
          .executeTakeFirst();
        if (res) report.opened++;
      } else if (was && newest) {
        const peak = scored.reduce((a, m) => (m.score! > a.score! ? m : a));
        const ending = v.kind === 'end';
        await deps.db
          .updateTable('anomaly_periods')
          .set({
            last_value: newest.value!,
            last_at: new Date(newest.t),
            ...(peak.score! > was.peakScore
              ? { peak_score: peak.score!, peak_value: peak.value!, peak_at: new Date(peak.t) }
              : {}),
            ...(ending ? { ended_at: new Date(v.endedAt) } : {}),
          })
          .where('id', '=', was.id)
          .where('ended_at', 'is', null)
          .execute();
        if (ending) report.ended++;
      } else if (was && v.kind === 'end') {
        await endPeriod(deps.db, was.id, v.endedAt);
        report.ended++;
      }
    }
  }
  // A series that stopped reporting: its period ends 10 minutes after its last minute.
  for (const [key, p] of open) {
    if (seen.has(key) || p.lastAt > end - rule.minutes * MIN_MS) continue;
    await endPeriod(deps.db, p.id, p.lastAt + MIN_MS);
    report.ended++;
  }
}

function endPeriod(db: Database, id: string, at: number) {
  return db
    .updateTable('anomaly_periods')
    .set({ ended_at: sql<Date>`greatest(started_at, ${new Date(at)})` })
    .where('id', '=', id)
    .where('ended_at', 'is', null)
    .execute();
}

// ------------------------------------------------------------------------------ the hour

/**
 * Every hour: the bucket of the hour that ended at or before `nowMs`, for every series of
 * every entitled cluster. Idempotent: running it twice for the same hour writes the same.
 */
export async function runAnomalyHour(deps: AnomalyDeps, nowMs: number): Promise<AnomalyReport> {
  const report = emptyReport();
  const hourEnd = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const list = await targets(deps, await syncOrgs(deps, nowMs));
  await eachTarget(deps, 'hour', list, report, async (t) => {
    report.series += await recomputeBucket(deps, t, hourEnd - HOUR_MS, { nowMs, full: true });
  });
  await housekeeping(deps, nowMs, report);
  return report;
}

/**
 * One bucket of one cluster: the minutes of the hour starting at `hour` and of the same
 * hour 7 days before, clipped at the org's learning start, without the minutes under a
 * firing alert on the series' subject (ADR-196). Returns the series written. With `clock` it
 * also records the look at that hour in the cluster's learning row (ADR-216, ADR-217), also
 * when nothing was read; `full` (the hourly run, not the demo's look-back) adds the series
 * it read and how many are still learning.
 */
export async function recomputeBucket(
  deps: AnomalyDeps,
  t: Target,
  hour: number,
  clock?: { nowMs: number; full: boolean },
) {
  const bucket = bucketOf(hour);
  const ranges: { start: number; end: number }[] = [];
  for (let back = 0; back * WEEK_MS < WINDOW_DAYS * DAY_MS; back++) {
    const from = Math.max(hour - back * WEEK_MS, t.learningSince);
    const to = hour - back * WEEK_MS + HOUR_MS;
    // Minute timestamps from `from` (rounded up to a minute) to the hour's last minute.
    const start = Math.ceil(from / MIN_MS) * MIN_MS;
    if (start < to) ranges.push({ start, end: to - MIN_MS });
  }
  if (!ranges.length) return 0; // the hour is before the org's learning start
  const composeOf: ComposeOf =
    t.kind === 'server' ? await composeMap(deps.db, t.clusterId) : new Map();
  const firing = await firingAlerts(
    deps.db,
    t.kind,
    t.clusterId,
    ranges.at(-1)!.start,
    hour + HOUR_MS,
    composeOf,
  );
  const series = new Map<
    string,
    {
      hash: Buffer;
      key: string;
      subject: Record<string, string>;
      tokens: Set<string>;
      first: number;
      last: number;
      values: number[];
    }
  >();
  const queries = await clusterQueries(deps.db, t);
  for (const { q, series: res } of await readAll(deps.victoria, t.scope, queries, ranges)) {
    for (const s of res) {
      const subject = subjectOf(s.labels);
      const hash = seriesHash(q.key, subject);
      const k = hex(hash);
      let acc = series.get(k);
      for (const [ts, v] of s.points) {
        const ms = ts * 1000;
        if (v === null || ms < t.learningSince || bucketOf(ms) !== bucket) continue;
        if (!acc) {
          acc = {
            hash,
            key: q.key,
            subject,
            tokens: seriesTokens(t.kind, subject, composeOf),
            first: ms,
            last: ms,
            values: [],
          };
          series.set(k, acc);
        }
        acc.first = Math.min(acc.first, ms);
        acc.last = Math.max(acc.last, ms);
        if (!excluded(ms, acc.tokens, firing)) acc.values.push(v);
      }
    }
  }
  const rows = [...series.values()];
  const firstSeen: number[] = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const stats = part.map((r) =>
      r.values.length ? medianAndMad(r.values) : { median: 0, mad: 0 },
    );
    // The series' row, then the bucket's element of each array (ADR-198: one element an hour).
    const written = await sql<{ first_seen: Date }>`
      INSERT INTO anomaly_baselines
        (org_id, cluster_id, series_hash, metric, subject, medians, mads, minutes, first_seen, last_seen)
      SELECT ${t.orgId}::uuid, ${t.clusterId}::uuid, u.h, u.m, u.s::jsonb,
             array_fill(0::real, ARRAY[${sql.lit(BUCKETS)}]),
             array_fill(0::real, ARRAY[${sql.lit(BUCKETS)}]),
             array_fill(0::smallint, ARRAY[${sql.lit(BUCKETS)}]),
             u.f, u.l
        FROM unnest(${part.map((r) => r.hash)}::bytea[], ${part.map((r) => r.key)}::text[],
                    ${part.map((r) => JSON.stringify(r.subject))}::text[],
                    ${part.map((r) => new Date(r.first).toISOString())}::timestamptz[],
                    ${part.map((r) => new Date(r.last).toISOString())}::timestamptz[])
             AS u(h, m, s, f, l)
      ON CONFLICT (cluster_id, series_hash) DO UPDATE
        SET first_seen = LEAST(anomaly_baselines.first_seen, excluded.first_seen),
            last_seen = GREATEST(anomaly_baselines.last_seen, excluded.last_seen)
      RETURNING first_seen`.execute(deps.db);
    for (const r of written.rows) firstSeen.push(r.first_seen.getTime());
    const el = sql.lit(bucket + 1);
    await sql`
      UPDATE anomaly_baselines b
         SET medians[${el}] = u.med, mads[${el}] = u.mad, minutes[${el}] = u.n
        FROM unnest(${part.map((r) => r.hash)}::bytea[], ${stats.map((s) => s.median)}::real[],
                    ${stats.map((s) => s.mad)}::real[],
                    ${part.map((r) => Math.min(r.values.length, 32767))}::smallint[])
             AS u(h, med, mad, n)
       WHERE b.cluster_id = ${t.clusterId}::uuid AND b.series_hash = u.h`.execute(deps.db);
  }
  // The worker looked at this hour, whatever it found: an hour with no data is a gap the
  // learning row must know about.
  if (clock) {
    await recordLearning(
      deps.db,
      t,
      hour,
      {
        withData: rows.filter((r) => r.values.length > 0).length,
        firstSeen,
        series: rows.map((r) => ({ key: r.key, subject: r.subject })),
      },
      clock,
    );
  }
  return rows.length;
}

// ------------------------------------------------------------------------------ the look-back

/** The look-back's progress per cluster: the hour it started from, and the hours done. */
export type LookBackState = Map<string, { anchor: number; done: number }>;
/** Hours of the look-back recomputed per cluster and run (a day: 7 runs for the week). */
export const LOOK_BACK_HOURS_PER_RUN = 24;

/**
 * The live demo only (ADR-203): once per worker process, each cluster's 168 buckets before
 * the hour that had ended when it was first seen, recomputed from the retained history (back
 * to the org's `learning_since`, which the look-back put 14 days back), with the same
 * firing-alert exclusion as every hour. So the demo's baselines exist the day it is deployed,
 * and a series with 7 days of retained data is scored at once. A day of buckets a run keeps
 * each tick short; a restart does it again (the recompute is idempotent). Does nothing
 * without `lookBackDays`, so Cloud and Community never read history from before the upgrade.
 */
export async function runAnomalyLookBack(
  deps: AnomalyDeps,
  nowMs: number,
  state: LookBackState,
): Promise<AnomalyReport> {
  const report = emptyReport();
  if (!deps.lookBackDays) return report;
  const list = (await targets(deps, await syncOrgs(deps, nowMs))).filter(
    (t) => (state.get(t.clusterId)?.done ?? 0) < BUCKETS,
  );
  await eachTarget(deps, 'look-back', list, report, async (t) => {
    const s = state.get(t.clusterId) ?? {
      anchor: Math.floor(nowMs / HOUR_MS) * HOUR_MS - HOUR_MS,
      done: 0,
    };
    state.set(t.clusterId, s);
    const stop = Math.min(BUCKETS, s.done + LOOK_BACK_HOURS_PER_RUN);
    for (; s.done < stop; s.done++) {
      report.series += await recomputeBucket(deps, t, s.anchor - s.done * HOUR_MS, {
        nowMs,
        full: false,
      });
    }
  });
  return report;
}

// ------------------------------------------------------------------------------ housekeeping

/**
 * Orgs that lost What changed: their open periods end now (scoring stops at once), and 30
 * days after they last had it their baselines and learning row are deleted, so an upgrade
 * within 30 days resumes and a later one learns again (ADR-198, ADR-204). For every org with
 * a learning row: periods older than its retention, and series gone for 14 days.
 */
async function housekeeping(deps: AnomalyDeps, nowMs: number, report: AnomalyReport) {
  const entitled = new Set(await deps.orgs());
  const known = await deps.systemDb
    .selectFrom('anomaly_orgs')
    .select(['org_id', 'entitled_at'])
    .execute();
  const now = new Date(nowMs);
  for (const row of known) {
    const orgId = row.org_id;
    try {
      await withOrg(orgId, async () => {
        if (!entitled.has(orgId)) {
          await deps.db
            .updateTable('anomaly_periods')
            .set({ ended_at: sql<Date>`greatest(started_at, last_at)` })
            .where('org_id', '=', orgId)
            .where('ended_at', 'is', null)
            .execute();
          if (row.entitled_at.getTime() < nowMs - DOWNGRADE_KEEP_DAYS * DAY_MS) {
            await deps.db.deleteFrom('anomaly_baselines').where('org_id', '=', orgId).execute();
            await deps.db.deleteFrom('anomaly_learning').where('org_id', '=', orgId).execute();
            await deps.db.deleteFrom('anomaly_orgs').where('org_id', '=', orgId).execute();
          }
        }
        const days = (await deps.retentionDays?.(orgId)) ?? 30;
        await deps.db
          .deleteFrom('anomaly_periods')
          .where('org_id', '=', orgId)
          .where('started_at', '<', new Date(nowMs - days * DAY_MS))
          .where('ended_at', 'is not', null)
          .execute();
        // Series gone for 14 days; not while the org is without What changed (no recompute
        // moves `last_seen` then, and its baselines are kept 30 days whole).
        if (entitled.has(orgId)) {
          await deps.db
            .deleteFrom('anomaly_baselines')
            .where('org_id', '=', orgId)
            .where('last_seen', '<', new Date(nowMs - WINDOW_DAYS * DAY_MS))
            .execute();
        }
      });
    } catch (err) {
      const msg = (err as Error).message;
      report.errors.push(`${orgId}: ${msg}`);
      deps.log.warn(
        { job: 'housekeeping', org: orgId, err: msg, at: now },
        'anomaly housekeeping failed',
      );
    }
  }
}
