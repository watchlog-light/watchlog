// SPDX-License-Identifier: AGPL-3.0-only
// The Cloud accounts API (ADR-175). These routes exist only with WATCHLOG_EDITION=cloud, and
// packages/api-types is generated in Community mode, so they are typed here by hand from the
// backend's schemas (backend/src/modules/accounts/routes.ts). Community answers 404 for each.
import type { CurrentUser } from '@watchlog/api-types';
import { api, ApiError } from './client';

export type Provider = 'github' | 'google';
export const PROVIDERS: readonly Provider[] = ['github', 'google'];

/** GET /auth/config: what the sign-up and sign-in pages offer. */
export interface CloudConfig {
  signup: boolean;
  providers: Record<Provider, boolean>;
  /** Load Cloudflare's Turnstile widget only when this is set. */
  turnstileSiteKey: string | null;
  passwordMinLength: number;
  verifyGraceDays: number;
  /** Onboarding (ADR-176): "Get help installing" writes here. */
  supportEmail: string;
  /** The read-only live demo: "Look around a sample organisation". */
  sampleUrl: string;
}

/** The overview's first-week card (ADR-176): each step from the org's real state. */
export type FirstWeekStepId = 'channel' | 'teammate' | 'application' | 'mcp' | 'problem';
export interface FirstWeek {
  dismissed: boolean;
  steps: { id: FirstWeekStepId; done: boolean; blocked: 'plan-limit' | null }[];
}

/** GET /plan (ADR-177): the org's plan, its limits and what it uses now. */
export type CloudPlan = 'free' | 'pro' | 'enterprise';
export interface PlanInfo {
  plan: CloudPlan;
  source: string;
  betaUntil: string | null;
  proFeatures: boolean;
  /** null: unlimited. */
  limits: {
    clusters: number | null;
    nodes: number | null;
    users: number | null;
    retentionDays: number;
  };
  usage: {
    clusters: number;
    /** Kubernetes nodes and Docker hosts seen in the last 24 hours (what the limit counts). */
    nodes: number;
    kubernetesNodes: number;
    dockerHosts: number;
    users: number;
  };
  /** This calendar month so far: the bill's 95th percentile and the peak hour. */
  period: { from: string; to: string; p95: number; peak: number };
  /** Nodes refused (402) in the last 24 hours. */
  refusedNodes: number;
  downgrade: {
    graceUntil: string;
    daysLeft: number;
    ended: boolean;
    nodesOver: number;
    clustersOver: number;
  } | null;
}

/** Funnel events only the page sees (POST /funnel; SPEC §10.4). */
export type ClientFunnelEvent =
  | 'install_command_copied'
  | 'onboarding_dashboard_opened'
  | 'onboarding_sample_opened'
  | 'onboarding_help_opened'
  | 'onboarding_troubleshooting_shown';

export type Restriction = 'mfa-setup-required' | 'email-verification-required';

/** GET /auth/account. */
export interface Account {
  email: string;
  emailVerified: boolean;
  /** When an unverified account stops working until it is verified. */
  verifyBy: string | null;
  restriction: Restriction | null;
  /** The account has a password (GitHub and Google accounts may not). */
  password: boolean;
  mfa: { enabled: boolean; required: boolean; recoveryCodesLeft: number };
  identities: { provider: Provider; email: string | null; linkedAt: string }[];
}

export interface AccountSession {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  mfa: boolean;
}

export interface OrgMembership {
  id: string;
  name: string;
  slug: string;
  role: CurrentUser['role'];
  current: boolean;
}

/**
 * The edition: Cloud's config, or null for Community (the route answers 404 there). Any
 * other failure counts as Community too, so a Community install never depends on it.
 */
export async function fetchCloudConfig(): Promise<CloudConfig | null> {
  try {
    return await api<CloudConfig>('/auth/config');
  } catch {
    return null;
  }
}

