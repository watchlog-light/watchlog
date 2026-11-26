// SPDX-License-Identifier: AGPL-3.0-only
// Change events from outside (1.0.0, ADR-238): "we deployed 2.15.0", "the config changed",
// sent by CI or a script with an own-metrics token. An event is stored twice, like a change
// WatchLog sees itself: a change marker (charts, What changed's "Changed around then",
// probable cause) and a row of Events on the workload or server it belongs to, labelled with
// the token's name. It never raises an alert: it is a fact for the alerts that do fire.
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { Database } from '../../db/index.js';
import { bindOrg } from '../../db/org-context.js';
import { newId } from '../../lib/ids.js';
import { ProblemType, sendProblem } from '../../lib/problem.js';
import { ProblemSchema } from '../auth/schemas.js';
import { recordEvent } from '../events/record.js';
import { TokenBuckets, type BucketSpec } from '../ingest/rate-limit.js';
import type { TokenCache } from '../ingest/token-cache.js';
import type { Belonging } from './belonging.js';
import { isMetricToken } from './tokens.js';

export const EVENT_KINDS = ['deploy', 'config', 'migration', 'flag', 'other'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
/** The marker kind of every change event from outside. */
export const EXTERNAL_MARKER = 'external';
/** One event a second from a token, bursts of 30: a pipeline, not a stream. */
export const EVENT_BUCKET: BucketSpec = { ratePerSec: 1, burst: 30 };
/** The Events row's reason, by kind. */
const REASON: Record<EventKind, string> = {
  deploy: 'Deployed',
  config: 'ConfigChanged',
  migration: 'Migrated',
  flag: 'FlagChanged',
  other: 'Changed',
};
const WEEK_MS = 7 * 86_400_000;

const lits = <T extends readonly string[]>(values: T) =>
  Type.Union(values.map((v) => Type.Literal(v))) as unknown as ReturnType<
    typeof Type.Unsafe<T[number]>
  >;

const Body = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200, description: '"Deployed orders 2.15.0"' }),
  kind: Type.Optional(lits(EVENT_KINDS)),
  /** In a cluster: what it is about, as "namespace/name". */
  workload: Type.Optional(Type.String({ maxLength: 400 })),
  /** On a fleet: the server it is about. */
  server: Type.Optional(Type.String({ maxLength: 253 })),
  /** A page to open from the event: the pipeline run, the pull request. */
  link: Type.Optional(Type.String({ maxLength: 500, pattern: '^https?://' })),
  /** When it happened (unix seconds or ISO 8601); now when left out. */
  time: Type.Optional(Type.Union([Type.Number(), Type.String({ maxLength: 40 })])),
});

export interface ChangeEventRoutesOptions {
  db: Database;
  tokens: TokenCache;
  belonging: Belonging;
  eventsRetentionDays: number;
  bucket?: BucketSpec;
  now?: () => number;
}

export const changeEventRoutes: FastifyPluginAsyncTypebox<ChangeEventRoutesOptions> = async (
  app,
  { db, tokens, belonging, eventsRetentionDays, bucket, now = Date.now },
) => {
  const buckets = new TokenBuckets(bucket ?? EVENT_BUCKET, now);
  const pruning = setInterval(() => buckets.prune(), 60_000);
  pruning.unref();
  app.addHook('onClose', async () => clearInterval(pruning));

  app.post(
    '/events',
    {
      schema: {
        summary: 'Tell WatchLog about a change: a deploy, a config change, a migration',
        description:
          'With an own-metrics token (`wl_mt_…`, made under Your metrics → Add a source), from CI or a script. The event shows in Events, as a marker on charts, under "Changed around then" in What changed and in probable cause, labelled with the token\'s name. It never raises an alert.',
        tags: ['own-metrics'],
        body: Body,
        response: {
          201: Type.Object({
            id: Type.String(),
            /** What the event was tied to: "shop/orders", "db-1"; null when to nothing. */
            belongsTo: Type.Union([Type.String(), Type.Null()]),
          }),
          400: ProblemSchema,
          401: ProblemSchema,
          402: ProblemSchema,
          429: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const header = request.headers.authorization ?? '';
      const value = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      const owner = isMetricToken(value) ? await tokens.verifyMetric(value) : null;
      if (!owner) {
        return sendProblem(
          reply,
          401,
          'Change events need an own-metrics token (wl_mt_…): make one under Your metrics → Add a source',
        );
      }
      bindOrg(owner.orgId);
      const block = app.entitlements ? await app.entitlements.ingestBlock(owner.orgId) : null;
      if (block) {
        return sendProblem(
          reply,
          402,
          block === 'deleting'
            ? 'This organization is scheduled for deletion; its data is not stored.'
            : 'This organization is suspended; its data is not stored.',
          block === 'deleting' ? ProblemType.orgDeleting : ProblemType.orgSuspended,
        );
      }
      const wait = buckets.take(owner.tokenId);
      if (wait > 0) {
        reply.header('retry-after', String(wait));
        return sendProblem(
          reply,
          429,
          'Change-event rate limit reached for this token; retry later',
        );
      }

      const b = request.body;
      const at =
        b.time === undefined
          ? now()
          : typeof b.time === 'number'
            ? b.time * 1000
            : Date.parse(b.time);
      if (!Number.isFinite(at))
        return sendProblem(reply, 400, 'Give `time` in unix seconds or ISO 8601');
      if (at > now() + 5 * 60_000 || at < now() - WEEK_MS)
        return sendProblem(reply, 400, '`time` must be within the last 7 days');
      const kind: EventKind = b.kind ?? 'deploy';
      const known = await belonging.known(owner.clusterId);
      const o = belonging.fromPush(known, { workload: b.workload, server: b.server });
      const target =
        o.kind === 'workload'
          ? `${o.workloadKind}/${o.namespace}/${o.name}`
          : o.kind === 'server'
            ? `Node/${o.name}`
            : `External/${owner.name}`;
      const belongsTo =
        o.kind === 'workload' ? `${o.namespace}/${o.name}` : o.kind === 'server' ? o.name : null;
      const id = newId();
      const title = b.title.trim();
      await db
        .insertInto('change_markers')
        .values({
          id,
          cluster_id: owner.clusterId,
          org_id: owner.orgId,
          kind: EXTERNAL_MARKER,
          target,
          namespace: o.kind === 'workload' ? o.namespace : '',
          details: JSON.stringify({
            title,
            what: kind,
            source: owner.name,
            ...(b.link ? { link: b.link } : {}),
          }),
          ts: new Date(at),
        })
        .execute();
      await recordEvent(
        db,
        {
          orgId: owner.orgId,
          clusterId: owner.clusterId,
          kind: 'Change',
          name: belongsTo ?? owner.name,
          key: `change:${id}`,
          host: o.kind === 'server' ? o.name : '',
          namespace: o.kind === 'workload' ? o.namespace : '',
          reason: REASON[kind],
          type: 'Normal',
          message: b.link ? `${title} · ${b.link}` : title,
          at,
          source: `token "${owner.name}"`,
        },
        eventsRetentionDays,
      );
      return reply.code(201).send({ id, belongsTo });
    },
  );
};
