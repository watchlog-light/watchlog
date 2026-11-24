// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// The network module (ADR-233): switches, routers and the map, polled by the integrations
// collector. Pro and Enterprise: every route answers 404 where `network` isn't licensed.
import type { EeBackendModule, EeHost } from '../../../../backend/src/ee-contract.js';
import { networkRules } from './alerts.js';
import { FEATURE, networkSection } from './collector.js';
import { registerNetworkIngest } from './ingest.js';
import { registerNetworkRoutes } from './routes.js';
import { seedNetwork } from './seed.js';

/** A device is one unit, like a node or a server; an access point a controller manages is free. */
function registerShared(host: EeHost): void {
  host.registerUnitSource({
    name: 'network devices',
    async current(db) {
      const rows = await (db as EeHost['systemDb'])
        .selectFrom('network_devices')
        .select(['org_id', host.sql<number>`count(*)::int`.as('n')])
        .where('removed_at', 'is', null)
        .where('managed_ap', '=', false)
        .groupBy('org_id')
        .execute();
      return new Map(rows.map((r: { org_id: string; n: number }) => [r.org_id, r.n]));
    },
  });
  host.alerts.register(networkRules(host));
}

export const network: EeBackendModule = {
  name: 'network',
  feature: FEATURE,
  async register(api, host) {
    registerShared(host);
    host.collector.registerSection('network', (c) => networkSection(host, c));
    await registerNetworkRoutes(api, host);
  },
  registerIngest(ingest, host) {
    registerNetworkIngest(ingest, host);
  },
  async worker(host) {
    registerShared(host);
  },
  seed: seedNetwork,
};
