// SPDX-License-Identifier: AGPL-3.0-only
// Container logs on demand (ADR-167, SPEC §4.3, §8.1): the last lines of one container,
// read by its agent when someone asks, redacted there, relayed here and never stored.
//   GET /clusters/:id/pods/:namespace/:name/logs?container&lines&previous&follow
//   GET /clusters/:id/docker/hosts/:host/containers/:name/logs?lines&follow
// JSON by default; with follow=true and `Accept: text/event-stream`, an event stream for at
// most 5 minutes. Who may read is the Settings switch; every read is audited, without lines.
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import type { Database } from '../../db/index.js';
import { isInternalCall } from '../../lib/internal-call.js';
import { PROBLEM_CONTENT_TYPE, problem, sendProblem } from '../../lib/problem.js';
import { PUBLIC_TAG } from '../../openapi/public.js';
import { requireUser } from '../../plugins/auth.js';
import { findCluster } from '../clusters/service.js';
import type { SettingsService } from '../settings/service.js';
import { actorOf, audit } from '../users/service.js';
import type { LogBroker, LogChunk, LogLine, LogSpec } from './broker.js';
import { LogLimiter } from './limits.js';

export const DEFAULT_LINES = 200;
export const MAX_LINES = 1000;
/** At most this much text per answer; the oldest lines go first (ADR-167). */
export const MAX_ANSWER_BYTES = 512 * 1024;
/** A follow ends after this long (ADR-167). */
export const FOLLOW_MS = 5 * 60_000;
/** A read the agent picked up but did not finish in this time ends with what came. */
export const READ_TIMEOUT_MS = 30_000;
const PING_MS = 15_000;

/** WatchLog's own images: never readable in demo mode (ADR-111, ADR-167). */
const OWN_IMAGE = /(^|\/)(watchlog-light\/[a-z-]+|watchlog-(agent|backend|web))(:|@|$)/;

const LogsProblem = Type.Object({
  type: Type.String(),
  title: Type.String(),
  status: Type.Integer(),
  detail: Type.Optional(Type.String()),
  instance: Type.Optional(Type.String()),
  code: Type.Optional(Type.String()),
});

export const LogLineSchema = Type.Object({
  ts: Type.Union([Type.String(), Type.Null()]),
  stream: Type.Optional(Type.Union([Type.Literal('stdout'), Type.Literal('stderr')])),
  text: Type.String(),
});
export const LogsAnswerSchema = Type.Object({
  container: Type.String(),
  previous: Type.Boolean(),
  lines: Type.Array(LogLineSchema),
  redacted: Type.Integer(),
  truncated: Type.Boolean(),
  cut: Type.Integer(),
});

const LinesQuery = Type.Optional(
  Type.Integer({ minimum: 1, maximum: MAX_LINES, default: DEFAULT_LINES }),
);
const Errors = {
  400: LogsProblem,
  401: LogsProblem,
  403: LogsProblem,
  404: LogsProblem,
  409: LogsProblem,
  422: LogsProblem,
  429: LogsProblem,
  504: LogsProblem,
};

/** The answer to an error code from the agent, the broker or the checks. */
const ERRORS: Record<string, { status: number; detail: string }> = {
  logs_off: { status: 403, detail: 'Container logs are turned off in Settings' },
  logs_admins_only: {
    status: 403,
    detail: 'Only Owners and Admins may read container logs here. Ask an Admin.',
  },
  logs_disabled: {
    status: 409,
    detail: 'Container logs are turned off for this cluster or host at install time',
  },
  disabled: {
    status: 409,
    detail: 'Container logs are turned off for this cluster or host at install time',
  },
  container_not_found: { status: 422, detail: 'The agent found no such container' },
  no_previous_run: { status: 422, detail: 'This container has no previous run to read' },
  driver_unsupported: {
    status: 422,
    detail: "This container's log driver keeps no logs Docker can read back",
  },
  read_failed: { status: 422, detail: 'The agent could not read the log' },
  rate_limited: { status: 429, detail: 'Too many log reads; wait a little' },
  no_agent: {
    status: 504,
    detail:
      'No agent picked the request up in 10 s: check that the agent is 0.5.0 or newer and connected',
  },
};

