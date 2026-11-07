// SPDX-License-Identifier: AGPL-3.0-only
// The read-only public demo (ADR-122): one shared viewer account, stateless sessions.

/** The demo viewer. `.invalid` is reserved (RFC 2606): no one can own or receive this address. */
export const DEMO_USER_EMAIL = 'demo@watchlog.invalid';
export const DEMO_USER_NAME = 'Demo visitor';
/** Not an argon2 hash: password verification always fails, so no one signs in as the demo user. */
export const DEMO_PASSWORD_HASH = '!demo-account-has-no-password';
/**
 * Demo sessions are signed cookies, never database rows: thousands of visitors cost
 * nothing to keep. One ends after 2 hours without a request.
 */
export const DEMO_SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
/** A demo cookie is renewed (its idle expiry pushed back) at most this often. */
export const DEMO_SESSION_REFRESH_MS = 10 * 60 * 1000;
/** Demo session tokens start with this; normal session tokens never do. */
export const DEMO_TOKEN_PREFIX = 'wl_demo.';

export const DEMO_READ_ONLY_CODE = 'demo_read_only';
export const DEMO_READ_ONLY_MESSAGE =
  'This is a read-only demo. Install WatchLog to try this on your cluster.';
