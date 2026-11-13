// SPDX-License-Identifier: AGPL-3.0-only
// The org a piece of work runs for (ADR-174). An AsyncLocalStorage holds it; the org-scoped
// pool (db/index.ts) writes it to `watchlog.org_id` on every connection checkout, so each
// query and transaction runs under Row-Level Security for that org without the modules
// passing anything. Outside an org the setting is empty, which matches no tenant row.
import { AsyncLocalStorage } from 'node:async_hooks';

interface OrgScope {
  orgId: string | null;
}

const storage = new AsyncLocalStorage<OrgScope>();

/** The org of the current request or `withOrg` call, or null outside one. */
export function currentOrgId(): string | null {
  return storage.getStore()?.orgId ?? null;
}

/** Runs `fn` for one org: every query it makes sees that org's rows only (Cloud). */
export function withOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ orgId }, fn);
}

/**
 * Starts a request's scope with no org (an onRequest hook calls it, plugins/org-scope.ts).
 * The org is bound once authentication knows it, with bindOrg.
 */
export function enterRequestScope(next: () => void): void {
  storage.run({ orgId: null }, next);
}

/**
 * Binds the current request to an org once a session, API token, cluster token or service
 * identity named it. Binding a different org in the same scope is a bug and throws. Outside
 * a scope it does nothing: queries then run with no org, which in Cloud sees no tenant row.
 */
export function bindOrg(orgId: string): void {
  const scope = storage.getStore();
  if (!scope) return;
  if (scope.orgId !== null && scope.orgId !== orgId) {
    throw new Error('This request is already bound to another organization');
  }
  scope.orgId = orgId;
}
