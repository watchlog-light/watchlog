// SPDX-License-Identifier: AGPL-3.0-only
// Network devices (ADR-233): Pro and Enterprise. The sidebar's "Network" item is the core's;
// its pages are ee/'s. Whether they are on here: Cloud with Pro, the demo, or a licence that
// lists `network`. Otherwise the item carries the Pro badge and opens the teaser, which loads
// no data (the network API answers 404 there).
export const NETWORK_FEATURE = 'network';

export function networkOn(o: {
  isCloud: boolean;
  demo: boolean;
  /** Cloud: the org's plan has Pro features. */
  proFeatures: boolean | null | undefined;
  /** Self-hosted: the licence's features. */
  licenseFeatures: readonly string[] | null | undefined;
}): boolean {
  if (o.demo) return true;
  if (o.isCloud) return o.proFeatures === true;
  return !!o.licenseFeatures?.includes(NETWORK_FEATURE);
}

/** A switch port's line on a server's or node's page: "sw-access-2 · Gi1/0/14 · 1 Gb/s". */
export function portLine(a: { device: string; port: string; speed: string }): string {
  return [a.device, a.port, a.speed].filter(Boolean).join(' · ');
}
