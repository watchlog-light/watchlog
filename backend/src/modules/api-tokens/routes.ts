// SPDX-License-Identifier: AGPL-3.0-only
// Settings → API tokens (ADR-125): each user lists, creates and revokes their own tokens.
// Session only: a token can never manage tokens (the scope guard refuses it first; the
// check here is a second line). Every role may have tokens: they only read what the
// user can read. Demo mode refuses creating and revoking like every change (ADR-122).
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import type { Database } from '../../db/index.js';
import { ProblemType, sendProblem } from '../../lib/problem.js';
import { requireUser } from '../../plugins/auth.js';
import { TOKEN_SCOPE_MESSAGE } from '../../plugins/api-token.js';
import { ProblemSchema } from '../auth/schemas.js';
import {
  ApiTokenDetailSchema,
  ApiTokenIdParams,
  ApiTokenListSchema,
  CreateApiTokenBody,
  CreatedApiTokenSchema,
} from './schemas.js';
import { createApiToken, getApiToken, listApiTokens, revokeApiToken } from './service.js';
import { DEFAULT_EXPIRY_DAYS, MAX_ACTIVE_API_TOKENS } from './tokens.js';

const NOT_FOUND = 'API token not found';
const TAGS = ['api-tokens'];

export const apiTokenRoutes: FastifyPluginAsyncTypebox<{
  db: Database;
  now?: () => Date;
}> = async (app, { db, now = () => new Date() }) => {
  const sessionOnly = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.apiToken) {
      return sendProblem(reply, 403, TOKEN_SCOPE_MESSAGE, ProblemType.tokenScope);
    }
  };
  const preHandler = [requireUser(db), sessionOnly];

  app.get(
    '/api-tokens',
    {
      preHandler,
      schema: {
        summary: 'Your API tokens, with the expired and revoked ones of the last 30 days',
        tags: TAGS,
        response: { 200: ApiTokenListSchema, 401: ProblemSchema, 403: ProblemSchema },
      },
    },
    async (request) => {
      const user = request.user!;
      return { tokens: await listApiTokens(db, user.id, user.org.id, now()) };
    },
  );

  app.post(
    '/api-tokens',
    {
      preHandler,
      schema: {
        summary: 'Create a read-only API token; its value is returned once',
        tags: TAGS,
        body: CreateApiTokenBody,
        response: {
          201: CreatedApiTokenSchema,
          400: ProblemSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          409: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const name = request.body.name.trim();
      if (!name) return sendProblem(reply, 400, 'Give the token a name');
      const created = await createApiToken(db, {
        userId: user.id,
        orgId: user.org.id,
        name,
        expiresInDays:
          request.body.expiresInDays === undefined
            ? DEFAULT_EXPIRY_DAYS
            : request.body.expiresInDays,
        now: now(),
      });
      if (created === 'limit') {
        return sendProblem(
          reply,
          409,
          `You can have at most ${MAX_ACTIVE_API_TOKENS} active API tokens. Revoke one first.`,
          ProblemType.tokenLimit,
        );
      }
      // The prefix only: the value is never logged.
      request.log.info(
        { tokenId: created.token.id, tokenPrefix: created.token.prefix },
        'API token created',
      );
      return reply.code(201).send(created);
    },
  );

  app.get(
    '/api-tokens/:id',
    {
      preHandler,
      schema: {
        summary: 'One of your API tokens with its history',
        tags: TAGS,
        params: ApiTokenIdParams,
        response: {
          200: ApiTokenDetailSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const found = await getApiToken(db, user.id, user.org.id, request.params.id, now());
      if (!found) return sendProblem(reply, 404, NOT_FOUND);
      return found;
    },
  );

  app.delete(
    '/api-tokens/:id',
    {
      preHandler,
      schema: {
        summary: 'Revoke an API token; it is refused from the next request on',
        tags: TAGS,
        params: ApiTokenIdParams,
        response: { 204: Type.Null(), 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const result = await revokeApiToken(db, {
        userId: user.id,
        orgId: user.org.id,
        id: request.params.id,
        now: now(),
      });
      if (!result) return sendProblem(reply, 404, NOT_FOUND);
      if (result.revoked) {
        request.log.info(
          { tokenId: request.params.id, tokenPrefix: result.prefix },
          'API token revoked',
        );
      }
      return reply.code(204).send(null);
    },
  );
};
