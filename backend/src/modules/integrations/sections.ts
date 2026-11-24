// SPDX-License-Identifier: AGPL-3.0-only
// Sections of the integrations collector's configuration from Enterprise modules (ADR-233):
// `modules.<name>`, which the collector hands to the module of that name (agent/ext). Each
// section is built per collector; a module leaves it out (undefined) for an org without its
// feature, so the collector runs nothing it isn't licensed for. Without ee/ there are none.
export interface CollectorSectionContext {
  orgId: string;
  clusterId: string;
  host: string;
}

type Build = (c: CollectorSectionContext) => Promise<unknown>;

const sections = new Map<string, Build>();

export function registerCollectorSection(name: string, build: Build): void {
  sections.set(name, build);
}

/** Tests only. */
export function clearCollectorSections(): void {
  sections.clear();
}

/** The sections for one collector, by module name; empty without modules. */
export async function collectorSections(
  c: CollectorSectionContext,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [name, build] of [...sections].sort(([a], [b]) => a.localeCompare(b))) {
    const v = await build(c);
    if (v !== undefined) out[name] = v;
  }
  return out;
}
