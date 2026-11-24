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
import { sql } from 'kysely';
import type { Config } from './config.js';
import type { Database } from './db/index.js';
import { newId } from './lib/ids.js';
import { decryptSecret, encryptSecret } from './lib/secrets.js';
import type { VictoriaQueryClient } from './lib/victoria.js';
import type { DefaultRule } from './modules/alerts/defaults.js';
import { ensureDefaultRules, registerModuleRules } from './modules/alerts/rules.js';
import { moduleRules } from './modules/alerts/module-rules.js';
import { clustersForOrg } from './modules/clusters/service.js';
import { recordEvent } from './modules/events/record.js';
import { useNetworkEvidence } from './modules/causes/gather.js';
import type { ConfigNotifier } from './modules/integrations/notifier.js';
import { registerCollectorSection } from './modules/integrations/sections.js';
import { grants, isActive } from './lib/license.js';
import { ProblemType, sendProblem } from './lib/problem.js';
import type { EeBackendModule, EeHost } from './ee-contract.js';
import type { EntitlementsService } from './modules/entitlements/service.js';
import { proFeatures } from './modules/license/pro.js';
import type { LicenseReader } from './modules/license/service.js';
import { registerUnitSource } from './modules/license/units.js';
import { closedSince } from './modules/license/closed.js';
import { requireRole, requireUser } from './plugins/auth.js';

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

/** What the core hands a module at run time, beyond the licence checks. */
export interface EeHostDeps {
  db: Database;
  systemDb: Database;
  secretKey: Buffer;
  victoria: VictoriaQueryClient | null | undefined;
  notifier: Pick<ConfigNotifier, 'notify'> | null;
  eventsRetentionDays: number;
  now?: () => number;
}

export function eeHost(
  config: Pick<Config, 'edition' | 'demoMode'>,
  license: LicenseReader,
  entitlements: Pick<EntitlementsService, 'get'> | null,
  log: EeHost['log'],
  deps: EeHostDeps,
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
    requireRole: (...roles) =>
      requireRole(...roles) as unknown as ReturnType<EeHost['requireRole']>,
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
    registerUnitSource: (s) =>
      registerUnitSource(s as unknown as Parameters<typeof registerUnitSource>[0]),
    log,
    db: deps.db as unknown as EeHost['db'],
    systemDb: deps.systemDb as unknown as EeHost['systemDb'],
    sql,
    newId,
    secrets: {
      encrypt: (plain, aad) => encryptSecret(deps.secretKey, plain, aad),
      decrypt: (cipher, aad) => decryptSecret(deps.secretKey, cipher, aad),
    },
    victoria: deps.victoria
      ? {
          // Only the org's own clusters: the scope is built from its rows, never from the ids
          // given, so a module can't reach another org's series.
          async query(orgId, clusterIds, expr, time) {
            const scope = await orgScope(deps.systemDb, orgId, clusterIds);
            return scope ? deps.victoria!.query(scope, expr, time) : [];
          },
          async queryRange(orgId, clusterIds, expr, start, end, step) {
            const scope = await orgScope(deps.systemDb, orgId, clusterIds);
            return scope ? deps.victoria!.queryRange(scope, expr, start, end, step) : [];
          },
        }
      : null,
    collector: {
      registerSection: registerCollectorSection,
      notify: (clusterId) => deps.notifier?.notify(clusterId),
    },
    events: {
      record: (e) => recordEvent(deps.systemDb, e, deps.eventsRetentionDays),
    },
    alerts: {
      register: (rules) => registerModuleRules(rules as unknown as DefaultRule[]),
      ensure: (orgId) => ensureDefaultRules(deps.systemDb, orgId, moduleRules()),
    },
    now: deps.now ?? Date.now,
    closedSince: async () =>
      config.edition === 'cloud' || config.demoMode
        ? null
        : closedSince(license, deps.systemDb, (deps.now ?? Date.now)()),
  };
}

/**
 * The org's scope when any asked cluster is the org's (one: that cluster's; several: all the
 * org's, as clustersForOrg gives it); null when none is.
 */
async function orgScope(db: Database, orgId: string, clusterIds: string[]) {
  const org = await clustersForOrg(db, orgId);
  const mine = org.rows.map((r) => r.id).filter((id) => clusterIds.includes(id));
  if (!mine.length) return null;
  return mine.length === 1 ? org.scopeOf(mine[0]!) : org.scope;
}

/** Registers each module's ingest routes (inside the ingest plugin, with its token auth). */
export function registerEeIngest(
  ingest: FastifyInstance,
  host: EeHost,
  modules: EeBackendModule[],
): void {
  for (const m of modules) m.registerIngest?.(ingest, host);
}

/** Registers every module found, each in its own plugin; returns their names. */
export async function registerEe(
  api: FastifyInstance,
  host: EeHost,
  modules?: EeBackendModule[],
): Promise<string[]> {
  const list = modules ?? (await loadEeModules());
  // Probable cause reads the network module's events about a focus's nodes and servers.
  if (list.some((m) => m.feature === 'network')) useNetworkEvidence();
  for (const m of list) {
    await api.register(async (scope) => m.register(scope, host));
  }
  if (list.length) host.log.info({ modules: list.map((m) => m.name) }, 'Enterprise modules loaded');
  return list.map((m) => m.name);
}
