// SPDX-License-Identifier: AGPL-3.0-only
// The Alerts tab of Your metrics (1.0.0, ADR-236): the rules on a cluster's own metrics, with
// what each says and whether it fires; "New alert" with its sentence before it is saved; and
// "Watch with What changed" (Pro, ADR-238). The rules are rows of alert_rules: they also show
// under Alerts with every other rule, and their alerts on the workload or server they name.
//
//   Cloud Free             no alerts on own metrics (the tab says so; the server refuses too)
//   Community              threshold alerts: above, below, not reported for, older than
//   Cloud Pro, licence     those, and "outside its usual range" on a watched metric
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply } from 'fastify';
import { Type, type Static } from 'typebox';
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { ProblemType, sendProblem } from '../../lib/problem.js';
import type { VictoriaQueryClient } from '../../lib/victoria.js';
import { PUBLIC_TAG } from '../../openapi/public.js';
import { requireRole, requireUser } from '../../plugins/auth.js';
import { ProblemSchema } from '../auth/schemas.js';
import { clusterForOrg } from '../clusters/service.js';
import { sendPlanLimit } from '../entitlements/limits.js';
import { OWN_WATCHED } from '../entitlements/own-metrics.js';
import {
  conditionWords,
  OWN_IS,
  OWN_RULE_TYPE,
  ownHits,
  ownSentence,
  ownSpecOf,
  type OwnIs,
  type OwnSpec,
} from './alerts.js';
import { listMetrics, type MetricInfo } from './read.js';
import type { OwnMetrics } from './service.js';
import type { OwnUsual } from './usual.js';

const lits = <T extends readonly string[]>(values: T) =>
  Type.Union(values.map((v) => Type.Literal(v))) as unknown as ReturnType<
    typeof Type.Unsafe<T[number]>
  >;
const Params = Type.Object({ id: Type.String({ format: 'uuid' }) });
const N = Type.Union([Type.Number(), Type.Null()]);
const TAGS = [PUBLIC_TAG, 'own-metrics'];
const PANEL = ['own-metrics'];
const IsS = lits(OWN_IS);
const PerS = lits(['s', 'min', 'h'] as const);
const SeverityS = lits(['warning', 'critical'] as const);

const RuleS = Type.Object({
  id: Type.String(),
  name: Type.String(),
  metric: Type.String(),
  /** The metric's id while it reports; null when it is gone (the rule rests). */
  metricId: Type.Union([Type.String(), Type.Null()]),
  is: IsS,
  value: N,
  per: Type.Union([PerS, Type.Null()]),
  forSeconds: Type.Integer(),
  severity: SeverityS,
  enabled: Type.Boolean(),
  channelIds: Type.Array(Type.String()),
  /** "above 500 for 15 min", as the list and the notification word it. */
  condition: Type.String(),
  firing: Type.Integer(),
  /** When it last started firing (ms); null when it never did. */
  lastFiredAt: N,
  evalError: Type.Union([Type.String(), Type.Null()]),
});

const NewRule = Type.Object({
  metricId: Type.String({ format: 'uuid' }),
  is: IsS,
  /** above, below: the value, a rate per second; absent, older: seconds. Not for unusual. */
  value: Type.Optional(Type.Number()),
  per: Type.Optional(PerS),
  forSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 86400 })),
  severity: Type.Optional(SeverityS),
  channelIds: Type.Optional(Type.Array(Type.String({ format: 'uuid' }), { maxItems: 20 })),
  name: Type.Optional(Type.String({ maxLength: 200 })),
});
type NewRuleT = Static<typeof NewRule>;

export interface OwnAlertRoutesOptions {
  db: Database;
  own: OwnMetrics;
  usual: OwnUsual;
  victoria: VictoriaQueryClient | null | undefined;
}

const NOT_FOUND = 'Cluster or fleet not found';
const NAMES: Record<OwnIs, string> = {
  above: 'above',
  below: 'below',
  absent: 'not reported',
  older: 'too old',
  unusual: 'outside its usual range',
};

