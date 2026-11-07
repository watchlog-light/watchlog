// SPDX-License-Identifier: AGPL-3.0-only
// RFC 9457 problem details for every error and unknown route (SPEC §8).
import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import { STATUS_CODES } from 'node:http';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
}

/** Problem types clients can branch on (RFC 9457 `type`); everything else is about:blank. */
export const ProblemType = {
  clusterLimit: 'urn:watchlog:problem:cluster-limit',
  nameTaken: 'urn:watchlog:problem:name-taken',
  tokenLimit: 'urn:watchlog:problem:token-limit',
  telegramUnreachable: 'urn:watchlog:problem:telegram-unreachable',
  /** Read-only demo mode (ADR-122); the body also has `code: "demo_read_only"`. */
  demoReadOnly: 'urn:watchlog:problem:demo-read-only',
} as const;
export type ProblemType = (typeof ProblemType)[keyof typeof ProblemType];

export function problem(
  status: number,
  detail?: string,
  instance?: string,
  type: ProblemType | 'about:blank' = 'about:blank',
): Problem {
  return {
    type,
    title: STATUS_CODES[status] ?? 'Error',
    status,
    ...(detail === undefined ? {} : { detail }),
    ...(instance === undefined ? {} : { instance }),
  };
}

/** Sends an RFC 9457 problem response. */
export function sendProblem(
  reply: FastifyReply,
  status: number,
  detail?: string,
  type?: ProblemType,
): FastifyReply {
  return reply
    .code(status)
    .type(PROBLEM_CONTENT_TYPE)
    .send(problem(status, detail, reply.request.url, type));
}

export function registerProblemHandlers(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'request failed');
    }
    // Never leak internal error messages on 5xx.
    const detail = status >= 500 ? undefined : error.message;
    return reply
      .code(status)
      .type(PROBLEM_CONTENT_TYPE)
      .send(problem(status, detail, request.url));
  });

  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .type(PROBLEM_CONTENT_TYPE)
      .send(problem(404, `No route for ${request.method} ${request.url}`, request.url)),
  );
}
