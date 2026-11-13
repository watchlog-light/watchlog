// SPDX-License-Identifier: AGPL-3.0-only
// Cloud-only routes (ADR-173). With WATCHLOG_EDITION unset (Community) they are never
// registered, so they answer 404 like any unknown path; test/edition.test.ts pins that for
// CLOUD_ONLY_PATHS. In Cloud every route they add carries `config.cloudOnly`, which the
// isolation suite's classification reads (test/isolation/).
import type { FastifyInstance, FastifyPluginAsync, RouteOptions } from 'fastify';
import type { Edition } from '../config.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Registered through registerCloudOnly: exists only with WATCHLOG_EDITION=cloud. */
    cloudOnly?: boolean;
    /**
     * The installation's own settings (ADR-093): in Cloud they are the operator's, set in the
     * environment, so the route answers 404 there (registerCommunityOnlyGuard).
     */
    communityOnly?: boolean;
  }
}

/**
 * Paths that exist only in Cloud, as the later slices add them (signup, the funnel, the
 * internal admin and billing APIs). Community answers 404 for each.
 */
export const CLOUD_ONLY_PATHS = [
  '/api/v1/auth/signup',
  '/api/v1/auth/config',
  '/api/v1/auth/oauth/github',
  '/api/v1/auth/oauth/github/start',
  '/api/v1/auth/2fa/verify',
  '/api/v1/orgs',
  '/api/v1/funnel',
  '/api/v1/onboarding/first-week',
  '/install.yaml',
  '/api/v1/plan',
  '/api/v1/plan/billing',
  '/api/v1/plan/beta',
  '/api/v1/plan/checkout',
  '/api/v1/plan/portal',
  '/internal/orgs',
  '/internal/entitlements',
  '/internal/orgs/00000000-0000-4000-8000-000000000000/entitlements',
  '/internal/orgs/00000000-0000-4000-8000-000000000000/usage',
  '/internal/orgs/00000000-0000-4000-8000-000000000000/owners',
] as const;

/** True for a route that answers 404 in Cloud. */
export function isCommunityOnly(route: Pick<RouteOptions, 'config'>): boolean {
  return (route.config as { communityOnly?: boolean } | undefined)?.communityOnly === true;
}

/**
 * Cloud: routes marked `communityOnly` answer 404, before authentication, as if they didn't
 * exist. They change or reveal what every org shares (the email server, the public address),
 * so no org's Owner may use them (ADR-174). Community: nothing changes.
 */
export function registerCommunityOnlyGuard(app: FastifyInstance, edition: Edition): void {
  if (edition !== 'cloud') return;
  app.addHook('onRequest', (request, reply, done) => {
    if (request.routeOptions.config?.communityOnly) return reply.callNotFound();
    done();
  });
}

/** True when a route was registered through registerCloudOnly. */
export function isCloudOnly(route: Pick<RouteOptions, 'config'>): boolean {
  return (route.config as { cloudOnly?: boolean } | undefined)?.cloudOnly === true;
}

/**
 * Registers `plugin` only in Cloud, marking each of its routes `cloudOnly`. In Community
 * this does nothing at all: the routes don't exist.
 */
export async function registerCloudOnly<T extends Record<string, unknown>>(
  app: FastifyInstance,
  edition: Edition,
  plugin: FastifyPluginAsync<T>,
  opts: T & { prefix?: string },
): Promise<void> {
  if (edition !== 'cloud') return;
  await app.register(async (scope) => {
    scope.addHook('onRoute', (route) => {
      route.config = { ...(route.config ?? {}), cloudOnly: true };
    });
    await scope.register(plugin, opts);
  });
}
