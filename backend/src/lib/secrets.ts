// SPDX-License-Identifier: AGPL-3.0-only
// Channel secrets with AES-256-GCM (ADR-079). Ciphertexts are `v1:<iv>:<data+tag>` in
// base64url; the version names the key, so a later rotation can add `v2`.
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

export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `${VERSION}:${iv.toString('base64url')}:${data.toString('base64url')}`;
}

export function decryptSecret(key: Buffer, ciphertext: string): string {
  const [version, iv, data] = ciphertext.split(':');
  if (version !== VERSION || !iv || !data) throw new SecretKeyError('unknown secret format');
  const raw = Buffer.from(data, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
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
