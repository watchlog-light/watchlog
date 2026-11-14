// SPDX-License-Identifier: AGPL-3.0-only
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import {
  DEMO_MCP_TOTAL_CALLS_PER_MINUTE,
  DEMO_MCP_VISITOR_CALLS_PER_MINUTE,
} from './modules/demo/mcp-token.js';
import { registerMcpRoutes } from './modules/mcp/routes.js';
import { publicSpec } from './openapi/public.js';
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
import { ConfigNotifier } from './modules/integrations/notifier.js';
import { installTarget } from './modules/clusters/install.js';
import { connectRoutes } from './modules/integrations/connect.js';
import { applicationRoutes } from './modules/integrations/routes.js';
import { causesRoutes } from './modules/causes/routes.js';
import { CausesService } from './modules/causes/likely.js';
import { kubernetesRoutes } from './modules/kubernetes/routes.js';
import { overviewRoutes } from './modules/overview/routes.js';
import { serviceMapRoutes } from './modules/servicemap/routes.js';
import { onboardingRoutes } from './modules/onboarding/routes.js';
import { installManifestRoutes } from './modules/onboarding/cloud-routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { setupRoutes } from './modules/setup/routes.js';
import type { SetupState } from './modules/setup/service.js';
import { registerCsrfProtection } from './plugins/csrf.js';
import {
  registerDemoGuard,
  registerDemoHiddenFacts,
  registerDemoQueryLimits,
  registerDemoSessions,
} from './plugins/demo.js';
import { DemoSessions } from './modules/demo/service.js';
import { parseTrustedProxies, registerClientIp } from './plugins/client-ip.js';
import { demoRoutes } from './modules/demo/routes.js';
import { dockerRoutes } from './modules/docker/routes.js';
import { queryRoutes } from './modules/query/routes.js';
import { alertRoutes } from './modules/alerts/routes.js';
import { HttpClient } from './modules/alerts/channels.js';
import { settingsRoutes } from './modules/settings/routes.js';
import { LogBroker } from './modules/logs/broker.js';
import { logsRoutes } from './modules/logs/routes.js';
import { rightSizingRoutes } from './modules/rightsizing/routes.js';
import { RightSizingService } from './modules/rightsizing/service.js';
import { searchRoutes } from './modules/search/routes.js';
import { userRoutes } from './modules/users/routes.js';
import { SettingsService } from './modules/settings/service.js';
import type { BucketSpec } from './modules/ingest/rate-limit.js';
import { applySeed, type Seed } from './modules/seed/seed.js';
import { applySeedServices } from './modules/seed/services.js';
import { apiTokenRoutes } from './modules/api-tokens/routes.js';
import { registerApiTokenAuth } from './plugins/api-token.js';
import { registerServiceIdentity } from './plugins/service-identity.js';
import { registerOrgScope } from './plugins/org-scope.js';
import { registerSupportMode } from './plugins/support.js';
import { requestWithoutCodes } from './lib/redact.js';
import { registerCloudOnly, registerCommunityOnlyGuard } from './plugins/edition.js';
import { cloudApiRoutes } from './modules/cloud/routes.js';
import { EntitlementsService } from './modules/entitlements/service.js';
import { SeriesGate } from './modules/entitlements/series-gate.js';
import { OrgLimits } from './plugins/org-limits.js';
import { OrgQueryLimiter } from './lib/org-queries.js';
import { NodeGate } from './modules/entitlements/node-gate.js';
import { metricsClient } from './modules/entitlements/metrics.js';
import { CloudAccounts } from './modules/accounts/context.js';
import { FunnelRecorder } from './modules/funnel/recorder.js';
import { EgressPolicy, type Resolver } from './lib/egress.js';
import { CLOUD_HELMET } from './lib/csp.js';

export const API_PREFIX = '/api/v1';

