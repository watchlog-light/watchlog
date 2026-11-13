// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import { refuseCluster } from '../entitlements/limits.js';
import type { Config } from '../../config.js';
import { isUniqueViolation, type Database } from '../../db/index.js';
import { ProblemType, sendProblem } from '../../lib/problem.js';
import { requireRole, requireUser } from '../../plugins/auth.js';
import { ProblemSchema } from '../auth/schemas.js';
import {
  dockerComposeSnippet,
  dockerRunCommand,
  helmInstallCommand,
  installTarget,
  kubectlApplyCommand,
} from './install.js';
import { issueInstallCode, revokeInstallCodes } from '../onboarding/install-codes.js';
import { recordFunnelEvent } from '../accounts/service.js';
import {
  ClusterDetailSchema,
  ClusterIdParams,
  ClusterListSchema,
  ClusterName,
  CreateClusterResponseSchema,
  IssueTokenResponseSchema,
  TokenParams,
} from './schemas.js';
import {
  countActiveTokens,
  clusterForOrg,
  insertCluster,
  listClusters,
  listTokens,
  MAX_ACTIVE_TOKENS,
  toClusterView,
  toTokenView,
} from './service.js';
import { issueClusterToken, type IssuedToken } from './tokens.js';
import type { SettingsService } from '../settings/service.js';
import type { TokenCache } from '../ingest/token-cache.js';
import { ingestFailures } from '../ingest/errors.js';
import { PUBLIC_TAG } from '../../openapi/public.js';

const NOT_FOUND = 'Cluster not found';

