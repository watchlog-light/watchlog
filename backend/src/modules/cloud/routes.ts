// SPDX-License-Identifier: AGPL-3.0-only
// The Cloud-only routes (ADR-173), registered only with WATCHLOG_EDITION=cloud
// (plugins/edition.ts). Empty in slice 1: signup and OAuth (ADR-175), the funnel (ADR-179)
// and the internal admin and entitlements APIs (ADR-177, ADR-179) are added here, and each
// new route is classified in test/isolation/classification.ts.
import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../../db/index.js';

export interface CloudRouteOptions extends Record<string, unknown> {
  db: Database;
}

/** Under /api/v1: the public Cloud API (signup, OAuth, funnel). */
export const cloudApiRoutes: FastifyPluginAsync<CloudRouteOptions> = async () => {};

/** Under /internal: the billing service's and the Cloud admin's API. */
export const internalRoutes: FastifyPluginAsync<CloudRouteOptions> = async () => {};