export interface AppDeps {
  /**
   * The request path's database. Cloud: `watchlog_app` with the org set on every checkout
   * (ADR-174); Community: the owner, as in 0.5.0.
   */
  db: Database;
  /**
   * The owner's connection, for the allow-listed work that runs before the org is known or
   * across orgs (ADR-174; test/isolation/system-db.test.ts). Community: the same as `db`.
   */
  systemDb?: Database;
  setup: SetupState;
  /** Cloud: the per-org request and stream limits (SR-9); tests may pass their own. */
  orgLimits?: OrgLimits;
  /** Cloud: each org's concurrent VictoriaMetrics queries (SR-9); tests pass their own. */
  orgQueries?: OrgQueryLimiter;
  /** Test overrides for the ingest rate limits (ADR-027). */
  ingestBuckets?: { agent?: BucketSpec; clusterAgent?: BucketSpec; cluster?: BucketSpec };
  /** Alert rules from WATCHLOG_SEED_FILE, applied again once first-run setup made an org. */
  seed?: Seed;
  /** Test hook: sees every route as it is registered (the demo guard's route test). */
  onRoute?: (route: RouteOptions) => void;
  /** Test hook: the probable-cause service (its cache, its explain) the routes share. */
  causes?: CausesService;
  /** Test hook: where the log goes (the API token test reads it for token values). */
  logStream?: { write(line: string): void };
  /**
   * The alert worker's in-process app (ADR-157): it answers the worker's service reads
   * (plugins/service-identity.ts), logs no request lines and runs no maintenance. Never set by
   * the backend that serves the API.
   */
  serviceReads?: boolean;
  /** Test hook: the `fetch` for Turnstile, Have I Been Pwned and OAuth (Cloud, ADR-175). */
  fetch?: typeof fetch;
  /** Test hook: the resolver Cloud's egress policy checks users' URLs with (ADR-181). */
  resolve?: Resolver;
  /** Test hook: Cloud's entitlements (ADR-177), shared with the internal API's app. */
  entitlements?: EntitlementsService;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Cloud's entitlements and limits (ADR-177); null in Community (no row, no checks). */
    entitlements: EntitlementsService | null;
  }
}

