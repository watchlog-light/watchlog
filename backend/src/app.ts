// SPDX-License-Identifier: AGPL-3.0-only
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import type { Config } from './config.js';
import type { Database } from './db/index.js';
import { registerProblemHandlers } from './lib/problem.js';
import { authRoutes } from './modules/auth/routes.js';
import { clusterRoutes } from './modules/clusters/routes.js';
import { ensureBootstrapCluster } from './modules/clusters/bootstrap.js';
import { ensureEventPartitions } from './modules/events/partitions.js';
import { ingestRoutes } from './modules/ingest/routes.js';
import { TokenCache } from './modules/ingest/token-cache.js';
import { kubernetesRoutes } from './modules/kubernetes/routes.js';
import { overviewRoutes } from './modules/overview/routes.js';
import { serviceMapRoutes } from './modules/servicemap/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { setupRoutes } from './modules/setup/routes.js';
import type { SetupState } from './modules/setup/service.js';
import { registerCsrfProtection } from './plugins/csrf.js';
import {
  registerDemoGuard,
  registerDemoQueryLimits,
  registerDemoSessions,
} from './plugins/demo.js';
import { DemoSessions } from './modules/demo/service.js';
import { parseTrustedProxies, registerClientIp } from './plugins/client-ip.js';
import { demoRoutes } from './modules/demo/routes.js';
import { VictoriaQueryClient } from './lib/victoria.js';
import { dockerRoutes } from './modules/docker/routes.js';
import { queryRoutes } from './modules/query/routes.js';
import { alertRoutes } from './modules/alerts/routes.js';
import { HttpClient } from './modules/alerts/channels.js';
import { settingsRoutes } from './modules/settings/routes.js';
import { SettingsService } from './modules/settings/service.js';
import type { BucketSpec } from './modules/ingest/rate-limit.js';
import { applySeed, type Seed } from './modules/seed/seed.js';

export const API_PREFIX = '/api/v1';

export interface AppDeps {
  db: Database;
  setup: SetupState;
  /** Test overrides for the ingest rate limits (ADR-027). */
  ingestBuckets?: { agent?: BucketSpec; clusterAgent?: BucketSpec; cluster?: BucketSpec };
  /** Alert rules from WATCHLOG_SEED_FILE, applied again once first-run setup made an org. */
  seed?: Seed;
  /** Test hook: sees every route as it is registered (the demo guard's route test). */
  onRoute?: (route: RouteOptions) => void;
}

export async function buildApp(config: Config, deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: config.trustProxy,
    logger: {
      level: config.logLevel,
      ...(config.isDevelopment ? { transport: { target: 'pino-pretty' } } : {}),
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  if (deps.onRoute) app.addHook('onRoute', deps.onRoute);
  registerProblemHandlers(app);
  // JSON only: text/plain is a CORS "simple" content type usable for CSRF (ADR-034).
  app.removeContentTypeParser('text/plain');
  app.decorateRequest('user', null);
  registerClientIp(app, {
    clientIpHeader: config.clientIpHeader,
    trustedProxies: parseTrustedProxies(config.trustedProxies),
    cookieSecure: config.cookieSecure,
  });
  registerCsrfProtection(app, config.publicUrl);
  // Read-only demo (ADR-122): every change is refused here, before any route runs.
  registerDemoGuard(app, config.demoMode);

  await app.register(helmet);
  await app.register(cookie);
  // Per visitor, also behind a proxy (WATCHLOG_CLIENT_IP_HEADER); routes may key otherwise.
  await app.register(rateLimit, { global: false, keyGenerator: (request) => request.clientIp });
  // Read-only demo (ADR-122): signed sessions without database rows, and small queries.
  const demoSessions = new DemoSessions(config.secretKey);
  if (config.demoMode) {
    registerDemoSessions(app, { db: deps.db, sessions: demoSessions });
    registerDemoQueryLimits(app);
  }
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'WatchLog API', version: config.version },
    },
  });

  const tokens = new TokenCache(deps.db);
  const victoria = config.victoriaMetricsUrl
    ? new VictoriaQueryClient(config.victoriaMetricsUrl, 10_000, config.queryTimeoutMs)
    : undefined;
  if (!victoria) app.log.warn('VICTORIAMETRICS_URL is not set; ingest will answer 503');
  // Send test and Telegram's getMe go out through the outbound proxy (ADR-080).
  const alertHttp = new HttpClient(config.proxy);
  app.addHook('onClose', () => alertHttp.close());
  const settings = new SettingsService(deps.db, config);

  await app.register(
    async (api) => {
      await api.register(healthRoutes, { version: config.version });
      await api.register(setupRoutes, {
        ...deps,
        demoMode: config.demoMode,
        afterSetup: async () => {
          await bootstrapCluster(app, config, deps.db);
          if (deps.seed) await applySeed(deps.db, deps.seed, app.log);
        },
      });
      await api.register(authRoutes, deps);
      await api.register(demoRoutes, {
        db: deps.db,
        demoMode: config.demoMode,
        sessions: demoSessions,
      });
      await api.register(clusterRoutes, { db: deps.db, config, tokens, settings });
      await api.register(queryRoutes, { db: deps.db, victoria });
      await api.register(dockerRoutes, { db: deps.db, victoria });
      await api.register(kubernetesRoutes, { db: deps.db, victoria, settings });
      await api.register(overviewRoutes, { db: deps.db, victoria, settings });
      await api.register(serviceMapRoutes, { db: deps.db, victoria, config, settings });
      await api.register(alertRoutes, { db: deps.db, config, http: alertHttp, settings, victoria });
      await api.register(settingsRoutes, { db: deps.db, settings, http: alertHttp });
      api.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
    },
    { prefix: API_PREFIX },
  );
  await app.register(ingestRoutes, {
    prefix: '/ingest/v1',
    db: deps.db,
    tokens,
    victoria,
    agentBucket: deps.ingestBuckets?.agent,
    clusterAgentBucket: deps.ingestBuckets?.clusterAgent,
    clusterBucket: deps.ingestBuckets?.cluster,
    eventsRetentionDays: config.eventsRetentionDays,
  });

  // Event partitions (ADR-061): on start, then every 6 hours.
  const maintain = () =>
    ensureEventPartitions(deps.db, config.eventsRetentionDays).catch((err: Error) =>
      app.log.error({ err: err.message }, 'event partition maintenance failed'),
    );
  let maintenance: ReturnType<typeof setInterval> | undefined;
  app.addHook('onReady', async () => {
    await maintain();
    maintenance = setInterval(() => void maintain(), 6 * 3_600_000);
    maintenance.unref();
  });
  app.addHook('onClose', async () => clearInterval(maintenance));

  return app;
}

/** Creates the Helm-configured Kubernetes cluster once an org exists (ADR-069). */
export async function bootstrapCluster(app: FastifyInstance, config: Config, db: AppDeps['db']) {
  if (!config.bootstrapCluster) return;
  const { name, token } = config.bootstrapCluster;
  const result = await ensureBootstrapCluster(db, name, token);
  if (result === 'created')
    app.log.info({ cluster: name }, 'Kubernetes cluster created from the Helm chart token');
  if (result === 'no-org') app.log.info('cluster bootstrap waits for first-run setup');
  if (result === 'revoked' || result === 'deleted') {
    app.log.info(
      { cluster: name, reason: result },
      `Helm chart token ${result === 'revoked' ? 'was revoked' : 'belongs to a deleted cluster'}; not recreating it`,
    );
  }
}
