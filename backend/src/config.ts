// SPDX-License-Identifier: AGPL-3.0-only
import { parseSecretKey } from './lib/secrets.js';
import {
  DEFAULT_TRUSTED_PROXIES,
  parseTrustedProxies,
  type CookieSecure,
} from './plugins/client-ip.js';

export interface Config {
  host: string;
  port: number;
  logLevel: string;
  version: string;
  isDevelopment: boolean;
  databaseUrl: string;
  /** Public origin of the web app (e.g. https://watchlog.example.com); optional. */
  publicUrl?: string;
  /** Trust X-Forwarded-* headers from a reverse proxy. */
  trustProxy: boolean;
  /** VictoriaMetrics base URL; ingest answers 503 when unset. */
  victoriaMetricsUrl?: string;
  /** Base URL agents push to; defaults to publicUrl, then the request origin. */
  ingestUrl?: string;
  /** Agent image used in install commands (default: ghcr.io/watchlog-light/agent:<version|latest>). */
  agentImage?: string;
  /** Headless admin bootstrap (ADR-032). */
  adminEmail?: string;
  adminPassword?: string;
  /** Days of Kubernetes events kept (ADR-061; Community 15). */
  eventsRetentionDays: number;
  /** Kubernetes cluster created with this token at start (Helm chart, ADR-069). */
  bootstrapCluster?: { name: string; token: string };
  /** Days resolved alerts and sent notifications are kept (ADR-087). */
  alertRetentionDays: number;
  /** Port of the alert-worker's /livez and /readyz (ADR-088). */
  workerPort: number;
  /** AES-256-GCM key for alert channel secrets (ADR-079). */
  secretKey: Buffer;
  /** One SMTP server for email channels (ADR-080); email channels fail without it. */
  smtp?: { url: string; from: string };
  /** Telegram Bot API base URL (ADR-080). */
  telegramApiUrl: string;
  /** Outbound proxy for channel deliveries (HTTPS_PROXY / HTTP_PROXY / NO_PROXY). */
  proxy: { http?: string; https?: string; no?: string };
  /** Read-only public demo (ADR-122): passwordless viewer sessions, every change refused. */
  demoMode: boolean;
  /** Timeout of one VictoriaMetrics query from the API, in ms (10 s in demo mode). */
  queryTimeoutMs: number;
  /** A header a trusted proxy sets to the visitor's address, e.g. X-Real-IP (rate limits). */
  clientIpHeader?: string;
  /** Peers whose client-IP header and X-Forwarded-Proto are believed (CIDRs, ADR-123). */
  trustedProxies: string[];
  /** The session cookie's Secure attribute: per request (auto), always or never. */
  cookieSecure: CookieSecure;
  /** Alert rules applied once at start (WATCHLOG_SEED_FILE, ADR-122). */
  seedFile?: string;
}

const DEV_DATABASE_URL = 'postgres://watchlog:watchlog@127.0.0.1:54320/watchlog';
const DEV_VICTORIAMETRICS_URL = 'http://127.0.0.1:8428';
/** Published development key ("watchlog-dev-key-not-secret-32b!"); never used outside NODE_ENV=development. */
export const DEV_SECRET_KEY = 'd2F0Y2hsb2ctZGV2LWtleS1ub3Qtc2VjcmV0LTMyYiE=';
const DEV_SMTP_URL = 'smtp://127.0.0.1:1025';

/** DATABASE_URL alone, for `migrate`, which needs no other setting (and no secret key). */
export function loadDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL || (env.NODE_ENV === 'development' ? DEV_DATABASE_URL : undefined);
  if (!url) throw new Error('DATABASE_URL is required');
  return url;
}

