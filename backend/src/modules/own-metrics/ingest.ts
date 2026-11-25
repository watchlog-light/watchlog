// SPDX-License-Identifier: AGPL-3.0-only
// The three ways a user's own metrics arrive (1.0.0, ADR-236), all ending in OwnMetrics.ingest:
//
//   POST /ingest/v1/own-metrics/scrape   the collector's scrapes (its cluster token, gzipped JSON)
//   POST /ingest/v1/own-metrics/probe    the collector's answer to "Find endpoints for me"
//   POST /ingest/v1/write                Prometheus remote write, with an own-metrics token
//                                        (`wl_mt_`): the existing path, told apart by the token
//   POST /ingest/v1/metrics              a push of one or more values, with an own-metrics token
//
// A refused series never fails the request: what is admitted is stored, and the panel's sources
// table says what was dropped and why. Remote write answers 204 (Prometheus retries anything
// else); a push answers what was stored and dropped.
import { createGunzip } from 'node:zlib';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Type, type Static } from 'typebox';
import { sendProblem } from '../../lib/problem.js';
import { VictoriaError } from '../../lib/victoria.js';
import { ProblemSchema } from '../auth/schemas.js';
import type { Belonging } from './belonging.js';
import { OWN_TYPES, typeFromName, type OwnType } from './naming.js';
import type { Probes } from './probes.js';
import type { Incoming, IngestResult, OwnMetrics } from './service.js';
import type { Targets } from './targets.js';
import type { MetricTokenOwner } from './tokens.js';
import { decodeWrite, WireError } from './wire.js';

/** One remote-write request: decoded size, series and samples. */
export const WRITE_LIMITS = { maxDecodedBytes: 32 << 20, maxSeries: 20_000, maxSamples: 200_000 };
const MAX_SCRAPE_BYTES = 32 << 20;
/** Values in one push. */
export const MAX_PUSH = 500;

declare module 'fastify' {
  interface FastifyRequest {
    /** Set when the bearer token is an own-metrics token (`wl_mt_`). */
    metricOwner: MetricTokenOwner | null;
  }
}

export interface OwnIngestDeps {
  own: OwnMetrics;
  targets: Targets;
  belonging: Belonging;
  probes: Probes;
  now?: () => number;
}

const Labels = Type.Record(Type.String({ maxLength: 200 }), Type.String({ maxLength: 2048 }), {
  maxProperties: 64,
});

const ScrapeBody = Type.Object({
  at: Type.Number({ minimum: 0 }),
  host: Type.Optional(Type.String({ maxLength: 253 })),
  targets: Type.Array(
    Type.Object({
      id: Type.String({ minLength: 1, maxLength: 800 }),
      error: Type.Optional(Type.String({ maxLength: 512 })),
      series: Type.Array(
        Type.Object({
          n: Type.String({ minLength: 1, maxLength: 300 }),
          l: Type.Optional(Labels),
          v: Type.Number(),
        }),
        { maxItems: 20_000 },
      ),
      types: Type.Optional(
        Type.Record(Type.String({ maxLength: 300 }), Type.String({ maxLength: 16 })),
      ),
      help: Type.Optional(
        Type.Record(Type.String({ maxLength: 300 }), Type.String({ maxLength: 512 })),
      ),
      truncated: Type.Optional(Type.Boolean()),
      more: Type.Optional(Type.Boolean()),
    }),
    { maxItems: 1000 },
  ),
});

const ProbeBody = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  host: Type.Optional(Type.String({ maxLength: 253 })),
  results: Type.Array(
    Type.Object({
      id: Type.String({ maxLength: 800 }),
      ok: Type.Boolean(),
      series: Type.Integer({ minimum: 0 }),
      names: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 10 })),
    }),
    { maxItems: 1000 },
  ),
});

const PushMetric = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  type: Type.Optional(Type.Union([Type.Literal('counter'), Type.Literal('gauge')])),
  value: Type.Number(),
  labels: Type.Optional(Labels),
  /** What it belongs to: "namespace/name" of a workload, or a server's name. */
  workload: Type.Optional(Type.String({ maxLength: 400 })),
  server: Type.Optional(Type.String({ maxLength: 253 })),
});
const PushBody = Type.Union([
  Type.Object({
    metrics: Type.Array(PushMetric, { minItems: 1, maxItems: MAX_PUSH }),
    workload: Type.Optional(Type.String({ maxLength: 400 })),
    server: Type.Optional(Type.String({ maxLength: 253 })),
  }),
  PushMetric,
]);
type PushBody = Static<typeof PushBody>;

