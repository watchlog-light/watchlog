// SPDX-License-Identifier: AGPL-3.0-only
// The integrations collector's side of the ingest API (ADR-131), registered inside the
// ingest plugin so it shares its token auth, rate limits and error recording:
//   GET  /ingest/v1/integrations/config  its targets, long-polled with If-None-Match
//   POST /ingest/v1/integrations/status  its health and each target's state; also its heartbeat
// Metrics go through /ingest/v1/write like every agent's.
import type { FastifyInstance } from 'fastify';
import { Type, type Static } from 'typebox';
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { sendProblem } from '../../lib/problem.js';
import { ProblemSchema } from '../auth/schemas.js';
import { buildCollectorConfig } from './collector-config.js';
import type { ConfigNotifier } from './notifier.js';

/** The longest a config request waits for a change (ADR-131). */
export const MAX_WAIT_S = 25;

const Host = Type.String({ maxLength: 253, pattern: '^[A-Za-z0-9._-]*$' });

export const StatusBody = Type.Object(
  {
    host: Host,
    mode: Type.Union([Type.Literal('kubernetes'), Type.Literal('docker')]),
    version: Type.String({ minLength: 1, maxLength: 64 }),
    config_version: Type.String({ maxLength: 64 }),
    self: Type.Object(
      {
        rss_bytes: Type.Optional(Type.Number({ minimum: 0 })),
        cpu_seconds: Type.Optional(Type.Number({ minimum: 0 })),
        series: Type.Optional(Type.Integer({ minimum: 0 })),
      },
      { additionalProperties: false },
    ),
    targets: Type.Array(
      Type.Object(
        {
          id: Type.String({ format: 'uuid' }),
          state: Type.Union([
            Type.Literal('ok'),
            Type.Literal('error'),
            Type.Literal('connecting'),
          ]),
          error: Type.Optional(Type.String({ maxLength: 512 })),
          service_version: Type.Optional(Type.String({ maxLength: 64 })),
          members: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  name: Type.String({ maxLength: 253 }),
                  up: Type.Boolean(),
                  error: Type.Optional(Type.String({ maxLength: 512 })),
                },
                { additionalProperties: false },
              ),
              { maxItems: 16 },
            ),
          ),
          // A tab that can't be filled and the missing privilege or setting (ADR-134).
          permissions: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  tab: Type.String({ maxLength: 32 }),
                  missing: Type.String({ maxLength: 128 }),
                },
                { additionalProperties: false },
              ),
              { maxItems: 16 },
            ),
          ),
        },
        { additionalProperties: false },
      ),
      { maxItems: 500 },
    ),
  },
  { additionalProperties: false },
);
export type StatusBody = Static<typeof StatusBody>;

export function registerIntegrationIngest(
  app: FastifyInstance,
  opts: { db: Database; notifier: ConfigNotifier },
): void {
  const { db, notifier } = opts;

  app.get(
    '/integrations/config',
    {
      schema: {
        summary: 'Integrations collector configuration (long-poll with If-None-Match)',
        tags: ['ingest'],
        hide: true,
        querystring: Type.Object({
          host: Type.Optional(Host),
          wait: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WAIT_S })),
        }),
        response: { 200: Type.Unknown(), 304: Type.Null(), 401: ProblemSchema, 429: ProblemSchema },
      },
    },
    async (request, reply) => {
      const owner = request.ingestOwner!;
      const { host = '', wait = 0 } = request.query as { host?: string; wait?: number };
      const known = (request.headers['if-none-match'] ?? '').replace(/^W\/|"/g, '');
      let config = await buildCollectorConfig(db, owner.clusterId, host);
      if (wait > 0 && known && known === config.version) {
        const aborted = new AbortController();
        request.raw.on('close', () => aborted.abort());
        await notifier.wait(owner.clusterId, wait * 1000, aborted.signal);
        if (aborted.signal.aborted) return reply;
        config = await buildCollectorConfig(db, owner.clusterId, host);
      }
      reply.header('etag', `"${config.version}"`).header('cache-control', 'no-store');
      if (known && known === config.version) return reply.code(304).send(null);
      return reply.send(config);
    },
  );

  app.post(
    '/integrations/status',
    {
      schema: {
        summary: 'Integrations collector status and heartbeat',
        tags: ['ingest'],
        hide: true,
        body: StatusBody,
        response: { 204: Type.Null(), 400: ProblemSchema, 401: ProblemSchema, 429: ProblemSchema },
      },
    },
    async (request, reply) => {
      const owner = request.ingestOwner!;
      const body = request.body as StatusBody;
      if (body.mode === 'kubernetes' && body.host !== '') {
        return sendProblem(reply, 400, 'A Kubernetes collector reports with an empty host');
      }
      const now = new Date();
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto('integration_collectors')
          .values({
            id: newId(),
            cluster_id: owner.clusterId,
            host: body.host,
            mode: body.mode,
            version: body.version,
            self: JSON.stringify(body.self),
            config_etag: body.config_version || null,
            last_seen_at: now,
          })
          .onConflict((oc) =>
            oc.columns(['cluster_id', 'host']).doUpdateSet({
              mode: body.mode,
              version: body.version,
              self: JSON.stringify(body.self),
              config_etag: body.config_version || null,
              last_seen_at: now,
            }),
          )
          .execute();
        for (const t of body.targets) {
          // Only this cluster's integrations that this collector is assigned.
          await trx
            .updateTable('integrations')
            .set({
              status: t.state,
              status_details: JSON.stringify({
                error: t.error,
                members: t.members ?? [],
                permissions: t.permissions ?? [],
              }),
              version: t.service_version ?? null,
              last_report_at: now,
            })
            .where('id', '=', t.id)
            .where('cluster_id', '=', owner.clusterId)
            .where('collector_host', '=', body.host)
            .where('status', '<>', 'paused')
            .execute();
        }
      });
      return reply.code(204).send(null);
    },
  );
}
