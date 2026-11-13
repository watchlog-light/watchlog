// SPDX-License-Identifier: AGPL-3.0-only
// Every request runs in its own org scope (ADR-174), entered before any other hook, so the
// org that authentication binds (db/org-context.ts) reaches every query the request makes,
// its SSE streams and timers included.
import type { FastifyInstance } from 'fastify';
import { enterRequestScope } from '../db/org-context.js';

export function registerOrgScope(app: FastifyInstance): void {
  // A callback hook: the rest of the request runs inside `done`, so inside the scope.
  app.addHook('onRequest', (_request, _reply, done) => enterRequestScope(done));
}
