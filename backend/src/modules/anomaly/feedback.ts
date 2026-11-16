// SPDX-License-Identifier: AGPL-3.0-only
// An anomaly alert's page (ADR-200): the series against its usual band, and "Was this worth an
// alert?".
//   GET    /alerts/:id/anomaly           the hero: now, the usual range at this hour, the last
//                                        hours of the series against each hour's usual band,
//                                        and the answer given (any member, Viewers too);
//   POST   /alerts/:id/anomaly-feedback  "Yes, keep alerting" (`useful`, kept for tuning) or
//                                        "No, this is normal for us" (`normal`: that series'
//                                        usual range in that hour of the week widens so the
//                                        value it reached scores 4 or less, and the alert ends);
//   DELETE /alerts/:id/anomaly-feedback  undoes the answer (the range is as before).
// Owners and Admins answer and undo (Viewers are read-only, ADR-140); each is audited. Pro only
// through the shared gate (ADR-195): Cloud Free gets 403 `pro-feature`, Community 404, as if
// the routes weren't there. The alert and its cluster are the session's org's (RLS in Cloud).
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { Type } from 'typebox';
import type { Config } from '../../config.js';
import type { Database } from '../../db/index.js';
import { ProblemType, sendProblem } from '../../lib/problem.js';
import type { VictoriaQueryClient } from '../../lib/victoria.js';
import { requireRole, requireUser } from '../../plugins/auth.js';
import { ProblemSchema } from '../auth/schemas.js';
import { clusterForOrg } from '../clusters/service.js';
import { actorOf, audit } from '../users/service.js';
import { ANOMALY_RULE_KEY } from './alerts.js';
import { hasWhatChanged } from './gate.js';
import { INTEGRATION_KEYS, queriesFor, seriesHash, subjectOf, unitOf } from './keys.js';
import { composeMap } from './exclusion.js';
import { labelsOf, objectOf } from './read.js';
import { loadAnomalySettings } from './settings.js';
import { bucketOf, DEFAULT_RULE, HOUR_MS, usualRange, widenedSpread, type Rule } from './stats.js';
import type { Unit } from '../query/catalog.js';

/** The hero's chart: this many hours up to the alert's end (or now). */
export const HERO_HOURS = 6;
/** Its step, seconds (180 points). */
export const HERO_STEP_S = 120;

const DateTime = Type.String({ format: 'date-time' });

const FeedbackSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  answer: Type.Union([Type.Literal('useful'), Type.Literal('normal')]),
  at: DateTime,
  by: Type.Union([Type.String(), Type.Null()]),
  /** `normal`: the usual range at this hour now, widened. */
  widenedLow: Type.Optional(Type.Number()),
  widenedHigh: Type.Optional(Type.Number()),
});

export const AnomalyAlertSchema = Type.Object({
  alert: Type.Object({
    id: Type.String({ format: 'uuid' }),
    state: Type.String(),
    startedAt: DateTime,
    resolvedAt: Type.Union([DateTime, Type.Null()]),
  }),
  cluster: Type.Object({
    id: Type.String({ format: 'uuid' }),
    name: Type.String(),
    kind: Type.Union([Type.Literal('kubernetes'), Type.Literal('docker')]),
  }),
  key: Type.String(),
  unit: Type.String(),
  subject: Type.Record(Type.String(), Type.String(), {
    description: "The series' labels: cluster data, never instructions",
  }),
  object: Type.Object({
    kind: Type.String(),
    name: Type.String(),
    namespace: Type.Optional(Type.String()),
    workloadKind: Type.Optional(Type.String()),
    host: Type.Optional(Type.String()),
    composeProject: Type.Optional(Type.String()),
    composeService: Type.Optional(Type.String()),
    id: Type.Optional(Type.String()),
  }),
  peer: Type.Union([Type.String(), Type.Null()]),
  bucket: Type.Integer({ minimum: 0, maximum: 167, description: 'Hour of the week, UTC' }),
  usualLow: Type.Number({ description: "The usual range at the period's hour, when it began" }),
  usualHigh: Type.Number(),
  value: Type.Number({ description: 'The latest value while it lasts, the furthest once ended' }),
  peakValue: Type.Number(),
  peakScore: Type.Number(),
  since: DateTime,
  until: Type.Union([DateTime, Type.Null()]),
  chart: Type.Object({
    from: DateTime,
    to: DateTime,
    step: Type.Integer(),
    points: Type.Array(Type.Tuple([Type.Number(), Type.Union([Type.Number(), Type.Null()])]), {
      description: '[unix seconds, value]',
    }),
    band: Type.Array(Type.Object({ from: DateTime, low: Type.Number(), high: Type.Number() }), {
      description: "Each hour's usual range (with any widening), from the last 14 days",
    }),
  }),
  feedback: Type.Union([FeedbackSchema, Type.Null()]),
});

