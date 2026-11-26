// SPDX-License-Identifier: AGPL-3.0-only
// The alert-worker process (SPEC §5.1, ADR-073): `node dist/alert-worker.js`.
import { pino } from 'pino';
import { buildApp } from './app.js';
import { eeHost, loadEeModules } from './ee.js';
import { useNetworkEvidence } from './modules/causes/gather.js';
import { loadConfig, type Config } from './config.js';
import { setEgressLearningDays } from './modules/egress/learning.js';
import { createDb, describeDbError, waitForDatabase } from './db/index.js';
import { checkSecretKey, usePreviousSecretKey } from './lib/secrets.js';
import { HttpClient } from './modules/alerts/channels.js';
import { EgressPolicy } from './lib/egress.js';
import { workerCauses, workerChanges } from './modules/alerts/likely-cause.js';
import { CausesService } from './modules/causes/likely.js';
import { SetupState } from './modules/setup/service.js';
import { deliverDue } from './modules/alerts/delivery.js';
import { pollTelegramVerifications } from './modules/alerts/telegram.js';
import { SettingsService } from './modules/settings/service.js';
import { ensureDefaultRules, lookupEvaluator } from './modules/alerts/rules.js';
import {
  ensureAnomalyRule,
  parseAlertKeys,
  setAnomalyAlertKeys,
  setAnomalyGate,
} from './modules/anomaly/alerts.js';
import { hasWhatChanged } from './modules/anomaly/gate.js';
import { LICENSE_JOBS_EVERY_MS, runLicenseJobs } from './modules/license/jobs.js';
import { LicenseService } from './modules/license/service.js';
import { configureOwnAlerts } from './modules/own-metrics/alerts.js';
import { ownLimitsProvider } from './modules/own-metrics/limits.js';
import { OwnUsual } from './modules/own-metrics/usual.js';
import { watchedQueries } from './modules/own-metrics/watched.js';
import { setExtraQueries } from './modules/anomaly/keys.js';
import { AlertWorker } from './modules/alerts/worker.js';
import { runApiTokenJobs, TOKEN_JOBS_EVERY_MS } from './modules/api-tokens/jobs.js';
import { EntitlementsService } from './modules/entitlements/service.js';
import { metricsClient } from './modules/entitlements/metrics.js';
import { recordUsage, USAGE_EVERY_MS } from './modules/entitlements/usage.js';
import { LIMIT_MAIL_EVERY_MS, sendLimitEmails } from './modules/entitlements/limit-mail.js';
import type { WorkerTask } from './modules/alerts/worker.js';
import { FunnelRecorder } from './modules/funnel/recorder.js';
import { DAY7_EVERY_MS, recordDay7Active } from './modules/funnel/day7.js';
import { LIFECYCLE_EVERY_MS, sendLifecycleEmails } from './modules/lifecycle/job.js';
import {
  EGRESS_BACKFILL_EVERY_MS,
  EGRESS_FORGET_EVERY_MS,
  EGRESS_MINUTE_EVERY_MS,
  runEgressBackfill,
  runEgressForget,
  runEgressMinute,
  type EgressDeps,
} from './modules/egress/inventory.js';
import {
  DATA_RIGHTS_EVERY_MS,
  runDeletions,
  runInactivity,
} from './modules/data-rights/service.js';

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
setEgressLearningDays(config.egressLearningDays);
try {
  await checkSecretKey(systemDb, config.secretKey);
} catch (err) {
  log.error(`watchlog alert-worker cannot start: ${(err as Error).message}`);
  process.exit(1);
}
// Cloud: users' Slack and webhook URLs go through the egress policy again at send time,
// connecting only to an address that passed (ADR-181).
const http = new HttpClient(config.proxy, cloud ? new EgressPolicy() : null);
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
// Cloud's funnel (ADR-179): the first notification, a Telegram chat connected, day7_active.
const funnel = cloud ? new FunnelRecorder(db, log) : null;
const victoria = metricsClient(config, entitlements, log);
// Anomaly alerts (ADR-200): only orgs with What changed (Pro in Cloud, the demo's org) get the
// rule and its alerts; Community never. The keys that may alert come from the setting.
// Self-hosted Enterprise (ADR-232): a licence with `pro` turns What changed on for every org.
const license = new LicenseService({ config, db });
const whatChanged = (orgId: string) => hasWhatChanged(config, entitlements, orgId, license);
// Alerts on a user's own metrics (1.0.0, ADR-236): the org's limits (Free has none, the usual
// range is Pro's) and a watched metric's usual range, read here as the server reads them.
configureOwnAlerts({
  limits: ownLimitsProvider({ config, db, entitlements, license }),
  usual: new OwnUsual(victoria),
});
// What changed scores the watched own metrics with its own keys (ADR-238).
setExtraQueries(watchedQueries);
setAnomalyGate(whatChanged);
try {
  setAnomalyAlertKeys(parseAlertKeys(process.env.WATCHLOG_ANOMALY_ALERT_KEYS));
} catch (err) {
  log.error(`watchlog alert-worker cannot start: ${(err as Error).message}`);
  process.exit(1);
}
const cloudTasks: WorkerTask[] = funnel
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
      // The lifecycle emails (ADR-179): across orgs, each record written inside its org.
      {
        name: 'lifecycle-emails',
        everyMs: LIFECYCLE_EVERY_MS,
        run: async (now) => {
          await sendLifecycleEmails(
            {
              systemDb,
              db,
              secretKey: config.secretKey,
              from: config.lifecycleFrom,
              settings: () => settings.alerting(),
              log,
            },
            now,
          );
        },
      },
      // Data rights (ADR-181): deletions after their 7 days, then inactive Free orgs.
      {
        name: 'data-rights',
        everyMs: DATA_RIGHTS_EVERY_MS,
        run: async (now) => {
          const mail = {
            systemDb,
            settings: () => settings.alerting(),
            from: config.lifecycleFrom,
            log,
          };
          await runDeletions({ ...mail, victoria: victoria ?? undefined }, now);
          await runInactivity({ ...mail, invalidate: (id) => entitlements?.invalidate(id) }, now);
        },
      },
      {
        name: 'funnel-day7',
        everyMs: DAY7_EVERY_MS,
        run: async (now) => {
          await recordDay7Active({ systemDb, funnel }, now);
        },
      },
    ]
  : [];
