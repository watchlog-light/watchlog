// SPDX-License-Identifier: AGPL-3.0-only
// The Cloud-only routes (ADR-173), registered only with WATCHLOG_EDITION=cloud
// (plugins/edition.ts). Accounts (ADR-175), onboarding (ADR-176), the plan (ADR-177) and
// Plan & billing's calls to the billing service (ADR-178), the lifecycle emails' unsubscribe
// and support mode (ADR-179), and the data rights (ADR-181) are here. The internal API (ADR-177, ADR-178) has its own
// listener (modules/internal/app.ts). Each route is classified in
// test/isolation/classification.ts.
import type { FastifyPluginAsync } from 'fastify';
import type { Config } from '../../config.js';
import type { Database } from '../../db/index.js';
import type { CloudAccounts } from '../accounts/context.js';
import { accountRoutes } from '../accounts/routes.js';
import { billingClient } from '../billing/client.js';
import { billingRoutes } from '../billing/routes.js';
import { onboardingCloudRoutes } from '../onboarding/cloud-routes.js';
import { planRoutes } from '../entitlements/routes.js';
import { unsubscribeRoutes } from '../lifecycle/unsubscribe.js';
import { supportRoutes } from '../support/routes.js';
import type { EntitlementsService } from '../entitlements/service.js';
import type { SettingsService } from '../settings/service.js';
import { dataRightsRoutes } from '../data-rights/routes.js';
import type { VictoriaClient } from '../../lib/victoria.js';

export interface CloudRouteOptions extends Record<string, unknown> {
  db: Database;
}

export interface CloudApiOptions extends CloudRouteOptions {
  /** Signup, sign-in and invites run before the org is known (ADR-174). */
  systemDb: Database;
  config: Config;
  settings: SettingsService;
  accounts: CloudAccounts;
  entitlements: EntitlementsService;
  victoria?: VictoriaClient;
}

/** Under /api/v1: the public Cloud API (accounts, onboarding's first week and the funnel). */
export const cloudApiRoutes: FastifyPluginAsync<CloudApiOptions> = async (app, opts) => {
  await app.register(accountRoutes, opts);
  await app.register(onboardingCloudRoutes, { db: opts.db, entitlements: opts.entitlements });
  await app.register(planRoutes, { db: opts.db, entitlements: opts.entitlements });
  // Support mode (ADR-179): entering from the Cloud admin's link, the banner, leaving, and
  // the Owners' list.
  await app.register(supportRoutes, { db: opts.db, systemDb: opts.systemDb });
  // The lifecycle emails' one-click unsubscribe (ADR-179): a signed link, no session.
  await app.register(unsubscribeRoutes, {
    systemDb: opts.systemDb,
    secretKey: opts.config.secretKey,
  });
  // Data rights (ADR-181): export, deletion with its 7-day undo, reactivation.
  await app.register(dataRightsRoutes, {
    db: opts.db,
    victoria: opts.victoria,
    entitlements: opts.entitlements,
    mail: {
      systemDb: opts.systemDb,
      settings: () => opts.settings.alerting(),
      from: opts.config.lifecycleFrom,
      log: app.log,
    },
  });
  const { billingUrl, internalApi } = opts.config;
  await app.register(billingRoutes, {
    billing: billingUrl && internalApi ? billingClient(billingUrl, internalApi.token) : null,
    entitlements: opts.entitlements,
  });
};
