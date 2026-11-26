// SPDX-License-Identifier: AGPL-3.0-only
// What changed's story (0.14.0, ADR-231): what an episode of unusual series says, built from
// fixed templates, never by an AI. Pure, on given rows and changes, so every rule is tested:
//
//   - an episode is a stretch where one series or more is outside its usual range: the
//     periods in the window, merged while they overlap or are less than 5 minutes apart;
//   - the change linked to it: one that started at most 15 minutes before the first series
//     moved, on the first series' own object, its node or server, or something it calls or is
//     called by on the service map (a rollout, an image change, a scale, a Compose or container
//     recreate, a service start, restart or failure, a new executable, a scheduled run);
//   - the chain: the linked change, then the series by first-move time, at most 6 boxes; two
//     series are connected only when the service map has calls between them or they share a
//     node or server, otherwise they "moved at the same time; no calls between them";
//   - the sentence: clauses as codes and facts (ADR-147), worded by the dashboard: "<first>
//     went to 14× usual 2 minutes after <the change>", "<next> then …", "and <last> …";
//   - changed around then: every change from 30 minutes before the episode to 5 after it.
// The facts name things in the platform's own words (ADR-124): "shop/backend", "postgres ·
// db-1", "api (pm2) · app-1".
import type { ObjectView } from '../anomaly/read.js';

export const EPISODE_GAP_MS = 5 * 60_000;
/** A change counts as the episode's when it started at most this long before the first move. */
export const CHANGE_WINDOW_MS = 15 * 60_000;
/** "Changed around then": from this long before the episode... */
export const AROUND_BEFORE_MS = 30 * 60_000;
/** ...to this long after it. */
export const AROUND_AFTER_MS = 5 * 60_000;
/** Boxes in the chain at most, the change included; the rest is "and N more". */
export const CHAIN_MAX = 6;

export interface StoryRow {
  id: string;
  since: number;
  until: number | null;
  key: string;
  object: ObjectView;
  peer: string | null;
  value: number;
  usualLow: number;
  usualHigh: number;
  peakScore: number;
}

export interface Episode {
  from: number;
  /** null while one of its series is still outside. */
  to: number | null;
  rowIds: string[];
}

export type ChangeKind =
  | 'rollout'
  | 'image'
  | 'scale'
  | 'compose'
  | 'recreate'
  | 'node'
  | 'service_start'
  | 'service_restart'
  | 'service_failed'
  | 'unit_changed'
  | 'release'
  | 'job_run'
  // Told from outside with a token (ADR-238): a deploy, a config change, a migration.
  | 'external'
  // A switch or router the place sits behind (ADR-233, from the network module's events).
  | 'port_down'
  | 'port_up'
  | 'port_speed'
  | 'port_errors'
  | 'uplink_errors'
  | 'device_reboot';

/** Something that changed in the place: a marker, a server event, a scheduled run. */
export interface Change {
  at: number;
  kind: ChangeKind;
  /** What changed: its name, and where (namespace, server). */
  name: string;
  namespace?: string;
  host?: string;
  facts: Record<string, string | number | null>;
}

export interface Clause {
  code: string;
  facts: Record<string, string | number | null>;
}

export interface ChainNode {
  kind: 'change' | 'first' | 'then';
  /** The series' row, or null for the change. */
  rowId: string | null;
  who: string;
  at: number;
  /** Minutes since the box before; null on the first box. */
  gapMin: number | null;
  /** Connected to the box before by calls on the service map or a shared node or server. */
  linked: boolean;
  change?: Change;
}

export interface Chain {
  nodes: ChainNode[];
  /** Series left out of the boxes. */
  more: number;
  /** Some two consecutive series are connected (the boxes get arrows). */
  linked: boolean;
}

// --------------------------------------------------------------------------- the words

/** What a series is about, as the story names it. */
export function whoOf(o: ObjectView): string {
  if (o.kind === 'workload') {
    if (o.namespace) return `${o.namespace}/${o.name}`;
    if (o.host) {
      return o.workloadKind === 'ProcessGroup' ? `${o.name} · ${o.host}` : `${o.name} · ${o.host}`;
    }
    return o.name;
  }
  if (o.kind === 'container') {
    const name = o.composeService ?? o.name;
    return o.host ? `${name} · ${o.host}` : name;
  }
  return o.name;
}

