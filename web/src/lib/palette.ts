// SPDX-License-Identifier: AGPL-3.0-only
// The ⌘K command palette (ADR-169, SPEC §11.3): what it lists and where each pick leads.
// Pages and clusters are matched here, in the browser; a cluster's objects come from
// GET /clusters/:id/search, which matches the same way in PostgreSQL. The five last picks
// are kept in this browser, per user.
import type { SearchResult } from '@watchlog/api-types';
import type { RouteLocationRaw } from 'vue-router';

export type PaletteKind =
  | 'page'
  | 'cluster'
  | 'workload'
  | 'pod'
  | 'node'
  | 'host'
  | 'container'
  | 'compose_project'
  | 'application';

/** The groups in their default order (the best match's group goes first). */
export const KIND_ORDER: PaletteKind[] = [
  'page',
  'cluster',
  'workload',
  'pod',
  'node',
  'host',
  'container',
  'compose_project',
  'application',
];

/** Which platform's vocabulary and logo a group carries. */
export const PLATFORM: Partial<Record<PaletteKind, 'kubernetes' | 'docker'>> = {
  workload: 'kubernetes',
  pod: 'kubernetes',
  node: 'kubernetes',
  host: 'docker',
  container: 'docker',
  compose_project: 'docker',
};

export interface PaletteItem {
  /** Unique within a list; the listbox value. */
  key: string;
  kind: PaletteKind;
  label: string;
  /** The second line: kind, namespace, host or type, already in words. */
  detail: string;
  to: RouteLocationRaw;
  /** 0 exact … 6 one typo (match.ts in the backend). */
  rank: number;
  /** A page: its navigation name (for its icon). */
  page?: string;
  /** A cluster or Docker fleet: picking it selects it. */
  clusterId?: string;
  /** The cluster's kind, or the application's service type, for the logo. */
  logo?: string;
}

// ---------------------------------------------------------------------------------------
// Matching: the backend's tiers (backend/src/modules/search/match.ts), for the few pages and
// clusters the browser has.

const TYPO_MIN = 4;
const TYPO_MAX = 32;
export const TYPO_RANK = 6;
const TIER_RANK: Record<SearchResult['match'], number> = {
  exact: 0,
  prefix: 1,
  substring: 2,
  path: 3,
  letters: 4,
  typo: TYPO_RANK,
};
export const rankOfTier = (t: SearchResult['match']) => TIER_RANK[t] ?? TYPO_RANK;

export const normalize = (q: string) => q.toLowerCase().trim().replace(/\s+/g, ' ');
const words = (q: string) => normalize(q).split(' ').filter(Boolean).slice(0, 4);

/** Whether `word`'s letters appear in `text` in order. */
export function inOrder(word: string, text: string, skip = -1): boolean {
  let j = 0;
  for (let i = 0; i < word.length; i++) {
    if (i === skip) continue;
    j = text.indexOf(word[i]!, j);
    if (j < 0) return false;
    j++;
  }
  return true;
}

function withOneTypo(word: string, text: string): boolean {
  if (word.length < TYPO_MIN || word.length > TYPO_MAX) return false;
  for (let i = 0; i < word.length; i++) if (inOrder(word, text, i)) return true;
  return false;
}

/**
 * How well `query` matches `name` (and `extra`, e.g. a namespace or a kind): 0 exact, 1
 * prefix, 2 substring, 3 in the extra text, 4 letters in order in the name, 5 in the extra
 * text, 6 one typo; null when it doesn't match.
 */
export function matchRank(query: string, name: string, extra = ''): number | null {
  const ws = words(query);
  if (!ws.length) return null;
  const n = name.toLowerCase();
  const hay = extra ? `${extra.toLowerCase()}/${n}` : n;
  const whole = ws.join('-');
  const spaced = ws.join(' ');
  if (n === whole || n === spaced) return 0;
  if (n.startsWith(whole) || n.startsWith(spaced)) return 1;
  if (n.includes(whole) || n.includes(spaced)) return 2;
  if (hay.includes(whole) || hay.includes(spaced)) return 3;
  if (ws.every((w) => inOrder(w, n))) return 4;
  if (ws.every((w) => inOrder(w, hay))) return 5;
  if (ws.every((w) => inOrder(w, hay) || withOneTypo(w, hay))) return TYPO_RANK;
  return null;
}

