// SPDX-License-Identifier: AGPL-3.0-only
import { parseSecretKey } from './lib/secrets.js';
import {
  DEFAULT_TRUSTED_PROXIES,
  parseTrustedProxies,
  type CookieSecure,
} from './plugins/client-ip.js';

/** Community (the default, 0.5.0's behaviour) or Cloud (ADR-173). */
export type Edition = 'community' | 'cloud';

export interface Config {
  /**
   * WATCHLOG_EDITION (ADR-173): `cloud` turns on every Cloud-only path; unset or `community`
   * keeps the product exactly as 0.5.0.
   */
  edition: Edition;
  host: string;
  port: number;
  logLevel: string;
  version: string;
  isDevelopment: boolean;
  databaseUrl: string;
  /**
   * The owner's connection (ADR-174), for migrations and the allow-listed `systemDb`. Cloud
   * reads it from DATABASE_SYSTEM_URL, and DATABASE_URL is then `watchlog_app`, which can't
   * bypass Row-Level Security. Community: the same URL as databaseUrl.
   */
  databaseSystemUrl: string;
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
  /** AES-256-GCM key for alert channel, SMTP and integration secrets (ADR-079, ADR-133). */
  secretKey: Buffer;
  /** The key before a rotation, still accepted for decrypting (ADR-133). */
  previousSecretKey?: Buffer;
  /** One SMTP server for email channels (ADR-080); email channels fail without it. */
  smtp?: { url: string; from: string };
  /** Telegram Bot API base URL (ADR-080). */
  telegramApiUrl: string;
  /** Outbound proxy for channel deliveries (HTTPS_PROXY / HTTP_PROXY / NO_PROXY). */
  proxy: { http?: string; https?: string; no?: string };
  /** Read-only public demo (ADR-122): passwordless viewer sessions, every change refused. */
  demoMode: boolean;
  /**
   * Right-sizing (ADR-168): the window of use, in hours (7 days), and the history a container
   * needs before it is judged (24 hours). Shorter values are for tests.
   */
  rightSizing: { windowHours: number; minHistoryHours: number };
  /** Timeout of one VictoriaMetrics query from the API, in ms (10 s in demo mode). */
  queryTimeoutMs: number;
  /** A header a trusted proxy sets to the visitor's address, e.g. X-Real-IP (rate limits). */
  clientIpHeader?: string;
  /**
   * A header a trusted proxy sets to the visitor's country (Cloudflare's CF-IPCountry),
   * shown with an API token's last use. Unset: no country. There is no GeoIP lookup.
   */
  clientCountryHeader?: string;
  /** Peers whose client-IP header and X-Forwarded-Proto are believed (CIDRs, ADR-123). */
  trustedProxies: string[];
  /** The session cookie's Secure attribute: per request (auto), always or never. */
  cookieSecure: CookieSecure;
  /** Alert rules applied once at start (WATCHLOG_SEED_FILE, ADR-122). */
  seedFile?: string;
  /** The MCP server at /mcp (ADR-127); on by default, it needs an API token anyway. */
  mcpEnabled: boolean;
  /** Per API token and minute (ADR-125): REST requests, and MCP tool calls (v0.2 slice 4). */
  apiTokenLimits: { restPerMinute: number; mcpCallsPerMinute: number };
  /** Accounts in Cloud (ADR-175); read only with WATCHLOG_EDITION=cloud. */
  accounts: AccountsConfig;
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface AccountsConfig {
  /**
   * Cloudflare Turnstile: TURNSTILE_SITE_KEY for the pages, TURNSTILE_SECRET_KEY for the
   * server-side check. Without the secret the check is off (tests, development).
   */
  turnstile: { siteKey?: string; secretKey?: string };
  /** GitHub sign-in; off unless both the client id and secret are set. */
  github?: OAuthClient;
  /** Google sign-in; off unless both the client id and secret are set. */
  google?: OAuthClient;
  /** More disposable-email domains, one per line (WATCHLOG_DISPOSABLE_DOMAINS_FILE). */
  disposableDomainsFile?: string;
}

/** ADR-125's rate limits per API token; fixed by the decision, not by an environment variable. */
export const API_TOKEN_REST_PER_MINUTE = 300;
export const API_TOKEN_MCP_CALLS_PER_MINUTE = 60;

const DEV_DATABASE_URL = 'postgres://watchlog:watchlog@127.0.0.1:54320/watchlog';
const DEV_VICTORIAMETRICS_URL = 'http://127.0.0.1:8428';
/** Published development key ("watchlog-dev-key-not-secret-32b!"); never used outside NODE_ENV=development. */
export const DEV_SECRET_KEY = 'd2F0Y2hsb2ctZGV2LWtleS1ub3Qtc2VjcmV0LTMyYiE=';
const DEV_SMTP_URL = 'smtp://127.0.0.1:1025';

/**
 * The database URL alone, for `migrate`, which needs no other setting (and no secret key).
 * Migrations run as the owner: DATABASE_SYSTEM_URL in Cloud (ADR-174), DATABASE_URL otherwise.
 */
export function loadDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WATCHLOG_EDITION === 'cloud') {
    if (!env.DATABASE_SYSTEM_URL) {
      throw new Error('DATABASE_SYSTEM_URL is required with WATCHLOG_EDITION=cloud');
    }
    return env.DATABASE_SYSTEM_URL;
  }
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
  const edition = env.WATCHLOG_EDITION ?? 'community';
  if (edition !== 'community' && edition !== 'cloud') {
    throw new Error(`Invalid WATCHLOG_EDITION: ${edition} (expected community or cloud)`);
  }
  // Cloud: the request path runs as watchlog_app and only systemDb as the owner (ADR-174).
  // Community never needs a second role: both are DATABASE_URL.
  const databaseSystemUrl = edition === 'cloud' ? env.DATABASE_SYSTEM_URL : databaseUrl;
  if (!databaseSystemUrl) {
    throw new Error(
      'DATABASE_SYSTEM_URL is required with WATCHLOG_EDITION=cloud (the database owner; DATABASE_URL is watchlog_app)',
    );
  }
  if (edition === 'cloud' && databaseSystemUrl === databaseUrl) {
    throw new Error(
      'With WATCHLOG_EDITION=cloud, DATABASE_URL must be the watchlog_app role, not DATABASE_SYSTEM_URL',
    );
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
  const rsWindow = Number(env.WATCHLOG_RIGHT_SIZING_WINDOW_HOURS ?? 168);
  if (!Number.isInteger(rsWindow) || rsWindow < 1 || rsWindow > 720) {
    throw new Error(
      `Invalid WATCHLOG_RIGHT_SIZING_WINDOW_HOURS: ${env.WATCHLOG_RIGHT_SIZING_WINDOW_HOURS}`,
    );
  }
  const rsMin = Number(env.WATCHLOG_RIGHT_SIZING_MIN_HOURS ?? Math.min(24, rsWindow));
  if (!Number.isFinite(rsMin) || rsMin < 0 || rsMin > rsWindow) {
    throw new Error(
      `Invalid WATCHLOG_RIGHT_SIZING_MIN_HOURS: ${env.WATCHLOG_RIGHT_SIZING_MIN_HOURS}`,
    );
  }
  const workerPort = Number(env.WATCHLOG_WORKER_PORT ?? 4081);
  if (!Number.isInteger(workerPort) || workerPort <= 0 || workerPort > 65535) {
    throw new Error(`Invalid WATCHLOG_WORKER_PORT: ${env.WATCHLOG_WORKER_PORT}`);
  }
  const secretKey = parseSecretKey(
    env.WATCHLOG_SECRET_KEY ?? (isDevelopment ? DEV_SECRET_KEY : undefined),
  );
  const previousSecretKey = env.WATCHLOG_SECRET_KEY_PREVIOUS
    ? parseSecretKey(env.WATCHLOG_SECRET_KEY_PREVIOUS)
    : undefined;
  const smtpUrl = env.WATCHLOG_SMTP_URL ?? (isDevelopment ? DEV_SMTP_URL : undefined);
  const smtpFrom = env.WATCHLOG_SMTP_FROM ?? 'WatchLog <alerts@watchlog.local>';
  const demoMode = env.WATCHLOG_DEMO_MODE;
  if (demoMode !== undefined && demoMode !== 'true' && demoMode !== 'false') {
    throw new Error(`Invalid WATCHLOG_DEMO_MODE: ${demoMode} (expected true or false)`);
  }
  const mcpEnabled = env.WATCHLOG_MCP_ENABLED;
  if (mcpEnabled !== undefined && mcpEnabled !== 'true' && mcpEnabled !== 'false') {
    throw new Error(`Invalid WATCHLOG_MCP_ENABLED: ${mcpEnabled} (expected true or false)`);
  }
  if (
    env.WATCHLOG_CLIENT_IP_HEADER !== undefined &&
    !/^[A-Za-z0-9-]{1,64}$/.test(env.WATCHLOG_CLIENT_IP_HEADER)
  ) {
    throw new Error(`Invalid WATCHLOG_CLIENT_IP_HEADER: ${env.WATCHLOG_CLIENT_IP_HEADER}`);
  }
  if (
    env.WATCHLOG_CLIENT_COUNTRY_HEADER !== undefined &&
    !/^[A-Za-z0-9-]{1,64}$/.test(env.WATCHLOG_CLIENT_COUNTRY_HEADER)
  ) {
    throw new Error(
      `Invalid WATCHLOG_CLIENT_COUNTRY_HEADER: ${env.WATCHLOG_CLIENT_COUNTRY_HEADER}`,
    );
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
  // Cloud: the session cookie is always Secure (ADR-175).
  const cookieSecure = env.WATCHLOG_COOKIE_SECURE ?? (edition === 'cloud' ? 'always' : 'auto');
  if (cookieSecure !== 'auto' && cookieSecure !== 'always' && cookieSecure !== 'never') {
    throw new Error(`Invalid WATCHLOG_COOKIE_SECURE: ${cookieSecure} (auto, always or never)`);
  }
  if (edition === 'cloud' && cookieSecure !== 'always') {
    throw new Error(
      'With WATCHLOG_EDITION=cloud the session cookie is always Secure: unset WATCHLOG_COOKIE_SECURE',
    );
  }
  const oauthClient = (name: 'GITHUB' | 'GOOGLE') => {
    const clientId = env[`WATCHLOG_${name}_CLIENT_ID`];
    const clientSecret = env[`WATCHLOG_${name}_CLIENT_SECRET`];
    if (!clientId !== !clientSecret) {
      throw new Error(
        `WATCHLOG_${name}_CLIENT_ID and WATCHLOG_${name}_CLIENT_SECRET are set together, or neither`,
      );
    }
    return clientId && clientSecret ? { clientId, clientSecret } : undefined;
  };
  const bootstrapToken = env.WATCHLOG_BOOTSTRAP_CLUSTER_TOKEN;
  if (bootstrapToken !== undefined && !/^wl_ct_[A-Za-z0-9_-]{43}$/.test(bootstrapToken)) {
    throw new Error('Invalid WATCHLOG_BOOTSTRAP_CLUSTER_TOKEN: expected wl_ct_ and 43 characters');
  }
  return {
    edition,
    host: env.HOST ?? '127.0.0.1',
    port,
    logLevel: env.LOG_LEVEL ?? 'info',
    version: env.WATCHLOG_VERSION ?? '0.0.0-dev',
    isDevelopment,
    databaseUrl,
    databaseSystemUrl,
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
    previousSecretKey,
    smtp: smtpUrl ? { url: smtpUrl, from: smtpFrom } : undefined,
    telegramApiUrl: env.WATCHLOG_TELEGRAM_API_URL ?? 'https://api.telegram.org',
    proxy: {
      http: env.HTTP_PROXY ?? env.http_proxy,
      https: env.HTTPS_PROXY ?? env.https_proxy,
      no: env.NO_PROXY ?? env.no_proxy,
    },
    demoMode: demoMode === 'true',
    clientIpHeader: env.WATCHLOG_CLIENT_IP_HEADER,
    clientCountryHeader: env.WATCHLOG_CLIENT_COUNTRY_HEADER,
    trustedProxies,
    cookieSecure,
    rightSizing: { windowHours: rsWindow, minHistoryHours: rsMin },
    queryTimeoutMs: demoMode === 'true' ? 10_000 : 15_000,
    seedFile: env.WATCHLOG_SEED_FILE,
    mcpEnabled: mcpEnabled !== 'false',
    apiTokenLimits: {
      restPerMinute: API_TOKEN_REST_PER_MINUTE,
      mcpCallsPerMinute: API_TOKEN_MCP_CALLS_PER_MINUTE,
    },
    accounts: {
      turnstile: { siteKey: env.TURNSTILE_SITE_KEY, secretKey: env.TURNSTILE_SECRET_KEY },
      github: oauthClient('GITHUB'),
      google: oauthClient('GOOGLE'),
      disposableDomainsFile: env.WATCHLOG_DISPOSABLE_DOMAINS_FILE,
    },
  };
}
