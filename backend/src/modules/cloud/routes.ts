// SPDX-License-Identifier: AGPL-3.0-only
// The Cloud-only routes (ADR-173), registered only with WATCHLOG_EDITION=cloud
// (plugins/edition.ts). Accounts (ADR-175) and onboarding (ADR-176) are here; the funnel's
// storage (ADR-179) and the internal
// admin and entitlements APIs (ADR-177, ADR-179) come in later slices. Each route is
// classified in test/isolation/classification.ts.
import type { FastifyPluginAsync } from 'fastify';
import type { Config } from '../../config.js';
import type { Database } from '../../db/index.js';
import type { CloudAccounts } from '../accounts/context.js';
import { accountRoutes } from '../accounts/routes.js';
import { onboardingCloudRoutes } from '../onboarding/cloud-routes.js';
import type { SettingsService } from '../settings/service.js';

export interface CloudRouteOptions extends Record<string, unknown> {
  db: Database;
}

export interface CloudApiOptions extends CloudRouteOptions {
  /** Signup, sign-in and invites run before the org is known (ADR-174). */
  systemDb: Database;
  config: Config;
  settings: SettingsService;
  accounts: CloudAccounts;
}

/** Under /api/v1: the public Cloud API (accounts, onboarding's first week and the funnel). */
export const cloudApiRoutes: FastifyPluginAsync<CloudApiOptions> = async (app, opts) => {
  await app.register(accountRoutes, opts);
  await app.register(onboardingCloudRoutes, { db: opts.db });
};

/** Under /internal: the billing service's and the Cloud admin's API. */
export const internalRoutes: FastifyPluginAsync<CloudRouteOptions> = async () => {};
