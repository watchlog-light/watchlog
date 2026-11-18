// SPDX-License-Identifier: AGPL-3.0-only
// "Unlimited" is `null` in an entitlement's limits. Fastify's validation coerces a body's
// values to the schema's first matching type, and for `integer | null` that turns an explicit
// null into 0: "unlimited nodes" from the admin panel was stored as 0 nodes (found in 0.9.6).
// These two hooks remember which of a route's fields arrived as null and put the nulls back
// after validation, so a limit is exactly what was sent.
import type { FastifyRequest } from 'fastify';

const sent = new WeakMap<FastifyRequest, string[]>();

/** `preValidation`: notes the named body fields that are explicitly null. */
export const rememberNulls =
  (fields: readonly string[]) =>
  async (request: FastifyRequest): Promise<void> => {
    const body = request.body;
    if (!body || typeof body !== 'object') return;
    sent.set(
      request,
      fields.filter((f) => (body as Record<string, unknown>)[f] === null),
    );
  };

/** In the handler: the body with those fields null again. */
export function withNulls<T extends object>(request: FastifyRequest, body: T): T {
  const nulls = sent.get(request);
  if (!nulls?.length) return body;
  const out = { ...body } as Record<string, unknown>;
  for (const f of nulls) out[f] = null;
  return out as T;
}