export const clusterRoutes: FastifyPluginAsyncTypebox<{
  db: Database;
  config: Config;
  tokens: TokenCache;
  settings: SettingsService;
}> = async (app, { db, config, tokens, settings }) => {
  const signedIn = requireUser();
  const canManage = [signedIn, requireRole('owner', 'admin')];
  const { image, version, endpointFor } = installTarget(config, settings);

  /**
   * The new token and its install commands. Cloud adds the Compose snippet, and the kubectl
   * command with an install code for this token (ADR-176); Community's are as in 0.5.0.
   */
  async function issuedTokenBody(
    request: FastifyRequest,
    token: IssuedToken,
    cluster: { id: string; org_id: string; kind: string },
    trx: Database = db,
  ) {
    const endpoint = await endpointFor(request);
    const cloud = config.edition === 'cloud';
    const code =
      cloud && cluster.kind === 'kubernetes'
        ? await issueInstallCode(trx, {
            orgId: cluster.org_id,
            clusterId: cluster.id,
            tokenId: token.id,
            token: token.value,
          })
        : null;
    return {
      token: { ...token, createdAt: token.createdAt.toISOString() },
      install:
        cluster.kind === 'kubernetes'
          ? {
              helm: helmInstallCommand({ token: token.value, endpoint, version }),
              ...(code
                ? {
                    kubectl: kubectlApplyCommand({ endpoint, code: code.code }),
                    installCodeExpiresAt: code.expiresAt.toISOString(),
                  }
                : {}),
            }
          : {
              dockerRun: dockerRunCommand({ token: token.value, endpoint, image }),
              ...(cloud
                ? { compose: dockerComposeSnippet({ token: token.value, endpoint, image }) }
                : {}),
            },
    };
  }

  app.get(
    '/clusters',
    {
      preHandler: signedIn,
      schema: {
        summary: "List the org's clusters and Docker fleets",
        tags: ['clusters', PUBLIC_TAG],
        response: { 200: ClusterListSchema, 401: ProblemSchema },
      },
    },
    async (request) => {
      const rows = await listClusters(db, request.user!.org.id);
      const failing = await ingestFailures(
        db,
        rows.map((r) => r.id),
      );
      return { clusters: rows.map((r) => toClusterView(r, failing.get(r.id) ?? null)) };
    },
  );

  app.post(
    '/clusters',
    {
      preHandler: canManage,
      schema: {
        summary:
          'Create a Docker fleet or Kubernetes cluster; returns its first token (shown once) and the install command',
        tags: ['clusters'],
        body: Type.Object({
          name: ClusterName,
          kind: Type.Union([Type.Literal('docker'), Type.Literal('kubernetes')]),
        }),
        response: {
          201: CreateClusterResponseSchema,
          400: ProblemSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          409: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const { org } = request.user!;
      // Cloud: a cluster or fleet over the plan answers 409 plan-limit (ADR-177).
      const entitlements = request.server.entitlements;
      if (entitlements && (await refuseCluster(db, entitlements, org.id, reply))) return reply;
      try {
        const { cluster, body } = await db.transaction().execute(async (trx) => {
          const cluster = await insertCluster(trx, org.id, request.body.name, request.body.kind);
          const token = await issueClusterToken(trx, cluster.id);
          return { cluster, body: await issuedTokenBody(request, token, cluster, trx) };
        });
        request.log.info(
          { clusterId: cluster.id, tokenPrefix: body.token.prefix },
          'cluster created',
        );
        if (config.edition === 'cloud') {
          recordFunnelEvent(request.log, {
            name: 'cluster_created',
            userId: request.user!.id,
            orgId: org.id,
            props: { kind: cluster.kind },
          });
        }
        return reply.code(201).send({ cluster: toClusterView(cluster), ...body });
      } catch (err) {
        if (isUniqueViolation(err)) {
          return sendProblem(
            reply,
            409,
            `A cluster named "${request.body.name}" already exists`,
            ProblemType.nameTaken,
          );
        }
        throw err;
      }
    },
  );

  app.get(
    '/clusters/:id',
    {
      preHandler: signedIn,
      schema: {
        summary: 'A cluster and its tokens (prefixes only)',
        tags: ['clusters', PUBLIC_TAG],
        params: ClusterIdParams,
        response: { 200: ClusterDetailSchema, 401: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, NOT_FOUND);
      // Read-only demo (ADR-122) and API tokens (ADR-125): not even token prefixes.
      const tokens = config.demoMode || request.apiToken ? [] : await listTokens(db, cluster.id);
      const failing = await ingestFailures(db, [cluster.id]);
      return {
        cluster: toClusterView(cluster, failing.get(cluster.id) ?? null),
        tokens: tokens.map(toTokenView),
      };
    },
  );

  app.patch(
    '/clusters/:id',
    {
      preHandler: canManage,
      schema: {
        summary: 'Rename a cluster',
        tags: ['clusters'],
        params: ClusterIdParams,
        body: Type.Object({ name: ClusterName }),
        response: {
          200: Type.Object({ cluster: ClusterDetailSchema.properties.cluster }),
          400: ProblemSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          409: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const row = await db
          .updateTable('clusters')
          .set({ name: request.body.name })
          .where('org_id', '=', request.user!.org.id)
          .where('id', '=', request.params.id)
          .returningAll()
          .executeTakeFirst();
        if (!row) return sendProblem(reply, 404, NOT_FOUND);
        return { cluster: toClusterView(row) };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return sendProblem(
            reply,
            409,
            `A cluster named "${request.body.name}" already exists`,
            ProblemType.nameTaken,
          );
        }
        throw err;
      }
    },
  );

  app.delete(
    '/clusters/:id',
    {
      // Deleting a cluster and its data is the Owner's (ADR-140).
      preHandler: [signedIn, requireRole('owner')],
      schema: {
        summary: 'Delete a cluster and revoke all its tokens',
        tags: ['clusters'],
        params: ClusterIdParams,
        response: { 204: Type.Null(), 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      // Token hashes outlive the cluster so the Helm bootstrap cannot recreate it (ADR-069).
      const result = await db.transaction().execute(async (trx) => {
        const cluster = await trx
          .selectFrom('clusters')
          .select('id')
          .where('org_id', '=', request.user!.org.id)
          .where('id', '=', request.params.id)
          .forUpdate()
          .executeTakeFirst();
        if (!cluster) return null;
        await trx
          .insertInto('retired_cluster_tokens')
          .columns(['token_hash'])
          .expression((eb) =>
            eb
              .selectFrom('cluster_tokens')
              .select('token_hash')
              .where('cluster_id', '=', cluster.id),
          )
          .onConflict((oc) => oc.doNothing())
          .execute();
        return trx.deleteFrom('clusters').where('id', '=', cluster.id).executeTakeFirst();
      });
      if (!result || result.numDeletedRows === 0n) return sendProblem(reply, 404, NOT_FOUND);
      tokens.invalidateCluster(request.params.id);
      request.log.info({ clusterId: request.params.id }, 'cluster deleted');
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/clusters/:id/tokens',
    {
      preHandler: canManage,
      schema: {
        summary:
          'Issue an additional token (rotation: issue, update agents, then revoke the old one)',
        tags: ['clusters'],
        params: ClusterIdParams,
        response: {
          201: IssueTokenResponseSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          409: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, NOT_FOUND);
      if ((await countActiveTokens(db, cluster.id)) >= MAX_ACTIVE_TOKENS) {
        return sendProblem(
          reply,
          409,
          `A cluster can have at most ${MAX_ACTIVE_TOKENS} active tokens. Revoke one first.`,
          ProblemType.tokenLimit,
        );
      }
      // A rotation: the install codes of the old token go (ADR-176).
      await revokeInstallCodes(db, cluster.id);
      const token = await issueClusterToken(db, cluster.id);
      request.log.info(
        { clusterId: cluster.id, tokenPrefix: token.prefix },
        'cluster token issued',
      );
      return reply.code(201).send(await issuedTokenBody(request, token, cluster));
    },
  );

  app.delete(
    '/clusters/:id/tokens/:tokenId',
    {
      preHandler: canManage,
      schema: {
        summary: 'Revoke a token; agents using it are rejected from then on',
        tags: ['clusters'],
        params: TokenParams,
        response: { 204: Type.Null(), 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, NOT_FOUND);
      const token = await db
        .selectFrom('cluster_tokens')
        .select(['id', 'prefix', 'revoked_at'])
        .where('cluster_id', '=', cluster.id)
        .where('id', '=', request.params.tokenId)
        .executeTakeFirst();
      if (!token) return sendProblem(reply, 404, 'Token not found');
      if (!token.revoked_at) {
        await db
          .updateTable('cluster_tokens')
          .set({ revoked_at: new Date() })
          .where('id', '=', token.id)
          .execute();
        await revokeInstallCodes(db, cluster.id);
        tokens.invalidateToken(token.id);
        request.log.info(
          { clusterId: cluster.id, tokenPrefix: token.prefix },
          'cluster token revoked',
        );
      }
      return reply.code(204).send(null);
    },
  );
};
