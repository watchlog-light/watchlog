// SPDX-License-Identifier: AGPL-3.0-only
// Who has Pro features (ADR-232): the one check every Pro gate uses, What changed and the
// anomaly-worker, the anomaly alert rule, All clusters and fleets, their MCP tools and the
// upgrade pages. Three ways in:
//   - Cloud: the org's `pro_features` entitlement (Pro and Enterprise plans, ADR-205);
//   - the live demo: the installation's org (ADR-203);
//   - self-hosted: a valid Enterprise licence with `pro`, for every org on the installation.
// Cloud ignores licences. A self-hosted install without one sees Community: the routes answer
// 404 and the tools aren't listed, exactly as before. A licence that ended keeps the routes
// (403 `license-ended`, "Your licence ended on …") so the pages can say so; the data stays.
import type { Config } from '../../config.js';
import type { FastifyReply } from 'fastify';
import { isActive } from '../../lib/license.js';
import { ProblemType, sendProblem } from '../../lib/problem.js';
import type { EntitlementsService } from '../entitlements/service.js';
import type { LicenseReader } from './service.js';

export type ProConfig = Pick<Config, 'edition' | 'demoMode'>;
type Entitlements = Pick<EntitlementsService, 'get'> | null | undefined;

export type ProAccess =
  | { ok: true; via: 'cloud' | 'demo' | 'license' }
  /** Not on this installation: Community without a licence that lists `pro`. */
  | { ok: false; status: 404 }
  /** Cloud: the org's plan has no Pro features. */
  | { ok: false; status: 403; type: 'pro-feature' }
  /** Self-hosted: the licence with `pro` ended (its grace too) on this day. */
  | { ok: false; status: 403; type: 'license-ended'; endedOn: string };

/** Whether an org has Pro features, and if not, how the route answers. */
export async function proAccess(
  config: ProConfig,
  license: LicenseReader | null | undefined,
  orgId: string,
  entitlements?: Entitlements,
): Promise<ProAccess> {
  if (config.edition === 'cloud') {
    if (entitlements && (await entitlements.get(orgId)).proFeatures)
      return { ok: true, via: 'cloud' };
    return { ok: false, status: 403, type: 'pro-feature' };
  }
  if (config.demoMode) return { ok: true, via: 'demo' };
  const check = license ? (await license.current()).check : null;
  if (!check?.payload || !check.payload.features.includes('pro')) return { ok: false, status: 404 };
  if (isActive(check.state)) return { ok: true, via: 'license' };
  return {
    ok: false,
    status: 403,
    type: 'license-ended',
    endedOn: check.payload.expiresAt.slice(0, 10),
  };
}

/** The one check: whether the org has Pro features now. */
export async function proFeatures(
  config: ProConfig,
  license: LicenseReader | null | undefined,
  orgId: string,
  entitlements?: Entitlements,
): Promise<boolean> {
  return (await proAccess(config, license, orgId, entitlements)).ok;
}

/**
 * Whether Pro routes and tools exist on this installation: Cloud, the demo, or a licence
 * that lists `pro` and was signed by WatchLog (active or ended; an ended one answers 403).
 */
export async function proExists(
  config: ProConfig,
  license: LicenseReader | null | undefined,
): Promise<boolean> {
  if (config.edition === 'cloud' || config.demoMode) return true;
  const check = license ? (await license.current()).check : null;
  return !!check?.payload?.features.includes('pro');
}

/** Sends the refusal a route gives for a ProAccess that isn't ok. */
export function sendProRefusal(
  reply: FastifyReply,
  access: Exclude<ProAccess, { ok: true }>,
  feature: string,
): FastifyReply {
  if (access.status === 404) return sendProblem(reply, 404, 'Not Found');
  if (access.type === 'license-ended') {
    return sendProblem(
      reply,
      403,
      `Your licence ended on ${access.endedOn}. ${feature} comes back with a new key, with its data kept.`,
      ProblemType.licenseEnded,
    );
  }
  return sendProblem(reply, 403, `${feature} is part of Pro`, ProblemType.proFeature);
}
