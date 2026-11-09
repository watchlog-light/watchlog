// SPDX-License-Identifier: AGPL-3.0-only
// The integrations collector's side of the ingest API (ADR-131), registered inside the
// ingest plugin so it shares its token auth, rate limits and error recording:
//   GET  /ingest/v1/integrations/config  its targets, long-polled with If-None-Match
//   POST /ingest/v1/integrations/status  its health and each target's state; also its heartbeat
//   POST /ingest/v1/integrations/probes  what its connection tests found (ADR-134)
// Metrics go through /ingest/v1/write like every agent's.
import type { FastifyInstance } from 'fastify';
import { Type, type Static } from 'typebox';
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { sendProblem } from '../../lib/problem.js';
import { ProblemSchema } from '../auth/schemas.js';
import { buildCollectorConfig } from './collector-config.js';
import { recordEvent } from './credentials.js';
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
        // Kubernetes: where the collector runs, for the Secret role commands (ADR-134).
        namespace: Type.Optional(Type.String({ maxLength: 63, pattern: '^[a-z0-9-]*$' })),
        service_account: Type.Optional(Type.String({ maxLength: 253, pattern: '^[a-z0-9.-]*$' })),
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

// Several types without a union: the validator would coerce a number to the first type.
const Fact = Type.Unsafe<string | number | boolean>({
  type: ['number', 'boolean', 'string'],
  maxLength: 256,
});
export const ProbesBody = Type.Object(
  {
    host: Host,
    results: Type.Array(
      Type.Object(
        {
          id: Type.String({ format: 'uuid' }),
          ok: Type.Boolean(),
          error: Type.Optional(Type.String({ maxLength: 512 })),
          version: Type.Optional(Type.String({ maxLength: 64 })),
          facts: Type.Optional(
            Type.Record(Type.String({ maxLength: 64 }), Fact, { maxProperties: 16 }),
          ),
          // Privileges beyond what WatchLog needs (superuser, +@all), ADR-134.
          excess: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { maxItems: 16 })),
        },
        { additionalProperties: false },
      ),
      { maxItems: 100 },
    ),
  },
  { additionalProperties: false },
);
type ProbesBody = Static<typeof ProbesBody>;

export function registerIntegrationIngest(
  app: FastifyInstance,
  opts: { db: Database; notifier: ConfigNotifier; secretKey: Buffer },
): void {
  const { db, notifier, secretKey } = opts;

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
      let config = await buildCollectorConfig(db, owner.clusterId, host, secretKey);
      if (wait > 0 && known && known === config.version) {
        const aborted = new AbortController();
        request.raw.on('close', () => aborted.abort());
        await notifier.wait(owner.clusterId, wait * 1000, aborted.signal);
        if (aborted.signal.aborted) return reply;
        config = await buildCollectorConfig(db, owner.clusterId, host, secretKey);
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
        // A credential set since the last good report works now: say so once (ADR-133).
        const ok = body.targets.filter((t) => t.state === 'ok').map((t) => t.id);
        if (ok.length) {
          const verified = await trx
            .updateTable('integration_credentials as c')
            .from('integrations as i')
            .set({ verified_at: now })
            .whereRef('i.id', '=', 'c.integration_id')
            .where('c.integration_id', 'in', ok)
            .where('c.verified_at', 'is', null)
            .where('i.cluster_id', '=', owner.clusterId)
            .where('i.collector_host', '=', body.host)
            .returning(['c.integration_id', 'i.org_id'])
            .execute();
          for (const v of verified) {
            await recordEvent(trx, {
              orgId: v.org_id,
              integrationId: v.integration_id,
              action: 'verified',
            });
          }
        }
      });
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/integrations/probes',
    {
      schema: {
        summary: "Integrations collector's connection tests",
        tags: ['ingest'],
        hide: true,
        body: ProbesBody,
        response: { 204: Type.Null(), 400: ProblemSchema, 401: ProblemSchema, 429: ProblemSchema },
      },
    },
    async (request, reply) => {
      const owner = request.ingestOwner!;
      const body = request.body as ProbesBody;
      let done = false;
      for (const r of body.results) {
        // Only this collector's own pending probes; one that works is done.
        const row = await db
          .updateTable('integration_probes')
          .set((eb) => ({
            attempts: eb('attempts', '+', 1),
            status: r.ok ? 'ok' : 'pending',
            result: JSON.stringify({
              ok: r.ok,
              error: r.error ?? null,
              version: r.version ?? null,
              facts: r.facts ?? {},
              excess: r.excess ?? [],
            }),
          }))
          .where('id', '=', r.id)
          .where('cluster_id', '=', owner.clusterId)
          .where('collector_host', '=', body.host)
          .where('status', '=', 'pending')
          .returning('id')
          .executeTakeFirst();
        if (row && r.ok) done = true;
      }
      // The configuration drops the probes that worked.
      if (done) notifier.notify(owner.clusterId);
      return reply.code(204).send(null);
    },
  );
}
