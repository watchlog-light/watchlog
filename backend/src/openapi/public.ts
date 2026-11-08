// SPDX-License-Identifier: AGPL-3.0-only
// The public REST API (ADR-126): routes tagged `public` are the documented, stable
// contract for scripts and API tokens. GET /api/v1/openapi.json serves only them; the
// other routes are the dashboard's own and may change without notice.

/** The tag that makes a route public, readable by API tokens and listed in the spec. */
export const PUBLIC_TAG = 'public';

type Json = Record<string, unknown>;
const METHODS = ['get', 'head', 'post', 'put', 'patch', 'delete', 'options'] as const;

const DESCRIPTION = [
  'The public WatchLog API: what an API token can read, for Kubernetes clusters and Docker fleets.',
  'Authenticate with `Authorization: Bearer <token>` (Settings → API tokens).',
  'Stability (ADR-126): additions may come in any release. A breaking change comes only with',
  '/api/v2, or after a deprecation that lasts two minor versions. Routes not listed here are',
  "the dashboard's own and may change without notice.",
].join(' ');

/** Whether an operation (or a route schema) carries the public tag. */
export const isPublic = (tags: readonly string[] | undefined) => !!tags?.includes(PUBLIC_TAG);

/**
 * The public part of the full OpenAPI document: only operations tagged `public` (the tag
 * itself left out), with the bearer token as the security scheme. The input is not changed.
 */
export function publicSpec(full: Json): Json {
  const paths: Record<string, Json> = {};
  for (const [path, item] of Object.entries((full.paths ?? {}) as Record<string, Json>)) {
    const kept: Json = {};
    for (const method of METHODS) {
      const op = item[method] as { tags?: string[] } | undefined;
      if (!op || !isPublic(op.tags)) continue;
      const tags = op.tags!.filter((t) => t !== PUBLIC_TAG);
      kept[method] = { ...structuredClone(op), tags, security: [{ bearerAuth: [] }] };
    }
    if (Object.keys(kept).length) paths[path] = kept;
  }
  const info = (full.info ?? {}) as Json;
  return {
    openapi: full.openapi,
    info: { ...info, description: DESCRIPTION },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'A personal API token (`wl_pat_…`), read only.',
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
  };
}

/** Where the committed snapshot of the public spec lives (from the backend package). */
export const SNAPSHOT_PATH = '../packages/api-types/openapi.public.json';

/** The public spec as committed: the API version instead of the release version. */
export function snapshotOf(spec: Json): Json {
  return { ...spec, info: { ...(spec.info as Json), version: 'v1' } };
}
