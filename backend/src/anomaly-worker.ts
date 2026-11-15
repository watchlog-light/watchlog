// SPDX-License-Identifier: AGPL-3.0-only
// The anomaly-worker process (SPEC §5.1, ADR-197): `node dist/anomaly-worker.js`, from the
// backend image beside the backend and the alert-worker. It learns each series' usual week
// and records unusual periods for What changed (ADR-196, ADR-198). It runs only in Cloud
// (WATCHLOG_EDITION=cloud) or the live demo (WATCHLOG_DEMO_MODE=true); anywhere else it
// exits at start saying why, so a Community install runs exactly what it ran before.
import { pino } from 'pino';
import { loadConfig, type Config } from './config.js';
import { createDb, describeDbError, waitForDatabase } from './db/index.js';
import { EntitlementsService } from './modules/entitlements/service.js';
import { metricsClient } from './modules/entitlements/metrics.js';
import { entitledOrgs, workerRefusal } from './modules/anomaly/gate.js';
import { loadAnomalySettings, type AnomalySettings } from './modules/anomaly/settings.js';
import { AnomalyWorker } from './modules/anomaly/worker.js';

// The guard reads the environment before anything else: Community needs no other setting.
const refusal = workerRefusal({
  edition: process.env.WATCHLOG_EDITION === 'cloud' ? 'cloud' : 'community',
  demoMode: process.env.WATCHLOG_DEMO_MODE === 'true',
});
if (refusal) {
  console.error(`watchlog anomaly-worker does not start: ${refusal}`);
  process.exit(0);
}

let config: Config;
let settings: AnomalySettings;
try {
  config = loadConfig();
  settings = loadAnomalySettings();
} catch (err) {
  console.error(`watchlog anomaly-worker cannot start: ${(err as Error).message}`);
  process.exit(1);
}
const log = pino({
  name: 'anomaly-worker',
  level: config.logLevel,
  ...(config.isDevelopment ? { transport: { target: 'pino-pretty' } } : {}),
});
// Cloud (ADR-174): each org's work as watchlog_app under RLS, inside withOrg; the list of
// entitled orgs and of learning rows as the owner. The demo (Community): one connection.
const cloud = config.edition === 'cloud';
const db = createDb(config.databaseUrl, { orgScoped: cloud });
const systemDb = cloud ? createDb(config.databaseSystemUrl) : db;

try {
  // The backend applies the migrations; on a fresh install this may start first.
  await waitForDatabase(
    () => db.selectFrom('anomaly_baselines').select('org_id').limit(1).execute(),
    { log: (msg) => log.info(msg) },
  );
} catch (err) {
  log.error(describeDbError(err, config.databaseUrl));
  process.exit(1);
}
const entitlements = cloud ? new EntitlementsService(systemDb) : null;
const victoria = metricsClient(config, entitlements, log);
if (!victoria) {
  log.error('watchlog anomaly-worker cannot start: VICTORIAMETRICS_URL is required');
  process.exit(1);
}
const gate = { edition: config.edition, demoMode: config.demoMode };
const worker = new AnomalyWorker({
  deps: {
    db,
    systemDb,
    victoria,
    orgs: () => entitledOrgs(gate, systemDb),
    // Periods are kept for the org's retention (Cloud's tiers, ADR-177); the demo's alerts'.
    retentionDays: async (orgId) =>
      entitlements ? (await entitlements.get(orgId)).retentionDays : config.alertRetentionDays,
    rule: settings.rule,
    spreadMs: settings.spreadMs,
    log,
  },
  version: config.version,
  log,
});
const server = await worker.listen(config.host, settings.port).catch((err: Error) => {
  log.error({ err: err.message }, 'health endpoint failed to start');
  process.exit(1);
});
log.info(
  { port: settings.port, edition: config.edition, demo: config.demoMode, rule: settings.rule },
  'anomaly-worker started',
);
worker.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'shutting down');
    server.close();
    worker
      .stop()
      .then(() => db.destroy())
      .then(() => (systemDb === db ? undefined : systemDb.destroy()))
      .then(
        () => process.exit(0),
        () => process.exit(1),
      );
  });
}
