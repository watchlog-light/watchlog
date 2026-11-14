// SPDX-License-Identifier: AGPL-3.0-only
// The checks around Cloud signup and the signed-out forms (ADR-175): Turnstile, the Have I
// Been Pwned range API, disposable email domains and the in-memory windows that limit
// signups per address and per email domain. Outbound calls go through `fetch`, which the
// tests replace; none of them can reach the real services.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { STATUS_CODES } from 'node:http';
import type { FastifyBaseLogger, FastifyReply } from 'fastify';
import { PROBLEM_CONTENT_TYPE } from '../../lib/problem.js';

export type Fetch = typeof fetch;

export const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const HIBP_URL = 'https://api.pwnedpasswords.com/range/';
const HIBP_TIMEOUT_MS = 2_000;
const TURNSTILE_TIMEOUT_MS = 5_000;

/** Error words the pages branch on (`code` and `type` of the problem body). */
export type AccountErrorCode =
  | 'turnstile-failed'
  | 'password-breached'
  | 'email-disposable'
  | 'rate-limited'
  | 'invalid-credentials'
  | 'invalid-token'
  | 'token-expired'
  | 'already-verified'
  | 'mfa-invalid'
  | 'mfa-locked'
  | 'mfa-already-enabled'
  | 'mfa-not-enabled'
  | 'mfa-required'
  | 'oauth-disabled'
  | 'identity-taken'
  | 'last-sign-in-method'
  | 'invite-other-email'
  | 'already-member'
  | 'plan-limit'
  | 'invite-required'
  | 'invite-email-mismatch'
  | 'invite-invalid'
  | 'not-found';

/** An RFC 9457 problem with a `code` the pages branch on. */
export function sendCode(
  reply: FastifyReply,
  status: number,
  code: AccountErrorCode,
  detail: string,
): FastifyReply {
  return reply
    .code(status)
    .type(PROBLEM_CONTENT_TYPE)
    .send({
      type: `urn:watchlog:problem:${code}`,
      // The status's own reason phrase (a 403 or 404 is not a "Bad Request").
      title: STATUS_CODES[status] ?? 'Error',
      status,
      detail,
      instance: reply.request.url,
      code,
    });
}

/**
 * Cloudflare Turnstile, verified server-side. Off (always true) without a secret key. A
 * failed call to Cloudflare counts as a failed check: the forms it guards stay closed to
 * bots while Cloudflare can't answer, and the visitor can try again.
 */
export async function verifyTurnstile(
  f: Fetch,
  secretKey: string | undefined,
  token: string | undefined,
  ip: string | undefined,
  log?: FastifyBaseLogger,
): Promise<boolean> {
  if (!secretKey) return true;
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret: secretKey, response: token });
    if (ip) body.set('remoteip', ip);
    const res = await f(TURNSTILE_URL, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
    });
    if (!res.ok) {
      log?.warn({ status: res.status }, 'turnstile: verification call failed');
      return false;
    }
    const out = (await res.json()) as { success?: boolean };
    return out.success === true;
  } catch (err) {
    log?.warn({ err: (err as Error).message }, 'turnstile: verification call failed');
    return false;
  }
}

/**
 * Whether a password is in Have I Been Pwned's breach corpus, with k-anonymity: only the
 * first 5 hex characters of its SHA-1 leave. `null` when the API didn't answer within 2 s;
 * the caller lets the signup go on and the skip is logged here.
 */
export async function isBreachedPassword(
  f: Fetch,
  password: string,
  log?: FastifyBaseLogger,
): Promise<boolean | null> {
  const hash = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  try {
    const res = await f(`${HIBP_URL}${prefix}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'WatchLog' },
      signal: AbortSignal.timeout(HIBP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    for (const line of text.split('\n')) {
      const [s, count] = line.trim().split(':');
      if (s === suffix && Number(count) > 0) return true;
    }
    return false;
  } catch (err) {
    log?.warn({ err: (err as Error).message }, 'breached-password check skipped');
    return null;
  }
}

/** Common disposable-email domains; WATCHLOG_DISPOSABLE_DOMAINS_FILE adds more. */
export const BUILTIN_DISPOSABLE_DOMAINS = [
  '10minutemail.com',
  '20minutemail.com',
  'anonbox.net',
  'burnermail.io',
  'discard.email',
  'dispostable.com',
  'emailondeck.com',
  'fakeinbox.com',
  'getairmail.com',
  'getnada.com',
  'guerrillamail.biz',
  'guerrillamail.com',
  'guerrillamail.de',
  'guerrillamail.info',
  'guerrillamail.net',
  'guerrillamail.org',
  'guerrillamailblock.com',
  'harakirimail.com',
  'inboxkitten.com',
  'jetable.org',
  'mailcatch.com',
  'maildrop.cc',
  'mailinator.com',
  'mailinator.net',
  'mailnesia.com',
  'mintemail.com',
  'mohmal.com',
  'mytemp.email',
  'nada.email',
  'sharklasers.com',
  'spam4.me',
  'spambox.us',
  'spamgourmet.com',
  'temp-mail.io',
  'temp-mail.org',
  'tempail.com',
  'tempmail.com',
  'tempmail.dev',
  'tempmail.net',
  'tempmailo.com',
  'tempr.email',
  'throwawaymail.com',
  'trashmail.com',
  'trashmail.de',
  'trashmail.net',
  'yopmail.com',
  'yopmail.fr',
  'yopmail.net',
];

/** The disposable domains: the built-in list plus the file's lines (`#` starts a comment). */
export function loadDisposableDomains(file?: string): Set<string> {
  const domains = new Set(BUILTIN_DISPOSABLE_DOMAINS);
  if (file) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const d = line.replace(/#.*/, '').trim().toLowerCase();
      if (d) domains.add(d);
    }
  }
  return domains;
}

/** True when the address's domain, or a parent of it, is disposable. */
export function isDisposable(domains: Set<string>, email: string): boolean {
  const parts = emailDomain(email).split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    if (domains.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

export const emailDomain = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();

/**
 * Fixed windows in memory, per key: at most `max` hits per `windowMs`. One backend replica
 * holds them (ADR-174's Redis buckets are blocked), as the other in-memory limits.
 */
export class WindowLimiter {
  private hits = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Counts a hit; false when the key is over its limit (the hit isn't counted then). */
  hit(key: string, now = Date.now()): boolean {
    const w = this.hits.get(key);
    if (!w || now - w.start >= this.windowMs) {
      if (this.hits.size > 50_000) this.sweep(now);
      this.hits.set(key, { start: now, count: 1 });
      return true;
    }
    if (w.count >= this.max) return false;
    w.count++;
    return true;
  }

  /** Whether the key is at its limit, without counting. */
  full(key: string, now = Date.now()): boolean {
    const w = this.hits.get(key);
    return !!w && now - w.start < this.windowMs && w.count >= this.max;
  }

  private sweep(now: number) {
    for (const [k, w] of this.hits) if (now - w.start >= this.windowMs) this.hits.delete(k);
  }
}
