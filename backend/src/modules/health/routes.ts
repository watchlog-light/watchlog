// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { PUBLIC_TAG } from '../../openapi/public.js';
import { isActive } from '../../lib/license.js';
import type { LicenseReader } from '../license/service.js';
import { editionOf } from '../license/status.js';

const HealthResponse = Type.Object({
  status: Type.Literal('ok'),
  version: Type.String(),
  edition: Type.Union(
    [Type.Literal('community'), Type.Literal('enterprise'), Type.Literal('cloud')],
    {
      description: 'Enterprise once a WatchLog licence key is set (ADR-232)',
    },
  ),
  licensed: Type.Boolean({
    description: 'A licence is set and works now; never its key or customer',
  }),
});

export const healthRoutes: FastifyPluginAsyncTypebox<{
  version: string;
  edition: 'community' | 'cloud';
  license: LicenseReader;
}> = async (app, { version, edition, license }) => {
  app.get(
    '/health',
    {
      schema: {
        summary: 'Liveness check, the version and the edition',
        tags: ['system', PUBLIC_TAG],
        response: { 200: HealthResponse },
      },
    },
    async () => {
      // Liveness first: a licence that can't be read still answers ok, as Community.
      const cur = await license
        .current()
        .catch(() => ({ source: 'none' as const, check: null, shadowed: false }));
      return {
        status: 'ok' as const,
        version,
        edition: editionOf({ edition }, cur),
        licensed: !!cur.check?.payload && isActive(cur.check.state),
      };
    },
  );
};