/** The items that match, best first (shorter labels first within a rank). */
export function rankItems<T extends { label: string }>(
  items: T[],
  query: string,
  extra: (item: T) => string = () => '',
): (T & { rank: number })[] {
  const out: (T & { rank: number })[] = [];
  for (const item of items) {
    const rank = matchRank(query, item.label, extra(item));
    if (rank !== null) out.push({ ...item, rank });
  }
  return out.sort((a, b) => a.rank - b.rank || a.label.length - b.label.length);
}

// ---------------------------------------------------------------------------------------
// Grouping

export interface PaletteGroup {
  kind: PaletteKind;
  items: PaletteItem[];
}

/**
 * Items by kind, the kind with the best match first; one-typo matches only when nothing
 * matches better (as the backend does).
 */
export function groupItems(all: PaletteItem[]): PaletteGroup[] {
  const items = all.some((i) => i.rank < TYPO_RANK) ? all.filter((i) => i.rank < TYPO_RANK) : all;
  const groups = new Map<PaletteKind, PaletteItem[]>();
  for (const i of items) groups.set(i.kind, [...(groups.get(i.kind) ?? []), i]);
  const best = (g: PaletteItem[]) => Math.min(...g.map((i) => i.rank));
  return [...groups]
    .map(([kind, list]) => ({ kind, items: list }))
    .sort(
      (a, b) =>
        best(a.items) - best(b.items) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
    );
}

// ---------------------------------------------------------------------------------------
// Where a search result leads

export function resultLink(r: SearchResult, clusterId: string): RouteLocationRaw {
  const cluster = { cluster: clusterId };
  switch (r.kind) {
    case 'workload':
      return {
        name: 'workloads',
        query: {
          ...cluster,
          view: 'pods',
          wkind: r.type ?? '',
          wns: r.namespace ?? '',
          wname: r.name,
        },
      };
    case 'pod':
      return {
        name: 'pod',
        params: { namespace: r.namespace ?? '', name: r.name },
        query: cluster,
      };
    case 'node':
      return { name: 'node', params: { name: r.name }, query: cluster };
    case 'host':
      return { name: 'docker-host', params: { host: r.name }, query: cluster };
    case 'container':
      return {
        name: 'docker-container',
        params: { host: r.host ?? '', name: r.name },
        query: cluster,
      };
    case 'compose_project':
      return { name: 'containers', query: { ...cluster, project: r.name } };
    case 'application':
      return { name: 'application', params: { id: r.id ?? '' }, query: cluster };
  }
}

// ---------------------------------------------------------------------------------------
// Recent picks: the last five, in this browser only, per user.

export const RECENT_MAX = 5;
const RECENT_KEY = 'watchlog.palette.recent';

const recentKey = (userId: string) => `${RECENT_KEY}.${userId}`;

/** A pick as it is kept: without its rank. */
export type RecentItem = Omit<PaletteItem, 'rank'>;

export function loadRecent(userId: string): RecentItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(recentKey(userId)) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (i): i is RecentItem =>
          !!i &&
          typeof i === 'object' &&
          typeof (i as RecentItem).key === 'string' &&
          typeof (i as RecentItem).label === 'string' &&
          KIND_ORDER.includes((i as RecentItem).kind) &&
          !!(i as RecentItem).to,
      )
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** Puts a pick first, without duplicates, keeping five. */
export function addRecent(list: RecentItem[], item: PaletteItem): RecentItem[] {
  const kept: RecentItem & { rank?: number } = { ...item };
  delete kept.rank;
  return [kept, ...list.filter((i) => i.key !== item.key)].slice(0, RECENT_MAX);
}

export function saveRecent(userId: string, list: RecentItem[]): void {
  try {
    localStorage.setItem(recentKey(userId), JSON.stringify(list));
  } catch {
    // Private windows: the recent picks last for this visit.
  }
}

/** Whether a key event opens the palette: ⌘K / Ctrl+K anywhere, `/` outside a field. */
export function opensPalette(e: KeyboardEvent): boolean {
  if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey)
    return true;
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return false;
  const t = e.target as HTMLElement | null;
  if (!t || typeof t.closest !== 'function') return true;
  return !t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
}

/** ⌘ on Apple platforms, Ctrl elsewhere: what the button's hint shows. */
export function isApple(platform = typeof navigator === 'undefined' ? '' : navigator.platform) {
  return /mac|iphone|ipad|ipod/i.test(platform);
}
