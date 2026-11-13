// SPDX-License-Identifier: AGPL-3.0-only
// GET /clusters/:id/search (ADR-169, SPEC §8.1): the ⌘K palette's search of one cluster's
// objects by name, in PostgreSQL. Kubernetes: workloads, pods, nodes; Docker: hosts,
// containers, Compose projects; both: applications. At most 8 per kind and 40 in all, the
// best matches first (match.ts). A 15,000-pod cluster is never sent to the browser.
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { sql, type RawBuilder } from 'kysely';
import { Type } from 'typebox';
import type { Database } from '../../db/index.js';
import { sendProblem } from '../../lib/problem.js';
import { PUBLIC_TAG } from '../../openapi/public.js';
import { requireUser } from '../../plugins/auth.js';
import { ProblemSchema } from '../auth/schemas.js';
import { clusterForOrg } from '../clusters/service.js';
import { WORKLOAD_KINDS } from '../kubernetes/views.js';
import { patterns, type SearchPatterns, type Tier } from './match.js';

export const PER_KIND = 8;
export const MAX_RESULTS = 40;

export const RESULT_KINDS = [
  'workload',
  'pod',
  'node',
  'host',
  'container',
  'compose_project',
  'application',
] as const;
type ResultKind = (typeof RESULT_KINDS)[number];

export const SearchResultSchema = Type.Object({
  kind: Type.Union([
    Type.Literal('workload'),
    Type.Literal('pod'),
    Type.Literal('node'),
    Type.Literal('host'),
    Type.Literal('container'),
    Type.Literal('compose_project'),
    Type.Literal('application'),
  ]),
  name: Type.String(),
  namespace: Type.Union([Type.String(), Type.Null()], {
    description: 'Kubernetes namespace; the Compose project of a Docker container',
  }),
  host: Type.Union([Type.String(), Type.Null()], {
    description: 'Docker host of a container or a Compose project (its first host)',
  }),
  type: Type.Union([Type.String(), Type.Null()], {
    description: "The workload's kind (Deployment, …) or the application's type (redis, …)",
  }),
  id: Type.Union([Type.String(), Type.Null()], { description: "The application's id" }),
  match: Type.Union(
    [
      Type.Literal('exact'),
      Type.Literal('prefix'),
      Type.Literal('substring'),
      Type.Literal('path'),
      Type.Literal('letters'),
      Type.Literal('typo'),
    ],
    {
      description:
        'exact, prefix (the name starts with the query), substring, path (namespace or host and name), letters (in order), typo (one letter off)',
    },
  ),
});

export const SearchSchema = Type.Object({
  query: Type.String(),
  results: Type.Array(SearchResultSchema),
  /** More matched than were returned. */
  truncated: Type.Boolean(),
});

export type Row = {
  grp: ResultKind;
  kind: string;
  namespace: string;
  name: string;
  node: string;
  rank: number;
  id?: string | null;
};

const raw = (s: string) => sql.raw(s);

/**
 * The rank of a match: 0 exact, 1 prefix, 2 substring, 3 path, 4 letters in the name, 5
 * letters in the path, 6 one typo. `n` is the name, `hay` the name with what else matches.
 */
function rankSql(p: SearchPatterns, n: RawBuilder<unknown>, hay: RawBuilder<unknown>) {
  const all = (col: RawBuilder<unknown>) =>
    sql.join(
      p.words.map((w) => sql`${col} LIKE ${w.letters}`),
      sql` AND `,
    );
  return sql<number>`CASE
    WHEN ${n} LIKE ${p.whole} THEN 0
    WHEN ${n} LIKE ${`${p.whole}%`} THEN 1
    WHEN ${n} LIKE ${`%${p.whole}%`} THEN 2
    WHEN ${hay} LIKE ${`%${p.whole}%`} THEN 3
    WHEN ${all(n)} THEN 4
    WHEN ${all(hay)} THEN 5
    ELSE 6 END`;
}

const TYPO_RANK = 6;
/** A rank's tier in the answer. */
const TIER_OF_RANK: Tier[] = ['exact', 'prefix', 'substring', 'path', 'letters', 'letters', 'typo'];

/** Every word in order, or with one typo. */
function matchSql(p: SearchPatterns, hay: RawBuilder<unknown>) {
  return sql.join(
    p.words.map(
      (w) =>
        sql`(${sql.join(
          [w.letters, ...w.typos].map((pat) => sql`${hay} LIKE ${pat}`),
          sql` OR `,
        )})`,
    ),
    sql` AND `,
  );
}

const KUBE_KINDS = [...WORKLOAD_KINDS, 'Pod', 'Node'];
const DOCKER_KINDS = ['DockerHost', 'DockerContainer'];

async function searchObjects(
  db: Database,
  clusterId: string,
  kinds: string[],
  p: SearchPatterns,
): Promise<Row[]> {
  const n = raw('lower(name)');
  const hay = raw("lower(CASE WHEN namespace <> '' THEN namespace || '/' ELSE '' END || name)");
  const { rows } = await sql<Row>`
    SELECT grp, kind, namespace, name, node, rank FROM (
      SELECT *, row_number() OVER (PARTITION BY grp ORDER BY rank, length(name), name) AS rn
      FROM (
        SELECT
          CASE kind WHEN 'Pod' THEN 'pod' WHEN 'Node' THEN 'node' WHEN 'DockerHost' THEN 'host'
            WHEN 'DockerContainer' THEN 'container' ELSE 'workload' END AS grp,
          kind, namespace, name, node, ${rankSql(p, n, hay)} AS rank
        FROM objects
        WHERE cluster_id = ${clusterId} AND deleted_at IS NULL
          AND kind IN (${sql.join(kinds)})
          AND NOT (kind = 'Job' AND spec_summary ? 'cronjob')
          AND ${matchSql(p, hay)}
      ) m
    ) r
    WHERE rn <= ${PER_KIND + 1}
    ORDER BY grp, rn`.execute(db);
  return rows;
}

