// SPDX-License-Identifier: AGPL-3.0-only
import { bootstrapCluster, buildApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { createDb, describeDbError } from './db/index.js';
import { checkSecretKey } from './lib/secrets.js';
import { SetupState } from './modules/setup/service.js';

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`watchlog backend cannot start: ${(err as Error).message}`);
  process.exit(1);
}
const db = createDb(config.databaseUrl);
const setup = new SetupState();
const app = await buildApp(config, { db, setup });
app.addHook('onClose', () => db.destroy());

try {
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
await bootstrapCluster(app, config, db).catch((err: Error) =>
  app.log.error({ err: err.message }, 'cluster bootstrap failed'),
);

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
