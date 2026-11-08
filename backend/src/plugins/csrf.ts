// SPDX-License-Identifier: AGPL-3.0-only
// CSRF defence for cookie-authenticated routes: Fetch Metadata + Origin check (ADR-034).
// Requests with an API token skip it (ADR-125).
import type { FastifyInstance } from 'fastify';
import { sendProblem } from '../lib/problem.js';
import { bearerToken } from './api-token.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface RequestOrigin {
  secFetchSite?: string;
  origin?: string;
  host?: string;
}

/** Returns true when a state-changing request must be rejected as cross-site. */
export function isCrossSiteRequest(req: RequestOrigin, publicUrl?: string): boolean {
  if (req.secFetchSite === 'same-origin' || req.secFetchSite === 'none') return false;
  if (req.origin === undefined) {
    // No browser metadata at all: a non-browser client, which cannot carry a victim's cookie.
    return req.secFetchSite !== undefined;
  }
  if (!URL.canParse(req.origin)) return true; // includes the literal "null" origin
  const origin = new URL(req.origin);
  if (publicUrl !== undefined && origin.origin === new URL(publicUrl).origin) return false;
  return req.secFetchSite !== undefined ? true : origin.host !== req.host;
}

export function registerCsrfProtection(app: FastifyInstance, publicUrl?: string): void {
  app.addHook('onRequest', async (request, reply) => {
    if (SAFE_METHODS.has(request.method) || !request.url.startsWith('/api/')) return;
    // API tokens (ADR-125): a browser cannot add this header to a cross-site request, and
    // a token request carrying a session cookie is refused (plugins/api-token.ts).
    if (bearerToken(request) !== undefined) return;
    const header = (name: string) => {
      const value = request.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    const blocked = isCrossSiteRequest(
      { secFetchSite: header('sec-fetch-site'), origin: header('origin'), host: header('host') },
      publicUrl,
    );
    if (blocked) {
      request.log.warn({ origin: header('origin') }, 'blocked cross-site request');
      return sendProblem(reply, 403, 'Cross-site request blocked');
    }
  });
}