export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): Config {
  // Compose passes unset variables as empty strings; treat them as unset.
  const env = Object.fromEntries(
    Object.entries(rawEnv).filter(([, v]) => v !== undefined && v !== ''),
  ) as NodeJS.ProcessEnv;
  const port = Number(env.PORT ?? 4080);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }
  const isDevelopment = env.NODE_ENV === 'development';
  const databaseUrl = env.DATABASE_URL ?? (isDevelopment ? DEV_DATABASE_URL : undefined);
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  for (const name of [
    'WATCHLOG_PUBLIC_URL',
    'WATCHLOG_INGEST_URL',
    'VICTORIAMETRICS_URL',
    'WATCHLOG_SMTP_URL',
    'WATCHLOG_TELEGRAM_API_URL',
  ] as const) {
    if (env[name] !== undefined && !URL.canParse(env[name])) {
      throw new Error(`Invalid ${name}: ${env[name]}`);
    }
  }
  const eventsRetentionDays = Number(env.WATCHLOG_EVENTS_RETENTION_DAYS ?? 15);
  if (
    !Number.isInteger(eventsRetentionDays) ||
    eventsRetentionDays < 1 ||
    eventsRetentionDays > 400
  ) {
    throw new Error(
      `Invalid WATCHLOG_EVENTS_RETENTION_DAYS: ${env.WATCHLOG_EVENTS_RETENTION_DAYS}`,
    );
  }
  const alertRetentionDays = Number(env.WATCHLOG_ALERT_RETENTION_DAYS ?? 90);
  if (!Number.isInteger(alertRetentionDays) || alertRetentionDays < 1 || alertRetentionDays > 400) {
    throw new Error(`Invalid WATCHLOG_ALERT_RETENTION_DAYS: ${env.WATCHLOG_ALERT_RETENTION_DAYS}`);
  }
  const workerPort = Number(env.WATCHLOG_WORKER_PORT ?? 4081);
  if (!Number.isInteger(workerPort) || workerPort <= 0 || workerPort > 65535) {
    throw new Error(`Invalid WATCHLOG_WORKER_PORT: ${env.WATCHLOG_WORKER_PORT}`);
  }
  const secretKey = parseSecretKey(
    env.WATCHLOG_SECRET_KEY ?? (isDevelopment ? DEV_SECRET_KEY : undefined),
  );
  const smtpUrl = env.WATCHLOG_SMTP_URL ?? (isDevelopment ? DEV_SMTP_URL : undefined);
  const smtpFrom = env.WATCHLOG_SMTP_FROM ?? 'WatchLog <alerts@watchlog.local>';
  const demoMode = env.WATCHLOG_DEMO_MODE;
  if (demoMode !== undefined && demoMode !== 'true' && demoMode !== 'false') {
    throw new Error(`Invalid WATCHLOG_DEMO_MODE: ${demoMode} (expected true or false)`);
  }
  if (
    env.WATCHLOG_CLIENT_IP_HEADER !== undefined &&
    !/^[A-Za-z0-9-]{1,64}$/.test(env.WATCHLOG_CLIENT_IP_HEADER)
  ) {
    throw new Error(`Invalid WATCHLOG_CLIENT_IP_HEADER: ${env.WATCHLOG_CLIENT_IP_HEADER}`);
  }
  const trustedProxies = env.WATCHLOG_TRUSTED_PROXIES
    ? env.WATCHLOG_TRUSTED_PROXIES.split(',')
        .map((c) => c.trim())
        .filter(Boolean)
    : DEFAULT_TRUSTED_PROXIES;
  try {
    parseTrustedProxies(trustedProxies);
  } catch (err) {
    throw new Error(`Invalid WATCHLOG_TRUSTED_PROXIES: ${(err as Error).message}`, { cause: err });
  }
  const cookieSecure = env.WATCHLOG_COOKIE_SECURE ?? 'auto';
  if (cookieSecure !== 'auto' && cookieSecure !== 'always' && cookieSecure !== 'never') {
    throw new Error(`Invalid WATCHLOG_COOKIE_SECURE: ${cookieSecure} (auto, always or never)`);
  }
  const bootstrapToken = env.WATCHLOG_BOOTSTRAP_CLUSTER_TOKEN;
  if (bootstrapToken !== undefined && !/^wl_ct_[A-Za-z0-9_-]{43}$/.test(bootstrapToken)) {
    throw new Error('Invalid WATCHLOG_BOOTSTRAP_CLUSTER_TOKEN: expected wl_ct_ and 43 characters');
  }
  return {
    host: env.HOST ?? '127.0.0.1',
    port,
    logLevel: env.LOG_LEVEL ?? 'info',
    version: env.WATCHLOG_VERSION ?? '0.0.0-dev',
    isDevelopment,
    databaseUrl,
    publicUrl: env.WATCHLOG_PUBLIC_URL,
    trustProxy: env.WATCHLOG_TRUST_PROXY === 'true',
    ingestUrl: env.WATCHLOG_INGEST_URL,
    victoriaMetricsUrl:
      env.VICTORIAMETRICS_URL ?? (isDevelopment ? DEV_VICTORIAMETRICS_URL : undefined),
    agentImage: env.WATCHLOG_AGENT_IMAGE,
    adminEmail: env.WATCHLOG_ADMIN_EMAIL,
    adminPassword: env.WATCHLOG_ADMIN_PASSWORD,
    eventsRetentionDays,
    bootstrapCluster: bootstrapToken
      ? { name: env.WATCHLOG_BOOTSTRAP_CLUSTER_NAME ?? 'kubernetes', token: bootstrapToken }
      : undefined,
    alertRetentionDays,
    workerPort,
    secretKey,
    smtp: smtpUrl ? { url: smtpUrl, from: smtpFrom } : undefined,
    telegramApiUrl: env.WATCHLOG_TELEGRAM_API_URL ?? 'https://api.telegram.org',
    proxy: {
      http: env.HTTP_PROXY ?? env.http_proxy,
      https: env.HTTPS_PROXY ?? env.https_proxy,
      no: env.NO_PROXY ?? env.no_proxy,
    },
    demoMode: demoMode === 'true',
    clientIpHeader: env.WATCHLOG_CLIENT_IP_HEADER,
    trustedProxies,
    cookieSecure,
    queryTimeoutMs: demoMode === 'true' ? 10_000 : 15_000,
    seedFile: env.WATCHLOG_SEED_FILE,
  };
}
