// SPDX-License-Identifier: AGPL-3.0-only
// Finds and registers the Enterprise modules in ee/backend (SPEC §3.4, ADR-232). ee/ is
// optional: without it nothing is imported and nothing is logged, and the core builds and
// runs as Community. Its entry is looked for where each way of running puts it:
//   - the image: /app/ee/backend/index.js, beside /app/dist (backend/Dockerfile);
//   - the repository, built: ee/backend/dist/index.js (`pnpm ee:build`);
//   - the repository under tsx (pnpm dev, tests): ee/backend/src/index.ts.
// Each module registers its routes behind host.requireFeature, which reads the licence per
// request: unlicensed, they answer 404 as if absent; a pasted key works without a restart.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import { grants, isActive } from './lib/license.js';
import { ProblemType, sendProblem } from './lib/problem.js';
import type { EeBackendModule, EeHost } from './ee-contract.js';
import type { EntitlementsService } from './modules/entitlements/service.js';
import { proFeatures } from './modules/license/pro.js';
import type { LicenseReader } from './modules/license/service.js';
import { registerUnitSource } from './modules/license/units.js';
import { requireUser } from './plugins/auth.js';

/** The places ee/backend's entry can be, for the file running now. */
export function eeCandidates(here = import.meta.url): string[] {
  const underTsx = here.endsWith('.ts');
  const rel = underTsx
    ? ['../../ee/backend/src/index.ts']
    : ['../ee/backend/index.js', '../../ee/backend/dist/index.js'];
  return rel.map((r) => fileURLToPath(new URL(r, here)));
}

/** ee/backend's modules, or none when ee/ isn't there. */
export async function loadEeModules(candidates = eeCandidates()): Promise<EeBackendModule[]> {
  const entry = candidates.find((p) => existsSync(p));
  if (!entry) return [];
  const mod = (await import(entry)) as { modules?: EeBackendModule[] };
  return Array.isArray(mod.modules) ? mod.modules : [];
}

export function eeHost(
  config: Pick<Config, 'edition' | 'demoMode'>,
  license: LicenseReader,
  entitlements: Pick<EntitlementsService, 'get'> | null,
  log: EeHost['log'],
): EeHost {
  // Cloud and the demo: a module's feature is a Pro feature (the org's plan, the demo's org).
  const hasFeature = async (orgId: string, feature: string) => {
    if (config.edition === 'cloud' || config.demoMode) {
      return proFeatures(config, license, orgId, entitlements);
    }
    return grants((await license.current()).check, feature);
  };
  return {
    edition: config.edition,
    demoMode: config.demoMode,
    requireUser: () => requireUser() as unknown as ReturnType<EeHost['requireUser']>,
    hasFeature,
    requireFeature: (feature) => async (request: FastifyRequest, reply: FastifyReply) => {
      const orgId = request.user?.org.id ?? '';
      if (await hasFeature(orgId, feature)) return undefined;
      if (config.edition === 'cloud') {
        return sendProblem(reply, 403, 'This is part of Pro', ProblemType.proFeature);
      }
      const check = (await license.current()).check;
      const p = check?.payload;
      if (p?.features.includes(feature) && !isActive(check!.state)) {
        return sendProblem(
          reply,
          403,
          `Your licence ended on ${p.expiresAt.slice(0, 10)}. A new key turns this back on, with its data kept.`,
          ProblemType.licenseEnded,
        );
      }
      return sendProblem(reply, 404, 'Not Found');
    },
    registerUnitSource: (s) => registerUnitSource(s as Parameters<typeof registerUnitSource>[0]),
    log,
  };
}

/** Registers every module found, each in its own plugin; returns their names. */
export async function registerEe(
  api: FastifyInstance,
  host: EeHost,
  modules?: EeBackendModule[],
): Promise<string[]> {
  const list = modules ?? (await loadEeModules());
  for (const m of list) {
    await api.register(async (scope) => m.register(scope, host));
  }
  if (list.length) host.log.info({ modules: list.map((m) => m.name) }, 'Enterprise modules loaded');
  return list.map((m) => m.name);
}
