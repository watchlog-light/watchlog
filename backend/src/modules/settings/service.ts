// SPDX-License-Identifier: AGPL-3.0-only
// Settings made in the UI for this installation (alerts redesign, ADR-093): the public
// address, the email server and Telegram's proxy. An environment variable always wins;
// the UI then shows the value read-only. Readers get the effective values through a
// short cache so the worker does not query them for every message.
import type { Config } from '../../config.js';
import type { Database } from '../../db/index.js';
import { decryptJson } from '../../lib/secrets.js';

export type SettingSource = 'env' | 'db' | 'none';

/** What senders need at send time (ADR-080, ADR-081). */
export interface AlertingSettings {
  publicUrl?: string;
  smtp?: { transport: string | Record<string, unknown>; from: string };
  telegramApiUrl: string;
  /** Outbound proxy for Telegram only (the environment's proxy applies to everything). */
  telegramProxy?: string;
}

export type SettingKey = 'general' | 'smtp' | 'telegram' | 'namespaces';

/** Namespaces hidden by default on the Workloads page and in the overview's tops. */
export const DEFAULT_SYSTEM_NAMESPACES = [
  'kube-system',
  'kube-public',
  'kube-node-lease',
  'local-path-storage',
];

/** The system-namespace list; `watchlog` also hides the namespaces WatchLog runs in. */
export interface NamespaceSettings {
  system: string[];
  watchlog: boolean;
}

/** The namespaces to treat as system ones: the list, plus WatchLog's when asked. */
export function systemNamespaces(s: NamespaceSettings, watchlogNamespaces: Iterable<string>) {
  const out = new Set(s.system);
  if (s.watchlog) for (const ns of watchlogNamespaces) out.add(ns);
  return out;
}

export type SmtpSecurity = 'starttls' | 'tls' | 'none';

/** The email server as the UI edits it; the password is stored apart, encrypted. */
export interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  from: string;
}

export interface SmtpView extends SmtpConfig {
  passwordSet: boolean;
  /** Last 4 characters of the stored password ("ends in …k2fa"); never the password. */
  passwordEnds: string | null;
  source: SettingSource;
}

/** nodemailer transport options for a server from the UI. */
export function smtpTransport(
  c: SmtpConfig,
  password: string | undefined,
): Record<string, unknown> {
  return {
    host: c.host,
    port: c.port,
    secure: c.security === 'tls',
    requireTLS: c.security === 'starttls',
    ignoreTLS: c.security === 'none',
    ...(c.username ? { auth: { user: c.username, pass: password ?? '' } } : {}),
  };
}

/** The parts of an SMTP URL from the environment, for the read-only view. */
function smtpFromUrl(url: string, from: string): SmtpView {
  const u = new URL(url);
  const tls = u.protocol === 'smtps:';
  return {
    host: u.hostname,
    port: Number(u.port || (tls ? 465 : 587)),
    security: tls ? 'tls' : 'starttls',
    username: decodeURIComponent(u.username),
    from,
    passwordSet: !!u.password,
    passwordEnds: null,
    source: 'env',
  };
}

const CACHE_MS = 10_000;

export class SettingsService {
  private cache: { at: number; value: AlertingSettings } | null = null;

  constructor(
    readonly db: Database,
    readonly config: Config,
  ) {}

  async row(key: SettingKey) {
    return this.db
      .selectFrom('server_settings')
      .selectAll()
      .where('key', '=', key)
      .executeTakeFirst();
  }

  async save(key: SettingKey, value: object, secret: string | null, userId: string | null) {
    await this.db
      .insertInto('server_settings')
      .values({ key, value: JSON.stringify(value), secret, updated_by: userId })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet({
          value: JSON.stringify(value),
          secret,
          updated_by: userId,
          updated_at: new Date(),
        }),
      )
      .execute();
    this.cache = null;
  }

  async remove(key: SettingKey) {
    await this.db.deleteFrom('server_settings').where('key', '=', key).execute();
    this.cache = null;
  }

  /** The public address and where it comes from. */
  async publicUrl(): Promise<{ value: string | null; source: SettingSource }> {
    if (this.config.publicUrl) return { value: this.config.publicUrl, source: 'env' };
    const row = await this.row('general');
    const v = (row?.value as { publicUrl?: string } | undefined)?.publicUrl;
    return v ? { value: v, source: 'db' } : { value: null, source: 'none' };
  }

  /** The email server and where it comes from; the password only as "set" and its end. */
  async smtp(): Promise<SmtpView | null> {
    if (this.config.smtp) return smtpFromUrl(this.config.smtp.url, this.config.smtp.from);
    const row = await this.row('smtp');
    if (!row) return null;
    const password = this.smtpPassword(row.secret);
    return {
      ...(row.value as unknown as SmtpConfig),
      passwordSet: !!password,
      passwordEnds: password ? password.slice(-4) : null,
      source: 'db',
    };
  }

  smtpPassword(secret: string | null): string | undefined {
    return secret ? decryptJson(this.config.secretKey, secret).password : undefined;
  }

  /** Telegram's outbound proxy and where it comes from (the environment's applies to all). */
  async telegram(): Promise<{ proxyUrl: string | null; source: SettingSource }> {
    const env = this.config.proxy.https ?? this.config.proxy.http;
    if (env) return { proxyUrl: env, source: 'env' };
    const row = await this.row('telegram');
    const v = (row?.value as { proxyUrl?: string } | undefined)?.proxyUrl;
    return v ? { proxyUrl: v, source: 'db' } : { proxyUrl: null, source: 'none' };
  }

  /** The system-namespace list; the default until it is changed in Settings. */
  async namespaces(): Promise<NamespaceSettings & { isDefault: boolean }> {
    const v = (await this.row('namespaces'))?.value as Partial<NamespaceSettings> | undefined;
    return {
      system: Array.isArray(v?.system) ? v.system : DEFAULT_SYSTEM_NAMESPACES,
      watchlog: v?.watchlog ?? true,
      isDefault: !v,
    };
  }

  /** The values senders use now (cached for 10 s, cleared on every change). */
  async alerting(now = Date.now()): Promise<AlertingSettings> {
    if (this.cache && now - this.cache.at < CACHE_MS) return this.cache.value;
    const value: AlertingSettings = {
      publicUrl: (await this.publicUrl()).value ?? undefined,
      smtp: await this.smtpTransport(),
      telegramApiUrl: this.config.telegramApiUrl,
    };
    // The environment's proxy is already in the HTTP client; a proxy from Settings is
    // used for Telegram's calls only.
    const tg = await this.telegram();
    if (tg.source === 'db' && tg.proxyUrl) value.telegramProxy = tg.proxyUrl;
    this.cache = { at: now, value };
    return value;
  }

  private async smtpTransport(): Promise<AlertingSettings['smtp']> {
    if (this.config.smtp) return { transport: this.config.smtp.url, from: this.config.smtp.from };
    const row = await this.row('smtp');
    if (!row) return undefined;
    const c = row.value as unknown as SmtpConfig;
    return { transport: smtpTransport(c, this.smtpPassword(row.secret)), from: c.from };
  }
}