// Egress watch's inventory (ADR-185, ADR-192), Community and Cloud: each org this worker's
// buckets hold, inside withOrg on the app connection; the metrics through clusterForOrg.
const egress: EgressDeps | null = victoria
  ? {
      db,
      victoria,
      orgs: async () =>
        (await systemDb.selectFrom('orgs').select('id').execute())
          .map((o) => o.id)
          .filter((id) => worker.holdsOrg(id)),
      log,
    }
  : null;
const egressTasks: WorkerTask[] = egress
  ? [
      {
        name: 'egress-minute',
        everyMs: EGRESS_MINUTE_EVERY_MS,
        run: (now) => runEgressMinute(egress, now),
      },
      {
        name: 'egress-backfill',
        everyMs: EGRESS_BACKFILL_EVERY_MS,
        run: (now) => runEgressBackfill(egress, now),
      },
      {
        name: 'egress-forget',
        everyMs: EGRESS_FORGET_EVERY_MS,
        run: (now) => runEgressForget(egress, now),
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
  // What changed around a firing alert (Pro): one line in its email (ADR-220).
  changes: workerChanges(reads),
  edition: config.edition,
  funnel,
};

// Enterprise modules (ADR-233): their alert rules and unit counts, in this process too.
const eeModules = await loadEeModules();
if (eeModules.length) {
  const host = eeHost(config, license, entitlements, log, {
    db,
    systemDb,
    secretKey: config.secretKey,
    victoria,
    notifier: null,
    eventsRetentionDays: config.eventsRetentionDays,
  });
  for (const m of eeModules) await m.worker?.(host);
  if (eeModules.some((m) => m.feature === 'network')) useNetworkEvidence();
  log.info({ modules: eeModules.map((m) => m.name) }, 'Enterprise modules loaded');
}

const worker = new AlertWorker({
  db,
  systemDb,
  databaseUrl: config.databaseSystemUrl,
  version: config.version,
  log,
  evaluators: lookupEvaluator,
  prepareOrg: async (orgId) => {
    await ensureDefaultRules(db, orgId);
    // Community without a licence key never reads an entitlement or writes the anomaly rule;
    // with one, the rule follows the licence (on while it works, off when it ends).
    if (cloud || config.demoMode || (await license.configured())) {
      await ensureAnomalyRule(db, orgId, await whatChanged(orgId));
    }
  },
  victoria,
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
        runApiTokenJobs(
          { db: systemDb, settings: () => settings.alerting(), log, edition: config.edition },
          now,
        ),
    },
    ...egressTasks,
    ...cloudTasks,
    // Self-hosted with a licence key (ADR-232): the units it counts, and the one reminder.
    ...(cloud
      ? []
      : [
          {
            name: 'license',
            everyMs: LICENSE_JOBS_EVERY_MS,
            run: async (now: number) => {
              await runLicenseJobs(
                { db, license, settings: () => settings.alerting(), log, edition: config.edition },
                now,
              );
            },
          },
        ]),
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
