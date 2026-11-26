// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// The network section of a collector's configuration (`modules.network`, ADR-233): the devices
// this collector polls, with their credentials, and the discoveries asked of it. Left out for
// an org without the feature, so an unlicensed collector polls nothing.
import type { EeHost } from '../../../../backend/src/ee-contract.js';
import { collectorCredential, findOrder, type CredentialRow } from './credentials.js';

export const FEATURE = 'network';

export async function networkSection(
  host: EeHost,
  c: { orgId: string; clusterId: string; host: string },
): Promise<unknown> {
  if (!(await host.hasFeature(c.orgId, FEATURE))) return undefined;
  const db = host.systemDb;
  const now = new Date(host.now());
  const [devices, discoveries] = await Promise.all([
    db
      .selectFrom('network_devices as d')
      .leftJoin('network_credentials as c', 'c.id', 'd.credential_id')
      .select([
        'd.id',
        'd.name',
        'd.address',
        'd.protocol',
        'd.profile',
        'd.status',
        'd.cert_pin',
        'c.id as cred_id',
        'c.org_id as cred_org',
        'c.name as cred_name',
        'c.protocol as cred_protocol',
        'c.settings as cred_settings',
        'c.ciphertext as cred_ciphertext',
      ])
      .where('d.org_id', '=', c.orgId)
      .where('d.cluster_id', '=', c.clusterId)
      .where('d.poller_host', '=', c.host)
      .where('d.removed_at', 'is', null)
      .orderBy('d.id')
      .execute(),
    db
      .selectFrom('network_discoveries')
      .select(['id', 'request'])
      .where('org_id', '=', c.orgId)
      .where('cluster_id', '=', c.clusterId)
      .where('poller_host', '=', c.host)
      .where('done', '=', false)
      .where('expires_at', '>', now)
      .orderBy('id')
      .execute(),
  ]);
  if (!devices.length && !discoveries.length) return undefined;
  // Ports whose series stay while they are down: links, and the servers and nodes behind them.
  const ids = devices.map((d: { id: string }) => d.id);
  const linked = new Map<string, Set<string>>();
  if (ids.length) {
    const [links, eps] = await Promise.all([
      db
        .selectFrom('network_links')
        .select(['a_device', 'a_port', 'b_device', 'b_port'])
        .where('org_id', '=', c.orgId)
        .execute(),
      db
        .selectFrom('network_endpoints')
        .select(['device_id', 'port'])
        .where('org_id', '=', c.orgId)
        .where('node', 'is not', null)
        .execute(),
    ]);
    const add = (d: string, p: string) => {
      const s = linked.get(d) ?? new Set<string>();
      s.add(p);
      linked.set(d, s);
    };
    for (const l of links) {
      add(l.a_device, l.a_port);
      add(l.b_device, l.b_port);
    }
    for (const e of eps) if (e.device_id && e.port) add(e.device_id, e.port);
  }
  const credOf = new Map<string, CredentialRow>();
  const out = {
    devices: devices.flatMap((d: Record<string, unknown>) => {
      if (!d.cred_id) return [];
      const row: CredentialRow = {
        id: d.cred_id as string,
        org_id: d.cred_org as string,
        name: d.cred_name as string,
        protocol: d.cred_protocol as CredentialRow['protocol'],
        settings: d.cred_settings as CredentialRow['settings'],
        ciphertext: d.cred_ciphertext as string | null,
      };
      credOf.set(row.id, row);
      const cred = collectorCredential(host, row, d.cert_pin as string | null);
      if (!cred) return [];
      return [
        {
          id: d.id,
          name: d.name,
          address: d.address,
          protocol: d.protocol,
          ...(d.profile ? { profile: d.profile } : {}),
          ...cred,
          // Not polled: a changed certificate waiting for an Owner, or paused by the user (1.0.2).
          ...(d.status === 'cert_changed' || d.status === 'paused' ? { paused: true } : {}),
          ...(linked.get(d.id as string)?.size
            ? { linked: [...linked.get(d.id as string)!].sort() }
            : {}),
        },
      ];
    }),
    discover: [] as unknown[],
  };
  if (discoveries.length) {
    const credIds = new Set<string>();
    for (const r of discoveries)
      for (const id of (r.request as { credentialIds?: string[] }).credentialIds ?? [])
        credIds.add(id);
    const creds = credIds.size
      ? await db
          .selectFrom('network_credentials')
          .selectAll()
          .where('org_id', '=', c.orgId)
          .where('id', 'in', [...credIds])
          .execute()
      : [];
    for (const r of creds) credOf.set(r.id, r as CredentialRow);
    out.discover = discoveries.map((r: { id: string; request: unknown }) => {
      const q = r.request as {
        seeds: string[];
        range?: string;
        neighbours: boolean;
        credentialIds: string[];
        test?: {
          protocol: CredentialRow['protocol'];
          settings: CredentialRow['settings'];
          ciphertext: string;
          pin?: string;
          find?: boolean;
        };
      };
      // "Test against an address" (1.0.2): one address with the values as typed, which are
      // sealed in this row and belong to no profile.
      if (q.test) {
        const cred = collectorCredential(
          host,
          {
            id: r.id,
            org_id: c.orgId,
            name: 'test',
            protocol: q.test.protocol,
            settings: q.test.settings,
            ciphertext: q.test.ciphertext,
          },
          q.test.pin ?? null,
        );
        // "Find what works" (1.0.4): the same passwords with each combination of protocols,
        // in order; the collector tries them one at a time (an older one, without pruning).
        if (q.test.find && cred && 'snmp' in cred) {
          const base = cred.snmp as Record<string, unknown>;
          return {
            id: r.id,
            seeds: q.seeds,
            neighbours: false,
            find: true,
            credentials: findOrder(q.test.settings as Record<string, unknown>).map((c) => ({
              id: `${r.id}|${c.auth}|${c.priv}`,
              protocol: 'snmp',
              snmp: {
                ...base,
                authProto: c.auth,
                privProto: c.priv,
                ...(c.priv === 'NONE' ? { privKey: undefined } : {}),
              },
            })),
          };
        }
        return {
          id: r.id,
          seeds: q.seeds,
          neighbours: false,
          credentials: cred ? [{ id: r.id, protocol: q.test.protocol, ...cred }] : [],
        };
      }
      return {
        id: r.id,
        seeds: q.seeds,
        ...(q.range ? { range: q.range } : {}),
        neighbours: q.neighbours,
        credentials: q.credentialIds.flatMap((id) => {
          const row = credOf.get(id);
          const cred = row ? collectorCredential(host, row) : null;
          return row && cred ? [{ id, protocol: row.protocol, ...cred }] : [];
        }),
      };
    });
  }
  return out;
}
