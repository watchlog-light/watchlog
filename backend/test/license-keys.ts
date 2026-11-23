// SPDX-License-Identifier: AGPL-3.0-only
// Licence keys for tests (ADR-232): a generated Ed25519 pair, never WatchLog's own, and keys
// signed with it on a given clock.
import {
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';

export const DAY = 86_400_000;

export function testKeyPair(): { privateKey: KeyObject; x: string } {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, x: createPublicKey(privateKey).export({ format: 'jwk' }).x! };
}

export const TEST_KEYS = testKeyPair();

export function licenseKey(
  now: number,
  over: Record<string, unknown> = {},
  k: KeyObject = TEST_KEYS.privateKey,
): string {
  const p = {
    v: 1,
    id: randomUUID(),
    customer: 'Acme',
    edition: 'enterprise',
    units: 50,
    features: ['pro', 'network'],
    issuedAt: new Date(now - 30 * DAY).toISOString(),
    expiresAt: new Date(now + 300 * DAY).toISOString(),
    ...over,
  };
  const bytes = Buffer.from(JSON.stringify(p));
  return `wl1.${bytes.toString('base64url')}.${sign(null, bytes, k).toString('base64url')}`;
}
