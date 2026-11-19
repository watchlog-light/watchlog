// SPDX-License-Identifier: AGPL-3.0-only
// What Cloud's account routes share (ADR-175): the configuration, `fetch` for Turnstile,
// Have I Been Pwned and the OAuth providers (replaced in tests), the disposable domains and
// the in-memory limits. Built once per app, in Cloud only; Community has none.
import type { FastifyRequest } from 'fastify';
import type { AccountsConfig } from '../../config.js';
import {
  checkTurnstile,
  loadDisposableDomains,
  pwnedRange,
  verifyTurnstile,
  WindowLimiter,
  type Fetch,
  type TurnstileState,
} from './checks.js';

const HOUR = 3_600_000;
const QUARTER = 15 * 60_000;
/** Ranges of leaked-password hashes kept for the sign-up page's live check: an hour, 2,000. */
const RANGE_TTL_MS = HOUR;
const RANGE_MAX = 2_000;

export class CloudAccounts {
  readonly disposable: Set<string>;
  /** Signups per visitor address: 5 an hour. */
  readonly signupsPerIp = new WindowLimiter(5, HOUR);
  /** Signups per email domain: 20 a day. */
  readonly signupsPerDomain = new WindowLimiter(20, 24 * HOUR);
  /** Verification emails per user (3 an hour) and per address (10 an hour). */
  readonly resendPerUser = new WindowLimiter(3, HOUR);
  readonly resendPerIp = new WindowLimiter(10, HOUR);
  /** Reset emails per account address: 3 an hour (on top of 5 a minute per visitor). */
  readonly resetsPerEmail = new WindowLimiter(3, HOUR);
  /** Password attempts per account, from any address: 20 in 15 minutes. */
  readonly loginsPerAccount = new WindowLimiter(20, QUARTER);
  /**
   * Password attempts that Turnstile did not vouch for (no token: the widget was blocked or
   * had not finished; or Cloudflare could not be asked): 5 per account and 10 per visitor
   * address in 15 minutes (ADR-175, amended in 0.9.9). Sign-in stays possible, slowly.
   */
  readonly unverifiedLoginsPerAccount = new WindowLimiter(5, QUARTER);
  readonly unverifiedLoginsPerIp = new WindowLimiter(10, QUARTER);
  private readonly ranges = new Map<string, { at: number; body: string }>();

  constructor(
    readonly config: AccountsConfig,
    readonly fetch: Fetch,
  ) {
    this.disposable = loadDisposableDomains(config.disposableDomainsFile);
  }

  /** What Turnstile said about a token (sign-in tells "refused" from "could not be asked"). */
  turnstileState(request: FastifyRequest, token: string | undefined): Promise<TurnstileState> {
    return checkTurnstile(
      this.fetch,
      this.config.turnstile.secretKey,
      token,
      request.clientIp,
      request.log,
    );
  }

  /**
   * The leaked-password range for a 5-character prefix (see `pwnedRange`), kept for an hour:
   * the page asks again with every pause in typing. Null when HIBP can't answer.
   */
  async leakedRange(request: FastifyRequest, prefix: string, now = Date.now()) {
    const key = prefix.toUpperCase();
    const kept = this.ranges.get(key);
    if (kept && now - kept.at < RANGE_TTL_MS) return kept.body;
    const body = await pwnedRange(this.fetch, key, request.log);
    if (body === null) return null;
    if (this.ranges.size >= RANGE_MAX) {
      for (const [k, v] of this.ranges) if (now - v.at >= RANGE_TTL_MS) this.ranges.delete(k);
      if (this.ranges.size >= RANGE_MAX) this.ranges.clear();
    }
    this.ranges.set(key, { at: now, body });
    return body;
  }

  /** Turnstile for a form (true when it is off). */
  turnstile(request: FastifyRequest, token: string | undefined): Promise<boolean> {
    return verifyTurnstile(
      this.fetch,
      this.config.turnstile.secretKey,
      token,
      request.clientIp,
      request.log,
    );
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Cloud's account checks and limits (ADR-175); null in Community. */
    accounts: CloudAccounts | null;
  }
}
