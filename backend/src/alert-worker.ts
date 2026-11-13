// SPDX-License-Identifier: AGPL-3.0-only
// The alert-worker process (SPEC §5.1, ADR-073): `node dist/alert-worker.js`.
import { pino } from 'pino';
import { buildApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { createDb, describeDbError, waitForDatabase } from './db/index.js';
import { checkSecretKey, usePreviousSecretKey } from './lib/secrets.js';
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
import { EntitlementsService } from './modules/entitlements/service.js';
import { metricsClient } from './modules/entitlements/metrics.js';
import { recordUsage, USAGE_EVERY_MS } from './modules/entitlements/usage.js';
import { LIMIT_MAIL_EVERY_MS, sendLimitEmails } from './modules/entitlements/limit-mail.js';
import type { WorkerTask } from './modules/alerts/worker.js';

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
// Cloud (ADR-174): each org's evaluation as watchlog_app under RLS, inside withOrg; the work
// across orgs (listing orgs, the outbox, Telegram polling, token jobs, pruning) as the owner.
// Community: one connection, as in 0.5.0.
const cloud = config.edition === 'cloud';
const db = createDb(config.databaseUrl, { orgScoped: cloud });
const systemDb = cloud ? createDb(config.databaseSystemUrl) : db;

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
  await checkSecretKey(systemDb, config.secretKey);
} catch (err) {
  log.error(`watchlog alert-worker cannot start: ${(err as Error).message}`);
  process.exit(1);
}
const http = new HttpClient(config.proxy);
const settings = new SettingsService(systemDb, config);
// The likely cause in the messages (ADR-148, ADR-157): probable cause reads the public API,
// so the worker builds the app in-process and reads it as a viewer of each alert's org.
const reads = await buildApp(config, {
  db,
  systemDb,
  setup: new SetupState(),
  serviceReads: true,
});
// Cloud's plans (ADR-177): the metrics tiers, the hourly usage and the limit emails.
const entitlements = cloud ? new EntitlementsService(systemDb) : null;
const cloudTasks: WorkerTask[] = cloud
  ? [
      {
        name: 'usage',
        everyMs: USAGE_EVERY_MS,
        run: async (now) => {
          await recordUsage({ systemDb, db }, now);
        },
      },
      {
        name: 'plan-limit-emails',
        everyMs: LIMIT_MAIL_EVERY_MS,
        run: async (now) => {
          await sendLimitEmails({ systemDb, settings: () => settings.alerting(), log }, now);
        },
      },
    ]
  : [];
const channelDeps = {
  db: systemDb,
  secretKey: config.secretKey,
  http,
  settings: () => settings.alerting(),
  log,
  causes: workerCauses(reads, new CausesService()),
};

const worker = new AlertWorker({
  db,
  systemDb,
  databaseUrl: config.databaseSystemUrl,
  version: config.version,
  log,
  evaluators: lookupEvaluator,
  prepareOrg: (orgId) => ensureDefaultRules(db, orgId),
  victoria: metricsClient(config, entitlements, log),
  retentionDays: config.alertRetentionDays,
  tasks: [
    { name: 'deliver', everyMs: 2_000, run: (now) => deliverDue(channelDeps, now) },
    // Long-polls (20 s) only while a verification is open.
    { name: 'telegram', everyMs: 3_000, run: (now) => pollTelegramVerifications(channelDeps, now) },
    // API tokens (ADR-125): expiry, deletion after 30 days, the reminder 7 days before.
    {
      name: 'api-tokens',
      everyMs: TOKEN_JOBS_EVERY_MS,
      run: (now) =>
        runApiTokenJobs({ db: systemDb, settings: () => settings.alerting(), log }, now),
    },
    ...cloudTasks,
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
      .then(() => (systemDb === db ? undefined : systemDb.destroy()))
      .then(
        () => process.exit(0),
        () => process.exit(1),
      );
  });
}
