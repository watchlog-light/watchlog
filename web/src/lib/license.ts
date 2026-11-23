// SPDX-License-Identifier: AGPL-3.0-only
// The words of the Enterprise licence (ADR-232) on Settings → License, the banners and the
// About line. Pure, so each state is tested.
import type { LicenseBanner, LicenseSummary, LicenseView } from '@watchlog/api-types';

type Tr = (key: string, values?: Record<string, unknown>, n?: number) => string;

/** "31 Dec 2027": a licence's dates are days (UTC), not moments. */
export function licenseDate(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export type Tone = 'ok' | 'warn' | 'bad' | 'none';
export function stateTone(state: LicenseView['state']): Tone {
  if (state === 'valid') return 'ok';
  if (state === 'expiring' || state === 'grace') return 'warn';
  if (state === 'expired' || state === 'invalid') return 'bad';
  return 'none';
}

/** The features in words: Pro, Network devices; an unknown one as it is written. */
export function featureNames(features: string[], t: Tr): string[] {
  const known: Record<string, string> = {
    pro: 'license.feature.pro',
    network: 'license.feature.network',
  };
  return features.map((f) => (known[f] ? t(known[f]) : f));
}

/** What the units were made of: "48 nodes, 10 servers". */
export function unitParts(parts: Record<string, number>, t: Tr): string {
  const out: string[] = [];
  for (const [k, n] of Object.entries(parts)) {
    if (k === 'nodes') out.push(t('license.units.nodes', { n }, n));
    else if (k === 'servers') out.push(t('license.units.servers', { n }, n));
    else if (n) out.push(`${n} ${k}`);
  }
  return out.join(', ');
}

/** One banner in words. */
export function bannerText(b: LicenseBanner, t: Tr): string {
  switch (b.kind) {
    case 'invalid':
      return t('license.banner.invalid', { reason: b.reason });
    case 'ended':
      return t('license.banner.ended', { date: licenseDate(b.endedOn) });
    case 'grace':
      return t('license.banner.grace', {
        date: licenseDate(b.endedOn),
        stops: licenseDate(b.stopsOn),
      });
    case 'expiring':
      return t('license.banner.expiring', { date: licenseDate(b.endsOn), n: b.days }, b.days);
    case 'over':
      return (
        t('license.banner.over', { used: b.used, limit: b.limit }) +
        (b.closedSince ? ` ${t('license.over.closed', { date: licenseDate(b.closedSince) })}` : '')
      );
  }
}

/** The account menu's About line: "Community", "Enterprise, licensed to Acme" (Owners). */
export function aboutLine(
  o: { isCloud: boolean; demo: boolean; license: LicenseSummary | null },
  t: Tr,
): string {
  if (o.isCloud) return t('license.about.cloud');
  if (o.license?.edition === 'enterprise') {
    return o.license.customer
      ? t('license.about.enterpriseFor', { customer: o.license.customer })
      : t('license.about.enterprise');
  }
  return t('license.about.community');
}
