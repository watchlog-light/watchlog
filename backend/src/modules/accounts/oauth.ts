// SPDX-License-Identifier: AGPL-3.0-only
// GitHub and Google sign-in through `fetch` (ADR-175): the authorization-code flow with PKCE
// (S256), and a `state` bound to a short-lived HttpOnly cookie. The cookie holds the state,
// the PKCE verifier and what the flow is for, encrypted with WATCHLOG_SECRET_KEY, so it can be
// neither read nor forged. Accounts are found by the provider's id only.
import { createHash, randomBytes } from 'node:crypto';
import type { AccountsConfig, OAuthClient } from '../../config.js';
import { decryptSecret, encryptSecret } from '../../lib/secrets.js';
import { safeEqual } from '../../lib/tokens.js';
import type { Fetch } from './checks.js';

export type Provider = 'github' | 'google';
export const PROVIDERS: Provider[] = ['github', 'google'];

export const OAUTH_COOKIE = 'wl_oauth';
export const OAUTH_COOKIE_PATH = '/api/v1/auth/oauth';
export const OAUTH_STATE_TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 10_000;

const ENDPOINTS = {
  github: {
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
  },
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
  },
} as const;
export const GITHUB_API = 'https://api.github.com';
export const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

export function oauthClient(config: AccountsConfig, p: Provider): OAuthClient | undefined {
  return config[p];
}

/** What a flow is for: signing in (or up), or linking to the signed-in user. */
export interface OAuthState {
  state: string;
  verifier: string;
  provider: Provider;
  intent: 'signin' | 'link';
  /** The signed-in user a link is for. */
  userId?: string;
  /** Where to go afterwards: a path on this site only. */
  next?: string;
  exp: number;
}

const AAD = 'oauth-state';

export function sealState(key: Buffer, s: OAuthState): string {
  return encryptSecret(key, JSON.stringify(s), AAD);
}

export function openState(key: Buffer, cookie: string | undefined, now = Date.now()) {
  if (!cookie) return null;
  try {
    const s = JSON.parse(decryptSecret(key, cookie, AAD)) as OAuthState;
    return s.exp > now ? s : null;
  } catch {
    return null;
  }
}

/** The state from the provider matches the cookie's, in constant time. */
export const stateMatches = (s: OAuthState, state: string | undefined) =>
  !!state && safeEqual(s.state, state);

/** A path on this site, or undefined: never another origin (no open redirect). */
export function safeNext(next: string | undefined): string | undefined {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return;
  return next.length <= 512 ? next : undefined;
}

export function newFlow(
  provider: Provider,
  intent: OAuthState['intent'],
  extra: { userId?: string; next?: string } = {},
  now = Date.now(),
): OAuthState {
  return {
    state: randomBytes(32).toString('base64url'),
    verifier: randomBytes(48).toString('base64url'),
    provider,
    intent,
    ...extra,
    exp: now + OAUTH_STATE_TTL_MS,
  };
}

export function authorizeUrl(client: OAuthClient, s: OAuthState, redirectUri: string): string {
  const e = ENDPOINTS[s.provider];
  const challenge = createHash('sha256').update(s.verifier).digest('base64url');
  const u = new URL(e.authorize);
  u.searchParams.set('client_id', client.clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', e.scope);
  u.searchParams.set('state', s.state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (s.provider === 'google') u.searchParams.set('prompt', 'select_account');
  if (s.provider === 'github') u.searchParams.set('allow_signup', 'true');
  return u.toString();
}

/** The provider's account: its id, and its address when the provider verified it. */
export interface ProviderProfile {
  id: string;
  email: string | null;
  name: string | null;
}

export class OAuthError extends Error {
  constructor(
    readonly code: 'oauth-failed' | 'oauth-email-unverified',
    message: string,
  ) {
    super(message);
  }
}

async function json(res: Response, what: string): Promise<Record<string, unknown>> {
  if (!res.ok) throw new OAuthError('oauth-failed', `${what}: HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Exchanges the code (with the PKCE verifier) and reads the provider's account. */
export async function fetchProfile(
  f: Fetch,
  client: OAuthClient,
  s: OAuthState,
  code: string,
  redirectUri: string,
): Promise<ProviderProfile> {
  const e = ENDPOINTS[s.provider];
  const tokenRes = await json(
    await f(e.token, {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: s.verifier,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }),
    'token',
  );
  const access = tokenRes.access_token;
  if (typeof access !== 'string') throw new OAuthError('oauth-failed', 'no access token');
  const auth = {
    authorization: `Bearer ${access}`,
    accept: 'application/json',
    'user-agent': 'WatchLog',
  };

  if (s.provider === 'github') {
    const user = await json(
      await f(`${GITHUB_API}/user`, { headers: auth, signal: AbortSignal.timeout(TIMEOUT_MS) }),
      'user',
    );
    const emails = (await (
      await f(`${GITHUB_API}/user/emails`, {
        headers: auth,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    ).json()) as { email: string; primary: boolean; verified: boolean }[];
    const primary = Array.isArray(emails) ? emails.find((m) => m.primary) : undefined;
    // GitHub's primary address must be verified (ADR-175).
    if (!primary?.verified) {
      throw new OAuthError('oauth-email-unverified', 'GitHub primary email is not verified');
    }
    if (typeof user.id !== 'number' && typeof user.id !== 'string') {
      throw new OAuthError('oauth-failed', 'no GitHub user id');
    }
    return {
      id: String(user.id),
      email: primary.email.toLowerCase(),
      name:
        typeof user.name === 'string'
          ? user.name
          : typeof user.login === 'string'
            ? user.login
            : null,
    };
  }

  const info = await json(
    await f(GOOGLE_USERINFO, { headers: auth, signal: AbortSignal.timeout(TIMEOUT_MS) }),
    'userinfo',
  );
  if (typeof info.sub !== 'string') throw new OAuthError('oauth-failed', 'no Google subject');
  if (info.email_verified !== true || typeof info.email !== 'string') {
    throw new OAuthError('oauth-email-unverified', 'Google email is not verified');
  }
  return {
    id: info.sub,
    email: info.email.toLowerCase(),
    name: typeof info.name === 'string' ? info.name : null,
  };
}
