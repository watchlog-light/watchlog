// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';

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
        tags: ['system'],
        response: { 200: HealthResponse },
      },
    },
    async () => ({ status: 'ok' as const, version }),
  );
};
