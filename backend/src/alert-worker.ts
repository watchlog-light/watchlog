// SPDX-License-Identifier: AGPL-3.0-only
// The alert-worker process (SPEC §5.1, ADR-073): `node dist/alert-worker.js`.
import { pino } from 'pino';
import { buildApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { createDb, describeDbError, waitForDatabase } from './db/index.js';
import { checkSecretKey, usePreviousSecretKey } from './lib/secrets.js';
import { VictoriaQueryClient } from './lib/victoria.js';
import { HttpClient } from './modules/alerts/channels.js';
import { workerCauses } from './modules/alerts/likely-cause.js';
import { CausesService } from './modules/causes/likely.js';
import { SetupState } from './modules/setup/service.js';
import { deliverDue } from './modules/alerts/delivery.js';
import { pollTelegramVerifications } from './modules/alerts/telegram.js';
import { SettingsService } from './modules/settings/service.js';
import { ensureDefaultRules, lookupEvaluator } from './modules/alerts/rules.js';
import { AlertWorker } from './modules/alerts/worker.js';
import { runApiTokenJobs, TOKEN_JOBS_EVERY_MS } from './modules/api-tokens/jobs.js';

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`watchlog alert-worker cannot start: ${(err as Error).message}`);
  process.exit(1);
}
const log = pino({
  name: 'alert-worker',
  level: config.logLevel,
  ...(config.isDevelopment ? { transport: { target: 'pino-pretty' } } : {}),
});
const db = createDb(config.databaseUrl);

try {
  // The backend applies the migrations; on a fresh install this may start first.
  await waitForDatabase(
    () => db.selectFrom('alert_worker_heartbeats').select('worker_id').limit(1).execute(),
    { log: (msg) => log.info(msg) },
  );
} catch (err) {
  log.error(describeDbError(err, config.databaseUrl));
  process.exit(1);
}
usePreviousSecretKey(config.previousSecretKey);
try {
  await checkSecretKey(db, config.secretKey);
} catch (err) {
  log.error(`watchlog alert-worker cannot start: ${(err as Error).message}`);
  process.exit(1);
}
const http = new HttpClient(config.proxy);
const settings = new SettingsService(db, config);
// The likely cause in the messages (ADR-148, ADR-157): probable cause reads the public API,
// so the worker builds the app in-process and reads it as a viewer of each alert's org.
const reads = await buildApp(config, { db, setup: new SetupState(), serviceReads: true });
const channelDeps = {
  db,
  secretKey: config.secretKey,
  http,
  settings: () => settings.alerting(),
  log,
  causes: workerCauses(reads, new CausesService()),
};

const worker = new AlertWorker({
  db,
  databaseUrl: config.databaseUrl,
  version: config.version,
  log,
  evaluators: lookupEvaluator,
  prepareOrg: (orgId) => ensureDefaultRules(db, orgId),
  victoria: config.victoriaMetricsUrl
    ? new VictoriaQueryClient(config.victoriaMetricsUrl)
    : undefined,
  retentionDays: config.alertRetentionDays,
  tasks: [
    { name: 'deliver', everyMs: 2_000, run: (now) => deliverDue(channelDeps, now) },
    // Long-polls (20 s) only while a verification is open.
    { name: 'telegram', everyMs: 3_000, run: (now) => pollTelegramVerifications(channelDeps, now) },
    // API tokens (ADR-125): expiry, deletion after 30 days, the reminder 7 days before.
    {
      name: 'api-tokens',
      everyMs: TOKEN_JOBS_EVERY_MS,
      run: (now) => runApiTokenJobs({ db, settings: () => settings.alerting(), log }, now),
    },
  ],
});
const server = await worker.listen(config.host, config.workerPort).catch((err: Error) => {
  log.error({ err: err.message }, 'health endpoint failed to start');
  process.exit(1);
});
log.info({ worker: worker.id, port: config.workerPort }, 'alert-worker started');
worker.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'shutting down');
    server.close();
    worker
      .stop()
      .then(() => http.close())
      .then(() => reads.close())
      .then(() => db.destroy())
      .then(
        () => process.exit(0),
        () => process.exit(1),
      );
  });
}
