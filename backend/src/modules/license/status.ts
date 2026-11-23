// SPDX-License-Identifier: AGPL-3.0-only
// What Settings → License, the Owners' banners and the About line say about the licence
// (ADR-232). Pure on the current licence and the unit count, so every state is tested on a
// clock: valid, expiring, in grace, ended, invalid, over the limit, closed to new places.
import type { LicenseState } from '../../lib/license.js';
import type { CurrentLicense } from './service.js';
import type { UnitsState } from './units.js';

export interface LicenseView {
  source: CurrentLicense['source'];
  /** A key is pasted in Settings while the environment's wins over it. */
  shadowed: boolean;
  fileError: string | null;
  state: LicenseState | 'none';
  reason: string;
  license: {
    id: string;
    customer: string;
    edition: 'enterprise';
    units: number;
    features: string[];
    issuedAt: string;
    expiresAt: string;
    graceEndsAt: string;
  } | null;
  units: (Omit<UnitsState, 'peak'> & { parts: Record<string, number> }) | null;
}

export function licenseView(cur: CurrentLicense, units: UnitsState | null): LicenseView {
  const c = cur.check;
  const p = c?.payload ?? null;
  return {
    source: cur.source,
    shadowed: cur.shadowed,
    fileError: cur.fileError ?? null,
    state: c ? c.state : cur.fileError ? 'invalid' : 'none',
    reason: c ? c.reason : (cur.fileError ?? 'no licence key'),
    license: p
      ? {
          id: p.id,
          customer: p.customer,
          edition: p.edition,
          units: p.units,
          features: p.features,
          issuedAt: p.issuedAt,
          expiresAt: p.expiresAt,
          graceEndsAt: c!.graceEndsAt!,
        }
      : null,
    units: units
      ? {
          used: units.used,
          limit: units.limit,
          over: units.over,
          overSince: units.overSince,
          overDays: units.overDays,
          closedSince: units.closedSince,
          parts: units.peak?.parts ?? { nodes: 0, servers: 0 },
        }
      : null,
  };
}

/** One banner for Owners, the most pressing first; words are the dashboard's (i18n). */
export type LicenseBanner =
  | { kind: 'invalid'; reason: string }
  | { kind: 'ended'; endedOn: string }
  | { kind: 'grace'; endedOn: string; stopsOn: string }
  | { kind: 'expiring'; endsOn: string; days: number }
  | { kind: 'over'; used: number; limit: number; closedSince: string | null };

const DAY_MS = 86_400_000;

export function bannersOf(v: LicenseView, nowMs: number): LicenseBanner[] {
  const out: LicenseBanner[] = [];
  const l = v.license;
  if (v.state === 'invalid') out.push({ kind: 'invalid', reason: v.reason });
  if (l && v.state === 'expired') out.push({ kind: 'ended', endedOn: l.expiresAt.slice(0, 10) });
  if (l && v.state === 'grace') {
    out.push({
      kind: 'grace',
      endedOn: l.expiresAt.slice(0, 10),
      stopsOn: l.graceEndsAt.slice(0, 10),
    });
  }
  if (l && v.state === 'expiring') {
    out.push({
      kind: 'expiring',
      endsOn: l.expiresAt.slice(0, 10),
      days: Math.max(0, Math.ceil((Date.parse(l.expiresAt) - nowMs) / DAY_MS)),
    });
  }
  // Over the limit only matters while licensed features work.
  if (
    v.units?.over &&
    l &&
    (v.state === 'valid' || v.state === 'expiring' || v.state === 'grace')
  ) {
    out.push({
      kind: 'over',
      used: v.units.used,
      limit: v.units.limit,
      closedSince: v.units.closedSince,
    });
  }
  return out;
}

/** The edition the API and the About line name: Enterprise once a WatchLog-signed key is set. */
export function editionOf(
  config: { edition: 'community' | 'cloud' },
  cur: CurrentLicense,
): 'community' | 'enterprise' | 'cloud' {
  if (config.edition === 'cloud') return 'cloud';
  return cur.check?.payload ? 'enterprise' : 'community';
}