/** How far out a value is: "14× usual" up, "÷1.5 usual" down, against its band's edge. */
export function factorOf(r: Pick<StoryRow, 'value' | 'usualLow' | 'usualHigh'>): {
  x: number;
  dir: 'up' | 'down';
} {
  const round = (x: number) => (x >= 10 ? Math.round(x) : Math.round(x * 10) / 10);
  if (r.value >= r.usualHigh) {
    const edge = r.usualHigh > 0 ? r.usualHigh : Math.max(r.usualHigh - r.usualLow, 1e-9);
    return { x: Math.min(999, round(r.value / edge)), dir: 'up' };
  }
  const x = r.value > 0 ? r.usualLow / r.value : 999;
  return { x: Math.min(999, round(x)), dir: 'down' };
}

// ----------------------------------------------------------------------------- episodes

/** The window's periods merged into episodes, oldest first. */
export function episodesOf(
  rows: Pick<StoryRow, 'id' | 'since' | 'until'>[],
  nowMs: number,
): Episode[] {
  const sorted = rows.slice().sort((a, b) => a.since - b.since || a.id.localeCompare(b.id));
  const out: (Episode & { end: number })[] = [];
  for (const r of sorted) {
    const end = r.until ?? nowMs;
    const last = out[out.length - 1];
    if (last && r.since <= last.end + EPISODE_GAP_MS) {
      last.rowIds.push(r.id);
      if (r.until === null) last.to = null;
      if (end > last.end) {
        last.end = end;
        if (last.to !== null) last.to = end;
      }
    } else {
      out.push({ from: r.since, to: r.until === null ? null : end, end, rowIds: [r.id] });
    }
  }
  return out.map(({ from, to, rowIds }) => ({ from, to, rowIds }));
}

/** Which episode a request means: the one starting at `fromMs`, else the newest. */
export function pickEpisode(episodes: Episode[], fromMs?: number): number {
  if (!episodes.length) return -1;
  if (fromMs !== undefined) {
    const i = episodes.findIndex((e) => e.from === fromMs);
    if (i >= 0) return i;
  }
  return episodes.length - 1;
}

// ------------------------------------------------------------------------------ changes

/** Whether two things are related: calls between them on the map, or a shared node or server. */
export type Related = (a: ObjectView, b: ObjectView) => boolean;

/** Whether a change is about a series' object, its server, or something related to it. */
function changeTouches(c: Change, o: ObjectView, related: Related): boolean {
  const host = o.host;
  if (c.host && host && c.host === host) return true;
  if (c.kind === 'node' && o.kind === 'node' && c.name === o.name) return true;
  const target: ObjectView =
    c.kind === 'job_run' ||
    c.kind.startsWith('service_') ||
    c.kind === 'unit_changed' ||
    c.kind === 'release'
      ? {
          kind: 'workload',
          name: c.name,
          workloadKind: 'Service',
          ...(c.host ? { host: c.host } : {}),
        }
      : c.namespace
        ? { kind: 'workload', name: c.name, namespace: c.namespace }
        : { kind: 'container', name: c.name, ...(c.host ? { host: c.host } : {}) };
  const sameName =
    target.name === o.name ||
    (o.kind === 'container' && (o.composeService === target.name || o.name === target.name));
  if (sameName && (target.namespace ?? '') === (o.namespace ?? '')) return true;
  return related(o, target);
}

/**
 * The change the episode is linked to: started at most 15 minutes before the first move, on
 * the first series' object, its node or server, or something related to it; the latest such.
 */
export function linkedChange(first: StoryRow, changes: Change[], related: Related): Change | null {
  const fit = changes
    .filter(
      (c) =>
        c.at <= first.since &&
        c.at >= first.since - CHANGE_WINDOW_MS &&
        changeTouches(c, first.object, related),
    )
    .sort((a, b) => b.at - a.at);
  return fit[0] ?? null;
}

/** Changed around then: every change from 30 minutes before the episode to 5 after it. */
export function changesAround(changes: Change[], ep: Episode, nowMs: number): Change[] {
  const end = ep.to ?? nowMs;
  return changes
    .filter((c) => c.at >= ep.from - AROUND_BEFORE_MS && c.at <= end + AROUND_AFTER_MS)
    .sort((a, b) => a.at - b.at);
}