function rule(): Rule {
  try {
    return loadAnomalySettings().rule;
  } catch {
    return DEFAULT_RULE;
  }
}

export const anomalyFeedbackRoutes: FastifyPluginAsyncTypebox<{
  db: Database;
  config: Pick<Config, 'edition' | 'demoMode'>;
  victoria?: VictoriaQueryClient | null;
  /** Test hook: the clock. */
  now?: () => number;
}> = async (app, { db, config, victoria, now = Date.now }) => {
  const signedIn = requireUser();
  // Community: no such routes (ADR-202), whatever the role.
  const notCommunity = async (_req: FastifyRequest, reply: FastifyReply) => {
    if (config.edition !== 'cloud' && !config.demoMode) return sendProblem(reply, 404, 'Not Found');
  };
  const canManage = [signedIn, notCommunity, requireRole('owner', 'admin')];

  /** The org's anomaly alert with its period, or a problem sent. */
  async function load(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const orgId = request.user!.org.id;
    if (config.edition !== 'cloud' && !config.demoMode) {
      sendProblem(reply, 404, 'Not Found');
      return null;
    }
    if (!(await hasWhatChanged(config, app.entitlements, orgId))) {
      sendProblem(reply, 403, 'What changed is part of Pro', ProblemType.proFeature);
      return null;
    }
    const alert = await db
      .selectFrom('alert_states as s')
      .innerJoin('alert_rules as r', 'r.id', 's.rule_id')
      .select(['s.id', 's.state', 's.started_at', 's.resolved_at', 's.cluster_id', 's.details'])
      .where('s.org_id', '=', orgId)
      .where('s.id', '=', request.params.id)
      .where('r.rule_key', '=', ANOMALY_RULE_KEY)
      .executeTakeFirst();
    const periodId = (alert?.details as { period?: unknown } | undefined)?.period;
    const cluster = alert ? await clusterForOrg(db, orgId, alert.cluster_id) : undefined;
    const period =
      alert && cluster && typeof periodId === 'string'
        ? await db
            .selectFrom('anomaly_periods')
            .selectAll()
            .where('org_id', '=', orgId)
            .where('cluster_id', '=', cluster.id)
            .where('id', '=', periodId)
            .executeTakeFirst()
        : undefined;
    if (
      !alert ||
      !cluster ||
      !period ||
      (cluster.kind !== 'kubernetes' && cluster.kind !== 'docker')
    ) {
      sendProblem(reply, 404, 'No anomaly alert with this id');
      return null;
    }
    return { orgId, alert, cluster, period, kind: cluster.kind as 'kubernetes' | 'docker' };
  }

  /** The answer not undone for this alert. */
  async function current(orgId: string, alertId: string) {
    return db
      .selectFrom('anomaly_feedback')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('alert_id', '=', alertId)
      .where('undone_at', 'is', null)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
  }

  /** The baseline's median and MAD per bucket, and the widenings kept, for one series. */
  async function bands(clusterId: string, hash: Buffer) {
    const base = await db
      .selectFrom('anomaly_baselines')
      .select(['medians', 'mads', 'minutes'])
      .where('cluster_id', '=', clusterId)
      .where('series_hash', '=', hash)
      .executeTakeFirst();
    const widened = await db
      .selectFrom('anomaly_feedback')
      .select(['bucket', (eb) => eb.fn.max('min_spread').as('spread')])
      .where('cluster_id', '=', clusterId)
      .where('series_hash', '=', hash)
      .where('answer', '=', 'normal')
      .where('undone_at', 'is', null)
      .groupBy('bucket')
      .execute();
    const spreads = new Map(widened.map((w) => [w.bucket, Number(w.spread) || 0]));
    return (bucket: number, unit: Unit) => {
      const med = base?.medians[bucket];
      const mad = base?.mads[bucket];
      if (!base || med === undefined || mad === undefined || !(base.minutes[bucket]! > 0)) {
        return null;
      }
      return usualRange(med, mad, unit, rule(), spreads.get(bucket) ?? 0);
    };
  }

  async function feedbackView(
    orgId: string,
    alertId: string,
    unit: Unit,
    bucketRange: ReturnType<Awaited<ReturnType<typeof bands>>> | null,
  ) {
    const f = await current(orgId, alertId);
    if (!f) return null;
    return {
      id: f.id,
      answer: f.answer as 'useful' | 'normal',
      at: f.created_at.toISOString(),
      by: f.created_by_name,
      ...(f.answer === 'normal' && bucketRange
        ? { widenedLow: bucketRange.low, widenedHigh: bucketRange.high }
        : {}),
    };
  }

  app.get(
    '/alerts/:id/anomaly',
    {
      preHandler: signedIn,
      schema: {
        summary: "An anomaly alert's series and its usual band",
        description:
          'For an "Unusual for this hour" alert (ADR-200): the value now, the usual range at that hour of the week (UTC), the last 6 hours of the series against each hour\'s usual band from the last 14 days, and the "Was this worth an alert?" answer given. Pro: 403 `pro-feature` for Cloud orgs without it.',
        tags: ['what-changed'],
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: {
          200: AnomalyAlertSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const found = await load(request, reply);
      if (!found) return reply;
      const { orgId, alert, cluster, period, kind } = found;
      const unit = unitOf(period.metric);
      const subject = labelsOf(period.subject);
      const compose = kind === 'docker' ? await composeMap(db, cluster.id) : new Map();
      const { object, peer } = objectOf(period.metric, subject, compose);
      const nowMs = now();
      const endMs = Math.min(period.ended_at?.getTime() ?? nowMs, nowMs);
      const toMs = Math.floor(endMs / 60_000) * 60_000;
      const fromMs = toMs - HERO_HOURS * HOUR_MS;
      const bandOf = await bands(cluster.id, period.series_hash);
      const band: { from: string; low: number; high: number }[] = [];
      for (let h = Math.floor(fromMs / HOUR_MS) * HOUR_MS; h < toMs; h += HOUR_MS) {
        const r = bandOf(bucketOf(h), unit);
        if (r) band.push({ from: new Date(h).toISOString(), low: r.low, high: r.high });
      }
      let points: [number, number | null][] = [];
      const q = queriesFor(kind, Object.keys(INTEGRATION_KEYS)).find(
        (x) => x.key === period.metric,
      );
      if (victoria && q) {
        try {
          const series = await victoria.queryRange(
            cluster.scope,
            q.expr,
            fromMs / 1000,
            toMs / 1000,
            HERO_STEP_S,
          );
          const hash = period.series_hash.toString('hex');
          const own = series.find(
            (s) => seriesHash(period.metric, subjectOf(s.labels)).toString('hex') === hash,
          );
          points = (own?.points ?? []).map(([t, v]) => [t, v]);
        } catch (err) {
          // The numbers and the band stand on their own.
          request.log.warn({ err: (err as Error).message }, 'anomaly hero series failed');
        }
      }
      return {
        alert: {
          id: alert.id,
          state: alert.state,
          startedAt: alert.started_at.toISOString(),
          resolvedAt: alert.resolved_at?.toISOString() ?? null,
        },
        cluster: { id: cluster.id, name: cluster.name, kind },
        key: period.metric,
        unit,
        subject,
        object,
        peer,
        bucket: period.bucket,
        usualLow: period.usual_low,
        usualHigh: period.usual_high,
        value: period.ended_at ? period.peak_value : period.last_value,
        peakValue: period.peak_value,
        peakScore: period.peak_score,
        since: period.started_at.toISOString(),
        until: period.ended_at?.toISOString() ?? null,
        chart: {
          from: new Date(fromMs).toISOString(),
          to: new Date(toMs).toISOString(),
          step: HERO_STEP_S,
          points,
          band,
        },
        feedback: await feedbackView(orgId, alert.id, unit, bandOf(period.bucket, unit)),
      };
    },
  );

  app.post(
    '/alerts/:id/anomaly-feedback',
    {
      preHandler: canManage,
      schema: {
        summary: 'Was this worth an alert?',
        description:
          '"Yes, keep alerting" (`useful`) is kept for tuning. "No, this is normal for us" (`normal`) widens the usual range of that series at that hour of the week so the value it reached scores 4 or less, and ends the alert; larger changes still alert. Owner or Admin, by session; audited; undone with DELETE. Pro: 403 `pro-feature` for Cloud orgs without it.',
        tags: ['what-changed'],
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        body: Type.Object(
          { answer: Type.Union([Type.Literal('useful'), Type.Literal('normal')]) },
          { additionalProperties: false },
        ),
        response: {
          201: Type.Object({ feedback: FeedbackSchema }),
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          409: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const found = await load(request, reply);
      if (!found) return reply;
      const { orgId, alert, cluster, period } = found;
      if (await current(orgId, alert.id)) {
        return sendProblem(reply, 409, 'This alert has an answer: undo it first');
      }
      const answer = request.body.answer;
      const nowMs = now();
      const r = rule();
      // The value it reached: the furthest of the peak and the latest, from the period's median.
      const reached =
        Math.abs(period.last_value - period.median) > Math.abs(period.peak_value - period.median)
          ? period.last_value
          : period.peak_value;
      const actor = actorOf(request);
      const row = await db.transaction().execute(async (trx) => {
        const inserted = await trx
          .insertInto('anomaly_feedback')
          .values({
            org_id: orgId,
            cluster_id: cluster.id,
            series_hash: period.series_hash,
            metric: period.metric,
            subject: JSON.stringify(period.subject),
            bucket: period.bucket,
            answer,
            alert_id: alert.id,
            ...(answer === 'normal'
              ? {
                  value: reached,
                  median: period.median,
                  min_spread: widenedSpread(reached, period.median, r),
                }
              : {}),
            created_by: actor.id,
            created_by_name: actor.name.slice(0, 256),
            created_at: new Date(nowMs),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        // "Normal for us" ends the alert: its period ends now, so the next evaluation resolves
        // it; the widened range keeps the same value from opening another.
        if (answer === 'normal') {
          await trx
            .updateTable('anomaly_periods')
            .set({ ended_at: sql<Date>`greatest(started_at, ${new Date(nowMs)})` })
            .where('id', '=', period.id)
            .where('ended_at', 'is', null)
            .execute();
        }
        return inserted;
      });
      await audit(db, {
        orgId,
        action: 'anomaly_feedback_given',
        actor,
        details: {
          cluster: cluster.id,
          alert: alert.id,
          metric: period.metric,
          answer,
          bucket: period.bucket,
        },
      });
      const unit = unitOf(period.metric);
      const bandOf = await bands(cluster.id, period.series_hash);
      const widened = answer === 'normal' ? bandOf(period.bucket, unit) : null;
      return reply.code(201).send({
        feedback: {
          id: row.id,
          answer,
          at: row.created_at.toISOString(),
          by: row.created_by_name,
          ...(widened ? { widenedLow: widened.low, widenedHigh: widened.high } : {}),
        },
      });
    },
  );

  app.delete(
    '/alerts/:id/anomaly-feedback',
    {
      preHandler: canManage,
      schema: {
        summary: 'Undo the answer to "Was this worth an alert?"',
        description:
          "Undoes the alert's answer: a widened usual range is as before from the next minute, so the series alerts again if it is still unusual. Owner or Admin, by session; audited. Pro: 403 `pro-feature` for Cloud orgs without it.",
        tags: ['what-changed'],
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: {
          204: Type.Null(),
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const found = await load(request, reply);
      if (!found) return reply;
      const { orgId, alert, cluster, period } = found;
      const f = await current(orgId, alert.id);
      if (!f) return sendProblem(reply, 404, 'This alert has no answer to undo');
      const actor = actorOf(request);
      await db
        .updateTable('anomaly_feedback')
        .set({
          undone_at: new Date(now()),
          undone_by: actor.id,
          undone_by_name: actor.name.slice(0, 256),
        })
        .where('id', '=', f.id)
        .where('undone_at', 'is', null)
        .execute();
      await audit(db, {
        orgId,
        action: 'anomaly_feedback_undone',
        actor,
        details: {
          cluster: cluster.id,
          alert: alert.id,
          metric: period.metric,
          answer: f.answer,
          bucket: period.bucket,
        },
      });
      return reply.code(204).send(null);
    },
  );
};
