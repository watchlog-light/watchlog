// SPDX-License-Identifier: AGPL-3.0-only
// Agent ingest API (SPEC §8.2): token auth, limits, server-side cluster_id (ADR-025/026/027).
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createGunzip } from 'node:zlib';
import { sql } from 'kysely';
import { Type } from 'typebox';
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { sendProblem } from '../../lib/problem.js';
import { VictoriaError, type VictoriaClient } from '../../lib/victoria.js';
import type { TokenOwner } from '../clusters/tokens.js';
import { ProblemSchema } from '../auth/schemas.js';
import { healthSince } from './health.js';
import {
  INGEST_ENDPOINTS,
  IngestErrorRecorder,
  isIngestError,
  type IngestEndpoint,
} from './errors.js';
import { dockerMarkers } from './docker-markers.js';
import { EventsBody, storeKubernetesEvents } from './kubernetes-events.js';
import { KubernetesObjectsBody, storeKubernetesObjects } from './kubernetes-objects.js';
import {
  AGENT_BUCKET,
  CLUSTER_AGENT_BUCKET,
  CLUSTER_AGENT_ID,
  CLUSTER_BUCKET,
  TokenBuckets,
  type BucketSpec,
} from './rate-limit.js';
import { inspectWriteRequest, RemoteWriteError } from './remote-write.js';
import type { TokenCache } from './token-cache.js';

/** Limits from ADR-027. */
export const MAX_COMPRESSED_BYTES = 4 << 20;
export const MAX_DECODED_BYTES = 32 << 20;
export const MAX_SERIES_PER_REQUEST = 20_000;
/** An agent is considered reporting while it sent a heartbeat within this window (SPEC §4.7). */
export const AGENT_STALE_MS = 3 * 60 * 1000;
const UNAVAILABLE_RETRY_AFTER_S = 15;
/** Decompressed size limit for inventory snapshots (gzip bomb protection). */
export const MAX_OBJECTS_BYTES = 16 << 20;

declare module 'fastify' {
  interface FastifyRequest {
    ingestOwner: TokenOwner | null;
  }
}

export interface IngestOptions {
  db: Database;
  tokens: TokenCache;
  victoria?: VictoriaClient;
  agentBucket?: BucketSpec;
  clusterAgentBucket?: BucketSpec;
  clusterBucket?: BucketSpec;
  /** Days of Kubernetes events kept (ADR-061). */
  eventsRetentionDays?: number;
}

const Str = (max: number) => Type.String({ maxLength: max });
const DockerObjectsBody = Type.Object({
  // A snapshot lists every container of the host; a delta only those changed by events.
  kind: Type.Union([Type.Literal('snapshot'), Type.Literal('delta')]),
  source: Type.Literal('docker'),
  node: Type.String({ minLength: 1, maxLength: 253 }),
  inventory: Type.Object({
    host: Type.Object({
      docker_version: Str(64),
      api_version: Str(16),
      os: Str(32),
      arch: Str(32),
      kernel_version: Str(128),
    }),
    containers: Type.Array(
      Type.Object({
        id: Type.String({ pattern: '^[a-f0-9]{12,64}$' }),
        name: Type.String({ minLength: 1, maxLength: 253 }),
        image: Str(512),
        state: Str(32),
        status: Str(128),
        health: Type.Optional(Str(32)),
        restart_count: Type.Integer({ minimum: 0 }),
        exit_code: Type.Integer(),
        oom_killed: Type.Boolean(),
        created_at: Type.Integer({ minimum: 0 }),
        started_at: Type.Optional(Str(64)),
        ports: Type.Optional(
          Type.Array(
            Type.Object({
              ip: Type.Optional(Str(64)),
              public_port: Type.Integer({ minimum: 0, maximum: 65535 }),
              private_port: Type.Integer({ minimum: 0, maximum: 65535 }),
              protocol: Str(8),
            }),
            { maxItems: 256 },
          ),
        ),
        compose_project: Type.Optional(Str(253)),
        compose_service: Type.Optional(Str(253)),
        networks: Type.Optional(Type.Array(Str(253), { maxItems: 32 })),
        size_rw: Type.Optional(Type.Integer({ minimum: 0 })),
        restarting: Type.Optional(Type.Boolean()),
        // Redacted and cut to 512 bytes by the agent (ADR-047); limits leave room for UTF-8.
        error: Type.Optional(Str(1024)),
        finished_at: Type.Optional(Str(64)),
        health_detail: Type.Optional(
          Type.Object({
            status: Str(32),
            failing_streak: Type.Integer({ minimum: 0 }),
            probes: Type.Array(
              Type.Object({
                start: Str(64),
                end: Str(64),
                exit_code: Type.Integer(),
                output: Type.Optional(Str(1024)),
              }),
              { maxItems: 10 },
            ),
            check: Type.Optional(
              Type.Object({
                command: Str(1024),
                shell: Type.Boolean(),
                interval_s: Type.Number({ minimum: 0 }),
                timeout_s: Type.Number({ minimum: 0 }),
                start_period_s: Type.Number({ minimum: 0 }),
                retries: Type.Integer({ minimum: 0 }),
              }),
            ),
          }),
        ),
      }),
      { maxItems: 5000 },
    ),
  }),
});

