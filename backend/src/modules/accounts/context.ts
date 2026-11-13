// SPDX-License-Identifier: AGPL-3.0-only
// What Cloud's account routes share (ADR-175): the configuration, `fetch` for Turnstile,
// Have I Been Pwned and the OAuth providers (replaced in tests), the disposable domains and
// the in-memory limits. Built once per app, in Cloud only; Community has none.
import type { FastifyRequest } from 'fastify';
import type { AccountsConfig } from '../../config.js';
import { loadDisposableDomains, verifyTurnstile, WindowLimiter, type Fetch } from './checks.js';

const HOUR = 3_600_000;

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
  readonly loginsPerAccount = new WindowLimiter(20, 15 * 60_000);

  constructor(
    readonly config: AccountsConfig,
    readonly fetch: Fetch,
  ) {
    this.disposable = loadDisposableDomains(config.disposableDomainsFile);
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
