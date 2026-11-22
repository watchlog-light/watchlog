// SPDX-License-Identifier: AGPL-3.0-only
// What changed's story for one window (0.14.0, ADR-231): the episodes in it, and for the
// selected one (the newest unless asked) the sentence, how it spread, the cause box, every
// check the probable-cause engine ran, what changed around then, and each series' minutes
// for its band sparkline. GET /what-changed adds it to its answer, and the MCP tool reads it
// from there; GET /what-changed/recent gives the last 7 days' episodes in brief.
import type { Database } from '../../db/index.js';
import type { ClusterScope, VictoriaQueryClient } from '../../lib/victoria.js';
import type { CausesAnswer } from '../causes/engine.js';
import type { Reader } from '../causes/evidence.js';
import { likelyCause, type CausesService, type LikelyCause } from '../causes/likely.js';
import {
  AROUND_AFTER_MS,
  AROUND_BEFORE_MS,
  chainOf,
  changeCause,
  changesAround,
  episodesOf,
  linkedChange,
  pickEpisode,
  storyOf,
  type Chain,
  type Change,
  type Clause,
  type Episode,
  type Related,
  type StoryRow,
} from '../causes/story.js';
import { parseSubject } from '../causes/subject.js';
import { INTEGRATION_KEYS, queriesFor, seriesHash, subjectOf } from './keys.js';
import { causeSubjectOf, oncePerSeries, sortRows, type ClusterKind, type RowView } from './read.js';
import type { OwnParts } from './live.js';
import { readChanges, relatedBy, workloadNodes, type MapRead } from './story-read.js';

/** Sparklines at most per story (the chain's series and the next ones). */
export const SPARKS_MAX = 8;
/** A sparkline's minutes before the series left its band and after the episode. */
const SPARK_PAD_MS = 10 * 60_000;
const SPARK_STEP_S = 60;

export interface ChangeView {
  at: string;
  kind: Change['kind'];
  name: string;
  namespace?: string;
  host?: string;
  facts: Change['facts'];
}

export const changeView = (c: Change): ChangeView => ({
  at: new Date(c.at).toISOString(),
  kind: c.kind,
  name: c.name,
  ...(c.namespace ? { namespace: c.namespace } : {}),
  ...(c.host ? { host: c.host } : {}),
  facts: c.facts,
});

export interface EpisodeView {
  from: string;
  to: string | null;
  count: number;
}

export interface StoryView {
  clauses: Clause[];
  chain: {
    nodes: (Omit<Chain['nodes'][number], 'at' | 'change'> & { at: string })[];
    more: number;
    linked: boolean;
  };
  change: ChangeView | null;
  cause: { state: 'likely' | 'change' | 'none'; change: Clause | null };
  checks: CausesAnswer['checks'];
  changes: ChangeView[];
  rows: RowView[];
  spark: { rowId: string; from: string; step: number; values: (number | null)[] }[];
}

export const storyRow = (r: RowView): StoryRow => ({
  id: r.id,
  since: Date.parse(r.since),
  until: r.until ? Date.parse(r.until) : null,
  key: r.key,
  object: r.object,
  peer: r.peer,
  value: r.value,
  usualLow: r.usualLow,
  usualHigh: r.usualHigh,
  peakScore: r.peakScore,
});

export const episodeView = (e: Episode): EpisodeView => ({
  from: new Date(e.from).toISOString(),
  to: e.to === null ? null : new Date(e.to).toISOString(),
  count: e.rowIds.length,
});

export interface StoryDeps {
  db: Database;
  causes?: CausesService | undefined;
  victoria?: VictoriaQueryClient | null | undefined;
  reader: Reader;
  log: { warn(obj: object, msg: string): void };
}

export interface StoryCluster {
  id: string;
  name: string;
  kind: ClusterKind;
  scope: ClusterScope;
  /** WatchLog's own parts when hidden: their changes are left out with their series. */
  own?: OwnParts | null;
}

/** Related for this cluster: its service map over the window, its pods' nodes. */
async function relatedFor(
  deps: StoryDeps,
  cluster: StoryCluster,
  rangeS: number,
): Promise<Related> {
  let map: MapRead | null = null;
  try {
    map = await deps.reader.get<MapRead>(`/clusters/${cluster.id}/service-map`, {
      range: Math.min(Math.max(rangeS, 900), 86_400),
    });
  } catch {
    // No map: only a shared node or server connects them.
  }
  const nodes =
    cluster.kind === 'kubernetes' ? await workloadNodes(deps.db, cluster.id) : new Map();
  return relatedBy(cluster.kind, map, nodes);
}

/** Each sparkline's minutes, one query per metric key. */
async function sparks(
  deps: StoryDeps,
  cluster: StoryCluster,
  rows: RowView[],
  fromMs: number,
  toMs: number,
): Promise<StoryView['spark']> {
  if (!deps.victoria || !rows.length) return [];
  const queries = queriesFor(cluster.kind, Object.keys(INTEGRATION_KEYS));
  const from = Math.floor(fromMs / 60_000) * 60;
  const to = Math.ceil(toMs / 60_000) * 60;
  const out: StoryView['spark'] = [];
  for (const key of [...new Set(rows.map((r) => r.key))]) {
    const q = queries.find((x) => x.key === key);
    if (!q) continue;
    try {
      const series = await deps.victoria.queryRange(cluster.scope, q.expr, from, to, SPARK_STEP_S);
      for (const r of rows.filter((x) => x.key === key)) {
        // jsonb reorders a stored subject's keys: compare in subjectOf's fixed order.
        const hash = seriesHash(r.key, subjectOf(r.subject)).toString('hex');
        const s = series.find((x) => seriesHash(key, subjectOf(x.labels)).toString('hex') === hash);
        if (!s) continue;
        const values = new Map(s.points.map(([t, v]) => [t, v]));
        const list: (number | null)[] = [];
        for (let t = from; t <= to; t += SPARK_STEP_S) list.push(values.get(t) ?? null);
        out.push({
          rowId: r.id,
          from: new Date(from * 1000).toISOString(),
          step: SPARK_STEP_S,
          values: list,
        });
      }
    } catch (err) {
      // The numbers stand on their own without the line.
      deps.log.warn({ err: (err as Error).message }, 'what-changed spark failed');
    }
  }
  return out;
}

