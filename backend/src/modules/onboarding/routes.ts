// SPDX-License-Identifier: AGPL-3.0-only
// GET /clusters/:id/onboarding-status (ADR-176): the live connection checklist as JSON, or
// with `Accept: text/event-stream` as Server-Sent Events: a `status` event whenever the
// checklist changes, then `end` once no step is waiting or after 10 minutes (the page
// reconnects). Community's "Add cluster" uses it too. The cluster goes through
// clusterForOrg like every other read (ADR-174).
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import type { Config } from '../../config.js';
import type { Database } from '../../db/index.js';
import { sendProblem } from '../../lib/problem.js';
import type { VictoriaQueryClient } from '../../lib/victoria.js';
import { requireUser } from '../../plugins/auth.js';
import { ProblemSchema } from '../auth/schemas.js';
import { installTarget } from '../clusters/install.js';
import { ClusterIdParams } from '../clusters/schemas.js';
import { clusterForOrg } from '../clusters/service.js';
import type { SettingsService } from '../settings/service.js';
import { onboardingStatus, type OnboardingStatus, type StatusCluster } from './status.js';

/** How often a stream looks again, how often it says it's alive, and how long it lasts. */
export const STREAM_POLL_MS = 3000;
const PING_MS = 15_000;
export const STREAM_MAX_MS = 10 * 60 * 1000;

const Nullable = <T extends ReturnType<typeof Type.String>>(s: T) => Type.Union([s, Type.Null()]);
const Count = Type.Optional(Type.Integer({ minimum: 0 }));

export const OnboardingStatusSchema = Type.Object({
  clusterId: Type.String({ format: 'uuid' }),
  kind: Type.Union([Type.Literal('kubernetes'), Type.Literal('docker')]),
  createdAt: Type.String({ format: 'date-time' }),
  now: Type.String({ format: 'date-time' }),
  steps: Type.Array(
    Type.Object({
      id: Type.Union([
        Type.Literal('agent'),
        Type.Literal('clusterAgent'),
        Type.Literal('metrics'),
        Type.Literal('ebpf'),
        Type.Literal('map'),
      ]),
      state: Type.Union([Type.Literal('waiting'), Type.Literal('done'), Type.Literal('off')]),
      since: Nullable(Type.String({ format: 'date-time' })),
      nodes: Count,
      containers: Count,
      enabled: Count,
      agents: Count,
      node: Type.Optional(Nullable(Type.String())),
      reason: Type.Optional(Nullable(Type.String())),
      cause: Type.Optional(
        Type.Union([
          Type.Literal('config'),
          Type.Literal('kernel'),
          Type.Literal('permission'),
          Type.Literal('load'),
          Type.Literal('outdated'),
          Type.Null(),
        ]),
      ),
      fix: Type.Optional(Nullable(Type.String())),
      services: Count,
      connections: Count,
    }),
  ),
  ready: Type.Boolean(),
  complete: Type.Boolean(),
});

export const onboardingRoutes: FastifyPluginAsyncTypebox<{
  db: Database;
  victoria: VictoriaQueryClient | null;
  config: Config;
  settings: SettingsService;
}> = async (app, { db, victoria, config, settings }) => {
  const signedIn = requireUser();
  const target = installTarget(config, settings);

  async function compute(request: FastifyRequest, cluster: StatusCluster) {
    return onboardingStatus(
      {
        db,
        victoria,
        install: {
          endpoint: await target.endpointFor(request),
          image: target.image,
          version: target.version,
        },
      },
      cluster,
    );
  }

  function stream(request: FastifyRequest, reply: FastifyReply, cluster: StatusCluster) {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    // Reconnect after 5 s if the connection drops (EventSource's own retry).
    res.write('retry: 5000\n\n');
    let ended = false;
    let last = '';
    let busy = false;
    const send = (event: string, data: unknown) => {
      if (!ended) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const stop = () => {
      ended = true;
      clearInterval(poll);
      clearInterval(ping);
      clearTimeout(limit);
    };
    const end = (reason: 'complete' | 'limit' | 'gone') => {
      if (ended) return;
      send('end', { reason });
      stop();
      res.end();
    };
    const tick = async () => {
      if (ended || busy) return;
      busy = true;
      try {
        const status: OnboardingStatus = await compute(request, cluster);
        // The clock changes every time; only a change of the checklist is sent.
        const key = JSON.stringify({ ...status, now: '' });
        if (key !== last) {
          last = key;
          send('status', status);
        }
        if (status.complete) end('complete');
      } catch (err) {
        // The cluster was deleted (its rows are gone), or the database is away for a moment.
        request.log.warn({ err: (err as Error).message }, 'onboarding status failed');
        const still = await clusterForOrg(db, request.user!.org.id, cluster.id).catch(() => true);
        if (!still) end('gone');
      } finally {
        busy = false;
      }
    };
    const poll = setInterval(() => void tick(), STREAM_POLL_MS);
    const ping = setInterval(() => {
      if (!ended) res.write(': ping\n\n');
    }, PING_MS);
    const limit = setTimeout(() => end('limit'), STREAM_MAX_MS);
    request.raw.on('close', stop);
    void tick();
    return reply;
  }

  app.get(
    '/clusters/:id/onboarding-status',
    {
      preHandler: signedIn,
      schema: {
        summary:
          'The live connection checklist of a new cluster: agents, cluster agent, first metrics, eBPF, service map. JSON, or Server-Sent Events with `Accept: text/event-stream`',
        tags: ['clusters'],
        params: ClusterIdParams,
        response: { 200: OnboardingStatusSchema, 401: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, 'Cluster not found');
      if ((request.headers.accept ?? '').includes('text/event-stream')) {
        return stream(request, reply, cluster);
      }
      const status = await compute(request, cluster);
      return reply.header('cache-control', 'no-store').send(status);
    },
  );
};
