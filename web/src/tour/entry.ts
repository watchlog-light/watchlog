// SPDX-License-Identifier: AGPL-3.0-only
// When the guided tour opens (1.3.0, ADR-246): by itself on a visitor's first visit only
// (remembered in this browser), at once on ?tour=k8s or ?tour=servers (the question skipped),
// never on ?tour=off. Storage that throws (a private window, blocked site data) is treated as
// a first visit that can't be remembered: the tour still opens once per page load.

export const SEEN_KEY = 'watchlog-demo-tour-seen';

export type TourEntry =
  { open: false } | { open: true; kind: 'kubernetes' | 'server' | null; reason: 'link' | 'first' };

/** The browser's storage, or null when reading it throws. */
type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** Whether this browser has seen the tour; storage that throws hasn't. */
export function seen(store: Store | null): boolean {
  try {
    return store?.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

/** Remembers that the tour was shown here; silent when storage throws. */
export function markSeen(store: Store | null): void {
  try {
    store?.setItem(SEEN_KEY, '1');
  } catch {
    /* a private window or blocked storage: it opens again next time, nothing breaks */
  }
}

/** Whether the tour opens on this page load, and for which side when a link names it. */
export function tourEntry(query: unknown, store: Store | null): TourEntry {
  const q = Array.isArray(query) ? query[0] : query;
  if (q === 'off') return { open: false };
  if (q === 'k8s' || q === 'kubernetes') return { open: true, kind: 'kubernetes', reason: 'link' };
  if (q === 'servers' || q === 'server') return { open: true, kind: 'server', reason: 'link' };
  return seen(store) ? { open: false } : { open: true, kind: null, reason: 'first' };
}

/** localStorage, or null when even touching it throws. */
export function browserStore(): Store | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