export interface BuiltStory {
  episodes: EpisodeView[];
  episode: number;
  story: StoryView | null;
  /** The probable cause's subject and likely cause for the selected episode. */
  subject: string | null;
  likely: LikelyCause | null;
}

/**
 * The window's episodes and the selected one's story. `all` is every period in the window
 * (own parts already left out when hidden).
 */
export async function buildStory(
  deps: StoryDeps,
  cluster: StoryCluster,
  orgId: string,
  all: RowView[],
  w: { fromMs: number; toMs: number },
  nowMs: number,
  episodeFromMs?: number,
): Promise<BuiltStory> {
  const episodes = episodesOf(all.map(storyRow), nowMs);
  const i = pickEpisode(episodes, episodeFromMs);
  const base = { episodes: episodes.map(episodeView), episode: i };
  if (i < 0) return { ...base, story: null, subject: null, likely: null };
  const ep = episodes[i]!;
  const ids = new Set(ep.rowIds);
  const rows = sortRows(oncePerSeries(all.filter((r) => ids.has(r.id))), 'first');
  const srows = rows.map(storyRow);
  const end = ep.to ?? nowMs;
  const [changes, related] = await Promise.all([
    readChanges(
      deps.db,
      cluster.id,
      ep.from - AROUND_BEFORE_MS,
      end + AROUND_AFTER_MS,
      cluster.own ?? null,
    ),
    relatedFor(deps, cluster, Math.ceil((end - ep.from) / 1000) + 3600),
  ]);
  const first = srows[0]!;
  const change = linkedChange(first, changes, related);
  const chain = chainOf(srows, change, related);
  const clauses = storyOf(srows, change, chain);
  // The probable-cause engine on the first series it can explain: its likely cause and checks.
  const subject = rows.map((r) => causeSubjectOf(r.object)).find((s) => s !== null) ?? null;
  let answer: CausesAnswer | undefined;
  if (subject && deps.causes) {
    try {
      [answer] = await deps.causes.answers(deps.reader, orgId, [
        {
          cluster: { id: cluster.id, name: cluster.name, kind: cluster.kind },
          subject: parseSubject(subject),
        },
      ]);
    } catch (err) {
      deps.log.warn({ err: (err as Error).message }, 'what-changed story cause failed');
    }
  }
  const likely = answer ? (likelyCause(answer) ?? null) : null;
  const byChange = changeCause(first, change);
  const shownIds = new Set([
    ...chain.nodes.flatMap((n) => (n.rowId ? [n.rowId] : [])),
    ...rows.slice(0, SPARKS_MAX).map((r) => r.id),
  ]);
  const spark = await sparks(
    deps,
    cluster,
    rows.filter((r) => shownIds.has(r.id)).slice(0, SPARKS_MAX),
    ep.from - SPARK_PAD_MS,
    Math.min(end + SPARK_PAD_MS, nowMs),
  );
  return {
    ...base,
    subject,
    likely,
    story: {
      clauses,
      chain: {
        nodes: chain.nodes.map((n) => ({
          kind: n.kind,
          rowId: n.rowId,
          who: n.who,
          gapMin: n.gapMin,
          linked: n.linked,
          at: new Date(n.at).toISOString(),
        })),
        more: chain.more,
        linked: chain.linked,
      },
      change: change ? changeView(change) : null,
      cause: { state: likely ? 'likely' : byChange ? 'change' : 'none', change: byChange },
      checks: answer?.checks ?? [],
      changes: changesAround(changes, ep, nowMs).map(changeView),
      rows,
      spark,
    },
  };
}

/** The last 7 days' episodes in brief (the quiet page): when, the sentence, the linked change. */
export async function recentEpisodes(
  deps: Pick<StoryDeps, 'db'>,
  cluster: StoryCluster,
  all: RowView[],
  nowMs: number,
  max: number,
): Promise<
  { from: string; to: string | null; count: number; clauses: Clause[]; cause: Clause | null }[]
> {
  const episodes = episodesOf(all.map(storyRow), nowMs).slice(-max).reverse();
  if (!episodes.length) return [];
  const span = { from: Math.min(...episodes.map((e) => e.from)), to: nowMs };
  const changes = await readChanges(
    deps.db,
    cluster.id,
    span.from - AROUND_BEFORE_MS,
    span.to,
    cluster.own ?? null,
  );
  // In brief, related is a shared node or server only: no map read per episode.
  const nodes =
    cluster.kind === 'kubernetes' ? await workloadNodes(deps.db, cluster.id) : new Map();
  const related = relatedBy(cluster.kind, null, nodes);
  return episodes.map((ep) => {
    const ids = new Set(ep.rowIds);
    const rows = sortRows(oncePerSeries(all.filter((r) => ids.has(r.id))), 'first').map(storyRow);
    const change = linkedChange(rows[0]!, changes, related);
    const chain = chainOf(rows, change, related);
    return {
      ...episodeView(ep),
      clauses: storyOf(rows, change, chain),
      cause: changeCause(rows[0], change),
    };
  });
}
