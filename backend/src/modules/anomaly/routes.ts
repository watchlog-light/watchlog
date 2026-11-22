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
//
// The learning week (ADR-216): every answer carries the learning state in full (the day, the
// hours of the week learned, the week as 168 characters, the series). GET
// /what-changed/learning gives that alone, for the sidebar's hint; PUT
// /what-changed/ready-email is a member's own "email me when it's ready" for one cluster.
// Both are the dashboard's own (not public), by session, behind the same gate.
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import type { Config } from '../../config.js';
import type { Database } from '../../db/index.js';
import { ProblemType, sendProblem } from '../../lib/problem.js';
import { requireRole, requireUser } from '../../plugins/auth.js';
import { DEMO_MAX_RANGE_S } from '../../plugins/demo.js';
import { ProblemSchema } from '../auth/schemas.js';
import { causeReader, CausesService, wantsCause, type LikelyCause } from '../causes/likely.js';
import { CheckSchema, LikelyCauseSchema } from '../causes/schemas.js';
import { parseSubject } from '../causes/subject.js';
import { clusterForOrg } from '../clusters/service.js';
import { PUBLIC_TAG } from '../../openapi/public.js';
import type { VictoriaQueryClient } from '../../lib/victoria.js';
import { hasWhatChanged, whatChangedExists } from './gate.js';
import { isOwnSeries, liveView, ownParts } from './live.js';
import { buildStory, changeView, recentEpisodes, type BuiltStory } from './story-build.js';
import { readChanges } from './story-read.js';
import { composeMap } from './exclusion.js';
import { BREAKDOWN_KEYS, learningOf } from './learning.js';
import {
  alertWindow,
  chartRange,
  labelsOf,
  rowView,
  readPeriods,
  WHAT_CHANGED_MAX_RANGE_S,
  WHAT_CHANGED_MAX_ROWS,
  type ClusterKind,
  type Window,
} from './read.js';

const DateTime = Type.String({ format: 'date-time' });
/** The quiet page's last days, and the episodes it shows at most. */
const RECENT_DAYS = 7;
const RECENT_MAX = 5;
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

export const RowSchema = Type.Object({
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
  own: Type.Optional(
    Type.Boolean({
      description:
        "One of WatchLog's own parts (its charts' workloads, its containers, its agent's units); listed only with `own=show`",
    }),
  ),
  more: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        'Other changes of the same series in the window: the list shows a series once, its strongest current change (ADR-229)',
    }),
  ),
});

const Count = Type.Optional(Type.Integer({ minimum: 1 }));

/** The learning week as data (ADR-204, ADR-216), by the worker's own rule (ADR-217). */
export const LearningSchema = Type.Object({
  learning: Type.Boolean({
    description:
      'True until the worker has learned every hour of the week (7 days of data): nothing is listed',
  }),
  since: Type.Union([DateTime, Type.Null()], {
    description:
      "When learning began: the later of the org's upgrade and the cluster's first series",
  }),
  until: Type.Union([DateTime, Type.Null()], {
    description:
      'When the list turns on: the moment it did, or, while learning, when it will if learning goes on without another gap (hours when the org was not on Pro or no data arrived are learned when that hour of the week comes round)',
  }),
  day: Type.Union([Type.Integer({ minimum: 1, maximum: 7 }), Type.Null()], {
    description:
      'The day of learning, 1 to 7: one for every 24 hours of the week learned; null before it started',
  }),
  hoursLearned: Type.Integer({
    minimum: 0,
    maximum: 168,
    description: 'Hours of the week that have a baseline',
  }),
  hoursTotal: Type.Integer({ description: '168: every weekday and hour, once' }),
  week: Type.String({
    pattern: '^[012]{168}$',
    description:
      'One character per hour of the week, UTC, Sunday 00:00 first: 1 has a baseline, 0 not seen yet, 2 looked at twice with no data',
  }),
  resumedAt: Type.Union([DateTime, Type.Null()], {
    description:
      'While learning: when it went on after a gap (what was learned before still counts); null if it never stopped',
  }),
  series: Type.Object({
    total: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()], {
      description: "Series read in the last hourly run; null before the worker's first one",
    }),
    learning: Type.Integer({
      minimum: 0,
      description:
        "How many the worker isn't scoring yet (all of them while `learning` is true; afterwards those that joined later)",
    }),
    readyAt: Type.Union([DateTime, Type.Null()], {
      description: 'When the last of those is ready; null when none is learning',
    }),
    breakdown: Type.Object(
      Object.fromEntries(BREAKDOWN_KEYS.map((k) => [k, Count])) as Record<
        (typeof BREAKDOWN_KEYS)[number],
        typeof Count
      >,
      {
        description:
          "The series' objects in the kind's words: nodes and workloads; servers, services, process groups and containers; applications (monitored services)",
      },
    ),
  }),
  emailWhenReady: Type.Boolean({
    description:
      'The signed-in user asked for an email when this cluster is ready; false for an API token',
  }),
});

