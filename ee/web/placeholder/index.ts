// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// The placeholder Enterprise web module (ADR-232): one page, behind the licence feature
// `network`, that reads the placeholder route. It proves the loading and the gate; the
// network module replaces it. No sidebar item: nobody should see it.
import type { EeWebModule } from '../../../web/src/ee/contract';
import PlaceholderPage from './PlaceholderPage.vue';

export const eeWebModule: EeWebModule = {
  name: 'placeholder',
  feature: 'network',
  routes: [
    {
      name: 'ee-placeholder',
      path: 'ee/placeholder',
      component: PlaceholderPage,
      meta: { titleKey: 'ee.placeholder.title' },
    },
  ],
};