export async function buildApp(config: Config, deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: config.trustProxy,
    logger: {
      // The worker's in-process reads log only what goes wrong, not each request.
      level: deps.serviceReads ? 'warn' : config.logLevel,
      // Credentials never reach the log, whatever a serializer adds later (ADR-125).
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      // Codes in URLs are credentials (an install code, ADR-176; OAuth's code): never logged.
      serializers: { req: requestWithoutCodes },
      ...(deps.logStream
        ? { stream: deps.logStream }
        : config.isDevelopment
          ? { transport: { target: 'pino-pretty' } }
          : {}),
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  if (deps.onRoute) app.addHook('onRoute', deps.onRoute);
  // First: each request's org scope, which authentication binds (ADR-174).
  registerOrgScope(app);
  registerCommunityOnlyGuard(app, config.edition);
  const systemDb = deps.systemDb ?? deps.db;
  app.decorate('systemDb', systemDb);
  app.decorate('edition', config.edition);
  // Cloud's account checks and limits (ADR-175); `fetch` is replaced in tests.
  const accounts =
    config.edition === 'cloud'
      ? new CloudAccounts(config.accounts, deps.fetch ?? globalThis.fetch)
      : null;
  app.decorate('accounts', accounts);
  // Cloud: each org's share of reads and streams (SR-9).
  app.decorate(
    'orgLimits',
    config.edition === 'cloud' ? (deps.orgLimits ?? new OrgLimits()) : null,
  );
  // Cloud's plans (ADR-177): read across orgs (ingest, the tiers), so on the owner's connection.
  const entitlements =
    config.edition === 'cloud' ? (deps.entitlements ?? new EntitlementsService(systemDb)) : null;
  app.decorate('entitlements', entitlements);
  // Cloud's funnel (ADR-179): written under each event's org, on the request path's pool.
  app.decorate(
    'funnel',
    config.edition === 'cloud' && !deps.serviceReads ? new FunnelRecorder(deps.db, app.log) : null,
  );
  registerProblemHandlers(app);
  // JSON only: text/plain is a CORS "simple" content type usable for CSRF (ADR-034).
  app.removeContentTypeParser('text/plain');
  app.decorateRequest('user', null);
  registerClientIp(app, {
    clientIpHeader: config.clientIpHeader,
    clientCountryHeader: config.clientCountryHeader,
    trustedProxies: parseTrustedProxies(config.trustedProxies),
    // Cloud: Secure cookies always (ADR-181), whatever built the configuration.
    cookieSecure: config.edition === 'cloud' ? 'always' : config.cookieSecure,
  });
  registerCsrfProtection(app, config.publicUrl);
  // Read-only demo (ADR-122): every change is refused here, before any route runs.
  registerDemoGuard(app, config.demoMode);

  // Cloud: the strict policy and headers (ADR-181); Community: helmet's defaults, as 0.5.0.
  await app.register(helmet, config.edition === 'cloud' ? CLOUD_HELMET : {});
  await app.register(cookie);
  // Per visitor, also behind a proxy (WATCHLOG_CLIENT_IP_HEADER), or per API token when a
  // request has one; routes may key otherwise.
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (request) =>
      request.apiToken ? `api-token:${request.apiToken.id}` : request.clientIp,
  });
  // Personal API tokens (ADR-125): before the session cookie and the demo's sessions.
  registerApiTokenAuth(app, {
    db: deps.db,
    systemDb,
    restPerMinute: config.apiTokenLimits.restPerMinute,
    demoMode: config.demoMode,
  });
  // Cloud's support mode (ADR-179): a staff member's read-only session for one org, checked
  // before the session cookie.
  if (config.edition === 'cloud' && !deps.serviceReads) registerSupportMode(app, { systemDb });
  // The alert worker's reads for the notifications' likely cause (ADR-157): its app only.
  if (deps.serviceReads) registerServiceIdentity(app, systemDb);
  // Read-only demo (ADR-122): signed sessions without database rows, and small queries.
  const demoSessions = new DemoSessions(config.secretKey);
  if (config.demoMode) {
    registerDemoSessions(app, { systemDb, sessions: demoSessions });
    registerDemoQueryLimits(app);
    registerDemoHiddenFacts(app);
  }
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'WatchLog API', version: config.version },
    },
  });

  // The cluster-token check runs before the org is known (ADR-174).
  const tokens = new TokenCache(systemDb);
  // Wakes integrations collectors waiting on their configuration (ADR-131).
  const collectors = new ConfigNotifier();
  // Logs on demand (ADR-167): readers and agents meet here, in this process only.
  const logBroker = new LogBroker();
  app.decorate('collectorNotifier', collectors);
  // Cloud with VICTORIAMETRICS_URL_3D and _30D: the org's tier (ADR-177); else the one URL.
  const victoria = metricsClient(config, entitlements, app.log, 10_000, config.queryTimeoutMs);
  if (!victoria) app.log.warn('VICTORIAMETRICS_URL is not set; ingest will answer 503');
  // Cloud: each org's concurrent metric queries are capped (SR-9, lib/org-queries.ts).
  if (victoria && config.edition === 'cloud')
    victoria.limitPerOrg(deps.orgQueries ?? new OrgQueryLimiter());
  // Cloud: a new node over the plan gets 402 at ingest (ADR-177); Community has no gate.
  const nodeGate = entitlements ? new NodeGate(systemDb, entitlements, app.log) : null;
  // Cloud: each org's active series, capped at ingest (SR-3).
  const seriesGate = entitlements ? new SeriesGate(entitlements, app.log) : null;
  // Send test and Telegram's getMe go out through the outbound proxy (ADR-080).
  // Cloud: users' Slack and webhook URLs go through the egress policy (ADR-181).
  const alertHttp = new HttpClient(
    config.proxy,
    config.edition === 'cloud' ? new EgressPolicy(deps.resolve) : null,
  );
  app.addHook('onClose', () => alertHttp.close());
  const settings = new SettingsService(deps.db, config);
  // One answer cache for GET /causes and the likelyCause fields (ADR-155).
  const causes = deps.causes ?? new CausesService();
  // Right-sizing (ADR-168): the use over the window, kept an hour per cluster.
  const rightSizing = new RightSizingService(
    deps.db,
    victoria,
    settings,
    config.rightSizing,
    app.log,
  );

  await app.register(
    async (api) => {
      await api.register(healthRoutes, { version: config.version });
      await api.register(setupRoutes, {
        setup: deps.setup,
        systemDb,
        demoMode: config.demoMode,
        demoMcpToken: config.demoMode ? deps.seed?.demoMcp?.token : undefined,
        smtpConfigured: async () => !!(await settings.alerting()).smtp,
        // Across orgs, right after the first one is made: the owner's connection.
        afterSetup: async () => {
          await bootstrapCluster(app, config, systemDb);
          if (deps.seed) await applySeed(systemDb, deps.seed, app.log);
        },
      });
      await api.register(authRoutes, { systemDb });
      await api.register(demoRoutes, {
        systemDb,
        demoMode: config.demoMode,
        sessions: demoSessions,
      });
      await api.register(clusterRoutes, { db: deps.db, config, tokens, settings, victoria });
      await api.register(queryRoutes, { db: deps.db, victoria });
      await api.register(dockerRoutes, { db: deps.db, victoria });
      await api.register(kubernetesRoutes, { db: deps.db, victoria, settings });
      await api.register(logsRoutes, { db: deps.db, settings, broker: logBroker });
      await api.register(rightSizingRoutes, { db: deps.db, rightSizing });
      await api.register(searchRoutes, { db: deps.db });
      await api.register(overviewRoutes, { db: deps.db, victoria, settings, causes });
      await api.register(serviceMapRoutes, { db: deps.db, victoria, config, settings });
      await api.register(onboardingRoutes, {
        db: deps.db,
        victoria: victoria ?? null,
        config,
        settings,
      });
      await api.register(alertRoutes, {
        db: deps.db,
        config,
        http: alertHttp,
        settings,
        victoria,
        causes,
      });
      await api.register(settingsRoutes, { db: deps.db, settings, http: alertHttp });
      await api.register(applicationRoutes, {
        db: deps.db,
        notifier: collectors,
        secretKey: config.secretKey,
        victoria,
        install: installTarget(config, settings),
        causes,
      });
      await api.register(connectRoutes, {
        db: deps.db,
        notifier: collectors,
        secretKey: config.secretKey,
      });
      await api.register(causesRoutes, { db: deps.db, causes });
      await api.register(apiTokenRoutes, { db: deps.db });
      // Cloud only (ADR-173): Community never registers these, so they answer 404.
      if (accounts && entitlements) {
        await registerCloudOnly(api, config.edition, cloudApiRoutes, {
          db: deps.db,
          systemDb,
          config,
          settings,
          accounts,
          entitlements,
          victoria,
        });
      }
      await api.register(userRoutes, {
        db: deps.db,
        systemDb,
        settings,
        secretKey: config.secretKey,
      });
      // The public API only (ADR-126): routes tagged `public`, with the bearer scheme.
      let spec: Record<string, unknown> | undefined;
      api.get(
        '/openapi.json',
        { schema: { hide: true } },
        async () => (spec ??= publicSpec(app.swagger() as unknown as Record<string, unknown>)),
      );
    },
    { prefix: API_PREFIX },
  );
  // The MCP server (ADR-127): API tokens only, on by default (WATCHLOG_MCP_ENABLED).
  if (config.mcpEnabled) {
    await registerMcpRoutes(app, {
      db: deps.db,
      version: config.version,
      callsPerMinute: config.apiTokenLimits.mcpCallsPerMinute,
      ...(config.demoMode
        ? {
            demo: {
              visitorCallsPerMinute:
                deps.seed?.demoMcp?.visitorCallsPerMinute ?? DEMO_MCP_VISITOR_CALLS_PER_MINUTE,
              totalCallsPerMinute:
                deps.seed?.demoMcp?.totalCallsPerMinute ?? DEMO_MCP_TOTAL_CALLS_PER_MINUTE,
            },
          }
        : {}),
    });
  }
  // Cloud: the kubectl manifest behind an install code, at the ingest address's root.
  await registerCloudOnly(app, config.edition, installManifestRoutes, {
    systemDb,
    config,
    settings,
  });
  // The internal API (ADR-177, ADR-178) is not here: it has its own listener
  // (modules/internal/app.ts), so the public one answers 404 for /internal/*.
  await app.register(ingestRoutes, {
    prefix: '/ingest/v1',
    db: deps.db,
    tokens,
    victoria,
    agentBucket: deps.ingestBuckets?.agent,
    clusterAgentBucket: deps.ingestBuckets?.clusterAgent,
    clusterBucket: deps.ingestBuckets?.cluster,
    eventsRetentionDays: config.eventsRetentionDays,
    notifier: collectors,
    secretKey: config.secretKey,
    logs: logBroker,
    nodeGate,
    seriesGate,
  });

  // Seeded services (ADR-142): monitored as soon as the agents report them, so tried on
  // start and every minute while any is still missing.
  const seededServices = deps.seed?.services ?? [];
  let seeding: ReturnType<typeof setInterval> | undefined;
  if (seededServices.length) {
    const seedServices = () =>
      applySeedServices(systemDb, seededServices, collectors, app.log).catch((err: Error) =>
        app.log.error({ err: err.message }, 'seed: services not applied'),
      );
    app.addHook('onReady', async () => {
      await seedServices();
      seeding = setInterval(() => void seedServices(), 60_000);
      seeding.unref();
    });
    app.addHook('onClose', async () => clearInterval(seeding));
  }

  // The worker's in-process app serves reads only; the backend maintains the partitions.
  if (deps.serviceReads) return app;
  // Event partitions (ADR-061): on start, then every 6 hours.
  const maintain = () =>
    ensureEventPartitions(systemDb, config.eventsRetentionDays).catch((err: Error) =>
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
