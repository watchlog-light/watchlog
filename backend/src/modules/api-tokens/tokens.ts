// SPDX-License-Identifier: AGPL-3.0-only
// Personal API tokens (ADR-125): `wl_pat_` + 256 random bits (base64url), shown once and
// stored as a SHA-256 hash with a short display prefix, as cluster tokens are (ADR-040).
// A random 256-bit value needs no slow hash.
import { isIP } from 'node:net';
import { sql, type RawBuilder } from 'kysely';
import { randomToken, sha256 } from '../../lib/tokens.js';

export const API_TOKEN_PREFIX = 'wl_pat_';
/** Characters of the random part kept for display: "wl_pat_7Kq2…". */
export const DISPLAY_CHARS = 4;
const TOKEN_PATTERN = /^wl_pat_[A-Za-z0-9_-]{43}$/;

export type ApiTokenScope = 'read';
export type ApiTokenStatus = 'active' | 'expires_soon' | 'never' | 'expired' | 'revoked';

/** At most this many active (not revoked, not expired) tokens per user. */
export const MAX_ACTIVE_API_TOKENS = 10;
/** The expiries offered at creation, in days; null is "never". */
export const EXPIRY_DAYS = [30, 90, 365] as const;
export const DEFAULT_EXPIRY_DAYS = 90;
/** A token expiring within this is "expires soon", and its owner gets one email. */
export const EXPIRES_SOON_MS = 7 * 86_400_000;
/** Expired and revoked tokens stay listed this long, then are deleted with their history. */
export const DEAD_TOKEN_KEPT_MS = 30 * 86_400_000;
/** last_used_* is written at most this often per token. */
export const LAST_USED_EVERY_MS = 60_000;
/** A token's history records at most this many new addresses after its first use. */
export const MAX_NEW_IP_EVENTS = 50;

export interface NewApiToken {
  /** The plaintext token; returned once and never stored or logged. */
  value: string;
  hash: Buffer;
  prefix: string;
}

export function generateApiToken(): NewApiToken {
  const value = `${API_TOKEN_PREFIX}${randomToken()}`;
  return { value, hash: sha256(value), prefix: displayPrefix(value) };
}

export function displayPrefix(value: string): string {
  return value.slice(0, API_TOKEN_PREFIX.length + DISPLAY_CHARS);
}

/** The shape of a personal API token; anything else is refused without a lookup. */
export function isApiTokenFormat(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export function tokenStatus(
  t: { revoked_at: Date | null; expires_at: Date | null },
  now: Date,
): ApiTokenStatus {
  if (t.revoked_at) return 'revoked';
  if (!t.expires_at) return 'never';
  const left = t.expires_at.getTime() - now.getTime();
  if (left <= 0) return 'expired';
  return left <= EXPIRES_SOON_MS ? 'expires_soon' : 'active';
}

export const isDead = (status: ApiTokenStatus) => status === 'expired' || status === 'revoked';

/** An address PostgreSQL can store as inet, or null; an IPv4-mapped IPv6 address as IPv4. */
export function storableIp(address: string | undefined): string | null {
  if (!address) return null;
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : '';
  if (v4 && isIP(v4) === 4) return v4;
  return isIP(address) ? address : null;
}

/**
 * An inet column cut to its /24 (IPv4) or /48 (IPv6) network, as inet: what is kept of
 * an address once its token is expired or revoked ("203.0.113.0/24").
 */
export function shortIp(column: string): RawBuilder<string | null> {
  const ref = sql.ref(column);
  return sql<string | null>`CASE WHEN ${ref} IS NULL THEN NULL
    WHEN family(${ref}) = 4 THEN network(set_masklen(${ref}, least(masklen(${ref}), 24)))::inet
    ELSE network(set_masklen(${ref}, least(masklen(${ref}), 48)))::inet END`;
}