/** Compose projects: the Compose project label of the fleet's containers. */
async function searchProjects(db: Database, clusterId: string, p: SearchPatterns) {
  const n = raw('lower(namespace)');
  const { rows } = await sql<Row>`
    SELECT 'compose_project' AS grp, 'ComposeProject' AS kind, '' AS namespace,
      namespace AS name, min(node) AS node, ${rankSql(p, n, n)} AS rank
    FROM objects
    WHERE cluster_id = ${clusterId} AND deleted_at IS NULL
      AND kind = 'DockerContainer' AND namespace <> ''
      AND ${matchSql(p, n)}
    GROUP BY namespace
    ORDER BY rank, length(namespace), namespace
    LIMIT ${PER_KIND + 1}`.execute(db);
  return rows;
}

/** Applications: by name, or by type ("redis" finds every Redis). */
async function searchApplications(db: Database, clusterId: string, p: SearchPatterns) {
  const n = raw('lower(name)');
  const hay = raw("lower(type || '/' || name)");
  const { rows } = await sql<Row>`
    SELECT 'application' AS grp, type AS kind, coalesce(target->>'namespace', target->>'compose_project', '') AS namespace,
      name, coalesce(target->>'host', '') AS node, id, ${rankSql(p, n, hay)} AS rank
    FROM integrations
    WHERE cluster_id = ${clusterId} AND ${matchSql(p, hay)}
    ORDER BY rank, length(name), name
    LIMIT ${PER_KIND + 1}`.execute(db);
  return rows;
}

/**
 * Up to PER_KIND per kind and `limit` in all, the best ranks kept; listed kind by kind,
 * the kind with the best match first.
 * Exported for its test.
 */
export function pick(found: Row[], limit: number) {
  const order = (k: ResultKind) => RESULT_KINDS.indexOf(k);
  // One-typo matches are a fallback: shown only when nothing matches better.
  const rows = found.some((r) => Number(r.rank) < TYPO_RANK)
    ? found.filter((r) => Number(r.rank) < TYPO_RANK)
    : found;
  const perKind = new Map<ResultKind, Row[]>();
  for (const r of rows) {
    const list = perKind.get(r.grp) ?? [];
    list.push(r);
    perKind.set(r.grp, list);
  }
  let truncated = false;
  const capped: Row[] = [];
  for (const list of perKind.values()) {
    if (list.length > PER_KIND) truncated = true;
    capped.push(...list.slice(0, PER_KIND));
  }
  const best = capped
    .map((r, i) => ({ r, i }))
    .sort(
      (a, b) => Number(a.r.rank) - Number(b.r.rank) || order(a.r.grp) - order(b.r.grp) || a.i - b.i,
    );
  if (best.length > limit) truncated = true;
  // Kinds in the order of their best match (an exact node before pods matching by letters).
  const top = best.slice(0, limit);
  const lead = new Map<ResultKind, number>();
  top.forEach(({ r }, i) => lead.set(r.grp, Math.min(lead.get(r.grp) ?? i, i)));
  const kept = top
    .sort((a, b) => lead.get(a.r.grp)! - lead.get(b.r.grp)! || a.i - b.i)
    .map(({ r }) => r);
  return { kept, truncated };
}

const toResult = (r: Row) => {
  const docker = r.grp === 'container' || r.grp === 'compose_project';
  return {
    kind: r.grp,
    name: r.name,
    namespace:
      r.grp === 'workload' || r.grp === 'pod' || r.grp === 'container' || r.grp === 'application'
        ? r.namespace || null
        : null,
    host: docker || r.grp === 'application' ? r.node || null : null,
    type: r.grp === 'workload' || r.grp === 'application' ? r.kind : null,
    id: r.grp === 'application' ? (r.id ?? null) : null,
    match: TIER_OF_RANK[Number(r.rank)] ?? 'typo',
  };
};

export const searchRoutes: FastifyPluginAsyncTypebox<{ db: Database }> = async (app, { db }) => {
  const signedIn = requireUser();

  app.get(
    '/clusters/:id/search',
    {
      preHandler: signedIn,
      schema: {
        summary: 'Search a cluster by name',
        description:
          "The ⌘K palette's search (ADR-169): workloads, pods and nodes of a Kubernetes cluster; hosts, containers and Compose projects of a Docker fleet; applications on both. Case-insensitive; a word matches when its letters appear in order in the name (with its namespace, Compose project or type), or with one letter off for words of 4 to 32 letters. The exact name first, then names starting with the query, then names containing it, then the rest. At most 8 per kind.",
        tags: ['search', PUBLIC_TAG],
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        querystring: Type.Object({
          q: Type.String({ minLength: 1, maxLength: 200, description: 'What to look for' }),
          limit: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: MAX_RESULTS,
              description: `At most this many results (default and maximum ${MAX_RESULTS})`,
            }),
          ),
        }),
        response: {
          200: SearchSchema,
          401: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, 'Cluster not found');
      const { q } = request.query;
      const p = patterns(q);
      if (!p) return { query: q, results: [], truncated: false };
      const docker = cluster.kind === 'docker';
      const found = await Promise.all([
        searchObjects(db, cluster.id, docker ? DOCKER_KINDS : KUBE_KINDS, p),
        docker ? searchProjects(db, cluster.id, p) : Promise.resolve([]),
        searchApplications(db, cluster.id, p),
      ]);
      const { kept, truncated } = pick(found.flat(), request.query.limit ?? MAX_RESULTS);
      return { query: q, results: kept.map(toResult), truncated };
    },
  );
};
