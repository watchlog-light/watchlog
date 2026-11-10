// SPDX-License-Identifier: AGPL-3.0-only
// Alerting API (SPEC §8.1): alerts, silences, rules, channels and whether alerting
// runs (ADR-088). Reads for every member, changes for owners and admins.
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql, type ExpressionBuilder, type Selectable } from 'kysely';
import { randomBytes } from 'node:crypto';
import { Type, type Static } from 'typebox';
import type { Config } from '../../config.js';
import type { Database } from '../../db/index.js';
import type { AlertChannels, DB } from '../../db/types.js';
import type { VictoriaQueryClient } from '../../lib/victoria.js';
import type { MessagePayload } from './outbox.js';
import { newId } from '../../lib/ids.js';
import { ProblemType, sendProblem } from '../../lib/problem.js';
import { decryptJson, encryptJson } from '../../lib/secrets.js';
import { redactUrl } from '../../lib/redact.js';
import { requireRole, requireUser } from '../../plugins/auth.js';
import { alertDefaultByKey } from '../integrations/alert-defaults.js';
import { ProblemSchema } from '../auth/schemas.js';
import { UnreachableError, type HttpClient } from './channels.js';
import { sendTest, type DeliveryDeps } from './delivery.js';
import { DEFAULT_RULES, ensureDefaultRules, insertThresholdRule } from './rules.js';
import {
  AlertChartSchema,
  AlertDetailSchema,
  ChartQuerySchema,
  AlertingStatusSchema,
  AlertListSchema,
  ChannelSchema,
  CreatedChannelSchema,
  CreateRuleSchema,
  CreateChannelSchema,
  CreateSilenceSchema,
  Id,
  IdParams,
  PatchChannelSchema,
  PatchRuleSchema,
  PreviewBodySchema,
  PreviewSchema,
  RuleSchema,
  Severity,
  SilenceMatchersSchema,
  SilenceSchema,
  TestResultSchema,
} from './schemas.js';
import { isSilenced, silenceTarget, type SilenceMatchers } from './silences.js';
import { alertingStatus } from './status.js';
import { alertText } from './text.js';
import { startTelegramVerification, telegramBotName } from './telegram.js';
import { resolveScope, validateThreshold, type ThresholdScope } from './threshold.js';
import { alertChart } from './alert-chart.js';
import { alertingGaps } from './periods.js';
import { backtest } from './preview.js';
import { seriesName } from './rule-charts.js';
import { validCondition } from './metric-rules.js';
import { metricKinds } from './conditions.js';
import type { Condition } from './defaults.js';
import {
  buildQuery,
  METRIC_KEYS,
  metricUnit,
  type MetricKey,
  type QueryScope,
} from '../query/catalog.js';
import type { SettingsService } from '../settings/service.js';
import { ruleView, validateRuleChange, type RuleRowView } from './rule-views.js';
import { PUBLIC_TAG } from '../../openapi/public.js';
import { causeReader, wantsCause, type CausesService } from '../causes/likely.js';

const Errors = { 400: ProblemSchema, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema };
const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());
const HISTORY_PAGE = 50;

export interface AlertRouteDeps {
  db: Database;
  config: Config;
  http: HttpClient;
  settings: SettingsService;
  victoria?: VictoriaQueryClient;
  /** The alert detail's likely cause (ADR-148, ADR-155); left out without it. */
  causes?: CausesService;
}

/** Joined alert row as the API shows it. */
const alertColumns = [
  's.id',
  's.state',
  's.severity',
  's.labels',
  's.details',
  's.started_at',
  's.fired_at',
  's.resolved_at',
  's.silenced',
  's.flapping',
  's.held',
  's.rule_id',
  's.cluster_id',
  's.fingerprint',
  'r.rule_key',
  'r.metric as rule_metric',
  'r.name as rule_name',
  'c.name as cluster_name',
  'c.kind as cluster_kind',
] as const;

interface AlertRow {
  id: string;
  state: string;
  severity: string;
  labels: unknown;
  details: unknown;
  started_at: Date;
  fired_at: Date | null;
  resolved_at: Date | null;
  silenced: boolean;
  flapping: boolean;
  held: boolean;
  rule_id: string;
  cluster_id: string;
  rule_key: string | null;
  rule_metric: string | null;
  rule_name: string;
  cluster_name: string;
  cluster_kind: string;
}

type Delivery = {
  channelId: string;
  name: string;
  type: string;
  status: string;
  error: string | null;
};

function toAlert(r: AlertRow, deliveries: Delivery[] = [], now = Date.now()) {
  const details = (r.details ?? {}) as { summary?: unknown; pods?: unknown; podCount?: unknown };
  const text = alertText({
    ruleKey: r.rule_key,
    ruleName: r.rule_name,
    metric: r.rule_metric,
    labels: r.labels as Record<string, string>,
    details: details as Record<string, unknown>,
    cluster: { name: r.cluster_name },
    now,
  });
  return {
    title: text.title,
    why: text.why,
    id: r.id,
    state: r.state as 'pending' | 'firing' | 'resolved',
    severity: r.severity as 'warning' | 'critical',
    rule: { id: r.rule_id, key: r.rule_key, name: r.rule_name },
    cluster: { id: r.cluster_id, name: r.cluster_name, kind: r.cluster_kind },
    labels: r.labels as Record<string, string>,
    summary: typeof details.summary === 'string' ? details.summary : null,
    pods: Array.isArray(details.pods) ? (details.pods as string[]) : [],
    podCount: typeof details.podCount === 'number' ? details.podCount : 0,
    startedAt: iso(r.started_at)!,
    firedAt: iso(r.fired_at),
    resolvedAt: iso(r.resolved_at),
    silenced: r.silenced,
    flapping: r.flapping,
    held: r.held,
    deliveries,
  };
}

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
}
function decodeCursor(c: string): { at: Date; id: string } | null {
  const [at, id] = Buffer.from(c, 'base64url').toString().split('|');
  if (!at || !id || Number.isNaN(Date.parse(at)) || !/^[0-9a-f-]{36}$/.test(id)) return null;
  return { at: new Date(at), id };
}

