// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { PUBLIC_TAG } from '../../openapi/public.js';

const HealthResponse = Type.Object({
  status: Type.Literal('ok'),
  version: Type.String(),
});

export const healthRoutes: FastifyPluginAsyncTypebox<{ version: string }> = async (
  app,
  { version },
) => {
  app.get(
    '/health',
    {
      schema: {
        summary: 'Liveness check',
        tags: ['system', PUBLIC_TAG],
        response: { 200: HealthResponse },
      },
    },
    async () => ({ status: 'ok' as const, version }),
  );
};
