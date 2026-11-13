// SPDX-License-Identifier: AGPL-3.0-only
import { bootstrapCluster, buildApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { createDb, describeDbError, waitForDatabase } from './db/index.js';
import { assertAppRole } from './db/app-role.js';
import { checkSecretKey, usePreviousSecretKey } from './lib/secrets.js';
import { SetupState } from './modules/setup/service.js';
import { syncDemoMcpToken } from './modules/demo/mcp-token.js';
import { ensureDemoUser } from './modules/demo/service.js';
import { applySeed, loadSeedFile, type Seed } from './modules/seed/seed.js';
import { buildInternalApp } from './modules/internal/app.js';
import { SettingsService } from './modules/settings/service.js';

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`watchlog backend cannot start: ${(err as Error).message}`);
  process.exit(1);
}
// The seed file (ADR-122): unreadable or invalid stops the start, with the path and why.
let seed: Seed | undefined;
if (config.seedFile) {
  try {
    seed = await loadSeedFile(config.seedFile);
  } catch (err) {
    console.error(`watchlog backend cannot start: ${(err as Error).message}`);
    process.exit(1);
  }
}
// Cloud (ADR-174): the request path as watchlog_app, the org set on every checkout; the
// allow-listed systemDb as the owner. Community: one connection, as in 0.5.0.
const cloud = config.edition === 'cloud';
const db = createDb(config.databaseUrl, { orgScoped: cloud });
const systemDb = cloud ? createDb(config.databaseSystemUrl) : db;
const setup = new SetupState();
const app = await buildApp(config, { db, systemDb, setup, seed });
app.addHook('onClose', async () => {
  await db.destroy();
  if (systemDb !== db) await systemDb.destroy();
});

try {
  await waitForDatabase(() => db.selectFrom('users').select('id').limit(1).execute(), {
    log: (msg) => app.log.info(msg),
  });
  // Cloud refuses to serve requests on a connection that RLS doesn't apply to.
  if (cloud) await assertAppRole(db);
  await setup.initialize(
    systemDb,
    { email: config.adminEmail, password: config.adminPassword },
    { info: (obj, msg) => app.log.info(obj, msg), warn: (msg) => app.log.warn(msg) },
  );
} catch (err) {
  app.log.error(describeDbError(err, config.databaseUrl));
  await app.close();
  process.exit(1);
}
usePreviousSecretKey(config.previousSecretKey);
try {
  await checkSecretKey(systemDb, config.secretKey);
} catch (err) {
  app.log.error(`watchlog backend cannot start: ${(err as Error).message}`);
  await app.close();
  process.exit(1);
}
// Read-only demo (ADR-122): the viewer account exists before the bootstrap cluster needs an org.
if (config.demoMode) {
  try {
    await ensureDemoUser(systemDb);
    app.log.warn('demo mode: the dashboard is a read-only public demo; every change answers 403');
  } catch (err) {
    app.log.error({ err: (err as Error).message }, 'demo account setup failed');
  }
}
await bootstrapCluster(app, config, systemDb).catch((err: Error) =>
  app.log.error({ err: err.message }, 'cluster bootstrap failed'),
);
// The demo's public MCP token (ADR-130): in demo mode the seed's, otherwise none.
await syncDemoMcpToken(
  systemDb,
  { demoMode: config.demoMode, token: seed?.demoMcp?.token },
  app.log,
).catch((err: Error) => app.log.error({ err: err.message }, 'demo MCP token setup failed'));
// After the bootstrap cluster, which a seeded rule may name. A rule that fails is logged.
if (seed) {
  await applySeed(systemDb, seed, app.log).catch((err: Error) =>
    app.log.error({ err: err.message }, 'seed failed'),
  );
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

// Cloud: the internal API for the billing service and staff (ADR-177, ADR-178), on its own
// listener that the Cloud kit keeps on the Compose network. Off without its token. Built
// before the public listener starts (hooks can't be added after).
let internal: Awaited<ReturnType<typeof buildInternalApp>> | null = null;
if (cloud && app.entitlements) {
  if (!config.internalApi) {
    app.log.warn('WATCHLOG_INTERNAL_TOKEN is not set; the internal API is off');
  } else {
    const internalSettings = new SettingsService(systemDb, config);
    const built = await buildInternalApp(config.internalApi, {
      systemDb,
      entitlements: app.entitlements,
      funnel: app.funnel,
      settings: () => internalSettings.alerting(),
      logLevel: config.logLevel,
    });
    internal = built;
    app.addHook('onClose', () => built.close());
  }
}

try {
  await app.listen({ host: config.host, port: config.port });
  if (internal && config.internalApi) {
    await internal.listen({ host: config.internalApi.host, port: config.internalApi.port });
  }
} catch (err) {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
}
