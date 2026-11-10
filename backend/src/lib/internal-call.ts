// SPDX-License-Identifier: AGPL-3.0-only
// MCP tools read through the public REST API in-process (app.inject), as the same API
// token: they can never return more than the API shows that token. Such a request carries
// a secret made at start, which never leaves the process. With it, the token plugin still
// verifies the token and its scope but neither counts the request against the REST rate
// limit nor records it as REST use: the MCP call it serves is counted and logged instead.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

export const INTERNAL_CALL_HEADER = 'x-watchlog-internal-call';
const SECRET = randomBytes(32).toString('base64url');

/** The headers of an in-process request made for an MCP tool. */
export const internalCallHeaders = (authorization: string) => ({
  authorization,
  [INTERNAL_CALL_HEADER]: SECRET,
});

/** The mark alone, for an in-process read made with a session or demo cookie. */
export const internalCallMark = () => ({ [INTERNAL_CALL_HEADER]: SECRET });

/** Whether a request was made in-process (an MCP tool, probable cause). */
export function isInternalCall(request: FastifyRequest): boolean {
  const value = request.headers[INTERNAL_CALL_HEADER];
  if (typeof value !== 'string' || value.length !== SECRET.length) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(SECRET));
}