const DroppedS = Type.Object({
  reserved: Type.Integer(),
  invalid: Type.Integer(),
  cardinality: Type.Array(Type.Object({ metric: Type.String(), label: Type.String() })),
  sourceCap: Type.Integer(),
  orgCap: Type.Integer(),
  sources: Type.Boolean(),
});
const PushAnswer = Type.Object({
  stored: Type.Integer({ description: 'Series stored from this push' }),
  dropped: DroppedS,
});

function storageDown(reply: FastifyReply, request: FastifyRequest, err: unknown) {
  if (err instanceof VictoriaError && err.status >= 400 && err.status < 500) {
    request.log.warn({ err: err.message }, 'metrics storage rejected an own-metrics batch');
    return sendProblem(reply, 400, 'Metrics storage rejected the batch');
  }
  request.log.error({ err: (err as Error).message }, 'metrics storage unavailable');
  reply.header('retry-after', '30');
  return sendProblem(reply, 503, 'Metrics storage temporarily unavailable');
}

const asTypes = (m: Record<string, string> | undefined): Map<string, OwnType> => {
  const out = new Map<string, OwnType>();
  for (const [k, v] of Object.entries(m ?? {}))
    if ((OWN_TYPES as readonly string[]).includes(v)) out.set(k, v as OwnType);
  return out;
};

/**
 * Prometheus remote write with an own-metrics token: every series judged on its own, tied to
 * the workload or server its labels name. Called by /ingest/v1/write for a `wl_mt_` token.
 */
export async function ownRemoteWrite(
  deps: OwnIngestDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  owner: MetricTokenOwner,
): Promise<FastifyReply> {
  const body = request.body;
  if (!(body instanceof Buffer)) {
    return sendProblem(reply, 415, 'Expected Content-Type: application/x-protobuf');
  }
  if (request.headers['content-encoding'] !== 'snappy') {
    return sendProblem(reply, 400, 'Expected Content-Encoding: snappy');
  }
  let batch;
  try {
    batch = decodeWrite(body, WRITE_LIMITS);
  } catch (err) {
    if (err instanceof WireError) return sendProblem(reply, err.status, err.message);
    throw err;
  }
  const known = await deps.belonging.known(owner.clusterId);
  const series: Incoming[] = batch.series.map((s) => ({
    name: s.name,
    labels: s.labels,
    samples: s.samples,
    owner: deps.belonging.fromLabels(known, s.labels),
  }));
  try {
    await deps.own.ingest({
      orgId: owner.orgId,
      clusterId: owner.clusterId,
      source: {
        kind: 'remote_write',
        key: `token:${owner.tokenId}:remote_write`,
        label: `token "${owner.name}"`,
        owner: { kind: '', namespace: '', workloadKind: '', name: '' },
        tokenId: owner.tokenId,
      },
      series,
      types: batch.types,
    });
  } catch (err) {
    return storageDown(reply, request, err);
  }
  return reply.code(204).send(null);
}