const Facts = Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Null()]));
const ClauseSchema = Type.Object(
  { code: Type.String(), facts: Facts },
  {
    description:
      'A clause as a code with its facts (ADR-147): after_change, first, then, same_time, more; change',
  },
);
export const ChangeSchema = Type.Object({
  at: DateTime,
  kind: Type.Union([
    Type.Literal('rollout'),
    Type.Literal('image'),
    Type.Literal('scale'),
    Type.Literal('compose'),
    Type.Literal('recreate'),
    Type.Literal('node'),
    Type.Literal('service_start'),
    Type.Literal('service_restart'),
    Type.Literal('service_failed'),
    Type.Literal('unit_changed'),
    Type.Literal('release'),
    Type.Literal('job_run'),
  ]),
  name: Type.String(),
  namespace: Opt(Type.String()),
  host: Opt(Type.String()),
  facts: Facts,
});
export const EpisodeSchema = Type.Object({
  from: DateTime,
  to: Type.Union([DateTime, Type.Null()], {
    description: 'null while one of its series is still outside',
  }),
  count: Type.Integer({ description: 'Periods in it' }),
});
export const StorySchema = Type.Object(
  {
    clauses: Type.Array(ClauseSchema, {
      description: 'The episode in one sentence, from fixed templates',
    }),
    chain: Type.Object({
      nodes: Type.Array(
        Type.Object({
          kind: Type.Union([Type.Literal('change'), Type.Literal('first'), Type.Literal('then')]),
          rowId: Type.Union([Type.String(), Type.Null()]),
          who: Type.String(),
          at: DateTime,
          gapMin: Type.Union([Type.Integer(), Type.Null()]),
          linked: Type.Boolean({
            description:
              'Connected to the box before: calls on the service map, or a shared node or server',
          }),
        }),
        { maxItems: 6 },
      ),
      more: Type.Integer({ description: 'Series left out of the boxes' }),
      linked: Type.Boolean({ description: 'Some two consecutive series are connected (arrows)' }),
    }),
    change: Type.Union([ChangeSchema, Type.Null()], {
      description:
        'The change linked to it: at most 15 minutes before the first move, on it or related to it',
    }),
    cause: Type.Object({
      state: Type.Union([Type.Literal('likely'), Type.Literal('change'), Type.Literal('none')], {
        description:
          "likely: the probable-cause engine's (in `cause.likely`); change: the linked change; none: no clear cause",
      }),
      change: Type.Union([ClauseSchema, Type.Null()]),
    }),
    checks: Type.Array(CheckSchema, { description: 'Every check the probable-cause engine ran' }),
    changes: Type.Array(ChangeSchema, {
      description: 'Changed around then: from 30 minutes before the episode to 5 after it',
    }),
    rows: Type.Array(RowSchema, { description: "The episode's series, once each, by first move" }),
    spark: Type.Array(
      Type.Object({
        rowId: Type.String(),
        from: DateTime,
        step: Type.Integer(),
        values: Type.Array(Type.Union([Type.Number(), Type.Null()])),
      }),
      { maxItems: 8 },
    ),
  },
  { description: 'The selected episode told (ADR-231); null when the window has none' },
);

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
  learning: LearningSchema,
  cause: Type.Object({
    subject: Type.Union([Type.String(), Type.Null()], {
      description:
        "GET /causes's subject: the alert, or the first row probable cause can explain; null when none",
    }),
    likely: Type.Union([LikelyCauseSchema, Type.Null()]),
  }),
  own: Type.Union([Type.Literal('hide'), Type.Literal('show')], {
    description: "Whether WatchLog's own parts are left out (the default) or listed",
  }),
  episodes: Type.Array(EpisodeSchema, {
    description: 'Stretches where one series or more was outside its usual range, oldest first',
  }),
  episode: Type.Integer({
    description: 'The selected episode (the newest unless `episode` asked); -1 for none',
  }),
  story: Type.Union([StorySchema, Type.Null()]),
  changes: Type.Array(ChangeSchema, {
    maxItems: 200,
    description:
      "What changed in the chart's range: its markers (rollouts, scaling, image changes, service starts and restarts, scheduled runs)",
  }),
});