const last4 = (v: string) => `…${v.slice(-4)}`;

export const alertRoutes: FastifyPluginAsyncTypebox<AlertRouteDeps> = async (
  app,
  { db, config, http, settings, victoria, causes },
) => {
  const signedIn = requireUser(db);
  const canManage = [signedIn, requireRole('owner', 'admin')];
  // Read-only demo (ADR-122): channels show their type and name, never where they send.
  const demoMode = config.demoMode;
  const delivery: DeliveryDeps = {
    db,
    secretKey: config.secretKey,
    http,
    settings: () => settings.alerting(),
    log: app.log,
  };

  async function botName(token: string) {
    const s = await settings.alerting();
    return telegramBotName(http, s.telegramApiUrl, token, s.telegramProxy);
  }

  /** Unreachable is not a wrong token: the UI then offers the proxy setting (ADR-093). */
  function telegramProblem(reply: FastifyReply, err: unknown) {
    if (err instanceof UnreachableError) {
      return sendProblem(
        reply,
        400,
        `WatchLog cannot reach Telegram from this server (${err.reason}). Set an HTTPS proxy for Telegram, or check this server's network.`,
        ProblemType.telegramUnreachable,
      );
    }
    return sendProblem(reply, 400, `The bot token did not work: ${(err as Error).message}`);
  }

  /** Each alert's latest firing message per channel: ✓ or ✕ with the error. */
  /**
   * Delivery and notification error text can carry an SMTP host or user, or part of a
   * webhook URL. It is left out in demo mode (ADR-122) and for API-token requests
   * (ADR-125), which a script or an AI assistant may pass on.
   */
  const hideErrors = (request: FastifyRequest) => demoMode || request.apiToken !== null;

  async function deliveriesOf(ids: string[], hide: boolean): Promise<Map<string, Delivery[]>> {
    const out = new Map<string, Delivery[]>();
    if (!ids.length) return out;
    const rows = await db
      .selectFrom('notification_alerts as na')
      .innerJoin('notifications as n', 'n.id', 'na.notification_id')
      .innerJoin('alert_channels as ch', 'ch.id', 'n.channel_id')
      .select(['na.alert_state_id', 'n.channel_id', 'ch.name', 'ch.type', 'n.status', 'n.error'])
      .where('na.alert_state_id', 'in', ids)
      .where('n.kind', 'in', ['firing', 'escalated', 'renotify', 'flapping'])
      .orderBy('n.created_at', 'desc')
      .execute();
    for (const r of rows) {
      const list = out.get(r.alert_state_id) ?? [];
      if (list.some((d) => d.channelId === r.channel_id)) continue;
      list.push({
        channelId: r.channel_id,
        name: r.name,
        type: r.type,
        status: r.status,
        error: hide ? null : r.error,
      });
      out.set(r.alert_state_id, list);
    }
    return out;
  }

  function alertsQuery(orgId: string) {
    return db
      .selectFrom('alert_states as s')
      .innerJoin('alert_rules as r', 'r.id', 's.rule_id')
      .innerJoin('clusters as c', 'c.id', 's.cluster_id')
      .select(alertColumns)
      .where('s.org_id', '=', orgId);
  }

  // ---------------------------------------------------------------- status

  app.get(
    '/alerting/status',
    {
      preHandler: signedIn,
      schema: {
        summary: 'Whether the alert-worker runs (ADR-088) and what alert messages can use',
        tags: ['alerts'],
        response: { 200: AlertingStatusSchema, 401: ProblemSchema },
      },
    },
    async () => {
      const s = await settings.alerting();
      return {
        ...(await alertingStatus(db)),
        publicUrlConfigured: !!s.publicUrl,
        smtpConfigured: !!s.smtp,
      };
    },
  );

  // ---------------------------------------------------------------- alerts

  app.get(
    '/alerts',
    {
      preHandler: signedIn,
      schema: {
        summary: 'Firing and pending alerts, or the history of resolved ones (paged)',
        tags: ['alerts', PUBLIC_TAG],
        querystring: Type.Object({
          view: Type.Optional(Type.Union([Type.Literal('firing'), Type.Literal('history')])),
          clusterId: Type.Optional(Type.String({ format: 'uuid' })),
          ruleId: Type.Optional(Type.String({ format: 'uuid' })),
          severity: Type.Optional(Severity),
          /** Only alerts held back while their cluster or node is not reporting (ADR-094). */
          held: Type.Optional(Type.Boolean()),
          cursor: Type.Optional(Type.String({ maxLength: 200 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
        }),
        response: { 200: AlertListSchema, ...Errors },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.org.id;
      const { view = 'firing', clusterId, ruleId, severity, cursor } = request.query;
      let q = alertsQuery(orgId);
      if (clusterId) q = q.where('s.cluster_id', '=', clusterId);
      if (ruleId) q = q.where('s.rule_id', '=', ruleId);
      if (severity) q = q.where('s.severity', '=', severity);

      let rows: AlertRow[];
      let nextCursor: string | null = null;
      if (view === 'firing') {
        rows = (await q
          .where('s.state', 'in', ['firing', 'pending'])
          .where('s.held', '=', request.query.held ?? false)
          .orderBy(sql`s.state = 'firing'`, 'desc')
          .orderBy(sql`s.severity = 'critical'`, 'desc')
          .orderBy('s.started_at', 'desc')
          .limit(500)
          .execute()) as AlertRow[];
      } else {
        const limit = request.query.limit ?? HISTORY_PAGE;
        let h = q.where('s.state', '=', 'resolved');
        if (cursor) {
          const c = decodeCursor(cursor);
          if (!c) return sendProblem(reply, 400, 'Invalid cursor');
          h = h.where((eb) =>
            eb.or([
              eb('s.resolved_at', '<', c.at),
              eb.and([eb('s.resolved_at', '=', c.at), eb('s.id', '<', c.id)]),
            ]),
          );
        }
        rows = (await h
          .orderBy('s.resolved_at', 'desc')
          .orderBy('s.id', 'desc')
          .limit(limit + 1)
          .execute()) as AlertRow[];
        if (rows.length > limit) {
          rows = rows.slice(0, limit);
          const last = rows[rows.length - 1]!;
          nextCursor = encodeCursor(new Date(last.resolved_at!), last.id);
        }
      }

      let cq = db
        .selectFrom('alert_states')
        .select([
          (eb) =>
            eb.fn
              .countAll<string>()
              .filterWhere((w) =>
                w.and([
                  w('state', '=', 'firing'),
                  w('silenced', '=', false),
                  w('held', '=', false),
                ]),
              )
              .as('firing'),
          (eb) =>
            eb.fn
              .countAll<string>()
              .filterWhere((w) =>
                w.and([w('state', 'in', ['firing', 'pending']), w('held', '=', true)]),
              )
              .as('held'),
          ...(['critical', 'warning'] as const).map(
            (sev) => (eb: ExpressionBuilder<DB, 'alert_states'>) =>
              eb.fn
                .countAll<string>()
                .filterWhere((w) =>
                  w.and([
                    w('state', '=', 'firing'),
                    w('silenced', '=', false),
                    w('held', '=', false),
                    w('severity', '=', sev),
                  ]),
                )
                .as(sev),
          ),
          (eb) =>
            eb.fn
              .countAll<string>()
              .filterWhere((w) => w.and([w('state', '=', 'pending'), w('held', '=', false)]))
              .as('pending'),
          (eb) =>
            eb.fn
              .countAll<string>()
              .filterWhere((w) => w.and([w('state', '=', 'firing'), w('silenced', '=', true)]))
              .as('silenced'),
        ])
        .where('org_id', '=', orgId);
      if (clusterId) cq = cq.where('cluster_id', '=', clusterId);
      const counts = await cq.executeTakeFirstOrThrow();
      return {
        alerts: await (async () => {
          const d = await deliveriesOf(
            rows.map((r) => r.id),
            hideErrors(request),
          );
          return rows.map((r) => toAlert(r, d.get(r.id)));
        })(),
        nextCursor,
        counts: {
          firing: Number(counts.firing),
          pending: Number(counts.pending),
          silenced: Number(counts.silenced),
          held: Number(counts.held),
          critical: Number(counts.critical),
          warning: Number(counts.warning),
        },
      };
    },
  );

  app.get(
    '/alerts/:id',
    {
      preHandler: signedIn,
      schema: {
        summary: 'One alert with the messages sent for it and its earlier episodes',
        tags: ['alerts', PUBLIC_TAG],
        params: IdParams,
        response: { 200: AlertDetailSchema, ...Errors },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.org.id;
      const row = (await alertsQuery(orgId)
        .where('s.id', '=', request.params.id)
        .executeTakeFirst()) as (AlertRow & { fingerprint: string }) | undefined;
      if (!row) return sendProblem(reply, 404, 'Alert not found');
      const [notes, history, gaps] = await Promise.all([
        db
          .selectFrom('notification_alerts as na')
          .innerJoin('notifications as n', 'n.id', 'na.notification_id')
          .leftJoin('alert_channels as ch', 'ch.id', 'n.channel_id')
          .select([
            'n.id',
            'n.kind',
            'n.status',
            'n.error',
            'n.attempts',
            'n.created_at',
            'n.sent_at',
            'n.payload',
            'ch.id as channel_id',
            'ch.name as channel_name',
            'ch.type as channel_type',
          ])
          .where('na.alert_state_id', '=', row.id)
          .orderBy('n.created_at')
          .execute(),
        alertsQuery(orgId)
          .where('s.rule_id', '=', row.rule_id)
          .where('s.cluster_id', '=', row.cluster_id)
          .where('s.fingerprint', '=', row.fingerprint)
          .where('s.id', '<>', row.id)
          .orderBy('s.started_at', 'desc')
          .limit(10)
          .execute(),
        alertingGaps(db, row.started_at, row.resolved_at ?? new Date()),
      ]);
      const alert = toAlert(row, (await deliveriesOf([row.id], hideErrors(request))).get(row.id));
      const [likelyCause] =
        causes && wantsCause(request)
          ? await causes.likely(causeReader(app, request), orgId, [
              {
                cluster: { ...alert.cluster, kind: alert.cluster.kind as 'kubernetes' | 'docker' },
                subject: { kind: 'alert', id: alert.id },
              },
            ])
          : [];
      return {
        alert,
        ...(likelyCause ? { likelyCause } : {}),
        notifications: notes.map((n) => ({
          id: n.id,
          kind: n.kind,
          status: n.status,
          error: hideErrors(request) ? null : n.error,
          attempts: n.attempts,
          createdAt: iso(n.created_at)!,
          sentAt: iso(n.sent_at),
          // The message carries the alert's likely cause (ADR-157).
          ...((n.payload as unknown as MessagePayload).items?.some(
            (i) => i.alertId === row.id && i.likelyCause,
          )
            ? { withCause: true }
            : {}),
          channel: n.channel_id
            ? { id: n.channel_id, name: n.channel_name!, type: n.channel_type! }
            : null,
        })),
        history: (history as AlertRow[]).map((r) => toAlert(r)),
        gaps: gaps.map((g) => ({ from: g.from.toISOString(), to: iso(g.to) })),
      };
    },
  );

  app.get(
    '/alerts/:id/chart',
    {
      preHandler: signedIn,
      schema: {
        summary: "An alert's chart: its object's series around the alert, thresholds and markers",
        tags: ['alerts', PUBLIC_TAG],
        params: IdParams,
        querystring: ChartQuerySchema,
        response: { 200: AlertChartSchema, 502: ProblemSchema, ...Errors },
      },
    },
    async (request, reply) => {
      try {
        const chart = await alertChart({ db, victoria }, request.user!.org.id, request.params.id, {
          rangeSeconds: request.query.range,
          // The demo charts at most a day, however long the alert (ADR-122).
          ...(demoMode ? { maxSpanSeconds: 86_400 } : {}),
        });
        if (!chart) return sendProblem(reply, 404, 'Alert not found');
        return chart;
      } catch (err) {
        request.log.warn({ err: (err as Error).message }, 'alert chart query failed');
        return sendProblem(reply, 502, 'Metrics could not be queried');
      }
    },
  );

  // ---------------------------------------------------------------- silences

  async function silenceViews(orgId: string, all: boolean) {
    const now = Date.now();
    let q = db
      .selectFrom('silences')
      .selectAll()
      .where('org_id', '=', orgId)
      .orderBy('ends_at', 'desc');
    if (!all) q = q.where('ends_at', '>', new Date(now));
    const [rows, open] = await Promise.all([
      q.limit(200).execute(),
      db
        .selectFrom('alert_states')
        .select(['labels', 'rule_id', 'cluster_id', 'severity'])
        .where('org_id', '=', orgId)
        .where('state', 'in', ['pending', 'firing'])
        .execute(),
    ]);
    return rows.map((s) => {
      const window = {
        matchers: s.matchers as SilenceMatchers,
        startsAt: new Date(s.starts_at).getTime(),
        endsAt: new Date(s.ends_at).getTime(),
      };
      const active = window.startsAt <= now && now < window.endsAt;
      const matching = active
        ? open.filter((a) =>
            isSilenced(
              [window],
              silenceTarget(
                a.labels as Record<string, string>,
                a.rule_id,
                a.cluster_id,
                a.severity as 'warning' | 'critical',
              ),
              now,
            ),
          ).length
        : 0;
      return {
        id: s.id,
        matchers: window.matchers as Static<typeof SilenceMatchersSchema>,
        startsAt: iso(s.starts_at)!,
        endsAt: iso(s.ends_at)!,
        comment: s.comment,
        createdBy: s.created_by,
        active,
        matching,
      };
    });
  }

  app.get(
    '/silences',
    {
      preHandler: signedIn,
      schema: {
        summary: 'Active silences (or all of the last ones with all=true)',
        tags: ['alerts', PUBLIC_TAG],
        querystring: Type.Object({ all: Type.Optional(Type.Boolean()) }),
        response: { 200: Type.Object({ silences: Type.Array(SilenceSchema) }), ...Errors },
      },
    },
    async (request) => ({
      silences: await silenceViews(request.user!.org.id, request.query.all ?? false),
    }),
  );

  app.post(
    '/silences',
    {
      preHandler: canManage,
      schema: {
        summary: 'Silence matching alerts for a while (ADR-077)',
        tags: ['alerts'],
        body: CreateSilenceSchema,
        response: { 201: SilenceSchema, ...Errors },
      },
    },
    async (request, reply) => {
      const { org, id: userId } = request.user!;
      const { matchers, durationMinutes, comment } = request.body;
      if (Object.keys(matchers).length === 0) {
        return sendProblem(reply, 400, 'A silence needs at least one matcher');
      }
      if (matchers.rule) {
        const rule = await db
          .selectFrom('alert_rules')
          .select('id')
          .where('id', '=', matchers.rule)
          .where('org_id', '=', org.id)
          .executeTakeFirst();
        if (!rule) return sendProblem(reply, 400, 'Unknown rule');
      }
      if (matchers.cluster) {
        const cluster = await db
          .selectFrom('clusters')
          .select('id')
          .where('id', '=', matchers.cluster)
          .where('org_id', '=', org.id)
          .executeTakeFirst();
        if (!cluster) return sendProblem(reply, 400, 'Unknown cluster');
      }
      const id = newId();
      const now = Date.now();
      await db
        .insertInto('silences')
        .values({
          id,
          org_id: org.id,
          matchers: JSON.stringify(matchers),
          starts_at: new Date(now),
          ends_at: new Date(now + durationMinutes * 60_000),
          created_by: userId,
          comment,
        })
        .execute();
      const view = (await silenceViews(org.id, false)).find((s) => s.id === id)!;
      return reply.code(201).send(view);
    },
  );

  app.delete(
    '/silences/:id',
    {
      preHandler: canManage,
      schema: {
        summary: 'End a silence now',
        tags: ['alerts'],
        params: IdParams,
        response: { 204: Type.Null(), ...Errors },
      },
    },
    async (request, reply) => {
      const res = await db
        .updateTable('silences')
        .set({ ends_at: sql`GREATEST(now(), starts_at + interval '1 millisecond')` })
        .where('id', '=', request.params.id)
        .where('org_id', '=', request.user!.org.id)
        .where('ends_at', '>', new Date())
        .executeTakeFirst();
      if (res.numUpdatedRows === 0n)
        return sendProblem(reply, 404, 'No active silence with this id');
      return reply.code(204).send(null);
    },
  );

  // ---------------------------------------------------------------- rules

  async function ruleViews(orgId: string, id?: string) {
    let q = db.selectFrom('alert_rules').selectAll().where('org_id', '=', orgId);
    if (id) q = q.where('id', '=', id);
    const [rows, firing] = await Promise.all([
      q.orderBy('type').orderBy('name').execute(),
      db
        .selectFrom('alert_states')
        .select(['rule_id', (eb) => eb.fn.countAll<string>().as('n')])
        .where('org_id', '=', orgId)
        .where('state', '=', 'firing')
        .groupBy('rule_id')
        .execute(),
    ]);
    const counts = new Map(firing.map((f) => [f.rule_id, Number(f.n)]));
    // Rules scoped to a monitored service name it (SPEC §4.12).
    const serviceIds = [
      ...new Set(
        rows
          .map((r) => (r.scope as { service?: string } | null)?.service)
          .filter((v): v is string => !!v),
      ),
    ];
    const services = serviceIds.length
      ? await db
          .selectFrom('integrations')
          .select(['id', 'name', 'type'])
          .where('org_id', '=', orgId)
          .where('id', 'in', serviceIds)
          .execute()
      : [];
    const byId = new Map(services.map((s) => [s.id, s]));
    return rows.map((r) => {
      const sid = (r.scope as { service?: string } | null)?.service;
      const svc = sid ? byId.get(sid) : undefined;
      return {
        ...ruleView(r as RuleRowView, counts.get(r.id) ?? 0),
        ...(sid ? { service: svc ? { id: svc.id, name: svc.name, type: svc.type } : null } : {}),
      };
    });
  }

  app.get(
    '/alert-rules',
    {
      preHandler: signedIn,
      schema: {
        summary: 'Default and custom alert rules',
        tags: ['alerts', PUBLIC_TAG],
        response: { 200: Type.Object({ rules: Type.Array(RuleSchema) }), ...Errors },
      },
    },
    async (request) => {
      await ensureDefaultRules(db, request.user!.org.id);
      return { rules: await ruleViews(request.user!.org.id) };
    },
  );

  app.patch(
    '/alert-rules/:id',
    {
      preHandler: canManage,
      schema: {
        summary: 'Change a rule: enable, thresholds, durations, severity, channels',
        tags: ['alerts'],
        params: IdParams,
        body: PatchRuleSchema,
        response: { 200: RuleSchema, ...Errors },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.org.id;
      const rule = await db
        .selectFrom('alert_rules')
        .selectAll()
        .where('id', '=', request.params.id)
        .where('org_id', '=', orgId)
        .executeTakeFirst();
      if (!rule) return sendProblem(reply, 404, 'Rule not found');
      const change = await validateRuleChange(db, orgId, rule as RuleRowView, request.body);
      if ('error' in change) return sendProblem(reply, 400, change.error);
      if (rule.type === 'threshold') {
        const err = await validateThreshold(db, orgId, {
          metric: rule.metric!,
          clusterId:
            request.body.clusterId !== undefined ? request.body.clusterId : rule.cluster_id,
          scope: (request.body.scope ?? rule.scope) as ThresholdScope,
        });
        if (err) return sendProblem(reply, 400, err);
      }
      await db.updateTable('alert_rules').set(change.set).where('id', '=', rule.id).execute();
      return (await ruleViews(orgId, rule.id))[0]!;
    },
  );

  app.post(
    '/alert-rules',
    {
      preHandler: canManage,
      schema: {
        summary: 'Create a custom threshold rule: metric, scope, condition (never MetricsQL)',
        tags: ['alerts'],
        body: CreateRuleSchema,
        response: { 201: RuleSchema, ...Errors },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.org.id;
      const b = request.body;
      const err = await validateThreshold(db, orgId, {
        metric: b.metric,
        clusterId: b.clusterId,
        scope: b.scope,
        condition: b.condition,
      });
      if (err) return sendProblem(reply, 400, err);
      const channels = [...new Set(b.channelIds)];
      if (channels.length) {
        const found = await db
          .selectFrom('alert_channels')
          .select('id')
          .where('org_id', '=', orgId)
          .where('id', 'in', channels)
          .execute();
        if (found.length !== channels.length) return sendProblem(reply, 400, 'Unknown channel');
      }
      const id = await insertThresholdRule(db, orgId, { ...b, channelIds: channels });
      return reply.code(201).send((await ruleViews(orgId, id))[0]!);
    },
  );

  app.put(
    '/alert-rules/defaults/channels',
    {
      preHandler: canManage,
      schema: {
        summary: 'Send every default rule to these channels ("Default rules send to")',
        tags: ['alerts'],
        body: Type.Object(
          { channelIds: Type.Array(Id, { maxItems: 50 }) },
          { additionalProperties: false },
        ),
        response: { 200: Type.Object({ rules: Type.Array(RuleSchema) }), ...Errors },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.org.id;
      const ids = [...new Set(request.body.channelIds)];
      if (ids.length) {
        const found = await db
          .selectFrom('alert_channels')
          .select('id')
          .where('org_id', '=', orgId)
          .where('id', 'in', ids)
          .execute();
        if (found.length !== ids.length) return sendProblem(reply, 400, 'Unknown channel');
      }
      await ensureDefaultRules(db, orgId);
      await db
        .updateTable('alert_rules')
        .set({ channel_ids: ids })
        .where('org_id', '=', orgId)
        .where('type', '=', 'default')
        .execute();
      return { rules: await ruleViews(orgId) };
    },
  );

  app.post(
    '/alert-rules/:id/reset',
    {
      preHandler: canManage,
      schema: {
        summary:
          "Put a default rule's thresholds, duration, severity and reminders back (channels stay)",
        tags: ['alerts'],
        params: IdParams,
        response: { 200: RuleSchema, 409: ProblemSchema, ...Errors },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.org.id;
      const rule = await db
        .selectFrom('alert_rules')
        .select(['id', 'rule_key', 'default_key'])
        .where('id', '=', request.params.id)
        .where('org_id', '=', orgId)
        .executeTakeFirst();
      if (!rule) return sendProblem(reply, 404, 'Rule not found');
      // A monitored service's default (slice 7): its condition, duration, severity and
      // name come back; whether it is on and its channels stay as they are.
      const serviceDefault = rule.default_key ? alertDefaultByKey(rule.default_key) : undefined;
      if (serviceDefault) {
        await db
          .updateTable('alert_rules')
          .set({
            name: serviceDefault.name,
            condition: JSON.stringify(serviceDefault.condition),
            for_seconds: serviceDefault.forSeconds,
            severity: serviceDefault.severity ?? 'warning',
            renotify_seconds: 14400,
            eval_error: null,
          })
          .where('id', '=', rule.id)
          .execute();
        return (await ruleViews(orgId, rule.id))[0]!;
      }
      const def = DEFAULT_RULES.find((r) => r.key === rule.rule_key);
      if (!def) return sendProblem(reply, 409, 'Only default rules can be reset');
      await db
        .updateTable('alert_rules')
        .set({
          name: def.name,
          condition: JSON.stringify(def.condition ?? {}),
          for_seconds: def.forSeconds,
          severity: def.severity,
          renotify_seconds: 14400,
          enabled: true,
          eval_error: null,
        })
        .where('id', '=', rule.id)
        .execute();
      return (await ruleViews(orgId, rule.id))[0]!;
    },
  );

  app.post(
    '/alert-rules/preview',
    {
      preHandler: canManage,
      schema: {
        summary:
          'How often a rule would have fired: a 24 h backtest for metric rules, the last 7 days of history for state rules',
        tags: ['alerts'],
        body: PreviewBodySchema,
        response: { 200: PreviewSchema, 503: ProblemSchema, ...Errors },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.org.id;
      const b = request.body;
      const rule = b.ruleId
        ? await db
            .selectFrom('alert_rules')
            .selectAll()
            .where('id', '=', b.ruleId)
            .where('org_id', '=', orgId)
            .executeTakeFirst()
        : undefined;
      if (b.ruleId && !rule) return sendProblem(reply, 404, 'Rule not found');
      const def = rule?.rule_key ? DEFAULT_RULES.find((d) => d.key === rule.rule_key) : undefined;

      // State rules cannot be replayed: say how often the rule fired in the last 7 days.
      if (def && !def.condition) {
        const since = new Date(Date.now() - 7 * 86_400_000);
        const counts = await db
          .selectFrom('alert_states')
          .select([
            (eb) => eb.fn.countAll<string>().as('fired'),
            (eb) =>
              eb.fn.countAll<string>().filterWhere('severity', '=', 'critical').as('critical'),
          ])
          .where('rule_id', '=', rule!.id)
          .where('fired_at', '>=', since)
          .executeTakeFirstOrThrow();
        // The latest of them, charted as on its alert page (rule-charts.ts).
        const latest = await db
          .selectFrom('alert_states')
          .select('id')
          .where('rule_id', '=', rule!.id)
          .where('fired_at', '>=', since)
          .orderBy('fired_at', 'desc')
          .limit(1)
          .executeTakeFirst();
        const chart = latest
          ? await alertChart({ db, victoria }, orgId, latest.id).catch((err: Error) => {
              request.log.warn({ err: err.message }, 'preview chart query failed');
              return null;
            })
          : null;
        return {
          kind: 'state' as const,
          fired: Number(counts.fired),
          critical: Number(counts.critical),
          hours: 168,
          unit: null,
          chart,
          series: null,
        };
      }

      if (!victoria) return sendProblem(reply, 503, 'Metrics are not available');
      const cond = (b.condition ?? rule?.condition) as Condition | undefined;
      if (!cond || !validCondition(cond)) return sendProblem(reply, 400, 'Enter a threshold');
      const forSeconds = b.forSeconds ?? rule?.for_seconds ?? 0;
      const clusterId = b.clusterId !== undefined ? b.clusterId : (rule?.cluster_id ?? null);
      const scope = (b.scope ?? rule?.scope ?? {}) as ThresholdScope;
      const custom = b.metric ?? (def ? undefined : (rule?.metric ?? undefined));
      if (custom && !(METRIC_KEYS as string[]).includes(custom)) {
        return sendProblem(reply, 400, `Unknown metric "${custom}"`);
      }
      let clusters = db
        .selectFrom('clusters')
        .select(['id', 'name', 'kind'])
        .where('org_id', '=', orgId);
      if (clusterId) clusters = clusters.where('id', '=', clusterId);
      const targets = await clusters.execute();

      const end = Math.floor(Date.now() / 1000);
      const start = end - 24 * 3600;
      const total = { fired: 0, critical: 0 };
      let busiest: {
        name: string;
        points: [number, number | null][];
        fired: number;
        peak: number;
      } | null = null;
      let unit: string | null = null;
      for (const c of targets) {
        const key = (custom ?? def?.metrics?.[c.kind as 'kubernetes' | 'docker']) as
          MetricKey | undefined;
        if (!key || (custom && !metricKinds(custom).includes(c.kind as 'kubernetes' | 'docker')))
          continue;
        unit = metricUnit(key);
        let q: QueryScope | null;
        try {
          q = custom ? await resolveScope(db, c.id, scope, custom) : {};
        } catch (err) {
          return sendProblem(reply, 400, (err as Error).message);
        }
        if (!q) continue;
        const { expr } = buildQuery(key, q, 60);
        const series = await victoria.queryRange({ clusterId: c.id }, expr, start, end, 60);
        for (const s of series) {
          const r = backtest(s.points, cond, forSeconds);
          total.fired += r.fired;
          total.critical += r.critical;
          const peak = Math.max(...s.points.map(([, v]) => v ?? -Infinity));
          if (
            !busiest ||
            r.fired > busiest.fired ||
            (r.fired === busiest.fired && peak > busiest.peak)
          ) {
            busiest = {
              name: seriesName(s.labels, c.name),
              points: s.points,
              fired: r.fired,
              peak,
            };
          }
        }
      }
      return {
        kind: 'metric' as const,
        ...total,
        hours: 24,
        unit,
        series: busiest ? { name: busiest.name, points: busiest.points } : null,
      };
    },
  );

  app.delete(
    '/alert-rules/:id',
    {
      preHandler: canManage,
      schema: {
        summary: 'Delete a custom rule (default rules can only be disabled)',
        tags: ['alerts'],
        params: IdParams,
        response: { 204: Type.Null(), 409: ProblemSchema, ...Errors },
      },
    },
    async (request, reply) => {
      const rule = await db
        .selectFrom('alert_rules')
        .select(['id', 'type'])
        .where('id', '=', request.params.id)
        .where('org_id', '=', request.user!.org.id)
        .executeTakeFirst();
      if (!rule) return sendProblem(reply, 404, 'Rule not found');
      if (rule.type === 'default') {
        return sendProblem(reply, 409, 'Default rules can be disabled, not deleted');
      }
      await db.deleteFrom('alert_rules').where('id', '=', rule.id).execute();
      return reply.code(204).send(null);
    },
  );

  // ---------------------------------------------------------------- channels

  function channelView(row: Selectable<AlertChannels>, ruleCount: number) {
    const cfg = row.config as Record<string, unknown>;
    let secrets: Record<string, string> = {};
    if (demoMode) {
      return {
        id: row.id,
        type: row.type as 'slack' | 'telegram' | 'email' | 'webhook',
        name: row.name,
        config: row.type === 'telegram' ? { connected: cfg.chatId !== undefined } : {},
        secrets,
        verifiedAt: iso(row.verified_at),
        lastSentAt: iso(row.last_sent_at),
        lastError: null,
        lastErrorAt: null,
        createdAt: iso(row.created_at)!,
        ruleCount,
      };
    }
    if (row.secret) {
      try {
        secrets = Object.fromEntries(
          Object.entries(decryptJson(config.secretKey, row.secret)).map(([k, v]) => [k, last4(v)]),
        );
      } catch {
        secrets = { secret: 'unreadable' };
      }
    }
    return {
      id: row.id,
      type: row.type as 'slack' | 'telegram' | 'email' | 'webhook',
      name: row.name,
      config: {
        ...(Array.isArray(cfg.recipients) ? { recipients: cfg.recipients as string[] } : {}),
        // A password or token inside the webhook's address is not shown (ADR-122).
        ...(typeof cfg.url === 'string' ? { url: redactUrl(cfg.url) } : {}),
        ...(typeof cfg.botName === 'string' ? { botName: cfg.botName } : {}),
        ...(typeof cfg.chatName === 'string' ? { chatName: cfg.chatName } : {}),
        ...(row.type === 'telegram' ? { connected: cfg.chatId !== undefined } : {}),
      },
      secrets,
      verifiedAt: iso(row.verified_at),
      lastSentAt: iso(row.last_sent_at),
      lastError: row.last_error,
      lastErrorAt: iso(row.last_error_at),
      createdAt: iso(row.created_at)!,
      ruleCount,
    };
  }

  async function channelViews(orgId: string, id?: string) {
    let q = db.selectFrom('alert_channels').selectAll().where('org_id', '=', orgId);
    if (id) q = q.where('id', '=', id);
    const [rows, uses] = await Promise.all([
      q.orderBy('created_at').execute(),
      sql<{ id: string; n: string }>`
        SELECT unnest(channel_ids) AS id, count(*) AS n FROM alert_rules
         WHERE org_id = ${orgId} GROUP BY 1`.execute(db),
    ]);
    const counts = new Map(uses.rows.map((u) => [u.id, Number(u.n)]));
    return rows.map((r) => channelView(r, counts.get(r.id) ?? 0));
  }

  async function findChannel(orgId: string, id: string) {
    return db
      .selectFrom('alert_channels')
      .selectAll()
      .where('id', '=', id)
      .where('org_id', '=', orgId)
      .executeTakeFirst();
  }

  app.get(
    '/alert-channels',
    {
      preHandler: signedIn,
      schema: {
        summary: 'Alert channels; secrets are shown only as their last 4 characters',
        tags: ['alerts'],
        response: { 200: Type.Object({ channels: Type.Array(ChannelSchema) }), ...Errors },
      },
    },
    async (request) => ({ channels: await channelViews(request.user!.org.id) }),
  );

  app.post(
    '/alert-channels',
    {
      preHandler: canManage,
      schema: {
        summary: 'Add a Slack, Telegram, email or webhook channel',
        tags: ['alerts'],
        body: CreateChannelSchema,
        response: { 201: CreatedChannelSchema, ...Errors },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.org.id;
      const { type, name, settings: input } = request.body;
      const cfg: Record<string, unknown> = {};
      const secret: Record<string, string> = {};
      let signingSecret: string | undefined;
      switch (type) {
        case 'slack':
          if (!input.webhookUrl) return sendProblem(reply, 400, 'Slack needs a webhook URL');
          secret.webhookUrl = input.webhookUrl;
          break;
        case 'telegram': {
          if (!input.botToken) return sendProblem(reply, 400, 'Telegram needs a bot token');
          try {
            cfg.botName = await botName(input.botToken);
          } catch (err) {
            return telegramProblem(reply, err);
          }
          secret.botToken = input.botToken;
          break;
        }
        case 'email':
          if (!input.recipients?.length) {
            return sendProblem(reply, 400, 'Email needs at least one recipient');
          }
          cfg.recipients = input.recipients;
          break;
        case 'webhook':
          if (!input.url) return sendProblem(reply, 400, 'A webhook needs a URL');
          cfg.url = input.url;
          signingSecret = input.signingSecret ?? randomBytes(24).toString('base64url');
          secret.signingSecret = signingSecret;
          break;
      }
      const id = newId();
      const existing = await db
        .selectFrom('alert_channels')
        .select('id')
        .where('org_id', '=', orgId)
        .limit(1)
        .execute();
      const useForAll = request.body.useForAllRules ?? existing.length === 0;
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto('alert_channels')
          .values({
            id,
            org_id: orgId,
            type,
            name,
            config: JSON.stringify(cfg),
            secret: Object.keys(secret).length ? encryptJson(config.secretKey, secret) : null,
          })
          .execute();
        if (useForAll) {
          await ensureDefaultRules(trx, orgId);
          await trx
            .updateTable('alert_rules')
            .set({ channel_ids: sql`array_append(channel_ids, ${id}::uuid)` })
            .where('org_id', '=', orgId)
            .execute();
        }
      });
      const connect =
        type === 'telegram'
          ? await startTelegramVerification(db, id, cfg.botName as string)
          : undefined;
      return reply.code(201).send({
        channel: (await channelViews(orgId, id))[0]!,
        ...(type === 'webhook' && !input.signingSecret ? { signingSecret } : {}),
        ...(connect ? { connect: { link: connect.link, expiresAt: iso(connect.expiresAt)! } } : {}),
      });
    },
  );

  app.patch(
    '/alert-channels/:id',
    {
      preHandler: canManage,
      schema: {
        summary: 'Rename a channel or replace its settings',
        tags: ['alerts'],
        params: IdParams,
        body: PatchChannelSchema,
        response: { 200: ChannelSchema, ...Errors },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.org.id;
      const row = await findChannel(orgId, request.params.id);
      if (!row) return sendProblem(reply, 404, 'Channel not found');
      const cfg = { ...(row.config as Record<string, unknown>) };
      const secret = row.secret ? decryptJson(config.secretKey, row.secret) : {};
      const s = request.body.settings ?? {};
      let reverify = false;
      if (row.type === 'slack' && s.webhookUrl) secret.webhookUrl = s.webhookUrl;
      if (row.type === 'email' && s.recipients) cfg.recipients = s.recipients;
      if (row.type === 'webhook') {
        if (s.url) cfg.url = s.url;
        if (s.signingSecret) secret.signingSecret = s.signingSecret;
      }
      if (row.type === 'telegram' && s.botToken) {
        try {
          cfg.botName = await botName(s.botToken);
        } catch (err) {
          return telegramProblem(reply, err);
        }
        secret.botToken = s.botToken;
        // A new bot cannot write to the old chat until it is connected again.
        delete cfg.chatId;
        delete cfg.chatName;
        reverify = true;
      }
      await db
        .updateTable('alert_channels')
        .set({
          name: request.body.name ?? row.name,
          config: JSON.stringify(cfg),
          secret: Object.keys(secret).length ? encryptJson(config.secretKey, secret) : null,
          ...(reverify || Object.keys(s).length ? { verified_at: null } : {}),
        })
        .where('id', '=', row.id)
        .execute();
      return (await channelViews(orgId, row.id))[0]!;
    },
  );

  app.delete(
    '/alert-channels/:id',
    {
      preHandler: canManage,
      schema: {
        summary: 'Delete a channel and remove it from every rule',
        tags: ['alerts'],
        params: IdParams,
        response: { 204: Type.Null(), ...Errors },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.org.id;
      const row = await findChannel(orgId, request.params.id);
      if (!row) return sendProblem(reply, 404, 'Channel not found');
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('alert_rules')
          .set({ channel_ids: sql`array_remove(channel_ids, ${row.id}::uuid)` })
          .where('org_id', '=', orgId)
          .execute();
        await trx.deleteFrom('alert_channels').where('id', '=', row.id).execute();
      });
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/alert-channels/:id/test',
    {
      preHandler: canManage,
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        summary: 'Send a test message now; returns the provider error if it fails',
        tags: ['alerts'],
        params: IdParams,
        response: { 200: TestResultSchema, ...Errors },
      },
    },
    async (request, reply) => {
      const row = await findChannel(request.user!.org.id, request.params.id);
      if (!row) return sendProblem(reply, 404, 'Channel not found');
      const res = await sendTest(delivery, row.id);
      const at = new Date();
      await db
        .updateTable('alert_channels')
        .set(
          res.ok
            ? {
                verified_at: row.verified_at ?? at,
                last_sent_at: at,
                last_error: null,
                last_error_at: null,
              }
            : { last_error: res.error.slice(0, 1000), last_error_at: at },
        )
        .where('id', '=', row.id)
        .execute();
      return res.ok ? { ok: true, error: null } : { ok: false, error: res.error };
    },
  );

  app.post(
    '/alert-channels/:id/telegram/connect',
    {
      preHandler: canManage,
      schema: {
        summary: 'A one-time link that connects a Telegram chat to this channel (10 minutes)',
        tags: ['alerts'],
        params: IdParams,
        response: {
          200: Type.Object({ link: Type.String(), expiresAt: Type.String() }),
          ...Errors,
        },
      },
    },
    async (request, reply) => {
      const row = await findChannel(request.user!.org.id, request.params.id);
      if (!row || row.type !== 'telegram')
        return sendProblem(reply, 404, 'Telegram channel not found');
      const botName = (row.config as { botName?: string }).botName;
      if (!botName) return sendProblem(reply, 400, 'The channel has no bot; set its token first');
      const { link, expiresAt } = await startTelegramVerification(db, row.id, botName);
      return { link, expiresAt: expiresAt.toISOString() };
    },
  );
};