export function registerOwnMetricsIngest(app: FastifyInstance, deps: OwnIngestDeps): void {
  const now = deps.now ?? Date.now;
  /** Endpoints whose last report said "more follows": the next one adds to its drops. */
  const continuing = new Set<string>();
  const gunzip = async (
    request: FastifyRequest,
    _reply: FastifyReply,
    payload: NodeJS.ReadableStream,
  ) => {
    if (request.headers['content-encoding'] !== 'gzip') return payload;
    delete request.headers['content-encoding'];
    delete request.headers['content-length'];
    return payload.pipe(createGunzip());
  };

  app.post<{ Body: Static<typeof ScrapeBody> }>(
    '/own-metrics/scrape',
    {
      bodyLimit: MAX_SCRAPE_BYTES,
      preParsing: gunzip,
      schema: {
        summary: "The collector's scrapes of a user's own metrics (gzipped JSON)",
        tags: ['ingest'],
        hide: true,
        body: ScrapeBody,
        response: { 204: Type.Null(), 400: ProblemSchema, 401: ProblemSchema, 503: ProblemSchema },
      },
    },
    async (request, reply) => {
      const owner = request.ingestOwner!;
      const host = request.body.host ?? '';
      const targets = new Map(
        (await deps.targets.forCollector(owner.clusterId, host)).map((t) => [t.id, t]),
      );
      const at = Math.min(request.body.at, now() + 60_000);
      // One source may be several pods: their reports are taken one after another.
      for (const rep of request.body.targets) {
        const t = targets.get(rep.id);
        if (!t) continue;
        const partKey = `${owner.clusterId}|${rep.id}`;
        const append = continuing.has(partKey);
        if (rep.more) continuing.add(partKey);
        else continuing.delete(partKey);
        try {
          await deps.own.ingest({
            orgId: owner.orgId,
            clusterId: owner.clusterId,
            source: t.source,
            series: rep.series.map((s) => ({
              name: s.n,
              labels: s.l ?? {},
              samples: [[at, s.v]],
              extra: t.extra,
            })),
            types: asTypes(rep.types),
            help: new Map(Object.entries(rep.help ?? {})),
            error: rep.error || undefined,
            append,
          });
        } catch (err) {
          return storageDown(reply, request, err);
        }
      }
      return reply.code(204).send(null);
    },
  );

  app.post<{ Body: Static<typeof ProbeBody> }>(
    '/own-metrics/probe',
    {
      schema: {
        summary: 'Which candidate endpoints expose metrics ("Find endpoints for me")',
        tags: ['ingest'],
        hide: true,
        body: ProbeBody,
        response: { 204: Type.Null(), 400: ProblemSchema, 401: ProblemSchema },
      },
    },
    async (request, reply) => {
      const owner = request.ingestOwner!;
      deps.probes.answer(
        owner.clusterId,
        request.body.id,
        request.body.host ?? '',
        request.body.results,
      );
      return reply.code(204).send(null);
    },
  );

  app.post<{ Body: PushBody }>(
    '/metrics',
    {
      bodyLimit: 1 << 20,
      schema: {
        summary: 'Push one or more values of your own metrics',
        description:
          'With an own-metrics token (`wl_mt_…`, made under Your metrics → Add a source). A `counter` push adds its value to the total; a `gauge` keeps the last value. `workload` ("namespace/name") or `server` says what a value belongs to. A refused series never fails the push: the answer says what was stored and what was dropped.',
        tags: ['ingest'],
        body: PushBody,
        response: {
          200: PushAnswer,
          400: ProblemSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          429: ProblemSchema,
          503: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const owner = request.metricOwner;
      if (!owner) {
        return sendProblem(
          reply,
          403,
          'Pushes need an own-metrics token (wl_mt_…): make one under Your metrics → Add a source',
        );
      }
      const body = request.body;
      const list = 'metrics' in body ? body.metrics : [body];
      const top = 'metrics' in body ? { workload: body.workload, server: body.server } : {};
      const known = await deps.belonging.known(owner.clusterId);
      const at = now();
      const types = new Map<string, OwnType>();
      const series: Incoming[] = list.map((m) => {
        // Without a type the name says it (`_total` is a counter). A gauge is read from its
        // name too (a `_timestamp` is one); only a counter is declared.
        const counter = m.type === 'counter' || (!m.type && typeFromName(m.name) === 'counter');
        if (counter) types.set(m.name, 'counter');
        return {
          name: m.name,
          labels: m.labels ?? {},
          samples: [[at, m.value]],
          add: counter,
          owner: deps.belonging.fromPush(known, {
            workload: m.workload ?? top.workload,
            server: m.server ?? top.server,
          }),
        };
      });
      let result: IngestResult;
      try {
        result = await deps.own.ingest({
          orgId: owner.orgId,
          clusterId: owner.clusterId,
          source: {
            kind: 'push',
            key: `token:${owner.tokenId}:push`,
            label: `token "${owner.name}"`,
            owner: { kind: '', namespace: '', workloadKind: '', name: '' },
            tokenId: owner.tokenId,
          },
          series,
          types,
        });
      } catch (err) {
        return storageDown(reply, request, err);
      }
      return reply.code(200).send({ stored: result.stored, dropped: result.dropped });
    },
  );
}
