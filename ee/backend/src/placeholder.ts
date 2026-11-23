// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// The placeholder Enterprise module (ADR-232): one route that answers only when the licence
// lists its feature. It proves the loading, the gate and the build; the network module
// replaces it.
import type { EeBackendModule } from '../../../backend/src/ee-contract.js';

export const placeholder: EeBackendModule = {
  name: 'placeholder',
  feature: 'network',
  async register(api, host) {
    api.get(
      '/ee/placeholder',
      {
        preHandler: [host.requireUser(), host.requireFeature('network')],
        schema: { hide: true },
      },
      async () => ({ module: 'placeholder', feature: 'network', licensed: true }),
    );
  },
};