export const ownAlertRoutes: FastifyPluginAsyncTypebox<OwnAlertRoutesOptions> = async (
  app,
  { db, own, usual, victoria },
) => {
  const read = [requireUser(), requireRole('owner', 'admin', 'viewer')];
  const write = [requireUser(), requireRole('owner', 'admin')];

  /** What the plan refuses, answered; false when the rule may be made. */
  function refused(
    reply: FastifyReply,
    limits: { alerts: string; usualRange: boolean },
    is: OwnIs,
  ) {
    if (limits.alerts === 'none') {
      sendPlanLimit(
        reply,
        402,
        'own-alerts',
        0,
        'Alerts on your own metrics are part of Pro. Upgrade to be told when a number goes wrong.',
      );
      return true;
    }
    if (is === 'unusual' && !limits.usualRange) {
      sendProblem(
        reply,
        403,
        '"Outside its usual range" is part of Pro; a value to compare with works on every plan',
        ProblemType.proFeature,
      );
      return true;
    }
    return false;
  }

  /** Checks a rule against its metric; the words of what is wrong, or null. */
  function mistake(m: MetricInfo, b: NewRuleT): string | null {
    if (m.refused)
      return `${m.name} is refused (too many values for ${m.refused.label}): fix that first`;
    if (b.is === 'unusual') {
      return m.watched
        ? null
        : 'Watch this metric with What changed first: its usual range is learnt from then on';
    }
    if (b.value === undefined || !Number.isFinite(b.value)) return 'Give the value to compare with';
    if (b.is === 'older') {
      if (m.type !== 'timestamp')
        return '"Older than" is for timestamps (a name ending in _timestamp)';
      return b.value > 0 ? null : 'Give how old is too old';
    }
    if (b.is === 'absent')
      return b.value >= 60 ? null : '"Not reported for" takes a minute at least';
    if (m.type === 'timestamp') return 'A timestamp is alerted on with "older than"';
    return null;
  }

  app.get(
    '/clusters/:id/own-metrics/alerts',
    {
      preHandler: read,
      schema: {
        summary: 'The alert rules on your own metrics, with what each says and whether it fires',
        tags: TAGS,
        params: Params,
        response: {
          200: Type.Object({
            rules: Type.Array(RuleS),
            /** What the plan allows: none (Cloud Free), threshold, or all (with the usual range). */
            allowed: lits(['none', 'threshold', 'all'] as const),
            watched: Type.Object({ used: Type.Integer(), max: Type.Integer() }),
          }),
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, NOT_FOUND);
      const [rows, states, metrics, usage, watched] = await Promise.all([
        db
          .selectFrom('alert_rules')
          .selectAll()
          .where('org_id', '=', cluster.org_id)
          .where('cluster_id', '=', cluster.id)
          .where('type', '=', OWN_RULE_TYPE)
          .orderBy('created_at')
          .execute(),
        db
          .selectFrom('alert_states')
          .select([
            'rule_id',
            (eb) => eb.fn.count<string>('id').filterWhere('state', '=', 'firing').as('firing'),
            (eb) => eb.fn.max('fired_at').as('last'),
          ])
          .where('org_id', '=', cluster.org_id)
          .where('cluster_id', '=', cluster.id)
          .groupBy('rule_id')
          .execute(),
        listMetrics(db, cluster.id),
        own.usage(cluster.org_id),
        db
          .selectFrom('own_metrics')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('org_id', '=', cluster.org_id)
          .where('watched_at', 'is not', null)
          .executeTakeFirst(),
      ]);
      const state = new Map(states.map((s) => [s.rule_id, s]));
      const byName = new Map(metrics.map((m) => [m.name, m]));
      return {
        allowed: usage.limits.alerts,
        watched: { used: Number(watched?.n ?? 0), max: usage.limits.watched },
        rules: rows.flatMap((r) => {
          const spec = ownSpecOf(r.scope);
          if (!spec) return [];
          const m = byName.get(spec.metric);
          const value = (r.condition as { value?: number }).value ?? null;
          const st = state.get(r.id);
          return [
            {
              id: r.id,
              name: r.name,
              metric: spec.metric,
              metricId: m?.id ?? null,
              is: spec.is,
              value,
              per: spec.per ?? null,
              forSeconds: r.for_seconds,
              severity: r.severity as 'warning' | 'critical',
              enabled: r.enabled,
              channelIds: r.channel_ids,
              condition: conditionWords({
                is: spec.is,
                threshold: value,
                forSeconds: r.for_seconds,
                showing: m ?? { unit: 'count', shown: 'as_is' },
                per: spec.per,
              }),
              firing: Number(st?.firing ?? 0),
              lastFiredAt: st?.last ? new Date(st.last as unknown as string).getTime() : null,
              evalError: r.eval_error,
            },
          ];
        }),
      };
    },
  );

  /** The metric a body names, and the rule as it would be stored. */
  async function prepared(orgId: string, clusterId: string, b: NewRuleT, reply: FastifyReply) {
    const usage = await own.usage(orgId);
    if (refused(reply, usage.limits, b.is)) return null;
    const [m] = await listMetrics(db, clusterId, { ids: [b.metricId] });
    if (!m) {
      sendProblem(reply, 404, 'Metric not found');
      return null;
    }
    const wrong = mistake(m, b);
    if (wrong) {
      sendProblem(reply, 400, wrong);
      return null;
    }
    const threshold = b.is === 'unusual' ? null : (b.value ?? null);
    // "Not reported for" and "older than" carry their time in the value itself.
    const forSeconds = b.is === 'absent' || b.is === 'older' ? 0 : (b.forSeconds ?? 300);
    const spec: OwnSpec = {
      metric: m.name,
      is: b.is,
      ...(m.shown === 'rate' && b.per ? { per: b.per } : {}),
    };
    return { m, spec, threshold, forSeconds };
  }

  app.post(
    '/clusters/:id/own-metrics/alerts/preview',
    {
      preHandler: write,
      schema: {
        summary: 'What an alert would say now, before it is made',
        tags: PANEL,
        params: Params,
        body: NewRule,
        response: {
          200: Type.Object({
            sentence: Type.String(),
            condition: Type.String(),
            /** Whether the condition holds now for any workload or server. */
            holds: Type.Boolean(),
          }),
          400: ProblemSchema,
          401: ProblemSchema,
          402: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, NOT_FOUND);
      const p = await prepared(cluster.org_id, cluster.id, request.body, reply);
      if (!p) return reply;
      const ctx = {
        victoria: victoria ?? undefined,
        cluster: { id: cluster.id, name: cluster.name, kind: cluster.kind as 'kubernetes' },
        now: Date.now(),
      };
      const every = victoria
        ? await ownHits(ctx, p.m, p.spec, p.threshold, usual, true).catch(() => [])
        : [];
      const op = p.spec.is === 'below' ? -1 : 1;
      const breaks = (v: number, low?: number, high?: number) =>
        p.spec.is === 'unusual'
          ? low !== undefined && high !== undefined && (v < low || v > high)
          : p.threshold !== null && (v - p.threshold) * op > 0;
      // The one that would fire, else the one nearest to it.
      const pick =
        every.find((h) => breaks(h.value, h.low, h.high)) ??
        [...every].sort((a, b) => (b.value - a.value) * op)[0];
      const base = {
        is: p.spec.is,
        threshold: p.threshold,
        forSeconds: p.forSeconds,
        showing: p.m,
        per: p.spec.per,
        low: pick?.low,
        high: pick?.high,
      };
      return {
        sentence: ownSentence({
          ...base,
          words: p.m.words,
          owner: pick?.owner ?? null,
          value: pick?.value ?? null,
        }).full,
        condition: conditionWords(base),
        holds: !!pick && breaks(pick.value, pick.low, pick.high),
      };
    },
  );

  app.post(
    '/clusters/:id/own-metrics/alerts',
    {
      preHandler: write,
      schema: {
        summary: 'Alert on one of your metrics',
        description:
          '`above` and `below` compare the metric as it is shown (a rate per second) with `value`; `absent` ("not reported for") and `older` (timestamps) take `value` in seconds; `unusual` (Pro) needs a watched metric.',
        tags: PANEL,
        params: Params,
        body: NewRule,
        response: {
          201: Type.Object({ id: Type.String(), name: Type.String() }),
          400: ProblemSchema,
          401: ProblemSchema,
          402: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, NOT_FOUND);
      const b = request.body;
      const p = await prepared(cluster.org_id, cluster.id, b, reply);
      if (!p) return reply;
      const channelIds = [...new Set(b.channelIds ?? [])];
      if (channelIds.length) {
        const found = await db
          .selectFrom('alert_channels')
          .select('id')
          .where('org_id', '=', cluster.org_id)
          .where('id', 'in', channelIds)
          .execute();
        if (found.length !== channelIds.length) return sendProblem(reply, 400, 'Unknown channel');
      }
      const name = (b.name ?? '').trim() || `${p.m.words} ${NAMES[b.is]}`;
      const id = newId();
      await db
        .insertInto('alert_rules')
        .values({
          id,
          org_id: cluster.org_id,
          cluster_id: cluster.id,
          name: name.slice(0, 200),
          type: OWN_RULE_TYPE,
          scope: JSON.stringify({ own: p.spec }),
          condition: JSON.stringify(
            p.threshold === null ? {} : { op: b.is === 'below' ? '<' : '>', value: p.threshold },
          ),
          for_seconds: p.forSeconds,
          severity: b.severity ?? 'warning',
          channel_ids: channelIds,
        })
        .execute();
      return reply.code(201).send({ id, name });
    },
  );

  app.delete(
    '/clusters/:id/own-metrics/alerts/:ruleId',
    {
      preHandler: write,
      schema: {
        summary: 'Delete an alert rule on one of your metrics',
        tags: PANEL,
        params: Type.Object({
          id: Type.String({ format: 'uuid' }),
          ruleId: Type.String({ format: 'uuid' }),
        }),
        response: { 204: Type.Null(), 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, NOT_FOUND);
      const gone = await db
        .deleteFrom('alert_rules')
        .where('org_id', '=', cluster.org_id)
        .where('cluster_id', '=', cluster.id)
        .where('type', '=', OWN_RULE_TYPE)
        .where('id', '=', request.params.ruleId)
        .returning('id')
        .executeTakeFirst();
      if (!gone) return sendProblem(reply, 404, 'Rule not found');
      return reply.code(204).send(null);
    },
  );

  app.put(
    '/clusters/:id/own-metrics/metrics/:metricId/watch',
    {
      preHandler: write,
      schema: {
        summary: 'Watch a metric with What changed (Pro), or stop',
        description: `Its usual range for each hour of the week is learnt (a week before it is used) and shown, and "outside its usual range" can be alerted on. At most ${OWN_WATCHED} watched metrics in an organisation.`,
        tags: PANEL,
        params: Type.Object({
          id: Type.String({ format: 'uuid' }),
          metricId: Type.String({ format: 'uuid' }),
        }),
        body: Type.Object({ watched: Type.Boolean() }),
        response: {
          200: Type.Object({ watched: Type.Boolean() }),
          400: ProblemSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          409: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, NOT_FOUND);
      const [m] = await listMetrics(db, cluster.id, { ids: [request.params.metricId] });
      if (!m) return sendProblem(reply, 404, 'Metric not found');
      if (request.body.watched && !m.watched) {
        const usage = await own.usage(cluster.org_id);
        if (!usage.limits.usualRange) {
          return sendProblem(
            reply,
            403,
            'Watching a metric with What changed is part of Pro',
            ProblemType.proFeature,
          );
        }
        if (m.type === 'timestamp')
          return sendProblem(
            reply,
            400,
            'A timestamp has no usual range: alert on it with "older than"',
          );
        const n = await db
          .selectFrom('own_metrics')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('org_id', '=', cluster.org_id)
          .where('watched_at', 'is not', null)
          .executeTakeFirst();
        if (Number(n?.n ?? 0) >= usage.limits.watched) {
          return sendProblem(
            reply,
            409,
            `${usage.limits.watched} metrics are watched already: stop watching one first`,
          );
        }
      }
      if (request.body.watched === m.watched) return { watched: m.watched };
      // What is in memory is written first, then let go (as for a type correction).
      await own.forget(cluster.id);
      await db
        .updateTable('own_metrics')
        .set({ watched_at: request.body.watched ? new Date() : null })
        .where('id', '=', m.id)
        .execute();
      return { watched: request.body.watched };
    },
  );
};
