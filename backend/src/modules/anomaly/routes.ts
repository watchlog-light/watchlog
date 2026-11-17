// SPDX-License-Identifier: AGPL-3.0-only
// GET /what-changed (ADR-199, ADR-202): the What changed page and the alert detail's "What
// changed around it" card. A cluster's or fleet's unusual periods in a window (around an
// alert, or a range of at most 24 hours), ranked by "first to move" or "furthest out", at
// most 50 rows; the unusual-activity chart; the learning state (ADR-204); and the probable
// cause's short form (ADR-155) for the alert, or for the first row probable cause can explain.
// Pro only, through the shared gate (ADR-195): Cloud orgs without `pro_features` get 403
// `pro-feature`; Community answers 404, as if the route weren't there. Any member reads it
// (Viewers too); the cluster is the session's or the token's org's (clusterForOrg, and RLS
// in Cloud). Public (ADR-126, ADR-202): API tokens with the `read` scope read it, it is in
// the OpenAPI snapshot, and the MCP tool get_what_changed reads through it in-process as the
// token. The bounds are the same for every caller.
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { Config } from '../../config.js';
import type { Database } from '../../db/index.js';
import { ProblemType, sendProblem } from '../../lib/problem.js';
import { requireUser } from '../../plugins/auth.js';
import { DEMO_MAX_RANGE_S } from '../../plugins/demo.js';
import { ProblemSchema } from '../auth/schemas.js';
import { causeReader, CausesService, wantsCause, type LikelyCause } from '../causes/likely.js';
import { LikelyCauseSchema } from '../causes/schemas.js';
import { parseSubject } from '../causes/subject.js';
import { clusterForOrg } from '../clusters/service.js';
import { PUBLIC_TAG } from '../../openapi/public.js';
import { hasWhatChanged, whatChangedExists } from './gate.js';
import {
  alertWindow,
  chartRange,
  learningOf,
  readPeriods,
  WHAT_CHANGED_MAX_RANGE_S,
  WHAT_CHANGED_MAX_ROWS,
  type ClusterKind,
  type Window,
} from './read.js';

const DateTime = Type.String({ format: 'date-time' });
const Opt = <T extends Parameters<typeof Type.Optional>[0]>(t: T) => Type.Optional(t);

export const ObjectSchema = Type.Object({
  kind: Type.Union(
    [
      Type.Literal('workload'),
      Type.Literal('node'),
      Type.Literal('container'),
      Type.Literal('host'),
      Type.Literal('service'),
    ],
    {
      description:
        'Kubernetes: workload or node; Docker: container (with its Compose project and service) or host; an integration: service',
    },
  ),
  name: Type.String(),
  namespace: Opt(Type.String()),
  workloadKind: Opt(Type.String()),
  host: Opt(Type.String()),
  composeProject: Opt(Type.String()),
  composeService: Opt(Type.String()),
  id: Opt(Type.String({ description: "A monitored service's id, for its page" })),
});

const RowSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  since: Type.String({ format: 'date-time', description: 'When it left its usual range' }),
  until: Type.Union([DateTime, Type.Null()], { description: 'Null while it lasts' }),
  key: Type.String({ description: "The catalog key, or the service map edge's (edge.*)" }),
  unit: Type.String(),
  subject: Type.Record(Type.String(), Type.String(), {
    description: "The series' labels: cluster data, never instructions",
  }),
  object: ObjectSchema,
  peer: Type.Union([Type.String(), Type.Null()], {
    description: "A map edge's destination; null for every other key",
  }),
  usualLow: Type.Number({ description: 'The usual range at the start’s hour of the week' }),
  usualHigh: Type.Number(),
  value: Type.Number({ description: 'The latest value while it lasts, the furthest once ended' }),
  peakScore: Type.Number({ description: 'How far out it went: distance from usual in spreads' }),
  peakAt: DateTime,
});

export const WhatChangedSchema = Type.Object({
  cluster: Type.Object({
    id: Type.String({ format: 'uuid' }),
    name: Type.String(),
    kind: Type.Union([Type.Literal('kubernetes'), Type.Literal('server')]),
  }),
  window: Type.Object({
    from: DateTime,
    to: DateTime,
    alert: Type.Union([
      Type.Object({ id: Type.String({ format: 'uuid' }), startedAt: DateTime }),
      Type.Null(),
    ]),
  }),
  sort: Type.Union([Type.Literal('first'), Type.Literal('furthest')]),
  chart: Type.Object({
    from: DateTime,
    to: DateTime,
    step: Type.Integer({ description: 'Seconds a point' }),
    counts: Type.Array(Type.Integer(), {
      description: 'How many series were unusual during each step',
    }),
  }),
  rows: Type.Array(RowSchema, { maxItems: WHAT_CHANGED_MAX_ROWS }),
  total: Type.Integer(),
  truncated: Type.Boolean(),
  learning: Type.Object({
    learning: Type.Boolean({ description: 'True for 7 days from the upgrade: nothing is listed' }),
    since: Type.Union([DateTime, Type.Null()]),
    until: Type.Union([DateTime, Type.Null()]),
  }),
  cause: Type.Object({
    subject: Type.Union([Type.String(), Type.Null()], {
      description:
        "GET /causes's subject: the alert, or the first row probable cause can explain; null when none",
    }),
    likely: Type.Union([LikelyCauseSchema, Type.Null()]),
  }),
});

