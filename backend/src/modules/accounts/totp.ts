// SPDX-License-Identifier: AGPL-3.0-only
// TOTP two-factor authentication (ADR-175): RFC 6238 with otpauth, 30-second steps, one step
// either side accepted, and a step never accepted twice. The secret is stored with
// AES-256-GCM under WATCHLOG_SECRET_KEY, bound to the user's id (ADR-079). Ten single-use
// recovery codes are stored as SHA-256.
import { randomBytes } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { decryptSecret, encryptSecret } from '../../lib/secrets.js';
import { sha256 } from '../../lib/tokens.js';

export const TOTP_PERIOD = 30;
export const RECOVERY_CODES = 10;
const ISSUER = 'WatchLog';

/** The associated data that binds a user's encrypted secret to that user. */
export const totpAad = (userId: string) => `totp:${userId}`;

export function newTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

export function encryptTotpSecret(key: Buffer, userId: string, base32: string): string {
  return encryptSecret(key, base32, totpAad(userId));
}

export function decryptTotpSecret(key: Buffer, userId: string, ciphertext: string): string {
  return decryptSecret(key, ciphertext, totpAad(userId));
}

function totp(base32: string, label = 'account'): TOTP {
  return new TOTP({
    issuer: ISSUER,
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: TOTP_PERIOD,
    secret: Secret.fromBase32(base32),
  });
}

/** The otpauth:// URI an authenticator app reads from a QR code. */
export function totpUri(base32: string, email: string): string {
  return totp(base32, email).toString();
}

/** The code for a moment (tests and the tools that check this module). */
export function totpCode(base32: string, timestamp = Date.now()): string {
  return totp(base32).generate({ timestamp });
}

/** The step a valid code belongs to (±1 around now), or null when the code is wrong. */
export function totpStep(base32: string, code: string, timestamp = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const t = totp(base32);
  const delta = t.validate({ token: code, timestamp, window: 1 });
  if (delta === null) return null;
  return t.counter({ timestamp }) + delta;
}

/**
 * Accepts a code for a user with a confirmed secret: right for the current step ±1 and
 * newer than the last step accepted. Records the step, atomically, so the same code (or an
 * older one) can't be used again, also by a parallel request.
 */
export async function acceptTotp(
  db: Database,
  key: Buffer,
  user: { id: string; totp_secret: string | null },
  code: string,
  now = Date.now(),
): Promise<boolean> {
  if (!user.totp_secret) return false;
  const step = totpStep(decryptTotpSecret(key, user.id, user.totp_secret), code, now);
  if (step === null) return false;
  const claimed = await db
    .updateTable('users')
    .set({ totp_last_step: step })
    .where('id', '=', user.id)
    .where((eb) =>
      eb.or([eb('totp_last_step', 'is', null), eb('totp_last_step', '<', String(step))]),
    )
    .returning('id')
    .executeTakeFirst();
  return !!claimed;
}

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** A recovery code as shown: `xxxxx-xxxxx`, 10 characters from a 31-letter alphabet. */
function recoveryCode(): string {
  const bytes = randomBytes(10);
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

const normalise = (code: string) => code.trim().toLowerCase().replace(/[\s-]/g, '');

/** Replaces a user's recovery codes with 10 new ones and returns them (shown once). */
export async function newRecoveryCodes(db: Database, userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODES }, recoveryCode);
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('recovery_codes').where('user_id', '=', userId).execute();
    await trx
      .insertInto('recovery_codes')
      .values(codes.map((c) => ({ id: newId(), user_id: userId, code_hash: sha256(normalise(c)) })))
      .execute();
  });
  return codes;
}

/** Uses up one recovery code; false when it is wrong or used. */
export async function useRecoveryCode(db: Database, userId: string, code: string) {
  const n = normalise(code);
  if (!/^[a-z0-9]{10}$/.test(n)) return false;
  const used = await db
    .updateTable('recovery_codes')
    .set({ used_at: new Date() })
    .where('user_id', '=', userId)
    .where('code_hash', '=', sha256(n))
    .where('used_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  return !!used;
}

/** A TOTP code (6 digits) or a recovery code, whichever the user typed. */
export async function acceptSecondFactor(
  db: Database,
  key: Buffer,
  user: { id: string; totp_secret: string | null },
  code: string,
): Promise<'totp' | 'recovery' | null> {
  const c = code.trim().replace(/\s/g, '');
  if (/^\d{6}$/.test(c)) return (await acceptTotp(db, key, user, c)) ? 'totp' : null;
  return (await useRecoveryCode(db, user.id, c)) ? 'recovery' : null;
}

export async function recoveryCodesLeft(db: Database, userId: string): Promise<number> {
  const r = await db
    .selectFrom('recovery_codes')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('user_id', '=', userId)
    .where('used_at', 'is', null)
    .executeTakeFirstOrThrow();
  return Number(r.n);
}
