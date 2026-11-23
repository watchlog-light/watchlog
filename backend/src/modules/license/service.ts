// SPDX-License-Identifier: AGPL-3.0-only
// The installation's Enterprise licence (ADR-232), self-hosted only. The key comes from the
// environment (WATCHLOG_LICENSE, or WATCHLOG_LICENSE_FILE read on each check, so a mounted
// Secret can be replaced in place) or from Settings → License (server_settings 'license',
// encrypted). The environment wins. Cloud never has one: its orgs use entitlements, and any
// key set there is ignored. Every process (the API, the alert-worker, the anomaly-worker)
// reads it the same way, cached for a few seconds, and nothing ever leaves the machine.
import { readFileSync } from 'node:fs';
import type { Config } from '../../config.js';
import { createDb, type Database } from '../../db/index.js';
import { decryptJson, encryptJson } from '../../lib/secrets.js';
import { grants, verifyLicense, type LicenseCheck } from '../../lib/license.js';

export type LicenseSource = 'env' | 'file' | 'setting' | 'none';

export interface CurrentLicense {
  source: LicenseSource;
  /** The check on the clock it was read at; null when there is no key. */
  check: LicenseCheck | null;
  /** A key is pasted in Settings while the environment's wins over it. */
  shadowed: boolean;
  /** The file in WATCHLOG_LICENSE_FILE can't be read: why. */
  fileError?: string;
}

/** What the core's gates read: the current licence, on a clock. */
export interface LicenseReader {
  current(): Promise<CurrentLicense>;
}

/**
 * Whether a key was pasted in Settings, read on a database URL alone (the anomaly-worker's
 * first look, before its configuration): false when the database can't be read.
 */
export async function storedLicenseExists(url: string | undefined): Promise<boolean> {
  if (!url) return false;
  const db = createDb(url);
  try {
    const row = await db
      .selectFrom('server_settings')
      .select('key')
      .where('key', '=', 'license')
      .executeTakeFirst();
    return !!row;
  } catch {
    return false;
  } finally {
    await db.destroy().catch(() => {});
  }
}

export const NO_LICENSE: CurrentLicense = { source: 'none', check: null, shadowed: false };

const CACHE_MS = 10_000;

export class LicenseService implements LicenseReader {
  private cache: { at: number; value: CurrentLicense } | null = null;

  constructor(
    private readonly deps: {
      config: Pick<Config, 'edition' | 'license' | 'secretKey'>;
      /** The installation's settings table (the owner's connection in Cloud, unused there). */
      db: Database;
      now?: () => number;
      /** Tests only: the public keys trusted instead of the built-in ones. */
      trusted?: readonly string[];
    },
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private check(key: string): LicenseCheck {
    return verifyLicense(key, {
      now: this.now(),
      ...(this.deps.trusted ? { trusted: this.deps.trusted } : {}),
    });
  }

  /** The key pasted in Settings, decrypted; null when none. */
  async storedKey(): Promise<string | null> {
    const row = await this.deps.db
      .selectFrom('server_settings')
      .select('secret')
      .where('key', '=', 'license')
      .executeTakeFirst();
    if (!row?.secret) return null;
    try {
      return decryptJson(this.deps.config.secretKey, row.secret).key ?? null;
    } catch {
      return null;
    }
  }

  async current(): Promise<CurrentLicense> {
    if (this.deps.config.edition === 'cloud') return NO_LICENSE;
    const at = this.now();
    if (this.cache && at - this.cache.at < CACHE_MS) return this.cache.value;
    const value = await this.read();
    this.cache = { at, value };
    return value;
  }

  private async read(): Promise<CurrentLicense> {
    const env = this.deps.config.license;
    const stored = await this.storedKey();
    if (env.key) return { source: 'env', check: this.check(env.key), shadowed: !!stored };
    if (env.file) {
      try {
        const text = readFileSync(env.file, 'utf8');
        return { source: 'file', check: this.check(text), shadowed: !!stored };
      } catch (err) {
        return {
          source: 'file',
          check: null,
          shadowed: !!stored,
          fileError: `${env.file}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`,
        };
      }
    }
    if (stored) return { source: 'setting', check: this.check(stored), shadowed: false };
    return NO_LICENSE;
  }

  /** Checks a pasted key on this installation's clock and trust list, without saving it. */
  test(key: string): LicenseCheck {
    return this.check(key);
  }

  async save(key: string, userId: string | null): Promise<void> {
    const secret = encryptJson(this.deps.config.secretKey, { key: key.trim() });
    await this.deps.db
      .insertInto('server_settings')
      .values({ key: 'license', value: JSON.stringify({}), secret, updated_by: userId })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet({
          value: JSON.stringify({}),
          secret,
          updated_by: userId,
          updated_at: new Date(),
        }),
      )
      .execute();
    this.cache = null;
  }

  async remove(): Promise<boolean> {
    const r = await this.deps.db
      .deleteFrom('server_settings')
      .where('key', '=', 'license')
      .executeTakeFirst();
    this.cache = null;
    return Number(r.numDeletedRows) > 0;
  }

  /** Whether the licence grants a feature now (active, and the key lists it). */
  async grants(feature: string): Promise<boolean> {
    return grants((await this.current()).check, feature);
  }

  /** Whether any key is configured (environment, file or setting), whatever its state. */
  async configured(): Promise<boolean> {
    return (await this.current()).source !== 'none';
  }

  clear(): void {
    this.cache = null;
  }
}