export const cloudApi = {
  signup: (body: { email: string; password: string; name?: string; turnstileToken?: string }) =>
    api<{ accepted: true; verificationSent: boolean }>('/auth/signup', { method: 'POST', body }),
  verifyEmail: (token: string) =>
    api<{ verified: true }>('/auth/verify-email', { method: 'POST', body: { token } }),
  resendVerification: (turnstileToken?: string) =>
    api<{ emailed: boolean }>('/auth/verify-email/resend', {
      method: 'POST',
      body: turnstileToken ? { turnstileToken } : {},
    }),
  verifyMfa: (code: string) =>
    api<{ user: CurrentUser }>('/auth/2fa/verify', { method: 'POST', body: { code } }),
  account: () => api<Account>('/auth/account'),
  setupMfa: () => api<{ secret: string; uri: string }>('/auth/2fa/setup', { method: 'POST' }),
  enableMfa: (code: string) =>
    api<{ recoveryCodes: string[] }>('/auth/2fa/enable', { method: 'POST', body: { code } }),
  disableMfa: (code: string) => api<void>('/auth/2fa/disable', { method: 'POST', body: { code } }),
  newRecoveryCodes: (code: string) =>
    api<{ recoveryCodes: string[] }>('/auth/2fa/recovery-codes', {
      method: 'POST',
      body: { code },
    }),
  sessions: () => api<{ sessions: AccountSession[] }>('/auth/sessions'),
  revokeSession: (id: string) =>
    api<void>(`/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  revokeOtherSessions: () => api<{ revoked: number }>('/auth/sessions', { method: 'DELETE' }),
  orgs: () => api<{ orgs: OrgMembership[] }>('/orgs'),
  switchOrg: (id: string) =>
    api<{ org: unknown }>(`/orgs/${encodeURIComponent(id)}/switch`, { method: 'POST' }),
  joinInvite: (token: string) =>
    api<{ org: unknown }>(`/invites/${encodeURIComponent(token)}/join`, { method: 'POST' }),
  unlink: (provider: Provider) => api<void>(`/auth/identities/${provider}`, { method: 'DELETE' }),
  firstWeek: () => api<FirstWeek>('/onboarding/first-week'),
  dismissFirstWeek: () => api<void>('/onboarding/first-week/dismiss', { method: 'POST' }),
  plan: () => api<PlanInfo>('/plan'),
};

/**
 * Records a funnel event; never fails the page (a lost event is only a lost count).
 * Cloud only: Community has no funnel, so nothing is sent there.
 */
export function funnel(
  name: ClientFunnelEvent,
  props?: { method?: string; kind?: 'kubernetes' | 'docker' },
): void {
  void api<void>('/funnel', { method: 'POST', body: props ? { name, props } : { name } }).catch(
    () => {},
  );
}

/** The browser navigates here to sign in, sign up or link with GitHub or Google. */
export function oauthStartUrl(
  provider: Provider,
  intent: 'signin' | 'link',
  next?: string,
): string {
  const q = new URLSearchParams({ intent });
  if (next && next.startsWith('/') && !next.startsWith('//')) q.set('next', next);
  return `/api/v1/auth/oauth/${provider}/start?${q.toString()}`;
}

/**
 * Every code the Cloud account routes answer with (RFC 9457 `code`), and the OAuth
 * callback's `?error=`. Each has a plain message under `cloud.errors.<code>` in en.json.
 */
export const CLOUD_ERROR_CODES = [
  'turnstile-failed',
  'email-disposable',
  'password-breached',
  'rate-limited',
  'invalid-credentials',
  'mfa-invalid',
  'invalid-token',
  'token-expired',
  'already-verified',
  'mfa-already-enabled',
  'mfa-not-enabled',
  'mfa-required',
  'mfa-setup-required',
  'email-verification-required',
  'not-found',
  'invite-other-email',
  'already-member',
  'last-sign-in-method',
  'identity-taken',
  'plan-limit',
  'oauth-state',
  'oauth-cancelled',
  'oauth-failed',
  'oauth-email-unverified',
  'oauth-disabled',
  'account-disabled',
] as const;
export type CloudErrorCode = (typeof CLOUD_ERROR_CODES)[number];

export function isCloudErrorCode(code: unknown): code is CloudErrorCode {
  return typeof code === 'string' && (CLOUD_ERROR_CODES as readonly string[]).includes(code);
}

/** The problem's code: `code`, else the end of `type` (`urn:watchlog:problem:<code>`). */
export function problemCode(err: unknown): string | null {
  if (!(err instanceof ApiError) || !err.problem) return null;
  if (err.problem.code) return err.problem.code;
  const m = /^urn:watchlog:problem:(.+)$/.exec(err.problem.type ?? '');
  return m?.[1] ?? null;
}

/**
 * The i18n key of a plain message for a failed account call: the code's own message, else
 * one by status. Never the server's English text, so every string stays in en.json.
 */
export function cloudErrorKey(err: unknown): string {
  const code = problemCode(err);
  if (isCloudErrorCode(code)) return `cloud.errors.${code}`;
  if (!(err instanceof ApiError)) return 'auth.errors.generic';
  if (err.status === 0 || err.status >= 500) return 'auth.errors.unavailable';
  if (err.status === 429) return 'cloud.errors.rate-limited';
  if (err.status === 400) return 'auth.errors.invalidInput';
  return 'auth.errors.generic';
}

/** Which gate a 403 names, if any. */
export function restrictionOf(err: unknown): Restriction | null {
  const code = problemCode(err);
  return err instanceof ApiError &&
    err.status === 403 &&
    (code === 'mfa-setup-required' || code === 'email-verification-required')
    ? code
    : null;
}

/**
 * The message for a 409/402 `plan-limit` (ADR-177): the limit's own words when the
 * problem names it (`limit`: clusters, users or nodes), else the general one.
 */
export function planLimitKey(err: unknown): string | null {
  if (problemCode(err) !== 'plan-limit') return null;
  const limit = (err as ApiError).problem?.limit;
  return limit === 'clusters' || limit === 'users' || limit === 'nodes'
    ? `cloud.plan.limitError.${limit}`
    : 'cloud.errors.plan-limit';
}
