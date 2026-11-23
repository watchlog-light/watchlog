// SPDX-License-Identifier: AGPL-3.0-only
// WatchLog Enterprise licence keys, verified offline (ADR-232). A key is one line of text,
// `wl1.<payload>.<signature>`: the payload is base64url JSON, the signature base64url Ed25519
// over the payload's exact bytes. Nothing here touches the network, so a key works
// air-gapped. The keys WatchLog trusts are built in (TRUSTED_KEYS), a list so a key can be
// rotated; tests pass their own through `trusted`. No environment variable or setting adds a
// trusted key: that would let anyone sign their own licence.
import { createPublicKey, verify, type KeyObject } from 'node:crypto';

export const LICENSE_PREFIX = 'wl1';

/**
 * The public keys WatchLog's licences are signed with: the raw 32-byte Ed25519 keys,
 * base64url, newest first. Rotating: add the new key first, release, then issue with it.
 */
export const TRUSTED_KEYS: readonly string[] = [
  // 2026-11-24, the first signing key.
  'LIQ0PAKHy45unLVuEejafFfRIACwoyXeOM-LJaKzbsQ',
];

const DAY_MS = 86_400_000;
/** 30 days or fewer left: "expiring", with a banner and one email to Owners. */
export const EXPIRING_DAYS = 30;
/** After the end date, licensed features keep working this long ("grace"). */
export const GRACE_DAYS = 14;
/** An `issuedAt` further ahead than this is a wrong clock or a forged key: invalid. */
export const CLOCK_SKEW_MS = DAY_MS;

export type LicenseState = 'valid' | 'expiring' | 'grace' | 'expired' | 'invalid';

/** The fields WatchLog reads. Unknown fields are ignored, so later keys can add some. */
export interface LicensePayload {
  v: 1;
  id: string;
  customer: string;
  edition: 'enterprise';
  units: number;
  features: string[];
  issuedAt: string;
  expiresAt: string;
}

export interface LicenseCheck {
  state: LicenseState;
  /** Why, in a few words: "the signature doesn't match", "ended on 2027-12-31". */
  reason: string;
  /** The payload when the signature matched, even when expired; null when invalid. */
  payload: LicensePayload | null;
  /** When licensed features stop: the end date plus the grace days. */
  graceEndsAt: string | null;
}

/** Whether licensed features work in this state: valid, expiring or in grace. */
export const isActive = (s: LicenseState): boolean =>
  s === 'valid' || s === 'expiring' || s === 'grace';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64URL = /^[A-Za-z0-9_-]+$/;

const keyCache = new Map<string, KeyObject | null>();
function publicKey(x: string): KeyObject | null {
  if (!keyCache.has(x)) {
    try {
      keyCache.set(x, createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' }));
    } catch {
      keyCache.set(x, null);
    }
  }
  return keyCache.get(x)!;
}

const invalid = (reason: string): LicenseCheck => ({
  state: 'invalid',
  reason,
  payload: null,
  graceEndsAt: null,
});

/** The payload's fields, checked; a reason when one is missing or wrong. */
function readPayload(raw: unknown): LicensePayload | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'the payload is not an object';
  const p = raw as Record<string, unknown>;
  if (p.v !== 1) return `version ${JSON.stringify(p.v ?? null)} is not supported`;
  if (typeof p.id !== 'string' || !UUID.test(p.id)) return 'the id is missing or not a UUID';
  if (typeof p.customer !== 'string' || !p.customer.trim()) return 'the customer is missing';
  if (p.edition !== 'enterprise') return 'the edition is not enterprise';
  if (typeof p.units !== 'number' || !Number.isInteger(p.units) || p.units < 0) {
    return 'units is not a whole number';
  }
  if (!Array.isArray(p.features) || p.features.some((f) => typeof f !== 'string')) {
    return 'features is not a list of names';
  }
  for (const f of ['issuedAt', 'expiresAt'] as const) {
    if (typeof p[f] !== 'string' || Number.isNaN(Date.parse(p[f]))) return `${f} is not a date`;
  }
  return {
    v: 1,
    id: p.id,
    customer: p.customer.trim(),
    edition: 'enterprise',
    units: p.units,
    features: [...new Set(p.features as string[])],
    issuedAt: new Date(Date.parse(p.issuedAt as string)).toISOString(),
    expiresAt: new Date(Date.parse(p.expiresAt as string)).toISOString(),
  };
}

/**
 * Checks a key offline: the signature against the trusted keys, the fields, then the dates
 * on the given clock. `expiring`: 30 days or fewer left; `grace`: ended at most 14 days ago;
 * `expired` after that; `invalid` for anything else, with the reason.
 */
export function verifyLicense(
  key: string,
  opts: { now: number; trusted?: readonly string[] },
): LicenseCheck {
  const text = key.trim();
  const parts = text.split('.');
  if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX) {
    return invalid('not a WatchLog licence key (it starts with wl1.)');
  }
  const [, body, sig] = parts as [string, string, string];
  if (!B64URL.test(body) || !B64URL.test(sig)) return invalid('the key is damaged');
  const bytes = Buffer.from(body, 'base64url');
  const signature = Buffer.from(sig, 'base64url');
  const keys = (opts.trusted ?? TRUSTED_KEYS).map(publicKey).filter((k) => k !== null);
  const signed = signature.length === 64 && keys.some((k) => verify(null, bytes, k, signature));
  if (!signed) return invalid("the signature doesn't match a WatchLog key");
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    return invalid('the payload is not JSON');
  }
  const payload = readPayload(raw);
  if (typeof payload === 'string') return invalid(payload);
  const issued = Date.parse(payload.issuedAt);
  const ends = Date.parse(payload.expiresAt);
  if (issued > opts.now + CLOCK_SKEW_MS) {
    return invalid(`issued on ${payload.issuedAt.slice(0, 10)}, after today: check the clock`);
  }
  if (ends <= issued) return invalid('it ends before it starts');
  const graceEnds = ends + GRACE_DAYS * DAY_MS;
  const base = { payload, graceEndsAt: new Date(graceEnds).toISOString() };
  const day = payload.expiresAt.slice(0, 10);
  if (opts.now > graceEnds) return { state: 'expired', reason: `ended on ${day}`, ...base };
  if (opts.now > ends) return { state: 'grace', reason: `ended on ${day}`, ...base };
  if (ends - opts.now <= EXPIRING_DAYS * DAY_MS) {
    return { state: 'expiring', reason: `ends on ${day}`, ...base };
  }
  return { state: 'valid', reason: `valid until ${day}`, ...base };
}

/** Whether a check grants a feature now: active, and the key lists it. */
export const grants = (c: LicenseCheck | null, feature: string): boolean =>
  !!c?.payload && isActive(c.state) && c.payload.features.includes(feature);
