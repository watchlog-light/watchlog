// SPDX-License-Identifier: AGPL-3.0-only
// The billing service's API (ADR-178), Cloud only: the product never talks to the payment
// provider; it asks the billing service, on the Compose network, with the shared internal
// token. Its answers are passed on to the Plan & billing page.

export interface BillingState {
  live: boolean;
  customer: boolean;
  subscription: {
    interval: 'monthly' | 'annual';
    status: string;
    committedNodes: number | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
  beta: { startedAt: string; betaUntil: string | null } | null;
  dunning: { since: string; downgradeAt: string; downgraded: boolean } | null;
}

/** The refusals the page has words for; anything else is "billing unavailable". */
export const BILLING_REFUSALS = [
  'billing-live',
  'billing-not-live',
  'already-pro',
  'already-subscribed',
  'no-billing-customer',
] as const;
export type BillingRefusal = (typeof BILLING_REFUSALS)[number];

/** The billing service said no, with a reason the page shows. */
export class BillingRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: BillingRefusal,
  ) {
    super(code);
  }
}

/** Not configured, unreachable, or an answer the product doesn't know. */
export class BillingUnavailable extends Error {}

export interface BillingClient {
  state(orgId: string): Promise<BillingState>;
  startBeta(orgId: string): Promise<BillingState>;
  checkout(
    orgId: string,
    body: { interval: 'monthly' | 'annual'; nodes?: number; email: string; orgName: string },
  ): Promise<{ url: string }>;
  portal(orgId: string): Promise<{ url: string }>;
}

const TIMEOUT_MS = 15_000;

export function billingClient(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): BillingClient {
  const call = async <T>(method: 'GET' | 'POST', path: string, body?: object): Promise<T> => {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new BillingUnavailable(`billing service unreachable: ${(err as Error).message}`);
    }
    if (res.ok) return (await res.json()) as T;
    const problem = (await res.json().catch(() => ({}))) as { code?: string };
    const code = problem.code as BillingRefusal | undefined;
    if (res.status === 409 && code && BILLING_REFUSALS.includes(code)) {
      throw new BillingRefused(409, code);
    }
    throw new BillingUnavailable(`billing service answered ${res.status} ${problem.code ?? ''}`);
  };
  const org = (id: string) => `/orgs/${encodeURIComponent(id)}`;
  /** Checkout and the portal are the provider's pages: only an https URL is passed on. */
  const page = (r: { url?: unknown }) => {
    if (typeof r.url !== 'string' || !r.url.startsWith('https://')) {
      throw new BillingUnavailable('billing service returned no https URL');
    }
    return { url: r.url };
  };
  return {
    state: (orgId) => call<BillingState>('GET', org(orgId)),
    startBeta: (orgId) => call<BillingState>('POST', `${org(orgId)}/beta`),
    checkout: async (orgId, body) =>
      page(await call<{ url?: unknown }>('POST', `${org(orgId)}/checkout`, body)),
    portal: async (orgId) => page(await call<{ url?: unknown }>('POST', `${org(orgId)}/portal`)),
  };
}
