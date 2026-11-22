// SPDX-License-Identifier: AGPL-3.0-only
// What changed's live map (0.14.0, ADR-231): every scored series as one square, grouped the
// platform's way, coloured by the worker's own state (inside in three shades, near the edge,
// outside). Kubernetes: by workload ("shop/backend"), nodes by name. A Server fleet: by server,
// each server's services, process groups and containers right after it ("postgres · db-1").
// Groups with something outside come first, then near the edge; past 14 groups the rest fold
// into "16 more". WatchLog's own parts drop out when hidden. Pure: the page gives the series.
import type { WhatChangedLive } from '@watchlog/api-types';

export type LiveSeries = WhatChangedLive['series'][number];
export type LiveState = LiveSeries['state'];

/** Groups shown before the rest fold. */
export const MAP_GROUPS = 14;

export interface MapCell {
  id: string;
  state: LiveState;
  shade: number;
  series: LiveSeries;
}

export interface MapGroup {
  /** What the group is: its name on the page and in the focus link. */
  key: string;
  name: string;
  /** A Server fleet's server the group belongs to ('' on Kubernetes). */
  host: string;
  cells: MapCell[];
  outside: number;
  near: number;
}

export interface LiveMap {
  groups: MapGroup[];
  /** The groups past MAP_GROUPS, as one: their count and their squares. */
  folded: { groups: number; cells: MapCell[] } | null;
  counts: { inside: number; near: number; outside: number };
  total: number;
  /** WatchLog's own series (the toggle's count), whether shown or not. */
  own: number;
}

const STATE_ORDER: Record<LiveState, number> = { outside: 0, near: 1, inside: 2 };

/** The group a series belongs to, in the platform's words. */
export function groupOf(
  s: Pick<LiveSeries, 'object'>,
  kind: 'kubernetes' | 'server',
): { key: string; host: string } {
  const o = s.object;
  if (kind === 'kubernetes') {
    if (o.kind === 'workload' && o.namespace) return { key: `${o.namespace}/${o.name}`, host: '' };
    return { key: o.name, host: '' };
  }
  if (o.kind === 'host') return { key: o.name, host: o.name };
  if (o.kind === 'container') {
    const name = o.composeService ?? o.name;
    return o.host ? { key: `${name} · ${o.host}`, host: o.host } : { key: name, host: '' };
  }
  if (o.kind === 'workload' && o.host) return { key: `${o.name} · ${o.host}`, host: o.host };
  return { key: o.name, host: '' };
}

export function liveMap(
  series: LiveSeries[],
  kind: 'kubernetes' | 'server',
  hideOwn: boolean,
): LiveMap {
  const own = series.filter((s) => s.own).length;
  const shown = hideOwn ? series.filter((s) => !s.own) : series;
  const byKey = new Map<string, MapGroup>();
  for (const s of shown) {
    const g = groupOf(s, kind);
    let group = byKey.get(g.key);
    if (!group) {
      group = { key: g.key, name: g.key, host: g.host, cells: [], outside: 0, near: 0 };
      byKey.set(g.key, group);
    }
    group.cells.push({ id: s.id, state: s.state, shade: s.shade, series: s });
    if (s.state === 'outside') group.outside++;
    if (s.state === 'near') group.near++;
  }
  const tier = (g: MapGroup) => (g.outside ? 0 : g.near ? 1 : 2);
  // A server's groups follow their server: the server's tier is its worst group's.
  const hostTier = new Map<string, number>();
  for (const g of byKey.values()) {
    if (g.host) hostTier.set(g.host, Math.min(hostTier.get(g.host) ?? 2, tier(g)));
  }
  const groups = [...byKey.values()];
  for (const g of groups) {
    g.cells.sort(
      (a, b) =>
        STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
        b.shade - a.shade ||
        a.id.localeCompare(b.id),
    );
  }
  groups.sort((a, b) => {
    const ta = a.host ? hostTier.get(a.host)! : tier(a);
    const tb = b.host ? hostTier.get(b.host)! : tier(b);
    if (ta !== tb) return ta - tb;
    if (a.host !== b.host) return (a.host || a.key).localeCompare(b.host || b.key);
    // On a server: the server itself first, then its services by their own trouble.
    const sa = a.key === a.host ? -1 : tier(a);
    const sb = b.key === b.host ? -1 : tier(b);
    return sa - sb || b.outside - a.outside || a.key.localeCompare(b.key);
  });
  const counts = { inside: 0, near: 0, outside: 0 };
  for (const s of shown) counts[s.state]++;
  const kept = groups.slice(0, MAP_GROUPS);
  const rest = groups.slice(MAP_GROUPS);
  return {
    groups: kept,
    folded: rest.length ? { groups: rest.length, cells: rest.flatMap((g) => g.cells) } : null,
    counts,
    total: shown.length,
    own,
  };
}

/** "checked 12 s ago" from the worker's last minute and the clock. */
export function checkedAgo(scoredAt: string | null, nowMs: number): number | null {
  if (!scoredAt) return null;
  return Math.max(0, Math.round((nowMs - Date.parse(scoredAt)) / 1000));
}
