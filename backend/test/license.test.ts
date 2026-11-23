// SPDX-License-Identifier: AGPL-3.0-only
// The licence key (ADR-232), offline, with generated keys and an injected clock.
import {
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { grants, isActive, TRUSTED_KEYS, verifyLicense } from '../src/lib/license.js';

const DAY = 86_400_000;
const NOW = Date.parse('2027-06-01T12:00:00Z');

function pair() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const x = createPublicKey(privateKey).export({ format: 'jwk' }).x!;
  return { privateKey, x };
}
const ours = pair();
const theirs = pair();

function payload(over: Record<string, unknown> = {}) {
  return {
    v: 1,
    id: randomUUID(),
    customer: 'Acme',
    edition: 'enterprise',
    units: 50,
    features: ['pro', 'network'],
    issuedAt: new Date(NOW - 100 * DAY).toISOString(),
    expiresAt: new Date(NOW + 200 * DAY).toISOString(),
    ...over,
  };
}
function keyOf(p: object, k: KeyObject = ours.privateKey) {
  const bytes = Buffer.from(JSON.stringify(p));
  return `wl1.${bytes.toString('base64url')}.${sign(null, bytes, k).toString('base64url')}`;
}
const check = (key: string, now = NOW) => verifyLicense(key, { now, trusted: [ours.x] });

describe('the licence key', () => {
  it('valid: the payload read, the grace end set', () => {
    const p = payload();
    const c = check(keyOf(p));
    expect(c.state).toBe('valid');
    expect(c.payload).toMatchObject({
      id: p.id,
      customer: 'Acme',
      units: 50,
      features: ['pro', 'network'],
    });
    expect(c.graceEndsAt).toBe(new Date(Date.parse(p.expiresAt) + 14 * DAY).toISOString());
    expect(isActive(c.state)).toBe(true);
    expect(grants(c, 'pro')).toBe(true);
    expect(grants(c, 'sso')).toBe(false);
  });

  it('a changed payload, a changed signature, or another key: invalid', () => {
    const key = keyOf(payload());
    const [w, body, sig] = key.split('.');
    const p = JSON.parse(Buffer.from(body!, 'base64url').toString());
    const more = Buffer.from(JSON.stringify({ ...p, units: 5000 })).toString('base64url');
    expect(check(`${w}.${more}.${sig}`)).toMatchObject({ state: 'invalid', payload: null });
    const s = Buffer.from(sig!, 'base64url');
    s[10] = s[10]! ^ 0xff;
    expect(check(`${w}.${body}.${s.toString('base64url')}`).state).toBe('invalid');
    const other = check(keyOf(payload(), theirs.privateKey));
    expect(other.state).toBe('invalid');
    expect(other.reason).toMatch(/signature/);
    // Trusted with their key, it is valid: the list decides, nothing else.
    expect(
      verifyLicense(keyOf(payload(), theirs.privateKey), { now: NOW, trusted: [ours.x, theirs.x] })
        .state,
    ).toBe('valid');
  });

  it('the built-in list trusts none of the test keys', () => {
    expect(TRUSTED_KEYS.length).toBeGreaterThan(0);
    expect(verifyLicense(keyOf(payload()), { now: NOW }).state).toBe('invalid');
  });

  it('expiring within 30 days, grace for 14 days after the end, then expired', () => {
    const ends = NOW + 30 * DAY;
    const key = keyOf(payload({ expiresAt: new Date(ends).toISOString() }));
    expect(check(key, ends - 31 * DAY).state).toBe('valid');
    expect(check(key, ends - 30 * DAY).state).toBe('expiring');
    expect(check(key, ends).state).toBe('expiring');
    const g = check(key, ends + 1);
    expect(g.state).toBe('grace');
    expect(g.reason).toMatch(/^ended on /);
    expect(grants(g, 'pro')).toBe(true);
    expect(check(key, ends + 14 * DAY).state).toBe('grace');
    const e = check(key, ends + 14 * DAY + 1);
    expect(e.state).toBe('expired');
    expect(e.payload?.customer).toBe('Acme');
    expect(grants(e, 'pro')).toBe(false);
  });

  it('issued more than a day ahead of the clock: invalid; a few hours: fine', () => {
    expect(
      check(keyOf(payload({ issuedAt: new Date(NOW + DAY + 60_000).toISOString() }))).state,
    ).toBe('invalid');
    expect(check(keyOf(payload({ issuedAt: new Date(NOW + 3_600_000).toISOString() }))).state).toBe(
      'valid',
    );
  });

  it('unknown fields are ignored; a version other than 1 is rejected', () => {
    const c = check(keyOf(payload({ seats: 9, region: 'eu', nested: { a: 1 } })));
    expect(c.state).toBe('valid');
    expect(Object.keys(c.payload!)).not.toContain('seats');
    for (const v of [2, 0, '1', null]) {
      const r = check(keyOf(payload({ v })));
      expect(r.state).toBe('invalid');
      expect(r.reason).toMatch(/version/);
    }
  });

  it('missing or wrong fields, and text that is not a key', () => {
    expect(check(keyOf(payload({ id: 'abc' }))).reason).toMatch(/id/);
    expect(check(keyOf(payload({ customer: ' ' }))).reason).toMatch(/customer/);
    expect(check(keyOf(payload({ edition: 'pro' }))).reason).toMatch(/edition/);
    expect(check(keyOf(payload({ units: 2.5 }))).reason).toMatch(/units/);
    expect(check(keyOf(payload({ features: 'pro' }))).reason).toMatch(/features/);
    expect(check(keyOf(payload({ expiresAt: 'soon' }))).reason).toMatch(/expiresAt/);
    expect(
      check(keyOf(payload({ expiresAt: new Date(NOW - 200 * DAY).toISOString() }))).reason,
    ).toMatch(/ends before/);
    for (const k of [
      '',
      'hello',
      'wl2.a.b',
      'wl1.a',
      'wl1.a!.b',
      `wl1.${'a'.repeat(10)}.${'b'.repeat(86)}`,
    ]) {
      expect(check(k).state).toBe('invalid');
    }
    // Whitespace around a pasted key is fine.
    expect(check(`  ${keyOf(payload())}\n`).state).toBe('valid');
  });
});