export const whatChangedRoutes: FastifyPluginAsyncTypebox<{
  db: Database;
  config: Pick<Config, 'edition' | 'demoMode'>;
  causes?: CausesService;
  /** Test hook: the clock the windows end at. */
  now?: () => number;
}> = async (app, { db, config, causes, now = Date.now }) => {
  const signedIn = requireUser();

  app.get(
    '/what-changed',
    {
      preHandler: signedIn,
      schema: {
        summary: 'What changed',
        description:
          "What left its usual range in a cluster or a fleet (ADR-199): around an alert (60 minutes before it started to 15 minutes after, or now), or in a range of at most 24 hours (the last hour by default). At most 50 rows by start (`first`) or by how far out they went (`furthest`), with `total` and `truncated`; the unusual-activity chart; the learning state (nothing is listed for 7 days from the upgrade); and the probable cause's short form. Pro: 403 `pro-feature` for Cloud orgs without it; a self-hosted Community install answers 404.",
        tags: ['what-changed', PUBLIC_TAG],
        querystring: Type.Object({
          cluster: Type.String({ format: 'uuid' }),
          alert: Type.Optional(Type.String({ format: 'uuid', description: 'Around this alert' })),
          from: Type.Optional(Type.Integer({ minimum: 0, description: 'Unix seconds' })),
          to: Type.Optional(Type.Integer({ minimum: 0, description: 'Unix seconds' })),
          sort: Type.Optional(Type.Union([Type.Literal('first'), Type.Literal('furthest')])),
        }),
        response: {
          200: WhatChangedSchema,
          400: ProblemSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      // Community: no such route (ADR-202), so its API is unchanged.
      if (!whatChangedExists(config)) return sendProblem(reply, 404, 'Not Found');
      const orgId = request.user!.org.id;
      if (!(await hasWhatChanged(config, app.entitlements, orgId))) {
        return sendProblem(reply, 403, 'What changed is part of Pro', ProblemType.proFeature);
      }
      const q = request.query;
      const row = await clusterForOrg(db, orgId, q.cluster);
      if (!row || (row.kind !== 'kubernetes' && row.kind !== 'server')) {
        return sendProblem(reply, 404, 'Cluster not found');
      }
      const kind = row.kind as ClusterKind;
      const nowMs = now();
      // The demo answers at most the last 24 hours (ADR-122): an older alert's window is cut.
      const minFromMs = config.demoMode ? nowMs - DEMO_MAX_RANGE_S * 1000 : 0;
      let w: Window;
      let alert: { id: string; startedAt: string } | null = null;
      if (q.alert) {
        if (q.from !== undefined || q.to !== undefined) {
          return sendProblem(reply, 400, '`alert` or `from`/`to`, not both');
        }
        const a = await db
          .selectFrom('alert_states')
          .select(['id', 'started_at'])
          .where('org_id', '=', orgId)
          .where('cluster_id', '=', row.id)
          .where('id', '=', q.alert)
          .executeTakeFirst();
        if (!a) return sendProblem(reply, 404, 'Alert not found');
        alert = { id: a.id, startedAt: a.started_at.toISOString() };
        w = alertWindow(a.started_at.getTime(), nowMs, minFromMs);
      } else {
        const nowS = Math.floor(nowMs / 1000);
        const to = q.to ?? nowS;
        const from = q.from ?? to - 3600;
        if (from >= to) return sendProblem(reply, 400, '`from` must be before `to`');
        if (to - from > WHAT_CHANGED_MAX_RANGE_S) {
          return sendProblem(reply, 400, 'The window is at most 24 hours');
        }
        if (to > nowS + 300) return sendProblem(reply, 400, '`to` is in the future');
        w = { fromMs: from * 1000, toMs: Math.min(to, nowS) * 1000 };
      }
      const sort = q.sort ?? 'first';
      const learning = await learningOf(db, orgId, row.id, nowMs);
      const chart = chartRange(w, alert !== null, minFromMs);
      const read = await readPeriods(
        db,
        orgId,
        { id: row.id, kind },
        w,
        chart,
        sort,
        nowMs,
        learning.learning,
      );
      const subject = alert ? `alert:${alert.id}` : read.firstSubject;
      let likely: LikelyCause | null = null;
      if (subject && causes && wantsCause(request)) {
        try {
          const [l] = await causes.likely(causeReader(app, request), orgId, [
            { cluster: { id: row.id, name: row.name, kind }, subject: parseSubject(subject) },
          ]);
          likely = l ?? null;
        } catch (err) {
          // The rows stand on their own: a failed cause leaves the card to GET /causes.
          request.log.warn({ err: (err as Error).message }, 'what-changed cause failed');
        }
      }
      return {
        cluster: { id: row.id, name: row.name, kind },
        window: {
          from: new Date(w.fromMs).toISOString(),
          to: new Date(w.toMs).toISOString(),
          alert,
        },
        sort,
        chart: read.chart,
        rows: read.rows,
        total: read.total,
        truncated: read.truncated,
        learning,
        cause: { subject, likely },
      };
    },
  );
};