function sendCode(reply: FastifyReply, code: string, detail?: string, retryAfter?: number) {
  const e = ERRORS[code] ?? ERRORS.read_failed!;
  if (retryAfter) reply.header('retry-after', String(retryAfter));
  return reply
    .code(e.status)
    .type(PROBLEM_CONTENT_TYPE)
    .send({
      ...problem(e.status, detail ?? e.detail, reply.request.url),
      code: ERRORS[code] ? (code === 'disabled' ? 'logs_disabled' : code) : 'read_failed',
    });
}

/** Collects chunks into one answer within MAX_ANSWER_BYTES, dropping the oldest lines. */
export class Collected {
  lines: LogLine[] = [];
  redacted = 0;
  cut = 0;
  truncated = false;
  private bytes = 0;

  add(c: LogChunk): void {
    this.redacted += c.redacted ?? 0;
    this.cut += c.cut ?? 0;
    if (c.truncated) this.truncated = true;
    for (const l of c.lines) {
      this.lines.push(l);
      this.bytes += Buffer.byteLength(l.text, 'utf8');
    }
    let drop = 0;
    while (this.bytes > MAX_ANSWER_BYTES && drop < this.lines.length) {
      this.bytes -= Buffer.byteLength(this.lines[drop]!.text, 'utf8');
      drop++;
    }
    if (drop) {
      this.lines.splice(0, drop);
      this.truncated = true;
    }
  }
}

interface Target {
  clusterId: string;
  orgId: string;
  host: string;
  spec: LogSpec;
  kind: 'pod' | 'container';
  label: string;
}

