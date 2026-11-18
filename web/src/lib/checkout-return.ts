// SPDX-License-Identifier: AGPL-3.0-only
// Where Checkout was started (ADR-216). Stripe Checkout always returns to Settings › Plan &
// billing (the billing service's success and cancel addresses). An Owner who pressed Upgrade
// on What changed's upgrade page is brought back there instead, where the page turns into the
// learning page as soon as Pro is on. Kept in the tab's session storage: it survives the trip
// to Stripe, is read once, and is ignored after two hours.
const KEY = 'watchlog.checkout-from';
const MAX_AGE_MS = 2 * 3_600_000;

export interface CheckoutOrigin {
  page: 'what-changed';
  cluster: string;
}

export function rememberCheckoutOrigin(cluster: string, nowMs = Date.now()): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ page: 'what-changed', cluster, at: nowMs }));
  } catch {
    // No storage: Checkout returns to Plan & billing, as it always did.
  }
}

/** Reads the origin and forgets it. Null when there is none, or it is stale or malformed. */
export function takeCheckoutOrigin(nowMs = Date.now()): CheckoutOrigin | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    const v = JSON.parse(raw) as { page?: unknown; cluster?: unknown; at?: unknown };
    if (v.page !== 'what-changed' || typeof v.cluster !== 'string' || typeof v.at !== 'number') {
      return null;
    }
    if (nowMs - v.at > MAX_AGE_MS || nowMs < v.at) return null;
    return { page: 'what-changed', cluster: v.cluster };
  } catch {
    return null;
  }
}
