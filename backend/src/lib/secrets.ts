// SPDX-License-Identifier: AGPL-3.0-only
// Channel, SMTP and integration secrets with AES-256-GCM (ADR-079, ADR-133). Ciphertexts
// are `v1:<iv>:<data+tag>` in base64url. An integration's credential is bound to its row
// with associated data, so a ciphertext copied to another row doesn't decrypt. During a
// key rotation the previous key (WATCHLOG_SECRET_KEY_PREVIOUS) still decrypts.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Database } from '../db/index.js';

const VERSION = 'v1';
const CANARY = 'watchlog-secret-key-check';

export class SecretKeyError extends Error {}

/** Parses WATCHLOG_SECRET_KEY: 32 bytes as base64 (44 characters) or hex (64). */
export function parseSecretKey(value: string | undefined): Buffer {
  if (value === undefined) {
    throw new SecretKeyError(
      'WATCHLOG_SECRET_KEY is not set. It encrypts alert channel secrets; create one with ' +
        '`openssl rand -base64 32` and keep a backup of it.',
    );
  }
  const v = value.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(v)
    ? Buffer.from(v, 'hex')
    : /^[A-Za-z0-9+/_-]{43}=?$/.test(v)
      ? Buffer.from(v, 'base64')
      : null;
  if (!key || key.length !== 32) {
    throw new SecretKeyError(
      'WATCHLOG_SECRET_KEY is malformed: expected 32 bytes as base64 (`openssl rand -base64 32`) or 64 hex characters.',
    );
  }
  return key;
}

/** Keys that still decrypt during a rotation (ADR-133); set once at start. */
let previousKeys: Buffer[] = [];
export function usePreviousSecretKey(key: Buffer | undefined): void {
  previousKeys = key ? [key] : [];
}

export function encryptSecret(key: Buffer, plaintext: string, aad?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `${VERSION}:${iv.toString('base64url')}:${data.toString('base64url')}`;
}