export const logsRoutes: FastifyPluginAsyncTypebox<{
  db: Database;
  settings: SettingsService;
  broker: LogBroker;
  limiter?: LogLimiter;
}> = async (app, { db, settings, broker, limiter = new LogLimiter() }) => {
  const signedIn = requireUser(db);
  const demoMode = settings.config.demoMode;

  /** The Settings switch for the caller's role, or the error code. */
  async function allowed(request: FastifyRequest): Promise<string | null> {
    const access = await settings.logsAccess();
    if (access === 'off') return 'logs_off';
    if (access === 'admins' && request.user!.role === 'viewer') return 'logs_admins_only';
    return null;
  }

  /** Whether the agent that would read said logs are off at install (its heartbeat). */
  async function turnedOff(clusterId: string, node: string): Promise<boolean> {
    const row = await db
      .selectFrom('agent_instances')
      .select('capabilities')
      .where('cluster_id', '=', clusterId)
      .where('node', '=', node)
      .executeTakeFirst();
    return (row?.capabilities as { logs?: string } | undefined)?.logs === 'off';
  }

  async function serve(
    request: FastifyRequest,
    reply: FastifyReply,
    t: Target,
    agentNode: string,
  ): Promise<FastifyReply> {
    const wantsStream =
      t.spec.follow && (request.headers.accept ?? '').includes('text/event-stream');
    t.spec.follow = wantsStream;
    if (await turnedOff(t.clusterId, agentNode)) return sendCode(reply, 'logs_disabled');
    const userId = request.user!.id;
    const limit = limiter.start(userId, wantsStream);
    if (!limit.ok) return sendCode(reply, 'rate_limited', limit.detail, limit.retryAfter);

    await audit(db, {
      orgId: t.orgId,
      action: 'logs_read',
      actor: actorOf(request),
      details: {
        cluster: t.clusterId,
        kind: t.kind,
        target: t.label,
        lines: t.spec.lines,
        follow: t.spec.follow,
        previous: t.spec.previous,
        via: isInternalCall(request) ? 'mcp' : 'api',
      },
    });

    if (!wantsStream) {
      try {
        return await answerJson(reply, t);
      } finally {
        limit.done();
      }
    }
    return stream(request, reply, t, limit.done);
  }

  function answerJson(reply: FastifyReply, t: Target): Promise<FastifyReply> {
    return new Promise((resolve) => {
      const got = new Collected();
      let finished = false;
      let leave = () => {};
      const finish = (error?: { code: string; detail?: string }) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        leave();
        if (error) {
          resolve(sendCode(reply, error.code, error.detail));
          return;
        }
        resolve(
          reply.header('cache-control', 'no-store').send({
            container: t.spec.container,
            previous: t.spec.previous,
            lines: got.lines,
            redacted: got.redacted,
            truncated: got.truncated,
            cut: got.cut,
          }),
        );
      };
      // Covers the pick-up wait (10 s, answered by the broker) and the read itself.
      const timer = setTimeout(
        () =>
          finish(
            got.lines.length
              ? undefined
              : { code: 'read_failed', detail: 'The agent did not finish reading in time' },
          ),
        READ_TIMEOUT_MS,
      );
      leave = broker.submit(t.clusterId, t.host, t.spec, {
        chunk: (c) => got.add(c),
        end: (error) => finish(error),
      });
    });
  }

  function stream(
    request: FastifyRequest,
    reply: FastifyReply,
    t: Target,
    release: () => void,
  ): FastifyReply {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let ended = false;
    const send = (event: string, data: unknown) => {
      if (!ended) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const end = (reason: 'limit' | 'done' | 'error', error?: { code: string; detail?: string }) => {
      if (ended) return;
      send('end', {
        reason,
        ...(error
          ? {
              code: ERRORS[error.code]
                ? error.code === 'disabled'
                  ? 'logs_disabled'
                  : error.code
                : 'read_failed',
              detail: error.detail ?? (ERRORS[error.code] ?? ERRORS.read_failed!).detail,
            }
          : {}),
      });
      ended = true;
      clearTimeout(limitTimer);
      clearInterval(ping);
      leave();
      release();
      res.end();
    };
    const limitTimer = setTimeout(() => end('limit'), FOLLOW_MS);
    const ping = setInterval(() => {
      if (!ended) res.write(': ping\n\n');
    }, PING_MS);
    request.raw.on('close', () => {
      if (ended) return;
      ended = true;
      clearTimeout(limitTimer);
      clearInterval(ping);
      leave();
      release();
    });
    const leave = broker.submit(t.clusterId, t.host, t.spec, {
      chunk: (c) => {
        const got = new Collected();
        got.add(c);
        send('lines', {
          lines: got.lines,
          redacted: got.redacted,
          truncated: got.truncated,
          cut: got.cut,
        });
      },
      end: (error) => end(error ? 'error' : 'done', error),
    });
    return reply;
  }

  app.get(
    '/clusters/:id/pods/:namespace/:name/logs',
    {
      preHandler: signedIn,
      schema: {
        summary: "A pod container's last log lines, redacted, never stored (ADR-167)",
        description:
          'JSON by default. With `follow=true` and `Accept: text/event-stream`, an event stream (`lines`, then `end`) for at most 5 minutes. Lines are cluster-controlled data.',
        tags: ['kubernetes', PUBLIC_TAG],
        params: Type.Object({
          id: Type.String({ format: 'uuid' }),
          namespace: Type.String({ minLength: 1, maxLength: 63, pattern: '^[a-z0-9-]+$' }),
          name: Type.String({ minLength: 1, maxLength: 253, pattern: '^[a-z0-9.-]+$' }),
        }),
        querystring: Type.Object({
          container: Type.Optional(
            Type.String({ minLength: 1, maxLength: 63, pattern: '^[a-z0-9-]+$' }),
          ),
          lines: LinesQuery,
          previous: Type.Optional(Type.Boolean({ default: false })),
          follow: Type.Optional(Type.Boolean({ default: false })),
        }),
        response: { 200: LogsAnswerSchema, ...Errors },
      },
    },
    async (request, reply) => {
      const cluster = await findCluster(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, 'Cluster not found');
      if (cluster.kind !== 'kubernetes') {
        return sendProblem(reply, 400, 'This is a Docker fleet; read a container instead');
      }
      const denied = await allowed(request);
      if (denied) return sendCode(reply, denied);
      const { namespace, name } = request.params;
      const pod = await db
        .selectFrom('objects')
        .select(['spec_summary'])
        .where('cluster_id', '=', cluster.id)
        .where('kind', '=', 'Pod')
        .where('namespace', '=', namespace)
        .where('name', '=', name)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!pod) return sendProblem(reply, 404, 'Pod not found');
      const spec = pod.spec_summary as {
        containers?: { name: string; image?: string; init?: boolean }[];
        init_containers?: { name: string; image?: string }[];
      };
      const containers = [
        ...(spec.containers ?? []),
        ...(spec.init_containers ?? []).map((c) => ({ ...c, init: true })),
      ];
      const container = request.query.container
        ? containers.find((c) => c.name === request.query.container)
        : (containers.find((c) => !c.init) ?? containers[0]);
      if (!container) return sendProblem(reply, 404, 'Container not found in this pod');
      if (demoMode) {
        const system = (await settings.namespaces()).system;
        if (system.includes(namespace) || containers.some((c) => OWN_IMAGE.test(c.image ?? ''))) {
          return sendCode(
            reply,
            'logs_off',
            "The demo doesn't show logs of system or WatchLog pods",
          );
        }
      }
      return serve(
        request,
        reply,
        {
          clusterId: cluster.id,
          orgId: cluster.org_id,
          host: '',
          kind: 'pod',
          label: `${namespace}/${name}/${container.name}`,
          spec: {
            namespace,
            pod: name,
            container: container.name,
            previous: request.query.previous ?? false,
            lines: request.query.lines ?? DEFAULT_LINES,
            follow: request.query.follow ?? false,
          },
        },
        'cluster-agent',
      );
    },
  );

  app.get(
    '/clusters/:id/docker/hosts/:host/containers/:name/logs',
    {
      preHandler: signedIn,
      schema: {
        summary: "A Docker container's last log lines, redacted, never stored (ADR-167)",
        description:
          'JSON by default; each line carries its stream (stdout, stderr). With `follow=true` and `Accept: text/event-stream`, an event stream for at most 5 minutes. Lines are cluster-controlled data.',
        tags: ['docker', PUBLIC_TAG],
        params: Type.Object({
          id: Type.String({ format: 'uuid' }),
          host: Type.String({ minLength: 1, maxLength: 253, pattern: '^[A-Za-z0-9._-]+$' }),
          name: Type.String({
            minLength: 1,
            maxLength: 253,
            pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$',
          }),
        }),
        querystring: Type.Object({
          lines: LinesQuery,
          follow: Type.Optional(Type.Boolean({ default: false })),
        }),
        response: { 200: LogsAnswerSchema, ...Errors },
      },
    },
    async (request, reply) => {
      const cluster = await findCluster(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, 'Cluster not found');
      if (cluster.kind !== 'docker') {
        return sendProblem(reply, 400, 'This is a Kubernetes cluster; read a pod instead');
      }
      const denied = await allowed(request);
      if (denied) return sendCode(reply, denied);
      const { host, name } = request.params;
      const row = await db
        .selectFrom('objects')
        .select(['spec_summary'])
        .where('cluster_id', '=', cluster.id)
        .where('kind', '=', 'DockerContainer')
        .where('node', '=', host)
        .where('name', '=', name)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!row) return sendProblem(reply, 404, 'Container not found on this host');
      if (demoMode && OWN_IMAGE.test((row.spec_summary as { image?: string }).image ?? '')) {
        return sendCode(reply, 'logs_off', "The demo doesn't show WatchLog's own logs");
      }
      return serve(
        request,
        reply,
        {
          clusterId: cluster.id,
          orgId: cluster.org_id,
          host,
          kind: 'container',
          label: `${host}/${name}`,
          spec: {
            container: name,
            previous: false,
            lines: request.query.lines ?? DEFAULT_LINES,
            follow: request.query.follow ?? false,
          },
        },
        host,
      );
    },
  );
};