// -------------------------------------------------------------------------------- chain

/** One box per series, by first move (the furthest first among equal starts). */
const byFirstMove = (a: StoryRow, b: StoryRow) =>
  a.since - b.since || b.peakScore - a.peakScore || a.id.localeCompare(b.id);

export function chainOf(rows: StoryRow[], change: Change | null, related: Related): Chain {
  const sorted = rows.slice().sort(byFirstMove);
  const room = CHAIN_MAX - (change ? 1 : 0);
  const shown = sorted.slice(0, room);
  const nodes: ChainNode[] = [];
  if (change) {
    nodes.push({
      kind: 'change',
      rowId: null,
      who: change.name,
      at: change.at,
      gapMin: null,
      linked: false,
      change,
    });
  }
  let prev: { at: number; object?: ObjectView } | null = change ? { at: change.at } : null;
  let anyLinked = false;
  shown.forEach((r, i) => {
    const linked =
      prev === null ? false : prev.object === undefined ? true : related(prev.object, r.object);
    if (i > 0 && linked) anyLinked = true;
    nodes.push({
      kind: i === 0 ? 'first' : 'then',
      rowId: r.id,
      who: whoOf(r.object),
      at: r.since,
      gapMin: prev === null ? null : Math.max(0, Math.round((r.since - prev.at) / 60_000)),
      linked,
    });
    prev = { at: r.since, object: r.object };
  });
  return {
    nodes,
    more: sorted.length - shown.length,
    linked: anyLinked || (shown.length === 1 && !!change),
  };
}

// ------------------------------------------------------------------------------- story

const seriesFacts = (r: StoryRow) => {
  const f = factorOf(r);
  return { who: whoOf(r.object), key: r.key, peer: r.peer, x: f.x, dir: f.dir };
};

/** What a change is, as the story's facts say it. */
export function changeFacts(c: Change): Record<string, string | number | null> {
  return {
    change: c.kind,
    target: c.name,
    host: c.host ?? null,
    namespace: c.namespace ?? null,
    ...c.facts,
  };
}

/**
 * The episode in one sentence, as clauses (ADR-147):
 *   after_change: "<first> went to <x> usual <gap> min after <change>"
 *   first:        "<first> went to <x> usual first"
 *   then:         "<next> then went to <x> usual" (the last of up to two with `and`)
 *   same_time:    "at the same time, <next> went to <x> usual" (no calls between them)
 *   more:         "and N more things moved"
 */
export function storyOf(rows: StoryRow[], change: Change | null, chain: Chain): Clause[] {
  const sorted = rows.slice().sort(byFirstMove);
  if (!sorted.length) return [];
  const first = sorted[0]!;
  const out: Clause[] = [];
  if (change) {
    out.push({
      code: 'after_change',
      facts: {
        ...seriesFacts(first),
        gap: Math.max(0, Math.round((first.since - change.at) / 60_000)),
        ...changeFacts(change),
      },
    });
  } else {
    out.push({ code: 'first', facts: seriesFacts(first) });
  }
  const next = sorted.slice(1, 3);
  next.forEach((r, i) => {
    const node = chain.nodes.find((n) => n.rowId === r.id);
    const linked = node ? node.linked : false;
    out.push({
      code: linked ? 'then' : 'same_time',
      facts: { ...seriesFacts(r), and: i === next.length - 1 && next.length > 1 ? 1 : 0 },
    });
  });
  if (sorted.length > 3) out.push({ code: 'more', facts: { n: sorted.length - 3 } });
  return out;
}

/**
 * The cause box when the probable-cause engine has no likely cause of its own: the linked
 * change, or null for "No clear cause".
 */
export function changeCause(first: StoryRow | undefined, change: Change | null): Clause | null {
  if (!first || !change) return null;
  return {
    code: 'change',
    facts: {
      ...changeFacts(change),
      at: new Date(change.at).toISOString(),
      gap: Math.max(0, Math.round((first.since - change.at) / 60_000)),
      who: whoOf(first.object),
    },
  };
}