export const whatChangedRoutes: FastifyPluginAsyncTypebox<{
  db: Database;
  config: Pick<Config, 'edition' | 'demoMode'>;
  causes?: CausesService;
  /** The story's sparklines (0.14.0); without it the story has none. */
  victoria?: VictoriaQueryClient | null;
  /** Test hook: the clock the windows end at. */
  now?: () => number;
}> = async (app, { db, config, causes, victoria, now = Date.now }) => {
  const signedIn = requireUser();

  /** The gate every route here shares: the route exists, the org has it, the cluster is its own. */
  async function gate(request: FastifyRequest, reply: FastifyReply, clusterId: string) {
    // Community: no such route (ADR-202), so its API is unchanged.
    if (!whatChangedExists(config)) {
      sendProblem(reply, 404, 'Not Found');
      return null;
    }
    const orgId = request.user!.org.id;
    if (!(await hasWhatChanged(config, app.entitlements, orgId))) {
      sendProblem(reply, 403, 'What changed is part of Pro', ProblemType.proFeature);
      return null;
    }
    const row = await clusterForOrg(db, orgId, clusterId);
    if (!row || (row.kind !== 'kubernetes' && row.kind !== 'server')) {
      sendProblem(reply, 404, 'Cluster not found');
      return null;
    }
    return { orgId, row, kind: row.kind as ClusterKind };
  }
  /** The session's user, for their own "email me when it's ready"; never a token's. */
  const sessionUser = (request: FastifyRequest) =>
    request.apiToken ? undefined : request.user!.id;

  app.get(
    '/what-changed',
    {
      preHandler: signedIn,
      schema: {
        summary: 'What changed',
        description:
          "What left its usual range in a cluster or a fleet (ADR-199): around an alert (60 minutes before it started to 15 minutes after, or now), or in a range of at most 24 hours (the last hour by default). At most 50 rows by start (`first`) or by how far out they went (`furthest`), with `total` and `truncated`; the unusual-activity chart; the learning state (nothing is listed for 7 days from the upgrade; `learning` says which day it is, when it is ready and which hours of the week have a baseline); and the probable cause's short form. Pro: 403 `pro-feature` for Cloud orgs without it; a self-hosted Community install answers 404.",
        tags: ['what-changed', PUBLIC_TAG],
        querystring: Type.Object({
          cluster: Type.String({ format: 'uuid' }),
          alert: Type.Optional(Type.String({ format: 'uuid', description: 'Around this alert' })),
          from: Type.Optional(Type.Integer({ minimum: 0, description: 'Unix seconds' })),
          to: Type.Optional(Type.Integer({ minimum: 0, description: 'Unix seconds' })),
          sort: Type.Optional(Type.Union([Type.Literal('first'), Type.Literal('furthest')])),
          own: Type.Optional(
            Type.Union([Type.Literal('hide'), Type.Literal('show')], {
              description: "WatchLog's own parts: left out (the default) or listed",
            }),
          ),
          episode: Type.Optional(
            Type.Integer({
              minimum: 0,
              description:
                'The episode to tell, by its start (Unix seconds); the newest by default',
            }),
          ),
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
      const q = request.query;
      const g = await gate(request, reply, q.cluster);
      if (!g) return reply;
      const { orgId, row, kind } = g;
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
      const own = q.own ?? 'hide';
      const learning = await learningOf(db, orgId, row.id, nowMs, sessionUser(request));
      const chart = chartRange(w, alert !== null, minFromMs);
      // WatchLog's own parts (ADR-231): left out by default, flagged when listed.
      const parts = learning.learning ? null : await ownParts(db, row.id);
      const isOwn = (subject: Record<string, string>) =>
        parts ? isOwnSeries(subject, parts) : false;
      const read = await readPeriods(
        db,
        orgId,
        { id: row.id, kind },
        w,
        chart,
        sort,
        nowMs,
        learning.learning,
        own === 'hide' ? isOwn : undefined,
      );
      if (own === 'show')
        for (const r of [...read.rows, ...read.all]) if (isOwn(r.subject)) r.own = true;
      // The story (ADR-231): the page's windows only; around an alert the card is the alert's.
      let built: BuiltStory | null = null;
      if (!alert && !learning.learning && read.all.length) {
        built = await buildStory(
          {
            db,
            causes: wantsCause(request) ? causes : undefined,
            victoria,
            reader: causeReader(app, request),
            log: request.log,
          },
          { id: row.id, name: row.name, kind, scope: row.scope },
          orgId,
          read.all,
          w,
          nowMs,
          q.episode !== undefined ? q.episode * 1000 : undefined,
        );
      }
      const changes =
        !alert && !learning.learning
          ? (await readChanges(db, row.id, chart.fromMs, chart.toMs)).map(changeView)
          : [];
      const subject = alert ? `alert:${alert.id}` : (built?.subject ?? read.firstSubject);
      let likely: LikelyCause | null = built?.likely ?? null;
      if (!built?.story && subject && causes && wantsCause(request)) {
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
        own,
        episodes: built?.episodes ?? [],
        episode: built?.episode ?? -1,
        story: built?.story ?? null,
        changes,
      };
    },
  );

  const LiveSchema = Type.Object({
    scoredAt: Type.Union([DateTime, Type.Null()], {
      description:
        "The anomaly-worker's last scoring of this cluster or fleet; null before its first",
    }),
    learning: Type.Integer({
      description: "Series that haven't learned their week yet (not shown)",
    }),
    series: Type.Array(
      Type.Object({
        id: Type.String(),
        key: Type.String(),
        unit: Type.String(),
        object: ObjectSchema,
        peer: Type.Union([Type.String(), Type.Null()]),
        value: Type.Union([Type.Number(), Type.Null()]),
        usualLow: Type.Number(),
        usualHigh: Type.Number(),
        score: Type.Union([Type.Number(), Type.Null()]),
        state: Type.Union([Type.Literal('inside'), Type.Literal('near'), Type.Literal('outside')]),
        shade: Type.Integer({ minimum: 0, maximum: 2 }),
        own: Type.Boolean({ description: "One of WatchLog's own parts" }),
      }),
    ),
  });

  app.get(
    '/what-changed/live',
    {
      preHandler: signedIn,
      schema: {
        summary: "What changed's live map",
        description:
          "Every scored series of a cluster or fleet as the anomaly-worker scored it at its last minute (ADR-231): its value, its usual range for this hour of the week, its score and state (inside in three shades, near the edge, outside), and whether it is one of WatchLog's own parts. One read, refreshed each minute by the worker. Pro: 403 `pro-feature` for Cloud orgs without it; Community answers 404.",
        tags: ['what-changed'],
        querystring: Type.Object({ cluster: Type.String({ format: 'uuid' }) }),
        response: { 200: LiveSchema, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const g = await gate(request, reply, request.query.cluster);
      if (!g) return reply;
      const row = await db
        .selectFrom('anomaly_live')
        .select(['scored_at', 'learning', 'series'])
        .where('org_id', '=', g.orgId)
        .where('cluster_id', '=', g.row.id)
        .executeTakeFirst();
      const [own, compose] = await Promise.all([
        ownParts(db, g.row.id),
        g.kind === 'server' && row ? composeMap(db, g.row.id) : Promise.resolve(new Map()),
      ]);
      return liveView(row, own, compose);
    },
  );

  app.get(
    '/what-changed/recent',
    {
      preHandler: signedIn,
      schema: {
        summary: "What changed's last 7 days",
        description:
          "The last 7 days' episodes of a cluster or fleet in brief (ADR-231), newest first, at most 5: when, how many series, the sentence and the linked change. For the page when everything is inside. Pro: 403 `pro-feature` for Cloud orgs without it; Community answers 404.",
        tags: ['what-changed'],
        querystring: Type.Object({
          cluster: Type.String({ format: 'uuid' }),
          own: Type.Optional(Type.Union([Type.Literal('hide'), Type.Literal('show')])),
        }),
        response: {
          200: Type.Object({
            episodes: Type.Array(
              Type.Object({
                from: DateTime,
                to: Type.Union([DateTime, Type.Null()]),
                count: Type.Integer(),
                clauses: Type.Array(ClauseSchema),
                cause: Type.Union([ClauseSchema, Type.Null()]),
              }),
              { maxItems: RECENT_MAX },
            ),
          }),
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const g = await gate(request, reply, request.query.cluster);
      if (!g) return reply;
      const nowMs = now();
      const fromMs = config.demoMode
        ? nowMs - DEMO_MAX_RANGE_S * 1000
        : nowMs - RECENT_DAYS * 86_400_000;
      const periods = await db
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
        .where('org_id', '=', g.orgId)
        .where('cluster_id', '=', g.row.id)
        .where('started_at', '>=', new Date(fromMs))
        .orderBy('started_at')
        .limit(5_000)
        .execute();
      const parts = request.query.own === 'show' ? null : await ownParts(db, g.row.id);
      const compose =
        g.kind === 'server' && periods.length ? await composeMap(db, g.row.id) : new Map();
      const rows = periods
        .filter((p) => !parts || !isOwnSeries(labelsOf(p.subject), parts))
        .map((p) => rowView(p, compose));
      const episodes = await recentEpisodes(
        { db },
        { id: g.row.id, name: g.row.name, kind: g.kind, scope: g.row.scope },
        rows,
        nowMs,
        RECENT_MAX,
      );
      return { episodes };
    },
  );

  app.get(
    '/what-changed/learning',
    {
      preHandler: signedIn,
      schema: {
        summary: "What changed's learning week",
        description:
          'The learning state of a cluster or a fleet alone (ADR-216), as GET /what-changed\'s `learning`: three single-row reads, for the sidebar\'s "day 3/7". Pro: 403 `pro-feature` for Cloud orgs without it; Community answers 404.',
        tags: ['what-changed'],
        querystring: Type.Object({ cluster: Type.String({ format: 'uuid' }) }),
        response: {
          200: Type.Object({ learning: LearningSchema }),
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const g = await gate(request, reply, request.query.cluster);
      if (!g) return reply;
      return {
        learning: await learningOf(db, g.orgId, g.row.id, now(), sessionUser(request)),
      };
    },
  );

  app.put(
    '/what-changed/ready-email',
    {
      // Every member, for themselves: a Viewer too (ADR-216).
      preHandler: [signedIn, requireRole('owner', 'admin', 'viewer')],
      schema: {
        summary: 'Email me when What changed is ready',
        description:
          "The signed-in user's own choice for one cluster or fleet (ADR-216): one email when its first baseline is 7 days old, nothing if the org has left Pro by then. `enabled: false` undoes it. By session only; 409 once the cluster has finished learning, or (Cloud) while the user's address isn't verified.",
        tags: ['what-changed'],
        body: Type.Object(
          { cluster: Type.String({ format: 'uuid' }), enabled: Type.Boolean() },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({ emailWhenReady: Type.Boolean() }),
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          409: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      if (request.apiToken) return sendProblem(reply, 403, 'Sign in to choose this');
      const g = await gate(request, reply, request.body.cluster);
      if (!g) return reply;
      const user = request.user!;
      if (!request.body.enabled) {
        await db
          .deleteFrom('anomaly_ready_emails')
          .where('org_id', '=', g.orgId)
          .where('cluster_id', '=', g.row.id)
          .where('user_id', '=', user.id)
          .where('sent_at', 'is', null)
          .execute();
        return { emailWhenReady: false };
      }
      if (user.account && !user.account.emailVerifiedAt) {
        return sendProblem(reply, 409, 'Verify your email address first');
      }
      const state = await learningOf(db, g.orgId, g.row.id, now());
      if (!state.learning) {
        return sendProblem(reply, 409, 'What changed is ready for this cluster');
      }
      await db
        .insertInto('anomaly_ready_emails')
        .values({ org_id: g.orgId, cluster_id: g.row.id, user_id: user.id })
        .onConflict((oc) => oc.columns(['cluster_id', 'user_id']).doNothing())
        .execute();
      return { emailWhenReady: true };
    },
  );
};
