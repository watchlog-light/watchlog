// SPDX-License-Identifier: AGPL-3.0-only
// The agents' side of logs on demand (ADR-167, SPEC §8.2), registered inside the ingest
// plugin so it shares its token auth:
//   GET  /ingest/v1/logs/requests?wait=25&host=  the requests for this agent, long-polled
//   POST /ingest/v1/logs/:requestId              lines for one request (redacted in the agent)
// The lines are handed to the waiting reader and dropped: never stored, never logged.
import type { FastifyInstance } from 'fastify';
import { Type, type Static } from 'typebox';
import { ProblemSchema } from '../auth/schemas.js';
import { sendProblem } from '../../lib/problem.js';
import type { LogBroker } from './broker.js';

/** The longest a poll waits for a request (ADR-167). */
export const MAX_WAIT_S = 25;
/** The most lines in one post; an answer comes in several posts when it is longer. */
export const MAX_LINES_PER_POST = 1000;
/** A line is cut at 2 KB in the agent (ADR-167); characters are at most that many bytes. */
export const MAX_LINE_CHARS = 2048;

const Host = Type.String({ maxLength: 253, pattern: '^[A-Za-z0-9._-]*$' });

export const LogChunkBody = Type.Object(
  {
    lines: Type.Array(
      Type.Object(
        {
          ts: Type.Union([Type.Null(), Type.String({ maxLength: 64 })]),
          stream: Type.Optional(Type.Union([Type.Literal('stdout'), Type.Literal('stderr')])),
          text: Type.String({ maxLength: MAX_LINE_CHARS }),
        },
        { additionalProperties: false },
      ),
      { maxItems: MAX_LINES_PER_POST },
    ),
    redacted: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
    cut: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
    truncated: Type.Optional(Type.Boolean()),
    done: Type.Optional(Type.Boolean()),
    error: Type.Optional(
      Type.Object(
        {
          code: Type.String({ maxLength: 64, pattern: '^[a-z_]+$' }),
          detail: Type.Optional(Type.String({ maxLength: 512 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
type LogChunkBody = Static<typeof LogChunkBody>;

export function registerLogsIngest(app: FastifyInstance, opts: { broker: LogBroker }): void {
  const { broker } = opts;

  app.get(
    '/logs/requests',
    {
      schema: {
        summary: 'Log requests for this agent (long-poll, ADR-167)',
        tags: ['ingest'],
        hide: true,
        querystring: Type.Object({
          host: Type.Optional(Host),
          wait: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WAIT_S })),
        }),
        response: { 200: Type.Unknown(), 204: Type.Null(), 401: ProblemSchema, 429: ProblemSchema },
      },
    },
    async (request, reply) => {
      const owner = request.ingestOwner!;
      const { host = '', wait = 0 } = request.query as { host?: string; wait?: number };
      if (wait > 0) {
        const aborted = new AbortController();
        request.raw.on('close', () => aborted.abort());
        await broker.wait(owner.clusterId, host, wait * 1000, aborted.signal);
        if (aborted.signal.aborted) return reply;
      }
      const requests = broker.take(owner.clusterId, host);
      reply.header('cache-control', 'no-store');
      if (!requests.length) return reply.code(204).send(null);
      return reply.send({
        requests: requests.map((r) => ({ id: r.id, ...r.spec, ...(host ? { host } : {}) })),
      });
    },
  );

  app.post(
    '/logs/:requestId',
    {
      bodyLimit: 2 << 20,
      schema: {
        summary: 'Lines for one log request (redacted in the agent, never stored)',
        tags: ['ingest'],
        hide: true,
        params: Type.Object({ requestId: Type.String({ format: 'uuid' }) }),
        body: LogChunkBody,
        response: {
          204: Type.Null(),
          400: ProblemSchema,
          401: ProblemSchema,
          404: ProblemSchema,
          410: ProblemSchema,
          429: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const owner = request.ingestOwner!;
      const { requestId } = request.params as { requestId: string };
      const result = broker.deliver(owner.clusterId, requestId, request.body as LogChunkBody);
      if (result === 'unknown') return sendProblem(reply, 404, 'No such log request');
      if (result === 'gone') return sendProblem(reply, 410, 'The reader left; stop sending');
      return reply.code(204).send(null);
    },
  );
}