function decryptWith(key: Buffer, ciphertext: string, aad: string | undefined): string {
  const [version, iv, data] = ciphertext.split(':');
  if (version !== VERSION || !iv || !data) throw new SecretKeyError('unknown secret format');
  const raw = Buffer.from(data, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  try {
    return Buffer.concat([
      decipher.update(raw.subarray(0, raw.length - 16)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new SecretKeyError('secret cannot be decrypted with this key');
  }
}

/** Decrypts with the key, or with the previous one during a rotation. */
export function decryptSecret(key: Buffer, ciphertext: string, aad?: string): string {
  try {
    return decryptWith(key, ciphertext, aad);
  } catch (err) {
    for (const k of previousKeys) {
      try {
        return decryptWith(k, ciphertext, aad);
      } catch {
        // the next one
      }
    }
    throw err;
  }
}

export function encryptJson(key: Buffer, value: Record<string, string>): string {
  return encryptSecret(key, JSON.stringify(value));
}

export function decryptJson(key: Buffer, ciphertext: string): Record<string, string> {
  return JSON.parse(decryptSecret(key, ciphertext)) as Record<string, string>;
}

/**
 * Refuses a key that cannot decrypt what is stored (ADR-079): the canary written on the
 * first start, or, before there is one, every stored channel secret. Writes the canary
 * when the key is good and none exists yet.
 */
export async function checkSecretKey(db: Database, key: Buffer): Promise<void> {
  const wrongKey = () =>
    new SecretKeyError(
      'WATCHLOG_SECRET_KEY cannot decrypt the secrets stored in this database. Start with ' +
        'the key this installation was set up with (restore it from your backup); a new ' +
        'key cannot read existing alert channel secrets.',
    );
  const check = await db.selectFrom('secret_key_check').select('canary').executeTakeFirst();
  if (check) {
    // decryptSecret also tries the previous key: a rolling restart during a rotation.
    try {
      if (decryptSecret(key, check.canary) === CANARY) return;
    } catch {
      // falls through
    }
    throw wrongKey();
  }
  const stored = await db
    .selectFrom('alert_channels')
    .select('secret')
    .where('secret', 'is not', null)
    .execute();
  for (const { secret } of stored) {
    try {
      decryptSecret(key, secret!);
    } catch {
      throw wrongKey();
    }
  }
  await db
    .insertInto('secret_key_check')
    .values({ id: 1, canary: encryptSecret(key, CANARY) })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  // Another process may have written the canary first with a different key.
  const written = await db
    .selectFrom('secret_key_check')
    .select('canary')
    .executeTakeFirstOrThrow();
  try {
    if (decryptSecret(key, written.canary) === CANARY) return;
  } catch {
    // falls through
  }
  throw wrongKey();
}

/**
 * Re-encrypts every stored secret from the old key to the new one in one transaction,
 * then the canary (ADR-133, `backend rotate-secret-key`). Returns how many it moved.
 */
export async function rotateSecretKey(
  db: Database,
  oldKey: Buffer,
  newKey: Buffer,
): Promise<{
  channels: number;
  settings: number;
  integrations: number;
  probes: number;
  totp: number;
}> {
  const move = (ct: string, aad?: string) =>
    encryptSecret(newKey, decryptWith(oldKey, ct, aad), aad);
  return db.transaction().execute(async (trx) => {
    const check = await trx.selectFrom('secret_key_check').select('canary').executeTakeFirst();
    if (check) {
      let ok: boolean;
      try {
        ok = decryptWith(oldKey, check.canary, undefined) === CANARY;
      } catch {
        ok = false;
      }
      if (!ok) {
        throw new SecretKeyError(
          'The old key (WATCHLOG_SECRET_KEY_PREVIOUS) is not the key this database was set up with.',
        );
      }
    }
    const channels = await trx
      .selectFrom('alert_channels')
      .select(['id', 'secret'])
      .where('secret', 'is not', null)
      .execute();
    for (const c of channels) {
      await trx
        .updateTable('alert_channels')
        .set({ secret: move(c.secret!) })
        .where('id', '=', c.id)
        .execute();
    }
    const settings = await trx
      .selectFrom('server_settings')
      .select(['key', 'secret'])
      .where('secret', 'is not', null)
      .execute();
    for (const s of settings) {
      await trx
        .updateTable('server_settings')
        .set({ secret: move(s.secret!) })
        .where('key', '=', s.key)
        .execute();
    }
    const creds = await trx
      .selectFrom('integration_credentials')
      .select(['integration_id', 'ciphertext'])
      .where('ciphertext', 'is not', null)
      .execute();
    for (const c of creds) {
      await trx
        .updateTable('integration_credentials')
        .set({ ciphertext: move(c.ciphertext!, c.integration_id) })
        .where('integration_id', '=', c.integration_id)
        .execute();
    }
    const probes = await trx
      .selectFrom('integration_probes')
      .select(['id', 'ciphertext'])
      .where('ciphertext', 'is not', null)
      .execute();
    for (const p of probes) {
      await trx
        .updateTable('integration_probes')
        .set({ ciphertext: move(p.ciphertext!, p.id) })
        .where('id', '=', p.id)
        .execute();
    }
    // Cloud's TOTP secrets (ADR-175), bound to their user.
    const totp = await trx
      .selectFrom('users')
      .select(['id', 'totp_secret'])
      .where('totp_secret', 'is not', null)
      .execute();
    for (const u of totp) {
      await trx
        .updateTable('users')
        .set({ totp_secret: move(u.totp_secret!, `totp:${u.id}`) })
        .where('id', '=', u.id)
        .execute();
    }
    await trx
      .insertInto('secret_key_check')
      .values({ id: 1, canary: encryptSecret(newKey, CANARY) })
      .onConflict((oc) => oc.column('id').doUpdateSet({ canary: encryptSecret(newKey, CANARY) }))
      .execute();
    return {
      channels: channels.length,
      settings: settings.length,
      integrations: creds.length,
      probes: probes.length,
      totp: totp.length,
    };
  });
}
