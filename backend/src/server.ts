// SPDX-License-Identifier: AGPL-3.0-only
import { bootstrapCluster, buildApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { createDb, describeDbError, waitForDatabase } from './db/index.js';
import { checkSecretKey } from './lib/secrets.js';
import { SetupState } from './modules/setup/service.js';
import { syncDemoMcpToken } from './modules/demo/mcp-token.js';
import { ensureDemoUser } from './modules/demo/service.js';
import { applySeed, loadSeedFile, type Seed } from './modules/seed/seed.js';

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
const db = createDb(config.databaseUrl);
const setup = new SetupState();
const app = await buildApp(config, { db, setup, seed });
app.addHook('onClose', () => db.destroy());

try {
  await waitForDatabase(() => db.selectFrom('users').select('id').limit(1).execute(), {
    log: (msg) => app.log.info(msg),
  });
  await setup.initialize(
    db,
    { email: config.adminEmail, password: config.adminPassword },
    { info: (obj, msg) => app.log.info(obj, msg), warn: (msg) => app.log.warn(msg) },
  );
} catch (err) {
  app.log.error(describeDbError(err, config.databaseUrl));
  await app.close();
  process.exit(1);
}
try {
  await checkSecretKey(db, config.secretKey);
} catch (err) {
  app.log.error(`watchlog backend cannot start: ${(err as Error).message}`);
  await app.close();
  process.exit(1);
}
// Read-only demo (ADR-122): the viewer account exists before the bootstrap cluster needs an org.
if (config.demoMode) {
  try {
    await ensureDemoUser(db);
    app.log.warn('demo mode: the dashboard is a read-only public demo; every change answers 403');
  } catch (err) {
    app.log.error({ err: (err as Error).message }, 'demo account setup failed');
  }
}
await bootstrapCluster(app, config, db).catch((err: Error) =>
  app.log.error({ err: err.message }, 'cluster bootstrap failed'),
);
// The demo's public MCP token (ADR-130): in demo mode the seed's, otherwise none.
await syncDemoMcpToken(
  db,
  { demoMode: config.demoMode, token: seed?.demoMcp?.token },
  app.log,
).catch((err: Error) => app.log.error({ err: err.message }, 'demo MCP token setup failed'));
// After the bootstrap cluster, which a seeded rule may name. A rule that fails is logged.
if (seed) {
  await applySeed(db, seed, app.log).catch((err: Error) =>
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

try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
}
