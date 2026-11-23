// SPDX-License-Identifier: AGPL-3.0-only
// The Enterprise web modules (ADR-232): every ee/web/<module>/index.ts that exports
// `eeWebModule`, found at build time. Without ee/ the glob is empty and the dashboard is the
// core's alone. Each module's routes render through EeGate, which shows the module only while
// the licence lists its feature (the backend checks again on every request), and the core's
// teaser otherwise.
import type { RouteRecordRaw } from 'vue-router';
import type { EeNavItem, EeWebModule } from './contract';
import EeGate from './EeGate.vue';

const found = import.meta.glob<{ eeWebModule?: EeWebModule }>('../../../ee/web/*/index.ts', {
  eager: true,
});

export function modulesOf(entries: Record<string, { eeWebModule?: EeWebModule }>): EeWebModule[] {
  return Object.values(entries)
    .map((m) => m.eeWebModule)
    .filter((m): m is EeWebModule => !!m && Array.isArray(m.routes));
}

export const eeWebModules: EeWebModule[] = modulesOf(found);

/** The modules' routes, each wrapped in its licence gate. */
export function eeRoutes(modules: EeWebModule[] = eeWebModules): RouteRecordRaw[] {
  return modules.flatMap((m) =>
    m.routes.map(
      (r) =>
        ({
          ...r,
          component: EeGate,
          props: { feature: m.feature, page: r.component },
          meta: { ...(r.meta ?? {}), eeFeature: m.feature },
        }) as RouteRecordRaw,
    ),
  );
}

/** The modules' sidebar items with their feature. */
export function eeNav(modules: EeWebModule[] = eeWebModules): (EeNavItem & { feature: string })[] {
  return modules.flatMap((m) => (m.nav ?? []).map((n) => ({ ...n, feature: m.feature })));
}
