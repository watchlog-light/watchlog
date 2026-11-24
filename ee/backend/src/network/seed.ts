// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// The seed's `modules.network` (ADR-233): the live demo's simulated office network, declared
// in its seed file because demo mode refuses every write through the API. Credential profiles
// by name and devices by address, polled from a cluster or a fleet's server named by kind;
// applied once each, never overwritten. Pending while the place or its collector isn't there.
import type { EeHost } from '../../../../backend/src/ee-contract.js';
import { sealSecret } from './credentials.js';

interface SeedNetwork {
  credentials?: {
    name: string;
    protocol: 'snmp' | 'routeros' | 'dahua';
    settings: Record<string, unknown>;
    secret: Record<string, string>;
  }[];
  devices?: {
    name: string;
    address: string;
    credential: string;
    clusterKind: 'kubernetes' | 'server';
    /** A fleet's server; '' (Kubernetes) by default. */
    host?: string;
    kind?: string;
    profile?: string;
  }[];
}

export async function seedNetwork(
  host: EeHost,
  orgId: string,
  section: unknown,
): Promise<{ pending: boolean }> {
  const s = (section ?? {}) as SeedNetwork;
  const db = host.systemDb;
  for (const c of s.credentials ?? []) {
    const exists = await db
      .selectFrom('network_credentials')
      .select('id')
      .where('org_id', '=', orgId)
      .where('name', '=', c.name)
      .executeTakeFirst();
    if (exists) continue;
    const id = host.newId();
    await db
      .insertInto('network_credentials')
      .values({
        id,
        org_id: orgId,
        name: c.name,
        protocol: c.protocol,
        settings: JSON.stringify(c.settings),
        ciphertext: sealSecret(host, id, c.secret),
      })
      .execute();
  }
  const creds = new Map(
    (
      await db
        .selectFrom('network_credentials')
        .select(['id', 'name', 'protocol'])
        .where('org_id', '=', orgId)
        .execute()
    ).map((c: any) => [c.name, c]),
  );
  const clusters = await db
    .selectFrom('clusters')
    .select(['id', 'kind'])
    .where('org_id', '=', orgId)
    .orderBy('created_at')
    .execute();
  let pending = false;
  let added = 0;
  for (const d of s.devices ?? []) {
    const exists = await db
      .selectFrom('network_devices')
      .select('id')
      .where('org_id', '=', orgId)
      .where('address', '=', d.address)
      .where('removed_at', 'is', null)
      .executeTakeFirst();
    if (exists) continue;
    const cluster = clusters.find((c: any) => c.kind === d.clusterKind);
    const cred = creds.get(d.credential) as { id: string; protocol: string } | undefined;
    if (!cluster || !cred) {
      pending = true;
      continue;
    }
    await db
      .insertInto('network_devices')
      .values({
        id: host.newId(),
        org_id: orgId,
        cluster_id: cluster.id,
        poller_host: d.host ?? '',
        name: d.name,
        address: d.address,
        protocol: cred.protocol,
        profile: d.profile ?? (cred.protocol === 'routeros' ? 'mikrotik' : null),
        credential_id: cred.id,
        kind:
          d.kind ??
          (cred.protocol === 'routeros' ? 'router' : cred.protocol === 'dahua' ? 'nvr' : 'switch'),
      })
      .execute();
    added++;
    host.collector.notify(cluster.id);
  }
  if (added) {
    await host.alerts.ensure(orgId);
    host.log.info({ added }, 'seed: network devices added');
  }
  return { pending };
}