// Docker inventory (Phase 1) or Kubernetes objects (ADR-055), told apart by `source`.
const ObjectsBody = Type.Union([DockerObjectsBody, KubernetesObjectsBody]);

const HeartbeatBody = Type.Object({
  agent_version: Type.String({ minLength: 1, maxLength: 64 }),
  mode: Type.Union([Type.Literal('node'), Type.Literal('cluster'), Type.Literal('docker')]),
  node: Type.String({ minLength: 1, maxLength: 253 }),
  capabilities: Type.Object(
    {
      ebpf: Type.Optional(Type.String({ maxLength: 32 })),
      /** Why eBPF is unsupported, or what part is missing (ADR-102). */
      ebpf_reason: Type.Optional(Type.String({ maxLength: 300 })),
      /** Why eBPF is not running, as a code the UI turns into a fix (ADR-107). */
      ebpf_cause: Type.Optional(
        Type.Union([
          Type.Literal('config'),
          Type.Literal('kernel'),
          Type.Literal('permission'),
          Type.Literal('load'),
        ]),
      ),
      /** namespace/release and chart, set by the agent chart for the upgrade command. */
      // Checked where used (helmUpgradeCommand): a bad value must not fail the heartbeat.
      helm_release: Type.Optional(Type.String({ maxLength: 128 })),
      helm_chart: Type.Optional(Type.String({ maxLength: 64 })),
      /** Docker agents: their own container, named in the upgrade command. */
      container_id: Type.Optional(Type.String({ maxLength: 64 })),
      cgroup: Type.Optional(Type.String({ maxLength: 16 })),
      /** Node agents: how the kubelet connection is secured (ADR-051). */
      kubelet_tls: Type.Optional(
        Type.Union([Type.Literal('verified'), Type.Literal('unverified')]),
      ),
      /** Where node metrics come from (ADR-121): the host's /proc or the node's cgroup. */
      node_scope: Type.Optional(Type.Union([Type.Literal('host'), Type.Literal('cgroup')])),
      /** cgroup scope: the node's capacity measured from its cgroup limits (ADR-121). */
      node_cpu_cores: Type.Optional(Type.Number({ minimum: 0, maximum: 1_000_000 })),
      node_memory_bytes: Type.Optional(Type.Number({ minimum: 0, maximum: 2 ** 60 })),
    },
    { additionalProperties: false },
  ),
  series: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
});

/** The detail of a problem+json answer, for the error's message. */
function problemDetail(payload: unknown): string {
  if (typeof payload !== 'string') return '';
  try {
    const p = JSON.parse(payload) as { detail?: unknown; title?: unknown };
    return String(p.detail ?? p.title ?? '');
  } catch {
    return payload.slice(0, 200);
  }
}

export const ingestRoutes: FastifyPluginAsyncTypebox<IngestOptions> = async (app, opts) => {
  const { db, tokens, victoria } = opts;
  const agentBuckets = new TokenBuckets(opts.agentBucket ?? AGENT_BUCKET);
  const clusterAgentBuckets = new TokenBuckets(opts.clusterAgentBucket ?? CLUSTER_AGENT_BUCKET);
  const clusterBuckets = new TokenBuckets(opts.clusterBucket ?? CLUSTER_BUCKET);
  const pruner = setInterval(() => {
    agentBuckets.prune();
    clusterAgentBuckets.prune();
    clusterBuckets.prune();
  }, 60_000);
  pruner.unref();
  app.addHook('onClose', async () => clearInterval(pruner));

  app.decorateRequest('ingestOwner', null);

  // Every answer to an authenticated agent: errors are recorded per cluster and
  // endpoint, a success ends the failure (ADR-117). Recording never fails the request.
  const errors = new IngestErrorRecorder(db);
  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload) => {
    const owner = request.ingestOwner;
    // The route's own path, without the plugin's prefix: /ingest/v1/write → write.
    const endpoint = (request.routeOptions.url ?? '').split('/').pop() as IngestEndpoint;
    if (!owner || !INGEST_ENDPOINTS.includes(endpoint)) return payload;
    const status = reply.statusCode;
    try {
      if (isIngestError(status)) {
        await errors.failure(owner.clusterId, endpoint, status, problemDetail(payload));
      } else if (status >= 200 && status < 300) {
        await errors.success(owner.clusterId, endpoint);
      }
    } catch (err) {
      request.log.warn({ err }, 'recording an ingest error failed');
    }
    return payload;
  });
  // Raw protobuf bodies only on the ingest routes (encapsulated to this plugin).
  app.addContentTypeParser(
    'application/x-protobuf',
    { parseAs: 'buffer', bodyLimit: MAX_COMPRESSED_BYTES },
    (_req, body, done) => done(null, body),
  );

  // Authenticate and rate-limit before the body is read.
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const owner = token ? await tokens.verify(token) : null;
    if (!owner) return sendProblem(reply, 401, 'Missing, invalid or revoked cluster token');
    request.ingestOwner = owner;

    const agentHeader = request.headers['x-watchlog-agent'];
    const agentId = (Array.isArray(agentHeader) ? agentHeader[0] : agentHeader) || request.ip;
    // The cluster-agent's start-up burst gets its own bucket; the cluster ceiling
    // still bounds anyone claiming its name (ADR-067).
    const instance = agentId === CLUSTER_AGENT_ID ? clusterAgentBuckets : agentBuckets;
    const wait = Math.max(
      instance.take(`${owner.tokenId}:${agentId}`),
      clusterBuckets.take(owner.clusterId),
    );
    if (wait > 0) {
      reply.header('retry-after', String(wait));
      return sendProblem(reply, 429, 'Ingest rate limit reached; retry later');
    }
  });

  app.post(
    '/write',
    {
      bodyLimit: MAX_COMPRESSED_BYTES,
      schema: {
        summary: 'Prometheus remote_write (protobuf + snappy) from an agent',
        tags: ['ingest'],
        hide: true,
        response: {
          204: Type.Null(),
          400: ProblemSchema,
          401: ProblemSchema,
          413: ProblemSchema,
          429: ProblemSchema,
          503: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const owner = request.ingestOwner!;
      const body = request.body;
      if (!(body instanceof Buffer)) {
        return sendProblem(reply, 415, 'Expected Content-Type: application/x-protobuf');
      }
      if (request.headers['content-encoding'] !== 'snappy') {
        return sendProblem(reply, 400, 'Expected Content-Encoding: snappy');
      }
      try {
        inspectWriteRequest(body, {
          maxDecodedBytes: MAX_DECODED_BYTES,
          maxSeries: MAX_SERIES_PER_REQUEST,
        });
      } catch (err) {
        if (err instanceof RemoteWriteError) return sendProblem(reply, err.status, err.message);
        throw err;
      }
      if (!victoria) {
        reply.header('retry-after', String(UNAVAILABLE_RETRY_AFTER_S));
        return sendProblem(reply, 503, 'Metrics storage is not configured');
      }
      try {
        await victoria.write({ clusterId: owner.clusterId }, body);
      } catch (err) {
        if (err instanceof VictoriaError && err.status >= 400 && err.status < 500) {
          request.log.warn(
            { err: err.message, clusterId: owner.clusterId },
            'metrics storage rejected a batch',
          );
          return sendProblem(reply, 400, 'Metrics storage rejected the batch');
        }
        request.log.error({ err: (err as Error).message }, 'metrics storage unavailable');
        reply.header('retry-after', String(UNAVAILABLE_RETRY_AFTER_S));
        return sendProblem(reply, 503, 'Metrics storage temporarily unavailable');
      }
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/objects',
    {
      bodyLimit: MAX_OBJECTS_BYTES,
      // Inventory snapshots are gzipped JSON; the limit applies to the decompressed body.
      preParsing: async (request, _reply, payload) => {
        if (request.headers['content-encoding'] !== 'gzip') return payload;
        delete request.headers['content-encoding'];
        delete request.headers['content-length'];
        return payload.pipe(createGunzip());
      },
      schema: {
        summary: 'Docker inventory or Kubernetes objects, snapshot or delta (gzipped JSON)',
        tags: ['ingest'],
        hide: true,
        body: ObjectsBody,
        response: {
          204: Type.Null(),
          400: ProblemSchema,
          401: ProblemSchema,
          413: ProblemSchema,
          429: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const owner = request.ingestOwner!;
      if (request.body.source === 'kubernetes') {
        await storeKubernetesObjects(db, owner.clusterId, request.body);
        return reply.code(204).send(null);
      }
      const { kind, node, inventory } = request.body;
      const now = new Date();
      const containers = inventory.containers;
      await db.transaction().execute(async (trx) => {
        // What the host ran before a complete snapshot, for its change markers.
        const before =
          kind === 'delta'
            ? []
            : (
                await trx
                  .selectFrom('objects')
                  .select(['uid', 'name', 'namespace', 'spec_summary'])
                  .where('cluster_id', '=', owner.clusterId)
                  .where('kind', '=', 'DockerContainer')
                  .where('node', '=', node)
                  .where('deleted_at', 'is', null)
                  .execute()
              ).map((r) => ({
                uid: r.uid,
                name: r.name,
                image: (r.spec_summary as { image?: string }).image ?? '',
                project: r.namespace,
              }));
        const previous = new Map(
          containers.length === 0
            ? []
            : (
                await trx
                  .selectFrom('objects')
                  .select(['uid', 'status_summary'])
                  .where('cluster_id', '=', owner.clusterId)
                  .where(
                    'uid',
                    'in',
                    containers.map((c) => c.id),
                  )
                  .execute()
              ).map((r) => [r.uid, r.status_summary as Parameters<typeof healthSince>[0]]),
        );
        const upsert = (row: {
          kind: string;
          uid: string;
          name: string;
          namespace: string;
          spec: object;
          status: object;
        }) =>
          trx
            .insertInto('objects')
            .values({
              id: newId(),
              cluster_id: owner.clusterId,
              source: 'docker',
              kind: row.kind,
              namespace: row.namespace,
              name: row.name,
              uid: row.uid,
              node,
              spec_summary: JSON.stringify(row.spec),
              status_summary: JSON.stringify(row.status),
              deleted_at: null,
            })
            .onConflict((oc) =>
              oc.columns(['cluster_id', 'uid']).doUpdateSet({
                kind: row.kind,
                namespace: row.namespace,
                name: row.name,
                node,
                spec_summary: JSON.stringify(row.spec),
                status_summary: JSON.stringify(row.status),
                deleted_at: null,
              }),
            )
            .execute();

        await upsert({
          kind: 'DockerHost',
          uid: `host:${node}`,
          name: node,
          namespace: '',
          spec: inventory.host,
          status: {},
        });
        for (const c of containers) {
          const since = healthSince(previous.get(c.id), c.health, c.health_detail, now);
          await upsert({
            kind: 'DockerContainer',
            uid: c.id,
            name: c.name,
            namespace: c.compose_project ?? '',
            spec: {
              image: c.image,
              created_at: c.created_at,
              ports: c.ports ?? [],
              compose_service: c.compose_service,
              networks: c.networks ?? [],
            },
            status: {
              state: c.state,
              status: c.status,
              health: c.health,
              restart_count: c.restart_count,
              exit_code: c.exit_code,
              oom_killed: c.oom_killed,
              started_at: c.started_at,
              size_rw: c.size_rw,
              restarting: c.restarting,
              error: c.error,
              finished_at: c.finished_at,
              health_detail: c.health_detail,
              health_since: since?.since,
              health_since_estimated: since?.estimated,
            },
          });
        }
        if (kind === 'delta') return;
        // A snapshot is complete for its host: compare with what the host ran before.
        const markers = dockerMarkers(
          node,
          before,
          containers.map((c) => ({
            uid: c.id,
            name: c.name,
            image: c.image,
            project: c.compose_project ?? '',
          })),
        );
        if (markers.length > 0)
          await trx
            .insertInto('change_markers')
            .values(
              markers.map((m) => ({
                id: newId(),
                cluster_id: owner.clusterId,
                kind: m.kind,
                target: m.target,
                namespace: m.namespace,
                details: JSON.stringify(m.details),
                ts: now,
              })),
            )
            .execute();
        // Containers it no longer lists are gone.
        let gone = trx
          .updateTable('objects')
          .set({ deleted_at: now })
          .where('cluster_id', '=', owner.clusterId)
          .where('kind', '=', 'DockerContainer')
          .where('node', '=', node)
          .where('deleted_at', 'is', null);
        if (containers.length > 0)
          gone = gone.where(
            'uid',
            'not in',
            containers.map((c) => c.id),
          );
        await gone.execute();
      });
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/events',
    {
      bodyLimit: MAX_OBJECTS_BYTES,
      // Gzipped JSON like /objects; the limit applies to the decompressed body.
      preParsing: async (request, _reply, payload) => {
        if (request.headers['content-encoding'] !== 'gzip') return payload;
        delete request.headers['content-encoding'];
        delete request.headers['content-length'];
        return payload.pipe(createGunzip());
      },
      schema: {
        summary:
          'Kubernetes events from the cluster-agent, Docker events from Docker agents (gzipped JSON)',
        tags: ['ingest'],
        hide: true,
        body: EventsBody,
        response: {
          204: Type.Null(),
          400: ProblemSchema,
          401: ProblemSchema,
          413: ProblemSchema,
          429: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      await storeKubernetesEvents(
        db,
        request.ingestOwner!.clusterId,
        request.body,
        opts.eventsRetentionDays ?? 15,
      );
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/heartbeat',
    {
      schema: {
        summary: 'Agent heartbeat (version, mode, node, capabilities)',
        tags: ['ingest'],
        hide: true,
        body: HeartbeatBody,
        response: { 204: Type.Null(), 400: ProblemSchema, 401: ProblemSchema, 429: ProblemSchema },
      },
    },
    async (request, reply) => {
      const owner = request.ingestOwner!;
      const hb = request.body;
      const now = new Date();
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto('agent_instances')
          .values({
            id: newId(),
            cluster_id: owner.clusterId,
            node: hb.node,
            mode: hb.mode,
            agent_version: hb.agent_version,
            capabilities: JSON.stringify(hb.capabilities),
            series: hb.series,
            last_seen_at: now,
          })
          .onConflict((oc) =>
            oc.columns(['cluster_id', 'node']).doUpdateSet({
              mode: hb.mode,
              agent_version: hb.agent_version,
              capabilities: JSON.stringify(hb.capabilities),
              series: hb.series,
              last_seen_at: now,
            }),
          )
          .execute();
        const staleBefore = new Date(now.getTime() - AGENT_STALE_MS);
        await trx
          .updateTable('clusters')
          .set({
            last_seen_at: now,
            first_seen_at: sql`coalesce(first_seen_at, ${now})`,
            agent_version: hb.agent_version,
            status: 'active',
            // Hosts or nodes: the cluster-agent is not one.
            node_count: sql`(select count(*) from agent_instances
              where cluster_id = ${owner.clusterId} and last_seen_at > ${staleBefore}
              and mode <> 'cluster')`,
          })
          .where('id', '=', owner.clusterId)
          .execute();
      });
      return reply.code(204).send(null);
    },
  );
};
